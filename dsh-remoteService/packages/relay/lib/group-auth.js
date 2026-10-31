/**
 * 群体服务版设备会话鉴权（P1 切片 3）。
 *
 * 链路：
 *   1. 设备配对后，主机把 `{deviceId, publicKey(P-256 未压缩点 base64url)}` 同步到 relay
 *      （控制消息 device.sync / device.revoke，主机重连后重新全量同步）。
 *   2. 设备向 relay 边缘（HTTPS，`<hostId>.<domain>`）请求 challenge，用设备私钥签
 *      `hostId\ndeviceId\nnonce` 换短时 token（Ed25519 签名，默认 15 分钟）。
 *   3. 设备把 token 放进 `__Host-dsh_session` cookie；relay 边缘逐连接校验（签名/过期/hostId/设备未撤销），
 *      通过后才开隧道；主机侧可用 relay 公钥逐请求复验（协议库 `verifyGroupSessionToken`）。
 *
 * 安全约定（对应 docs/group-service-design.zh.md §7/§10）：
 *   - 身份只来自「设备私钥签名的 challenge + relay 签名的 token」，不来自 IP/头/localhost；
 *   - token 只由 relay 的 Ed25519 私钥签，主机持公钥可离线逐请求校验；
 *   - challenge 一次性、2 分钟过期；每 IP 限速；设备撤销后 token 立即失效（relay 侧再查注册表）。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import {
  GROUP_AUTH_CHALLENGE_PATH,
  GROUP_AUTH_TOKEN_PATH,
  GROUP_CHALLENGE_DEFAULT_TTL_MS,
  GROUP_SESSION_COOKIE,
  GROUP_SESSION_DEFAULT_TTL_MS,
  groupDeviceChallengeMessage,
  isValidGroupDeviceId,
  newGroupChallenge,
  parseCookieHeader,
  signGroupSessionToken,
  verifyGroupDeviceSignature,
  verifyGroupSessionToken,
} from 'dsh-remote-protocol';

const SIGNING_KEY_FILE_MODE = 0o600;
const SIGNING_KEY_DIR_MODE = 0o700;
const RATE_WINDOW_MS = 60_000;

/** 鉴权失败错误（带 HTTP 状态码/retry-after）。 */
export class GroupAuthError extends Error {
  /**
   * @param {string} code
   * @param {string} [message]
   * @param {{status?: number, retryAfterSec?: number}} [options]
   */
  constructor(code, message, options = {}) {
    super(message ?? code);
    this.name = 'GroupAuthError';
    this.code = code;
    this.status = options.status ?? 400;
    /** @type {number | undefined} */
    this.retryAfterSec = options.retryAfterSec;
  }
}

/**
 * 读取/生成 relay 的 Ed25519 token 签名密钥（PEM，0600）。
 * @param {string} file
 */
function ensureSigningKey(file) {
  const abs = resolve(file);
  if (existsSync(abs)) {
    const privateKeyPem = readFileSync(abs, 'utf8');
    const privateKey = createPrivateKey(privateKeyPem);
    return { privateKey, publicKeyPem: createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }) };
  }
  mkdirSync(dirname(abs), { recursive: true, mode: SIGNING_KEY_DIR_MODE });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  writeFileSync(abs, privateKeyPem, { mode: SIGNING_KEY_FILE_MODE });
  try {
    chmodSync(abs, SIGNING_KEY_FILE_MODE);
  } catch {
    /* 文件系统不支持时忽略（仍由 umask 保护） */
  }
  return { privateKey, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) };
}

/** 滚动窗口限速（单进程内存）。 */
class RateLimiter {
  /** @param {{maxPerWindow: number, now: () => number}} options */
  constructor({ maxPerWindow, now }) {
    this.maxPerWindow = maxPerWindow;
    this.now = now;
    /** @type {Map<string, number[]>} */
    this.hits = new Map();
  }

  /** 记录一次尝试；超限抛 RATE_LIMITED。 */
  hit(key) {
    const now = this.now();
    const cutoff = now - RATE_WINDOW_MS;
    const entries = (this.hits.get(String(key)) ?? []).filter((ts) => ts > cutoff);
    if (entries.length >= this.maxPerWindow) {
      const retryAfterSec = Math.max(1, Math.ceil((entries[0] + RATE_WINDOW_MS - now) / 1000));
      throw new GroupAuthError('rate_limited', 'too many authentication attempts', { status: 429, retryAfterSec });
    }
    entries.push(now);
    this.hits.set(String(key), entries);
  }
}

export class GroupAuthService {
  /**
   * @param {object} options
   * @param {string} options.groupFile group.json 路径（用于推导默认签名密钥路径）
   * @param {string} [options.signingKeyFile]
   * @param {number} [options.tokenTtlMs]
   * @param {number} [options.challengeTtlMs]
   * @param {number} [options.maxAttemptsPerMinutePerIp]
   * @param {any} [options.logger]
   * @param {() => number} [options.now]
   */
  constructor(options) {
    this.logger = options.logger ?? { debug() {}, info() {}, warn() {}, error() {} };
    this.now = options.now ?? (() => Date.now());
    this.tokenTtlMs = options.tokenTtlMs ?? GROUP_SESSION_DEFAULT_TTL_MS;
    this.challengeTtlMs = options.challengeTtlMs ?? GROUP_CHALLENGE_DEFAULT_TTL_MS;
    const signingKeyFile = options.signingKeyFile ?? `${dirname(resolve(options.groupFile))}/signing-key.pem`;
    const keys = ensureSigningKey(signingKeyFile);
    this.signingKeyFile = signingKeyFile;
    this.privateKey = keys.privateKey;

    /** @type {Map<string, Map<string, string>>} hostId → (deviceId → publicKey base64url) */
    this.devices = new Map();
    /** @type {Map<string, {hostId: string, deviceId: string, nonce: string, expiresAt: number}>} */
    this.challenges = new Map();
    this.limiter = new RateLimiter({
      maxPerWindow: options.maxAttemptsPerMinutePerIp ?? 30,
      now: this.now,
    });
  }

  /** relay token 签名公钥（PEM）；主机用它对每个请求离线校验 token。 */
  get publicKey() {
    return createPublicKey(this.privateKey).export({ type: 'spki', format: 'pem' });
  }

  /**
   * 覆盖式同步某台主机的设备列表（主机重连后重新同步）。
   * @param {string} hostId
   * @param {unknown} devices
   * @returns {number} 同步后的设备数
   */
  syncDevices(hostId, devices) {
    if (!Array.isArray(devices)) throw new GroupAuthError('invalid_devices', 'devices must be an array', { status: 400 });
    /** @type {Map<string, string>} */
    const next = new Map();
    for (const entry of devices) {
      if (!entry || typeof entry !== 'object') throw new GroupAuthError('invalid_devices', 'invalid device entry', { status: 400 });
      const deviceId = String(entry.deviceId ?? '');
      const publicKey = String(entry.publicKey ?? '');
      if (!isValidGroupDeviceId(deviceId)) throw new GroupAuthError('invalid_devices', `invalid deviceId: ${JSON.stringify(deviceId)}`, { status: 400 });
      const raw = Buffer.from(publicKey, 'base64url');
      if (raw.length !== 65 || raw[0] !== 0x04) {
        throw new GroupAuthError('invalid_devices', `device ${deviceId} publicKey must be an uncompressed P-256 point`, { status: 400 });
      }
      next.set(deviceId, publicKey);
    }
    this.devices.set(hostId, next);
    return next.size;
  }

  /**
   * 撤销单台设备（配对解除/丢手机）。
   * @param {string} hostId
   * @param {string} deviceId
   * @returns {boolean}
   */
  revokeDevice(hostId, deviceId) {
    const map = this.devices.get(hostId);
    if (!map) return false;
    return map.delete(String(deviceId));
  }

  /** 主机离线时清理其设备注册（重连后会重新同步）。 */
  clearHost(hostId) {
    this.devices.delete(hostId);
    for (const [key, challenge] of this.challenges) {
      if (challenge.hostId === hostId) this.challenges.delete(key);
    }
  }

  /** @param {string} hostId @param {string} deviceId */
  getDevicePublicKey(hostId, deviceId) {
    return this.devices.get(hostId)?.get(String(deviceId));
  }

  /** @param {string} hostId @param {string} deviceId */
  hasDevice(hostId, deviceId) {
    return Boolean(this.getDevicePublicKey(hostId, deviceId));
  }

  /**
   * 校验会话 token（签名 + 过期 + hostId + 设备仍在注册表）。
   * @param {string} token
   * @param {string} hostId
   */
  verifySessionToken(token, hostId) {
    const payload = verifyGroupSessionToken({ token, publicKey: this.publicKey, hostId, now: this.now() });
    if (!payload) return undefined;
    if (!this.hasDevice(hostId, payload.deviceId)) return undefined;
    return payload;
  }

  /**
   * 从请求头 cookie 中取会话。
   * @param {Record<string, string>} headers
   * @param {string} hostId
   */
  sessionFromHeaders(headers, hostId) {
    const cookies = parseCookieHeader(headers?.cookie);
    const token = cookies[GROUP_SESSION_COOKIE];
    if (!token) return undefined;
    return this.verifySessionToken(token, hostId);
  }

  /**
   * 第一步：设备请求 challenge。
   * @param {{hostId: string, deviceId: string, clientKey: string}} input
   */
  challenge({ hostId, deviceId, clientKey }) {
    this.limiter.hit(clientKey);
    const id = String(deviceId ?? '');
    if (!isValidGroupDeviceId(id)) throw new GroupAuthError('invalid_request', 'invalid deviceId', { status: 400 });
    if (!this.hasDevice(hostId, id)) throw new GroupAuthError('unknown_device', 'device is not registered for this host', { status: 404 });
    const now = this.now();
    // 清理过期 challenge，避免 map 增长
    for (const [key, entry] of this.challenges) {
      if (entry.expiresAt <= now) this.challenges.delete(key);
    }
    const nonce = newGroupChallenge();
    const expiresAt = now + this.challengeTtlMs;
    // 同一设备允许多个未消费的 nonce：App 可能并发/重复请求 challenge，
    // 不能互相覆盖，否则 token 会因 nonce 不匹配而 401（诊断时实际遇到过）。
    this.challenges.set(`${hostId}\u0000${id}\u0000${nonce}`, { hostId, deviceId: id, nonce, expiresAt });
    return { ok: true, hostId, deviceId: id, nonce, expiresAt };
  }

  /**
   * 第二步：校验设备签名并签发短时 token。
   * @param {{hostId: string, deviceId: string, nonce: string, signature: string, clientKey: string}} input
   */
  issueToken({ hostId, deviceId, nonce, signature, clientKey }) {
    this.limiter.hit(clientKey);
    const id = String(deviceId ?? '');
    if (!isValidGroupDeviceId(id)) throw new GroupAuthError('invalid_request', 'invalid deviceId', { status: 400 });
    const publicKey = this.getDevicePublicKey(hostId, id);
    if (!publicKey) throw new GroupAuthError('unknown_device', 'device is not registered for this host', { status: 404 });
    const nonceKey = `${hostId}\u0000${id}\u0000${String(nonce ?? '')}`;
    const challenge = this.challenges.get(nonceKey);
    if (!challenge || challenge.nonce !== String(nonce ?? '') || challenge.expiresAt <= this.now()) {
      throw new GroupAuthError('auth_failed', 'challenge is missing, expired or mismatched', { status: 401 });
    }
    this.challenges.delete(nonceKey);
    const message = groupDeviceChallengeMessage(hostId, id, challenge.nonce);
    if (!verifyGroupDeviceSignature({ publicKey, message, signature: String(signature ?? '') })) {
      throw new GroupAuthError('auth_failed', 'invalid device signature', { status: 401 });
    }
    const { token, payload } = signGroupSessionToken({
      privateKey: this.privateKey,
      hostId,
      deviceId: id,
      iat: this.now(),
      ttlMs: this.tokenTtlMs,
    });
    return {
      ok: true,
      hostId,
      deviceId: id,
      token,
      expiresAt: payload.exp * 1000,
      setCookie: this.sessionCookie(token, payload.exp * 1000 - this.now()),
    };
  }

  /**
   * Set-Cookie 串：host-only、Secure、HttpOnly、SameSite=Strict（见 AGENTS 五.9）。
   * @param {string} token
   * @param {number} ttlMs
   */
  sessionCookie(token, ttlMs) {
    const maxAge = Math.max(1, Math.floor(ttlMs / 1000));
    return `${GROUP_SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
  }

  /**
   * 处理 relay 边缘上的鉴权请求（调用方已解析 HTTP head/body）。
   * @param {{hostId: string, method: string, path: string, body: any, clientKey: string}} input
   * @returns {{status: number, headers?: Record<string,string>, body: any}}
   */
  handleAuthRequest({ hostId, method, path, body, clientKey }) {
    try {
      if (method !== 'POST') return { status: 405, body: { ok: false, error: { code: 'method_not_allowed' } } };
      const payload = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
      if (path === GROUP_AUTH_CHALLENGE_PATH) {
        const result = this.challenge({
          hostId,
          deviceId: payload.deviceId,
          clientKey,
        });
        this.logger.info(`group auth: challenge issued host ${hostId} device ${result.deviceId}`);
        return { status: 200, body: result };
      }
      if (path === GROUP_AUTH_TOKEN_PATH) {
        const result = this.issueToken({
          hostId,
          deviceId: payload.deviceId,
          nonce: payload.nonce,
          signature: payload.signature,
          clientKey,
        });
        this.logger.info(`group auth: token issued host ${hostId} device ${result.deviceId}`);
        const { setCookie, ...rest } = result;
        return { status: 200, headers: { 'set-cookie': setCookie }, body: rest };
      }
      return { status: 404, body: { ok: false, error: { code: 'not_found' } } };
    } catch (err) {
      if (err instanceof GroupAuthError) {
        const headers = err.retryAfterSec ? { 'retry-after': String(err.retryAfterSec) } : undefined;
        return { status: err.status, headers, body: { ok: false, error: { code: err.code, message: err.message } } };
      }
      this.logger.error(`group auth: unexpected error: ${err && err.message ? err.message : String(err)}`);
      return { status: 500, body: { ok: false, error: { code: 'internal' } } };
    }
  }
}
