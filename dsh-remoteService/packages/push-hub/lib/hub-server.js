/**
 * 官方推送 hub 的 HTTP(S) 服务（0.3.0 起只有 R2：官方 App 登记 + 主机直连推送）。
 *
 * 对外路由（契约：docs/group-push-r2-contract.zh.md §4）：
 *   GET  /healthz                 → 能力/配额摘要（不含任何 token/密钥/credential）
 *   POST /v1/enroll/challenge     → 签发一次性 challenge（nonce + 120s TTL）
 *   POST /v1/enroll               → 校验设备 P-256 PoP 签名，签发 device credential（EdDSA JWT）
 *   POST /v1/push                 → Authorization: Bearer <deviceCredential>（body 为单个 token）
 *
 * 安全边界：
 *   - 鉴权只认 `Authorization: Bearer <deviceCredential>`，**不信任来源 IP / X-Forwarded-* /
 *     自定义头**（IP 只用于限流分桶，不是身份）；不是合法 device credential 一律 401；
 *   - schema 只允许 kind/host/token/environment/enroll 字段：title、body、sessionId 等任何
 *     多余字段 400；
 *   - 设备 token / credential / 请求体不写日志：日志只有模式、计数、结果；
 *   - 限流全内存滑动窗口（契约 §4.5，默认值见 docs/group-push-load-evaluation.zh.md §4），
 *     429 带 `Retry-After`；被拒请求不消耗任何一层配额。
 *
 * 零第三方依赖（dsh-remote-apns / dsh-remote-protocol 都是本仓库 workspace 包）。
 */

import { createPrivateKey } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createApnsClient } from 'dsh-remote-apns';
import {
  PUSH_ENROLL_CHALLENGE_PATH,
  PUSH_ENROLL_PATH,
  PUSH_SEND_PATH,
  safeEqualStrings,
  sha256Base64Url,
} from 'dsh-remote-protocol';
import {
  HUB_BODY_LIMIT_BYTES,
  HUB_DEFAULT_CREDENTIAL_TTL_DAYS,
  HUB_DEFAULT_ENROLL_CHALLENGE_TTL_SECONDS,
  HUB_DEFAULT_ENROLL_ENABLED,
  HUB_DEFAULT_LISTEN_HOST,
  HUB_LIMIT_DEFAULTS,
  createConsoleLogger,
  readHubTlsMaterial,
  redactSecrets,
} from './config.js';
import { HUB_ERROR, errorPayload, statusForError } from './errors.js';
import { HUB_LIMIT_WINDOWS, RateLimitSet, SlidingWindowLimiter, retryAfterSeconds } from './limits.js';
import { issueDeviceCredential, loadOrCreateSigningKey, verifyCredential } from './credential.js';
import {
  ChallengeStore,
  constantTimeEquals,
  validateChallengeRequest,
  validateEnrollRequest,
  verifyEnrollSignature,
} from './enroll.js';
import { HUB_PUSH_KINDS, sendPushNotifications, validateDevicePushRequest } from './push.js';

/** 推送路由（协议常量，App/主机插件共用）。 */
export const HUB_PUSH_PATH = PUSH_SEND_PATH;
/** 设备登记路由（R2）。 */
export const HUB_ENROLL_CHALLENGE_PATH = PUSH_ENROLL_CHALLENGE_PATH;
export const HUB_ENROLL_PATH = PUSH_ENROLL_PATH;
/** 健康检查路由（容器 HEALTHCHECK / 监控用，不含敏感信息）。 */
export const HUB_HEALTH_PATH = '/healthz';

// 方便工具/测试直接从本文件 import（index.js 也是同一组导出）。
export { HUB_ERROR, errorPayload, statusForError };
export { SlidingWindowLimiter, RateLimitSet, retryAfterSeconds };
export { HUB_PUSH_KINDS };

/** device 推送限流各层的可读名（用于 429 message）。 */
const PUSH_LIMIT_LABELS = Object.freeze({
  token: 'device token per minute',
  tokenDay: 'device token per day',
  credential: 'credential per minute',
  host: 'host per minute',
  ip: 'client IP per minute',
  global: 'hub-wide per minute',
});

/**
 * 构造 APNs client（私钥只在这里读取一次；失败不打印密钥内容）。
 * @param {object} apnsConfig 规范化后的 config.apns
 * @param {any} logger
 * @returns {ReturnType<typeof createApnsClient> | null}
 */
function buildApnsClient(apnsConfig, logger) {
  if (!apnsConfig || apnsConfig.configured !== true) return null;
  /** @type {Record<string, any>} */
  const clientOptions = {
    keyId: apnsConfig.keyId,
    teamId: apnsConfig.teamId,
    topic: apnsConfig.topic,
    // hub 是官方 App 的推送入口：development/production 由设备登记（enroll）时上报，按条目 environment 走。
    environment: 'auto',
  };
  if (apnsConfig.keyFile) clientOptions.keyFile = apnsConfig.keyFile;
  if (apnsConfig.privateKey) {
    try {
      clientOptions.privateKey = createPrivateKey(apnsConfig.privateKey);
    } catch {
      logger.error('apns: 内联私钥无法解析（apns.privateKey 需为 PKCS#8 EC P-256 PEM）；推送将返回 503');
      return null;
    }
  }
  const client = createApnsClient(clientOptions);
  if (!client.isConfigured()) {
    logger.error(`apns: 未就绪（${redactSecrets(client.error || '配置不完整')}）；/v1/push 将返回 503 push_unavailable`);
  } else {
    logger.info(`apns: ready（topic=${apnsConfig.topic}）`);
  }
  return client;
}

/**
 * 从请求头取 Bearer token（不读查询参数 / 自定义头）。
 * @param {import('node:http').IncomingMessage} req
 * @returns {string}
 */
function bearerToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : '';
}

/**
 * 客户端来源地址（只用于限流分桶，不作为身份；反向代理后通常是回环地址）。
 * @param {import('node:http').IncomingMessage} req
 * @returns {string}
 */
function remoteAddress(req) {
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'unknown';
}

/**
 * 创建官方推送 hub 服务（不立即监听；调用 listen() 才绑定端口）。
 *
 * @param {object} options
 * @param {object} options.config 已规范化的配置（createHubConfig / loadHubConfig 的返回值）
 * @param {any} [options.logger] 默认按 config.logLevel 输出 console
 * @param {object} [options.apnsClient] 测试注入：{ isConfigured(), sendToTokens(entries, message) }
 * @param {() => number} [options.now] 测试注入时钟（challenge TTL / 限流窗口 / credential exp）
 * @returns {{
 *   config: object,
 *   listen: (port?: number) => Promise<{host: string, port: number, url: string, tls: boolean}>,
 *   close: () => Promise<void>,
 *   address: () => {host: string, port: number, url: string, tls: boolean} | null,
 *   health: () => object,
 * }}
 */
export function createHubServer(options = {}) {
  const config = options.config;
  if (!config || typeof config !== 'object') {
    throw new Error('createHubServer 需要规范化配置（请先用 createHubConfig/loadHubConfig）');
  }
  /** 合并默认值，兼容旧配置对象（缺 limits 字段时也能跑）。 */
  const limits = { ...HUB_LIMIT_DEFAULTS, ...((config.limits && typeof config.limits === 'object') ? config.limits : {}) };
  const listenHost = config.listenHost ?? HUB_DEFAULT_LISTEN_HOST;
  const logger = options.logger ?? createConsoleLogger(config.logLevel ?? 'info', 'push-hub');
  const apns = options.apnsClient !== undefined ? options.apnsClient : buildApnsClient(config.apns, logger);
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const apnsTopic = config.apns && config.apns.configured === true ? config.apns.topic : '';
  const publicUrl = typeof config.publicUrl === 'string' ? config.publicUrl : '';
  const ttlDays = config.credential && Number.isInteger(config.credential.ttlDays)
    ? config.credential.ttlDays
    : HUB_DEFAULT_CREDENTIAL_TTL_DAYS;
  const enrollConfig = config.enroll && typeof config.enroll === 'object'
    ? config.enroll
    : { enabled: HUB_DEFAULT_ENROLL_ENABLED, challengeTtlSeconds: HUB_DEFAULT_ENROLL_CHALLENGE_TTL_SECONDS };
  const challengeTtlSeconds = Number.isInteger(enrollConfig.challengeTtlSeconds)
    ? enrollConfig.challengeTtlSeconds
    : HUB_DEFAULT_ENROLL_CHALLENGE_TTL_SECONDS;

  // ── R2（官方 App ↔ hub 设备直连）可用性 ────────────────────────────────────
  // 只有配置了 HUB_PUBLIC_URL（credential aud）+ APNs topic 时才启用。
  /** @type {ReturnType<typeof loadOrCreateSigningKey> | null} */
  let signing = null;
  let r2DisabledReason = '';
  if (publicUrl === '') {
    r2DisabledReason = 'HUB_PUBLIC_URL 未配置';
    logger.info('R2: HUB_PUBLIC_URL 未配置，设备直连/enroll 未启用');
  } else if (apnsTopic === '') {
    r2DisabledReason = 'APNs 未配置（缺 apns.topic），无法校验 bundleId';
    logger.error(`R2: HUB_PUBLIC_URL 已设置但 ${r2DisabledReason}；设备直连/enroll 不可用`);
  } else {
    try {
      signing = loadOrCreateSigningKey(config.signingKeyFile, { logger });
    } catch (error) {
      r2DisabledReason = error && error.message ? error.message : String(error);
      logger.error(`R2: 签名 key 不可用（${redactSecrets(r2DisabledReason)}）；设备直连/enroll 已禁用`);
    }
  }
  const credentialEnabled = Boolean(signing);
  const enrollEnabled = credentialEnabled && enrollConfig.enabled !== false;
  if (credentialEnabled) {
    logger.info(`R2: 设备直连已启用（aud=${publicUrl} topic=${apnsTopic} ttlDays=${ttlDays} kid=${signing?.kid ?? '-'}）`);
  }

  // ── 限流（全部层级；契约 §4.5）────────────────────────────────────────────
  /** @param {number} limit @param {number} windowMs */
  const makeLimiter = (limit, windowMs) => new SlidingWindowLimiter({ limit, windowMs, now });
  const limiters = {
    // enroll / challenge
    enrollIp: makeLimiter(limits.enrollPerHourPerIp, HUB_LIMIT_WINDOWS.hour),
    enrollDevice: makeLimiter(limits.enrollPerHourPerDevice, HUB_LIMIT_WINDOWS.hour),
    challengeIp: makeLimiter(limits.challengePerHourPerIp, HUB_LIMIT_WINDOWS.hour),
    // device push（R2）
    pushToken: makeLimiter(limits.pushPerMinutePerToken, HUB_LIMIT_WINDOWS.minute),
    pushTokenDay: makeLimiter(limits.pushPerDayPerToken, HUB_LIMIT_WINDOWS.day),
    pushCredential: makeLimiter(limits.pushPerMinutePerCredential, HUB_LIMIT_WINDOWS.minute),
    pushHost: makeLimiter(limits.pushPerMinutePerHost, HUB_LIMIT_WINDOWS.minute),
    pushIp: makeLimiter(limits.pushPerMinutePerIp, HUB_LIMIT_WINDOWS.minute),
    pushGlobal: makeLimiter(limits.pushPerMinuteGlobal, HUB_LIMIT_WINDOWS.minute),
  };
  const devicePushLimits = new RateLimitSet({
    token: limiters.pushToken,
    tokenDay: limiters.pushTokenDay,
    credential: limiters.pushCredential,
    host: limiters.pushHost,
    ip: limiters.pushIp,
    global: limiters.pushGlobal,
  });
  const challengeStore = new ChallengeStore({ ttlMs: challengeTtlSeconds * 1000, now });

  /** @type {import('node:http').Server | null} */
  let server = null;
  /** @type {{host: string, port: number, url: string, tls: boolean} | null} */
  let serverInfo = null;

  /** APNs 是否可用（healthz / 503 判定都走这里）。 */
  function isApnsConfigured() {
    if (!apns) return false;
    return typeof apns.isConfigured === 'function' ? Boolean(apns.isConfigured()) : true;
  }

  /**
   * @param {import('node:http').ServerResponse} res
   * @param {number} status
   * @param {any} body
   * @param {Record<string, string>} [extraHeaders]
   */
  function sendJson(res, status, body, extraHeaders = {}) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-length': Buffer.byteLength(payload),
      ...extraHeaders,
    });
    res.end(payload);
  }

  /**
   * 统一的 429 响应（带 Retry-After 秒数）。
   * @param {import('node:http').ServerResponse} res
   * @param {number} retryAfterMs
   * @param {string} message
   */
  function sendRateLimited(res, retryAfterMs, message) {
    const seconds = retryAfterSeconds(retryAfterMs);
    sendJson(res, 429, errorPayload(HUB_ERROR.RATE_LIMITED, message), { 'retry-after': String(seconds) });
    return seconds;
  }

  /**
   * 读请求体（上限 limit 字节）。超限抛 status=413；非法 JSON 抛 status=400。
   * 超限后仍继续把剩余数据读掉（上限 drain 保护的 64 倍），保证还能回一个 413。
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {number} limit
   * @returns {Promise<unknown>}
   */
  async function readBody(req, limit) {
    const chunks = [];
    let total = 0;
    let exceeded = false;
    const drainCap = limit * 64;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > limit) exceeded = true;
      if (!exceeded) chunks.push(chunk);
      if (total > drainCap) break;
    }
    if (exceeded) {
      throw Object.assign(new Error(`request body exceeds ${limit} bytes`), { status: 413 });
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (text.trim() === '') throw Object.assign(new Error('request body must be a JSON object'), { status: 400 });
    try {
      return JSON.parse(text);
    } catch {
      throw Object.assign(new Error('request body must be valid JSON'), { status: 400 });
    }
  }

  /**
   * 读 body；失败时直接回 400/413 并返回 null（调用方 return）。
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {string} scope 日志里的作用域
   * @returns {Promise<{ok: true, body: unknown} | {ok: false}>}
   */
  async function readBodyOrRespond(req, res, scope) {
    try {
      return { ok: true, body: await readBody(req, HUB_BODY_LIMIT_BYTES) };
    } catch (error) {
      const status = error && Number.isInteger(error.status) ? error.status : 400;
      const message = redactSecrets(error && error.message ? error.message : 'invalid request body');
      logger.warn(`${scope}: invalid request body: ${message}`);
      sendJson(res, status, errorPayload(HUB_ERROR.INVALID_REQUEST, message), status === 413 ? { connection: 'close' } : {});
      return { ok: false };
    }
  }

  /** /healthz body：能力/配额摘要；不含 token/密钥/credential/路径。 */
  function health() {
    return {
      ok: true,
      apns: { configured: isApnsConfigured(), topic: config.apns ? config.apns.topic : '' },
      credential: { enabled: credentialEnabled, ttlDays },
      enroll: { enabled: enrollEnabled },
      limits: { ...limits },
    };
  }

  /**
   * 发送 APNs 结果的后处理：日志 + 归一化（device credential 推送用）。
   * @param {string} scope 日志前缀
   * @param {{kind: string, host: string, title?: string, body?: string,
   *   entries: Array<{deviceId: string, token: string, environment: string}>}} input
   * @returns {Promise<{ok: true, delivered: number, failed: number, pruned: string[]}
   *   | {ok: false, reason: 'not-configured' | 'error'}>}
   */
  async function dispatchPush(scope, { kind, host, title = '', body = '', sessionId = '', entries }) {
    if (!isApnsConfigured()) {
      logger.error(`${scope}: APNs not configured on this hub; rejecting push (503)`);
      return { ok: false, reason: 'not-configured' };
    }
    const startedAt = Date.now();
    let result;
    try {
      result = await sendPushNotifications(apns, { kind, host, title, body, sessionId, entries });
    } catch (error) {
      // 异常文本可能带任意内容，日志前统一脱敏；响应只给稳定错误码。
      logger.error(`${scope}: apns call failed: ${redactSecrets(error && error.message)}`);
      return { ok: false, reason: 'error' };
    }
    if (result.skipped === 'not-configured') {
      logger.error(`${scope}: apns client reported not-configured; rejecting push (503)`);
      return { ok: false, reason: 'not-configured' };
    }
    const elapsedMs = Date.now() - startedAt;
    logger.info(
      `${scope}: kind=${kind} tokens=${entries.length} delivered=${result.delivered}`
      + ` failed=${result.failed} pruned=${result.pruned.length} ms=${elapsedMs}`,
    );
    if (result.configErrors.length > 0) {
      logger.warn(`${scope}: apns config error(s): ${redactSecrets(result.configErrors.join(', '))}（检查 topic/key/team/environment）`);
    }
    if (result.errors.length > 0) {
      const reasons = result.errors.map((entry) => (entry && entry.reason ? entry.reason : 'unknown')).slice(0, 3);
      logger.warn(`${scope}: apns failure(s): ${redactSecrets(reasons.join('; '))}`);
    }
    return {
      ok: true,
      delivered: result.delivered,
      failed: result.failed,
      pruned: result.pruned,
    };
  }

  // ── POST /v1/enroll/challenge（R2）─────────────────────────────────────────
  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function handleEnrollChallenge(req, res) {
    if (!enrollEnabled) {
      logger.warn('enroll: challenge rejected (enroll disabled)');
      req.resume();
      sendJson(res, 503, errorPayload(HUB_ERROR.ENROLL_DISABLED, `device enrollment is disabled on this hub${r2DisabledReason ? ` (${r2DisabledReason})` : ''}`));
      return;
    }
    const ip = remoteAddress(req);
    const ipQuota = limiters.challengeIp.take(ip);
    if (!ipQuota.allowed) {
      const seconds = sendRateLimited(res, ipQuota.retryAfterMs, 'too many enroll challenges from this client (per IP per hour)');
      logger.warn(`enroll: challenge rate limited by IP (retry after ${seconds}s)`);
      req.resume();
      return;
    }
    const bodyResult = await readBodyOrRespond(req, res, 'enroll');
    if (!bodyResult.ok) return;
    const validated = validateChallengeRequest(bodyResult.body);
    if (!validated.ok) {
      logger.warn(`enroll: invalid challenge request: ${validated.message}`);
      sendJson(res, 400, errorPayload(HUB_ERROR.INVALID_REQUEST, validated.message));
      return;
    }
    let challenge;
    try {
      challenge = challengeStore.issue(validated.devicePublicKey);
    } catch (error) {
      if (error && error.code === 'rate_limited') {
        sendRateLimited(res, HUB_LIMIT_WINDOWS.hour, 'too many pending enroll challenges on this hub');
        return;
      }
      throw error;
    }
    logger.debug?.('enroll: challenge issued');
    sendJson(res, 200, {
      ok: true,
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      expiresAt: challenge.expiresAt,
    });
  }

  // ── POST /v1/enroll（R2）───────────────────────────────────────────────────
  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function handleEnroll(req, res) {
    if (!enrollEnabled) {
      logger.warn('enroll: rejected (enroll disabled)');
      req.resume();
      sendJson(res, 503, errorPayload(HUB_ERROR.ENROLL_DISABLED, `device enrollment is disabled on this hub${r2DisabledReason ? ` (${r2DisabledReason})` : ''}`));
      return;
    }
    const ip = remoteAddress(req);
    // 契约顺序：先 IP 限速，再 tokenHash 限速，最后字段/挑战/签名。
    const ipQuota = limiters.enrollIp.take(ip);
    if (!ipQuota.allowed) {
      const seconds = sendRateLimited(res, ipQuota.retryAfterMs, 'too many enroll requests from this client (per IP per hour)');
      logger.warn(`enroll: rate limited by IP (retry after ${seconds}s)`);
      req.resume();
      return;
    }
    const bodyResult = await readBodyOrRespond(req, res, 'enroll');
    if (!bodyResult.ok) return;
    const rawBody = bodyResult.body;
    const rawToken = rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody) && typeof rawBody.token === 'string'
      ? rawBody.token
      : '';
    const tokenHash = sha256Base64Url(rawToken);
    const deviceQuota = limiters.enrollDevice.take(tokenHash);
    if (!deviceQuota.allowed) {
      const seconds = sendRateLimited(res, deviceQuota.retryAfterMs, 'too many enroll requests for this device token (per hour)');
      logger.warn(`enroll: rate limited by device token (retry after ${seconds}s)`);
      return;
    }
    const validated = validateEnrollRequest(rawBody);
    if (!validated.ok) {
      logger.warn(`enroll: invalid request: ${validated.message}`);
      sendJson(res, 400, errorPayload(HUB_ERROR.INVALID_REQUEST, validated.message));
      return;
    }
    const fields = validated.fields;

    // 挑战：存在、未使用、未过期、nonce 常量时间一致。
    const challenge = challengeStore.lookup(fields.challengeId);
    if (challenge.status === 'used') {
      logger.warn('enroll: challenge already used');
      sendJson(res, 400, errorPayload(HUB_ERROR.CHALLENGE_USED, 'enroll challenge has already been used; request a new one'));
      return;
    }
    if (challenge.status === 'expired') {
      logger.warn('enroll: challenge expired or unknown');
      sendJson(res, 400, errorPayload(HUB_ERROR.CHALLENGE_EXPIRED, 'enroll challenge expired or unknown; request a new one'));
      return;
    }
    if (!constantTimeEquals(challenge.nonce, fields.nonce)) {
      logger.warn('enroll: nonce mismatch');
      sendJson(res, 400, errorPayload(HUB_ERROR.INVALID_SIGNATURE, 'enroll nonce does not match the challenge'));
      return;
    }
    if (!verifyEnrollSignature(fields)) {
      logger.warn('enroll: device signature verification failed');
      sendJson(res, 400, errorPayload(HUB_ERROR.INVALID_SIGNATURE, 'device signature verification failed'));
      return;
    }
    if (fields.bundleId !== apnsTopic) {
      logger.warn('enroll: unsupported bundle id');
      sendJson(res, 400, errorPayload(HUB_ERROR.UNSUPPORTED_BUNDLE_ID, 'bundleId is not the official bundle id of this hub'));
      return;
    }
    if (!signing) {
      // 理论上 enrollEnabled=false 已拦截；防御性兜底。
      sendJson(res, 503, errorPayload(HUB_ERROR.ENROLL_DISABLED, 'device enrollment is disabled on this hub'));
      return;
    }

    challengeStore.consume(fields.challengeId);
    const issued = issueDeviceCredential({
      privateKey: signing.privateKey,
      kid: signing.kid,
      audience: publicUrl,
      ttlDays,
      tokenHash,
      environment: fields.environment,
      bundleId: fields.bundleId,
      hostId: fields.hostId,
      now,
    });
    logger.info(
      `enroll: credential issued（hostId=${fields.hostId || '-'} env=${fields.environment}`
      + ` ttlDays=${ttlDays} exp=${new Date(issued.expiresAt).toISOString()}）`,
    );
    sendJson(res, 200, {
      ok: true,
      credential: issued.credential,
      expiresAt: issued.expiresAt,
      hub: { endpoint: publicUrl, topic: apnsTopic },
    });
  }

  // ── POST /v1/push：device credential（主机直连）─────────────────────────────
  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {string} credential
   */
  async function handleDevicePush(req, res, credential) {
    if (!credentialEnabled || !signing) {
      logger.warn('push: device credential rejected (R2 disabled)');
      req.resume();
      sendJson(res, 503, errorPayload(HUB_ERROR.PUSH_UNAVAILABLE, `device credential push is not enabled on this hub${r2DisabledReason ? ` (${r2DisabledReason})` : ''}`));
      return;
    }
    const verified = verifyCredential({
      publicKey: signing.publicKey,
      credential,
      audience: publicUrl,
      bundleId: apnsTopic,
      now,
    });
    if (!verified.ok) {
      logger.warn(`push: rejected device credential (${verified.code})`);
      req.resume();
      sendJson(res, statusForError(verified.code), errorPayload(verified.code, verified.message));
      return;
    }
    const claims = verified.claims;

    const bodyResult = await readBodyOrRespond(req, res, 'push: mode=device');
    if (!bodyResult.ok) return;
    const validated = validateDevicePushRequest(bodyResult.body);
    if (!validated.ok) {
      logger.warn(`push: mode=device invalid request: ${validated.message}`);
      sendJson(res, 400, errorPayload(HUB_ERROR.INVALID_REQUEST, validated.message));
      return;
    }
    // token 必须与 credential 绑定（常量时间比较）。
    if (!safeEqualStrings(sha256Base64Url(validated.token), claims.tokenHash)) {
      logger.warn('push: mode=device token does not match credential');
      sendJson(res, 401, errorPayload(HUB_ERROR.TOKEN_MISMATCH, 'token does not match the device credential'));
      return;
    }
    if (validated.environment !== '' && validated.environment !== claims.env) {
      logger.warn('push: mode=device environment does not match credential');
      sendJson(res, 400, errorPayload(HUB_ERROR.INVALID_REQUEST, 'environment does not match the device credential'));
      return;
    }

    // 限流（契约 §4.3：每 token 分钟/天、每 credential、每 host、每 IP、全局）。
    const hostKey = validated.host === '' ? 'unknown' : validated.host.toLowerCase();
    const quota = devicePushLimits.take([
      ['token', claims.tokenHash],
      ['tokenDay', claims.tokenHash],
      ['credential', claims.jti],
      ['host', hostKey],
      ['ip', remoteAddress(req)],
      ['global', '*'],
    ]);
    if (!quota.allowed) {
      const label = PUSH_LIMIT_LABELS[quota.blockedBy] ?? 'rate limit';
      const seconds = sendRateLimited(res, quota.retryAfterMs, `rate limit exceeded: ${label}`);
      logger.warn(`push: mode=device rate limited by ${quota.blockedBy} (retry after ${seconds}s)`);
      return;
    }

    const entries = [{ deviceId: '0', token: validated.token, environment: claims.env }];
    const result = await dispatchPush('push: mode=device', {
      kind: validated.kind,
      host: validated.host,
      title: validated.title,
      body: validated.body,
      sessionId: validated.sessionId,
      entries,
    });
    if (!result.ok) {
      if (result.reason === 'not-configured') {
        sendJson(res, 503, errorPayload(HUB_ERROR.PUSH_UNAVAILABLE, 'APNs is not configured on this hub'));
      } else {
        sendJson(res, 500, errorPayload(HUB_ERROR.INTERNAL, 'internal error'));
      }
      return;
    }
    sendJson(res, 200, {
      ok: true,
      delivered: result.delivered,
      failed: result.failed,
      pruned: result.pruned,
      mode: 'device',
    });
  }

  /**
   * POST /v1/push 入口：只接受 device credential。
   *
   * 缺 Bearer 或 Bearer 不是合法 device credential（含三段式 JWT 以外的任何形态，例如
   * 旧式 relay token）→ 401 `invalid_credential`（hub 不识别任何 relay 凭据）。
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function handlePush(req, res) {
    const bearer = bearerToken(req);
    if (bearer === '') {
      logger.warn('push: rejected request without device credential');
      req.resume();
      sendJson(res, 401, errorPayload(HUB_ERROR.INVALID_CREDENTIAL, 'missing bearer device credential'));
      return;
    }
    await handleDevicePush(req, res, bearer);
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function handleRequest(req, res) {
    let pathname = '/';
    try {
      pathname = new URL(req.url ?? '/', 'http://hub.invalid').pathname;
    } catch {
      pathname = req.url ?? '/';
    }
    const method = req.method ?? 'GET';
    try {
      if (pathname === HUB_HEALTH_PATH) {
        if (method !== 'GET' && method !== 'HEAD') {
          sendJson(res, 405, errorPayload(HUB_ERROR.METHOD_NOT_ALLOWED, 'use GET /healthz'), { allow: 'GET, HEAD' });
          return;
        }
        sendJson(res, 200, health());
        return;
      }
      /** @type {Array<[string, (req: any, res: any) => Promise<void> | void]>} */
      const postRoutes = [
        [HUB_PUSH_PATH, handlePush],
        [HUB_ENROLL_CHALLENGE_PATH, handleEnrollChallenge],
        [HUB_ENROLL_PATH, handleEnroll],
      ];
      for (const [route, handler] of postRoutes) {
        if (pathname !== route) continue;
        if (method !== 'POST') {
          sendJson(res, 405, errorPayload(HUB_ERROR.METHOD_NOT_ALLOWED, `use POST ${route}`), { allow: 'POST' });
          return;
        }
        await handler(req, res);
        return;
      }
      sendJson(res, 404, errorPayload(HUB_ERROR.NOT_FOUND, 'not found'));
    } catch (error) {
      logger.error(`request ${method} ${pathname} failed: ${redactSecrets(error && error.message)}`);
      if (!res.headersSent) sendJson(res, 500, errorPayload(HUB_ERROR.INTERNAL, 'internal error'));
      else res.destroy();
    }
  }

  /** IP 监听地址 → 可点击 URL 里的 host（通配地址显示为回环，日志用）。 */
  function hostForUrl(host) {
    if (host === '0.0.0.0' || host === '') return '127.0.0.1';
    if (host === '::' || host === '[::]') return '[::1]';
    return host.includes(':') ? `[${host}]` : host;
  }

  /**
   * 开始监听（port 省略时用 config.port；0 = 系统分配临时端口，测试用）。
   * @param {number} [port]
   * @returns {Promise<{host: string, port: number, url: string, tls: boolean}>}
   */
  async function listen(port) {
    if (server) throw new Error('hub server is already listening');
    const tlsMaterial = readHubTlsMaterial(config.tls);
    const requestHandler = (req, res) => { void handleRequest(req, res); };
    const created = tlsMaterial
      ? createHttpsServer({ cert: tlsMaterial.cert, key: tlsMaterial.key }, requestHandler)
      : createHttpServer(requestHandler);
    created.requestTimeout = 30_000;
    created.headersTimeout = 10_000;
    created.keepAliveTimeout = 5_000;
    const targetPort = port === undefined ? config.port : Number(port);
    await new Promise((resolvePromise, reject) => {
      const onError = (error) => {
        created.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        created.off('error', onError);
        resolvePromise();
      };
      created.once('error', onError);
      created.once('listening', onListening);
      created.listen(targetPort, listenHost);
    });
    server = created;
    const bound = created.address();
    const actualPort = bound && typeof bound === 'object' ? bound.port : targetPort;
    const scheme = tlsMaterial ? 'https' : 'http';
    serverInfo = {
      host: listenHost,
      port: actualPort,
      url: `${scheme}://${hostForUrl(listenHost)}:${actualPort}`,
      tls: Boolean(tlsMaterial),
    };
    logger.info(
      `listening ${serverInfo.url} (tls=${serverInfo.tls} apns=${isApnsConfigured() ? 'ready' : 'not-configured'}`
      + ` credential=${credentialEnabled ? 'enabled' : 'disabled'} enroll=${enrollEnabled ? 'enabled' : 'disabled'})`,
    );
    return serverInfo;
  }

  /** 停止监听（幂等）。 */
  async function close() {
    const current = server;
    if (!current) return;
    server = null;
    serverInfo = null;
    challengeStore.reset();
    await new Promise((resolvePromise) => current.close(() => resolvePromise()));
  }

  return {
    config,
    listen,
    close,
    address: () => serverInfo,
    /** /healthz 的 body（测试可直接断言；HTTP 契约相同）。 */
    health,
  };
}
