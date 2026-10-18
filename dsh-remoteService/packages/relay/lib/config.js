/**
 * relay 配置校验/规范化。
 *
 * createRelay(options) 与 startRelay(config)、CLI、docker 都走这一层，保证：
 *   - domain 合法（决定 <hostId>.<domain> 路由与 host.ready 回包）；
 *   - 生产必须提供 TLS 证书，dev 模式才允许 ws:// 控制面；
 *   - 端口允许 0（测试用临时端口），其余必须 0..65535 整数。
 */

import { readFileSync } from 'node:fs';

/** 公开配置默认值。 */
export const RELAY_PUSH_DEFAULTS = Object.freeze({
  endpoint: 'https://exp.host/--/api/v2/push/send',
  title: 'DSH',
  body: '有任务需要你',
});

export const RELAY_DEFAULTS = Object.freeze({
  dataPort: 443,
  controlPort: 8443,
  httpPort: 80,
  dataHost: '0.0.0.0',
});

/** 内部定时器默认值（不作为公开契约；测试可覆盖以缩短等待）。 */
export const RELAY_TIMINGS = Object.freeze({
  handshakeTimeoutMs: 10_000,
  heartbeatIntervalMs: 10_000,
  heartbeatTimeoutMs: 30_000,
  openTimeoutMs: 20_000,
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
 * @param {unknown} raw
 * @returns {Record<string, string>}
 */
function normalizeHostTokens(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('hostTokens must be an object mapping hostId → token');
  }
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`hostTokens[${JSON.stringify(key)}] must be a non-empty string`);
    }
    const hostId = String(key).trim().toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$/.test(hostId)) {
      throw new Error(`hostTokens key ${JSON.stringify(key)} is not a valid hostId`);
    }
    out[hostId] = value;
  }
  return out;
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
    throw new Error(`cannot load control-plane TLS certificate: ${detail}`);
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
 * @param {unknown} raw
 * @returns {object} 规范化后的配置
 */
export function normalizeConfig(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('relay options must be an object');
  }
  const input = /** @type {Record<string, any>} */ (raw);

  const dev = Boolean(input.dev);
  const tls = normalizeTls(input.tls);
  if (!tls && !dev) {
    throw new Error(
      'refusing to start relay without TLS: control plane would be ws:// (plaintext), exposing host tokens. '
      + 'Provide options.tls = {certFile, keyFile} (CLI: --cert-file/--key-file or RELAY_TLS_CERT_FILE/RELAY_TLS_KEY_FILE), '
      + 'or run with --dev (dev/test only, never on a public host).',
    );
  }

  const dataHost = input.dataHost === undefined || input.dataHost === null || input.dataHost === ''
    ? RELAY_DEFAULTS.dataHost
    : String(input.dataHost).trim();
  if (!dataHost) throw new Error('invalid dataHost: expected an interface address such as 0.0.0.0 or 127.0.0.1');

  const logLevel = input.logLevel === undefined ? 'info' : String(input.logLevel);
  const logger = input.logger && typeof input.logger === 'object'
    && ['debug', 'info', 'warn', 'error'].every((m) => typeof input.logger[m] === 'function')
    ? input.logger
    : createConsoleLogger(LOG_LEVELS.has(logLevel) ? logLevel : 'info');

  return {
    domain: normalizeDomain(input.domain),
    push: normalizePush(input.push),
    dataPort: normalizePort(input.dataPort, 'dataPort', RELAY_DEFAULTS.dataPort),
    controlPort: normalizePort(input.controlPort, 'controlPort', RELAY_DEFAULTS.controlPort),
    httpPort: normalizePort(input.httpPort, 'httpPort', RELAY_DEFAULTS.httpPort),
    dataHost,
    dev,
    tls,
    tokensFile: input.tokensFile === undefined || input.tokensFile === null || input.tokensFile === ''
      ? undefined
      : String(input.tokensFile),
    hostTokens: normalizeHostTokens(input.hostTokens),
    logger,
    timings: {
      handshakeTimeoutMs: normalizeTiming(input.handshakeTimeoutMs, 'handshakeTimeoutMs', RELAY_TIMINGS.handshakeTimeoutMs),
      heartbeatIntervalMs: normalizeTiming(input.heartbeatIntervalMs, 'heartbeatIntervalMs', RELAY_TIMINGS.heartbeatIntervalMs),
      heartbeatTimeoutMs: normalizeTiming(input.heartbeatTimeoutMs, 'heartbeatTimeoutMs', RELAY_TIMINGS.heartbeatTimeoutMs),
      openTimeoutMs: normalizeTiming(input.openTimeoutMs, 'openTimeoutMs', RELAY_TIMINGS.openTimeoutMs),
    },
  };
}


/**
 * 规范化 push 配置；`push: false` 或 `enabled:false` 关闭推送。
 * @param {unknown} raw
 */
export function normalizePush(raw) {
  if (raw === false) return { enabled: false };
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? /** @type {Record<string, any>} */ (raw) : {};
  const endpoint = input.endpoint === undefined ? RELAY_PUSH_DEFAULTS.endpoint : String(input.endpoint);
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`invalid push.endpoint: ${JSON.stringify(endpoint)}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('push.endpoint must be http(s)');
  const accessToken = input.accessToken === undefined || input.accessToken === null || input.accessToken === ''
    ? undefined
    : String(input.accessToken);
  const title = input.title === undefined ? RELAY_PUSH_DEFAULTS.title : String(input.title).slice(0, 80);
  const body = input.body === undefined ? RELAY_PUSH_DEFAULTS.body : String(input.body).slice(0, 200);
  return { enabled: input.enabled !== false, endpoint, accessToken, title, body };
}
