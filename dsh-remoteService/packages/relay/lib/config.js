/**
 * relay 配置校验/规范化（群体服务版，A 模式）。
 *
 * 0.3.0 起 relay 只服务「群体服务版」产品线：classic 单机盲中继（443 TLS 透传 /
 * 80 跳转 / tokens.json）已删除。本文件只保留群体版配置：
 *   - domain 合法（决定 <hostId>.<domain> 路由与 host.ready 回包）；
 *   - group.file 必填（邀请/主机注册表，0600）；
 *   - 生产必须提供控制面 TLS 证书，dev 模式才允许 ws:// 控制面；
 *   - group.edge（手机数据面）默认开启：必须提供覆盖 *.<domain> 的通配证书；
 *     只有显式 `"enabled": false` 才关闭（仅控制面/注册/后台，会打 warn）；
 *   - 端口允许 0（测试用临时端口），其余必须 0..65535 整数。
 *
 * 向后兼容：旧配置里的 classic 字段（mode/dataPort/tokensFile/hostTokens/push）
 * 会被**忽略并告警**，不再实现其行为；`mode` 只接受 "group"（classic 显式报错）。
 */

import { readFileSync } from 'node:fs';
import {
  GROUP_CHALLENGE_DEFAULT_TTL_MS,
  GROUP_DEFAULT_MOBILE_PORT,
  GROUP_PUSH_DEFAULT_COOLDOWN_SECONDS,
  GROUP_REGISTER_BODY_LIMIT_BYTES,
  GROUP_SESSION_DEFAULT_TTL_MS,
} from 'dsh-remote-protocol';

/** 默认端口/监听地址（控制面 + health；数据面只有 group.edge）。 */
export const RELAY_DEFAULTS = Object.freeze({
  controlPort: 8443,
  httpPort: 80,
  listenHost: '0.0.0.0',
});

/** 已删除的 classic 配置字段（只告警、不生效）。 */
const REMOVED_CLASSIC_FIELDS = Object.freeze([
  'dataPort',
  'tokensFile',
  'hostTokens',
  'push',
]);

/** 群体服务版配置默认值。 */
export const RELAY_GROUP_DEFAULTS = Object.freeze({
  mobilePort: GROUP_DEFAULT_MOBILE_PORT,
  maxHosts: 200,
  registration: Object.freeze({
    enabled: true,
    maxAttemptsPerMinutePerIp: 10,
    maxAttemptsPerMinute: 120,
    bodyLimitBytes: GROUP_REGISTER_BODY_LIMIT_BYTES,
  }),
  auth: Object.freeze({
    tokenTtlMs: GROUP_SESSION_DEFAULT_TTL_MS,
    challengeTtlMs: GROUP_CHALLENGE_DEFAULT_TTL_MS,
    maxAttemptsPerMinutePerIp: 30,
  }),
  /** 服务端集中推送（默认关闭；R2 起只有 self：部署方 APNs key 直连 Apple）。 */
  push: Object.freeze({
    enabled: false,
    mode: 'self',
    content: 'generic',
    cooldownSeconds: GROUP_PUSH_DEFAULT_COOLDOWN_SECONDS,
  }),
});

/** 内部定时器默认值（不作为公开契约；测试可覆盖以缩短等待）。 */
export const RELAY_TIMINGS = Object.freeze({
  handshakeTimeoutMs: 10_000,
  heartbeatIntervalMs: 10_000,
  heartbeatTimeoutMs: 30_000,
  openTimeoutMs: 20_000,
});

/** 边缘连接限制默认值（DoS 兜底；不替代主机侧设备鉴权）。 */
export const RELAY_LIMIT_DEFAULTS = Object.freeze({
  maxConnectionsPerIp: 64,
  maxEdgeConnections: 1024,
});

const DOMAIN_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error', 'silent']);

/**
 * 校验并规范化 relay domain（小写、去尾点、逐标签校验）。
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeDomain(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('relay config requires "domain", e.g. "relay.example.com" (or pass --domain)');
  }
  let domain = raw.trim().toLowerCase();
  if (domain.endsWith('.')) domain = domain.slice(0, -1);
  if (domain.length === 0 || domain.length > 253) throw new Error(`invalid relay domain: ${JSON.stringify(raw)}`);
  for (const label of domain.split('.')) {
    if (!DOMAIN_LABEL_RE.test(label)) throw new Error(`invalid relay domain label ${JSON.stringify(label)} in ${JSON.stringify(raw)}`);
  }
  return domain;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function normalizePort(value, name, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const port = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid ${name} ${JSON.stringify(value)}: expected integer 0..65535 (0 = ephemeral port)`);
  }
  return port;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @param {number} fallback
 * @param {number} min
 * @returns {number}
 */
function normalizeTiming(value, name, fallback, min = 10) {
  if (value === undefined || value === null || value === '') return fallback;
  const ms = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(ms) || ms < min) throw new Error(`invalid ${name} ${JSON.stringify(value)}: expected >= ${min} ms`);
  return ms;
}

/**
 * 规范化 TLS 配置：
 *   - {certFile, keyFile} 文件路径（生产推荐）
 *   - {cert, key} 内联 PEM（测试/嵌入式）
 * @param {unknown} raw
 * @returns {{certFile: string, keyFile: string} | {cert: Buffer, key: Buffer} | undefined}
 */
function normalizeTls(raw) {
  if (raw === undefined || raw === null || raw === false) return undefined;
  if (typeof raw !== 'object') throw new Error('tls must be an object like {"certFile":"...","keyFile":"..."}');
  if (raw.cert !== undefined || raw.key !== undefined) {
    if (!raw.cert || !raw.key) throw new Error('tls.cert and tls.key must both be provided');
    return { cert: Buffer.from(raw.cert), key: Buffer.from(raw.key) };
  }
  if (!raw.certFile || !raw.keyFile) {
    throw new Error('tls requires {"certFile":"...","keyFile":"..."} (control-plane WSS certificate)');
  }
  return { certFile: String(raw.certFile), keyFile: String(raw.keyFile) };
}

/**
 * 读取 TLS 材料（路径 → Buffer，内联 → Buffer）。
 * @param {{certFile: string, keyFile: string} | {cert: Buffer, key: Buffer} | undefined} tls
 * @returns {{cert: Buffer, key: Buffer} | undefined}
 */
export function readTlsMaterial(tls) {
  if (!tls) return undefined;
  if (tls.cert && tls.key) return tls;
  try {
    return { cert: readFileSync(tls.certFile), key: readFileSync(tls.keyFile) };
  } catch (err) {
    const detail = err && err.message ? err.message : String(err);
    throw new Error(`cannot load TLS certificate: ${detail}`);
  }
}

/**
 * 默认 console logger（带时间戳；不记录 token/内容）。
 * @param {'debug'|'info'|'warn'|'error'|'silent'} [level]
 * @param {string} [scope]
 */
export function createConsoleLogger(level = 'info', scope = 'relay') {
  const threshold = LOG_LEVELS.has(level) ? level : 'info';
  const order = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
  const emit = (kind, message) => {
    if (threshold === 'silent' || order[kind] < order[threshold]) return;
    const line = `${new Date().toISOString()} ${kind.toUpperCase()} ${scope}: ${message}`;
    if (kind === 'error' || kind === 'warn') console.error(line);
    else console.log(line);
  };
  return {
    debug: (message) => emit('debug', message),
    info: (message) => emit('info', message),
    warn: (message) => emit('warn', message),
    error: (message) => emit('error', message),
  };
}

/**
 * 0.3.0 起 relay 只服务群体版：旧配置里的 `mode` 只接受 "group"。
 * @param {unknown} raw
 * @returns {'group'}
 */
function normalizeMode(raw) {
  if (raw === undefined || raw === null || raw === '') return 'group';
  const mode = String(raw).trim().toLowerCase();
  if (mode === 'group') return 'group';
  throw new Error(
    `invalid mode ${JSON.stringify(raw)}: classic 单机模式已在 relay 0.3.0 删除，只支持 group（群体服务版）`,
  );
}

/** 内容策略 / APNs 环境取值（语义与 dsh-remote-protocol 常量一致）。 */
const PUSH_CONTENTS = new Set(['generic', 'summary']);
const PUSH_ENVIRONMENTS = new Set(['auto', 'development', 'production']);
/** R2 起唯一保留的推送通道：部署方自己的 APNs key（relay 直连 Apple）。 */
const PUSH_MODE = 'self';

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function optionalString(value) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text === '' ? undefined : text;
}

/**
 * 规范化/校验群体版服务端集中推送配置（`group.push`）。
 *
 * R2（0.4.0）起 relay 只做 **self** 推送：部署方自签 App 用自己的 APNs Auth Key，
 * 由 relay 直连 Apple。官方 App 的推送改为「App 向官方 hub 登记 → 主机直连 hub」，
 * 不经过 relay；因此 `mode` 只接受 `"self"`，`official` 及其他值在启动阶段直接报错。
 *
 * 启动阶段就校验（避免带病启动）：
 *   - `enabled=true` 时 self 必填 APNs key/keyId/teamId/topic；
 *   - cooldownSeconds 必须是 0..3600 整数；
 *   - 私钥文件**只记录路径、不读取内容**：首次实际推送时才读，失败给可操作错误。
 *
 * @param {unknown} raw
 */
function normalizePush(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? /** @type {Record<string, any>} */ (raw) : {};
  const enabled = input.enabled === true;

  const mode = optionalString(input.mode)?.toLowerCase() ?? PUSH_MODE;
  if (mode !== PUSH_MODE) {
    if (mode === 'official') {
      throw new Error(
        'group.push.mode="official" 已删除：R2 起官方 App 推送直连官方 hub（App 向 hub 登记、主机直连），relay 只做 self 推送',
      );
    }
    throw new Error(`invalid group.push.mode ${JSON.stringify(input.mode)}: 只支持 "self"（relay 用部署方自己的 APNs key 推送自签 App）`);
  }
  const content = optionalString(input.content)?.toLowerCase() ?? 'generic';
  if (!PUSH_CONTENTS.has(content)) {
    throw new Error(`invalid group.push.content ${JSON.stringify(input.content)}: expected "generic" or "summary"`);
  }
  const cooldownRaw = input.cooldownSeconds === undefined || input.cooldownSeconds === null || input.cooldownSeconds === ''
    ? RELAY_GROUP_DEFAULTS.push.cooldownSeconds
    : Number(input.cooldownSeconds);
  if (!Number.isInteger(cooldownRaw) || cooldownRaw < 0 || cooldownRaw > 3600) {
    throw new Error(`invalid group.push.cooldownSeconds ${JSON.stringify(input.cooldownSeconds)}: expected integer 0..3600 (seconds)`);
  }

  // self 模式（部署方自己的 APNs Auth Key；keyFile 只在首次推送时读取）。
  const selfInput = input.self && typeof input.self === 'object' && !Array.isArray(input.self)
    ? /** @type {Record<string, any>} */ (input.self)
    : {};
  const environment = optionalString(selfInput.environment)?.toLowerCase() ?? 'auto';
  if (!PUSH_ENVIRONMENTS.has(environment)) {
    throw new Error(`invalid group.push.self.environment ${JSON.stringify(selfInput.environment)}: expected "auto" | "development" | "production"`);
  }
  const self = {
    keyFile: optionalString(selfInput.keyFile),
    keyId: optionalString(selfInput.keyId),
    teamId: optionalString(selfInput.teamId),
    topic: optionalString(selfInput.topic),
    environment,
  };

  if (enabled && (!self.keyFile || !self.keyId || !self.teamId || !self.topic)) {
    throw new Error(
      'group.push.mode="self" 需要 group.push.self.{keyFile,keyId,teamId,topic}（APNs Auth Key / Key ID / Apple Team ID / bundle id）',
    );
  }

  return { enabled, mode: PUSH_MODE, content, cooldownSeconds: cooldownRaw, self };
}

/**
 * 规范化 group 配置（群体版唯一产品线；group.file 必填）。
 * @param {unknown} raw
 * @param {boolean} dev
 */
function normalizeGroup(raw, dev = false) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? /** @type {Record<string, any>} */ (raw) : {};
  const file = input.file === undefined || input.file === null || input.file === '' ? undefined : String(input.file);
  if (!file) {
    throw new Error('group relay requires group.file (group.json path; CLI default: <config dir>/group.json)');
  }
  const mobilePort = input.mobilePort === undefined ? RELAY_GROUP_DEFAULTS.mobilePort : Number(input.mobilePort);
  if (!Number.isInteger(mobilePort) || mobilePort < 1 || mobilePort > 65535) {
    throw new Error(`invalid group.mobilePort ${JSON.stringify(input.mobilePort)}: expected 1..65535`);
  }
  const maxHosts = input.maxHosts === undefined ? RELAY_GROUP_DEFAULTS.maxHosts : Number(input.maxHosts);
  if (!Number.isSafeInteger(maxHosts) || maxHosts < 1) throw new Error('group.maxHosts 必须是正整数');

  const regInput = input.registration && typeof input.registration === 'object' && !Array.isArray(input.registration)
    ? /** @type {Record<string, any>} */ (input.registration)
    : {};
  const defaults = RELAY_GROUP_DEFAULTS.registration;
  const perIp = regInput.maxAttemptsPerMinutePerIp === undefined ? defaults.maxAttemptsPerMinutePerIp : Number(regInput.maxAttemptsPerMinutePerIp);
  const global = regInput.maxAttemptsPerMinute === undefined ? defaults.maxAttemptsPerMinute : Number(regInput.maxAttemptsPerMinute);
  const bodyLimit = regInput.bodyLimitBytes === undefined ? defaults.bodyLimitBytes : Number(regInput.bodyLimitBytes);
  if (!Number.isSafeInteger(perIp) || perIp < 1) throw new Error('group.registration.maxAttemptsPerMinutePerIp 必须是正整数');
  if (!Number.isSafeInteger(global) || global < 1) throw new Error('group.registration.maxAttemptsPerMinute 必须是正整数');
  if (!Number.isSafeInteger(bodyLimit) || bodyLimit < 1024) throw new Error('group.registration.bodyLimitBytes 必须 >= 1024');

  // 群体版边缘 TLS（A 模式）：relay 终止手机 TLS，流的明文经控制面隧道转发到主机。
  // 这是本产品线唯一的数据面；部署产品时必须 enabled 且提供覆盖 *.<domain> 的通配证书。
  const edgeInput = input.edge && typeof input.edge === 'object' && !Array.isArray(input.edge)
    ? /** @type {Record<string, any>} */ (input.edge)
    : {};
  // 群体版 relay 的唯一数据面：默认**开启**（显式 false 才关闭，关闭时打 warn）。
  const edgeEnabled = edgeInput.enabled !== false;
  const edgeTls = normalizeTls(edgeInput.tls);
  if (edgeEnabled && !edgeTls) {
    throw new Error('group edge requires TLS: group.edge.tls = {"certFile","keyFile"} (通配证书) 或 {"cert","key"}');
  }
  const edgePort = edgeInput.port === undefined ? mobilePort : Number(edgeInput.port);
  if (!Number.isInteger(edgePort) || edgePort < 0 || edgePort > 65535) {
    throw new Error(`invalid group.edge.port ${JSON.stringify(edgeInput.port)}: expected 0..65535 (0 = ephemeral)`);
  }
  const allowUnauthenticated = edgeInput.allowUnauthenticated === true;
  if (edgeEnabled && allowUnauthenticated && !dev) {
    throw new Error('group.edge.allowUnauthenticated is dev-only (未认证边缘隧道不得用于生产)');
  }

  // 设备会话鉴权（短时 token / 签名密钥）。默认 15 分钟 token、2 分钟 challenge。
  const authInput = input.auth && typeof input.auth === 'object' && !Array.isArray(input.auth)
    ? /** @type {Record<string, any>} */ (input.auth)
    : {};
  const authDefaults = RELAY_GROUP_DEFAULTS.auth;
  const tokenTtlMs = authInput.tokenTtlMs === undefined ? authDefaults.tokenTtlMs : Number(authInput.tokenTtlMs);
  if (!Number.isSafeInteger(tokenTtlMs) || tokenTtlMs < 5_000 || tokenTtlMs > 2 * 60 * 60 * 1000) {
    throw new Error('group.auth.tokenTtlMs 必须是 5000..7200000 的整数（5 秒–2 小时；默认 15 分钟）');
  }
  const challengeTtlMs = authInput.challengeTtlMs === undefined ? authDefaults.challengeTtlMs : Number(authInput.challengeTtlMs);
  if (!Number.isSafeInteger(challengeTtlMs) || challengeTtlMs < 10_000 || challengeTtlMs > 10 * 60 * 1000) {
    throw new Error('group.auth.challengeTtlMs 必须是 10000..600000 的整数（10 秒–10 分钟）');
  }
  const maxAuthAttempts = authInput.maxAttemptsPerMinutePerIp === undefined
    ? authDefaults.maxAttemptsPerMinutePerIp
    : Number(authInput.maxAttemptsPerMinutePerIp);
  if (!Number.isSafeInteger(maxAuthAttempts) || maxAuthAttempts < 1) {
    throw new Error('group.auth.maxAttemptsPerMinutePerIp 必须是正整数');
  }
  const signingKeyFile = authInput.signingKeyFile === undefined || authInput.signingKeyFile === null || authInput.signingKeyFile === ''
    ? undefined
    : String(authInput.signingKeyFile);

  // 部署方后台（/__admin）：token 可显式配置，或首次启动自动生成到 group.json 同目录的 admin-token（0600）。
  const adminToken = input.adminToken === undefined || input.adminToken === null || input.adminToken === ''
    ? undefined
    : String(input.adminToken);
  const adminTokenFile = input.adminTokenFile === undefined || input.adminTokenFile === null || input.adminTokenFile === ''
    ? undefined
    : String(input.adminTokenFile);

  // 职责分离：控制面只做 WSS 隧道；注册 API 与部署方后台各自独立监听。
  // 不配置时保留「都挂在控制面」的行为（兼容旧部署 / 测试）。
  const optionalPort = (value, label) => {
    if (value === undefined || value === null || value === '') return undefined;
    const port = Number(value);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(`invalid group.${label} ${JSON.stringify(value)}: expected 0..65535 (0 = ephemeral)`);
    }
    return port;
  };
  const apiPort = optionalPort(input.apiPort, 'apiPort');
  const adminPort = optionalPort(input.adminPort, 'adminPort');
  const publicControlPort = optionalPort(input.publicControlPort, 'publicControlPort');
  const optionalBind = (value) => (value === undefined || value === null || value === '' ? undefined : String(value));
  const apiBind = optionalBind(input.apiBind);
  const adminBind = optionalBind(input.adminBind);

  return {
    file,
    mobilePort,
    maxHosts,
    registration: {
      enabled: regInput.enabled !== false,
      maxAttemptsPerMinutePerIp: perIp,
      maxAttemptsPerMinute: global,
      bodyLimitBytes: bodyLimit,
    },
    edge: {
      enabled: edgeEnabled,
      port: edgePort,
      tls: edgeTls,
      allowUnauthenticated,
    },
    auth: {
      tokenTtlMs,
      challengeTtlMs,
      maxAttemptsPerMinutePerIp: maxAuthAttempts,
      signingKeyFile,
    },
    adminToken,
    adminTokenFile,
    apiPort,
    adminPort,
    apiBind,
    adminBind,
    publicControlPort,
    push: normalizePush(input.push),
  };
}

/**
 * 规范化边缘连接限制（DoS 兜底；不替代主机侧设备鉴权）。
 * 0.3.0 起只有边缘连接：maxEdgeConnections；旧名 maxDataConnections 作为别名接受。
 * @param {unknown} raw
 */
export function normalizeLimits(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? /** @type {Record<string, any>} */ (raw) : {};
  const maxConnectionsPerIp = input.maxConnectionsPerIp === undefined
    ? RELAY_LIMIT_DEFAULTS.maxConnectionsPerIp
    : Number(input.maxConnectionsPerIp);
  const maxEdgeConnectionsRaw = input.maxEdgeConnections === undefined ? input.maxDataConnections : input.maxEdgeConnections;
  const maxEdgeConnections = maxEdgeConnectionsRaw === undefined
    ? RELAY_LIMIT_DEFAULTS.maxEdgeConnections
    : Number(maxEdgeConnectionsRaw);
  if (!Number.isSafeInteger(maxConnectionsPerIp) || maxConnectionsPerIp < 1) throw new Error('limits.maxConnectionsPerIp 必须是正整数');
  if (!Number.isSafeInteger(maxEdgeConnections) || maxEdgeConnections < 1) throw new Error('limits.maxEdgeConnections 必须是正整数');
  return { maxConnectionsPerIp, maxEdgeConnections };
}

/**
 * @param {unknown} raw
 * @returns {object} 规范化后的配置
 */
export function normalizeConfig(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('relay options must be an object');
  }
  const input = /** @type {Record<string, any>} */ (raw);

  const dev = Boolean(input.dev);
  normalizeMode(input.mode);
  const group = normalizeGroup(input.group, dev);
  const tls = normalizeTls(input.tls);
  if (!tls && !dev) {
    throw new Error(
      'refusing to start relay without TLS: control plane would be ws:// (plaintext), exposing host tokens. '
      + 'Provide options.tls = {certFile, keyFile} (CLI: --cert-file/--key-file or RELAY_TLS_CERT_FILE/RELAY_TLS_KEY_FILE), '
      + 'or run with --dev (dev/test only, never on a public host).',
    );
  }

  // 0.3.0 起叫 listenHost；旧配置里的 dataHost 继续作为别名（classic 字段已删、行为不变）。
  const listenHostRaw = input.listenHost === undefined || input.listenHost === null || input.listenHost === ''
    ? input.dataHost
    : input.listenHost;
  const listenHost = listenHostRaw === undefined || listenHostRaw === null || listenHostRaw === ''
    ? RELAY_DEFAULTS.listenHost
    : String(listenHostRaw).trim();
  if (!listenHost) throw new Error('invalid listenHost: expected an interface address such as 0.0.0.0 or 127.0.0.1');

  const logLevel = input.logLevel === undefined ? 'info' : String(input.logLevel);
  const logger = input.logger && typeof input.logger === 'object'
    && ['debug', 'info', 'warn', 'error'].every((m) => typeof input.logger[m] === 'function')
    ? input.logger
    : createConsoleLogger(LOG_LEVELS.has(logLevel) ? logLevel : 'info');

  // 旧配置里的 classic 字段只告警、不生效（不实现 classic 行为）。
  const ignored = REMOVED_CLASSIC_FIELDS.filter((key) => Object.hasOwn(input, key) && input[key] !== undefined);
  if (ignored.length > 0) {
    logger.warn(`relay 0.3.0 removed classic config field(s): ${ignored.join(', ')} — ignored (only group mode is served)`);
  }
  if (!group.edge.enabled) {
    logger.warn(
      'group.edge.enabled=false: relay has no phone data plane (only control plane / registration API / admin). '
      + '群体版生产部署应配置通配证书并开启 edge；显式关闭仅用于特殊/测试场景。',
    );
  }

  // 测试注入点：APNs 客户端替身（JSON 配置无法表达函数，仅 createRelay 程序化测试用）。
  const pushClients = input.pushClients && typeof input.pushClients === 'object' && !Array.isArray(input.pushClients)
    ? /** @type {Record<string, any>} */ (input.pushClients)
    : undefined;

  return {
    domain: normalizeDomain(input.domain),
    group,
    limits: normalizeLimits(input.limits),
    controlPort: normalizePort(input.controlPort, 'controlPort', RELAY_DEFAULTS.controlPort),
    httpPort: normalizePort(input.httpPort, 'httpPort', RELAY_DEFAULTS.httpPort),
    listenHost,
    dev,
    tls,
    logger,
    pushClients,
    timings: {
      handshakeTimeoutMs: normalizeTiming(input.handshakeTimeoutMs, 'handshakeTimeoutMs', RELAY_TIMINGS.handshakeTimeoutMs),
      heartbeatIntervalMs: normalizeTiming(input.heartbeatIntervalMs, 'heartbeatIntervalMs', RELAY_TIMINGS.heartbeatIntervalMs),
      heartbeatTimeoutMs: normalizeTiming(input.heartbeatTimeoutMs, 'heartbeatTimeoutMs', RELAY_TIMINGS.heartbeatTimeoutMs),
      openTimeoutMs: normalizeTiming(input.openTimeoutMs, 'openTimeoutMs', RELAY_TIMINGS.openTimeoutMs),
    },
  };
}
