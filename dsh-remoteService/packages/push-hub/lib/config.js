/**
 * push-hub 配置：`hub.json` 读取 → `HUB_*` 环境变量覆盖 → 校验/规范化。
 *
 * 配置形态（完整示例见 README.md；0.3.0 起 hub 只服务 R2：官方 App 登记 + 直连推送）：
 * {
 *   "listenHost": "0.0.0.0",                     // 默认 127.0.0.1（生产前面由 nginx 终止 TLS）
 *   "port": 9445,                                // 0 = 临时端口（测试）
 *   "tls": { "certFile": "...", "keyFile": "..." } | { "cert": "<PEM>", "key": "<PEM>" },
 *   "apns": { "keyFile": "...|privateKey": "<PEM>", "keyId": "...", "teamId": "...", "topic": "..." },
 *   "publicUrl": "https://push.example.com",      // R2：credential 的 aud（必填才启用设备直连）
 *   "signingKeyFile": "/data/push-hub-signing-key.pem", // R2：Ed25519 签名 key（不存在则 0600 自动生成）
 *   "credential": { "ttlDays": 30 },              // R2：device credential 有效期
 *   "enroll": { "enabled": true, "challengeTtlSeconds": 120 }, // R2：设备登记
 *   "limits": { "maxTokensPerRequest": 20, "pushPerMinutePerToken": 6, ... },
 *   "logLevel": "info"
 * }
 *
 * 约定：
 *   - `tls` 可省略：hub 本身只跑 HTTP，由前置 nginx 终止 TLS（见 server/nginx/push-hub-http.conf）；
 *   - `apns` 可省略：APNs 未配置时 `/v1/push` 返回 503 `push_unavailable`，`/healthz` 显示
 *     `apns.configured=false`，方便先部署再补 key；
 *   - **R2 设备直连（/v1/enroll、device credential）在 `publicUrl` 为空时不启用**：
 *     `/healthz` 显示 `credential.enabled=false`、`enroll.enabled=false`；
 *   - 相对路径按 **配置文件所在目录** 解析（环境变量里的相对路径按进程 cwd 解析）；
 *   - `signingKeyFile` 默认放在 baseDir（有配置文件时即配置文件目录；纯环境变量模式为 cwd）下的
 *     `push-hub-signing-key.pem`（容器内即 `/data/...`）；
 *   - 校验错误信息必须可操作，且**绝不包含密钥/token 内容**（只提字段名与期望格式）。
 *
 * R2 契约：docs/group-push-r2-contract.zh.md §4/§4.5；限流默认值见
 * docs/group-push-load-evaluation.zh.md §4。
 */

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

/** 默认监听地址：只有前置 nginx 时应该用回环；容器内由 compose 的 HUB_LISTEN_HOST=0.0.0.0 覆盖。 */
export const HUB_DEFAULT_LISTEN_HOST = '127.0.0.1';
/** 容器/默认端口（compose 里宿主发布到 127.0.0.1:19445）。 */
export const HUB_DEFAULT_PORT = 9445;
/** 默认每请求 token 上限（R2 每次只推 1 个 token；保留该配置位作为请求形状上限）。 */
export const HUB_DEFAULT_MAX_TOKENS_PER_REQUEST = 20;
/** 默认每 token 每分钟推送配额（R2 device 直连；契约 §4.5）。 */
export const HUB_DEFAULT_PUSH_PER_MINUTE_PER_TOKEN = 6;
/** 默认每 token 每天推送配额（R2）。 */
export const HUB_DEFAULT_PUSH_PER_DAY_PER_TOKEN = 120;
/** 默认每 credential 每分钟推送配额（R2）。 */
export const HUB_DEFAULT_PUSH_PER_MINUTE_PER_CREDENTIAL = 6;
/** 默认每 host 每分钟推送配额（R2；同一主机多设备共享）。 */
export const HUB_DEFAULT_PUSH_PER_MINUTE_PER_HOST = 30;
/** 默认每来源 IP 每分钟推送配额（R2）。 */
export const HUB_DEFAULT_PUSH_PER_MINUTE_PER_IP = 60;
/** 默认全局每分钟推送配额（R2 兜底）。 */
export const HUB_DEFAULT_PUSH_PER_MINUTE_GLOBAL = 120;
/** 默认每 IP 每小时 enroll 配额。 */
export const HUB_DEFAULT_ENROLL_PER_HOUR_PER_IP = 20;
/** 默认每设备（tokenHash）每小时 enroll 配额。 */
export const HUB_DEFAULT_ENROLL_PER_HOUR_PER_DEVICE = 5;
/** 默认每 IP 每小时 challenge 配额。 */
export const HUB_DEFAULT_CHALLENGE_PER_HOUR_PER_IP = 60;
/** 默认 credential TTL（天）。 */
export const HUB_DEFAULT_CREDENTIAL_TTL_DAYS = 30;
/** 默认是否启用设备登记（/v1/enroll*）。 */
export const HUB_DEFAULT_ENROLL_ENABLED = true;
/** 默认 enroll challenge TTL（秒；契约 §4.1 为 120s）。 */
export const HUB_DEFAULT_ENROLL_CHALLENGE_TTL_SECONDS = 120;
/** 签名 key 默认文件名（放在 baseDir 下；容器内即 /data 下）。 */
export const HUB_DEFAULT_SIGNING_KEY_FILE_NAME = 'push-hub-signing-key.pem';

/** 请求体上限：官方 hub 只收 kind/host/token/environment/enroll 等小字段，16KB 足够且有富余（契约 §4.5）。 */
export const HUB_BODY_LIMIT_BYTES = 16 * 1024;
/** 默认配置文件名（CLI 未给 --config / HUB_CONFIG 时使用）。 */
export const HUB_DEFAULT_CONFIG_FILE = 'hub.json';
/** 默认日志级别。 */
export const HUB_DEFAULT_LOG_LEVEL = 'info';

/**
 * 限流默认值（R2 全部层级；docs/group-push-load-evaluation.zh.md §4）。
 * 单位：minute → 60s，day → 24h，hour → 1h。
 */
export const HUB_LIMIT_DEFAULTS = Object.freeze({
  maxTokensPerRequest: HUB_DEFAULT_MAX_TOKENS_PER_REQUEST,
  enrollPerHourPerIp: HUB_DEFAULT_ENROLL_PER_HOUR_PER_IP,
  enrollPerHourPerDevice: HUB_DEFAULT_ENROLL_PER_HOUR_PER_DEVICE,
  challengePerHourPerIp: HUB_DEFAULT_CHALLENGE_PER_HOUR_PER_IP,
  pushPerMinutePerToken: HUB_DEFAULT_PUSH_PER_MINUTE_PER_TOKEN,
  pushPerDayPerToken: HUB_DEFAULT_PUSH_PER_DAY_PER_TOKEN,
  pushPerMinutePerCredential: HUB_DEFAULT_PUSH_PER_MINUTE_PER_CREDENTIAL,
  pushPerMinutePerHost: HUB_DEFAULT_PUSH_PER_MINUTE_PER_HOST,
  pushPerMinutePerIp: HUB_DEFAULT_PUSH_PER_MINUTE_PER_IP,
  pushPerMinuteGlobal: HUB_DEFAULT_PUSH_PER_MINUTE_GLOBAL,
});

/** 合法日志级别。 */
export const HUB_LOG_LEVELS = Object.freeze(['debug', 'info', 'warn', 'error', 'silent']);

/** 监听地址允许的字符（IPv4 / IPv6 / 主机名，不含空白与控制字符）。 */
const LISTEN_HOST_RE = /^[0-9A-Za-z.:[\]_-]+$/;
/** Apple Key ID / Team ID 都是 10 位字母数字。 */
const APPLE_ID_RE = /^[A-Za-z0-9]{10}$/;
/** bundle id 形态（官方 App 的 topic）。 */
const BUNDLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{2,254}$/;
/** 内联 PEM 证书/私钥的最小形态检查（避免把文件路径误填进内联字段）。 */
const PEM_CERT_RE = /-----BEGIN [A-Z0-9 ]*CERTIFICATE-----/;
const PEM_KEY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;

/**
 * 控制台 logger（日志只记计数/结果，绝不含 token/密钥）。
 * @param {string} [level]
 * @param {string} [scope]
 * @returns {{debug: Function, info: Function, warn: Function, error: Function}}
 */
export function createConsoleLogger(level = HUB_DEFAULT_LOG_LEVEL, scope = 'push-hub') {
  const threshold = HUB_LOG_LEVELS.includes(level) ? level : HUB_DEFAULT_LOG_LEVEL;
  const order = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
  /**
   * @param {'debug'|'info'|'warn'|'error'} kind
   * @param {string} message
   */
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

/** 公开日志/错误里出现 token 形态（64 hex / 43 位 base64url）时替换掉，兜底防泄漏。 */
const TOKEN_LIKE_RE = /[0-9a-f]{64}|[A-Za-z0-9_-]{43}/g;

/**
 * 把任意错误文本里的 token 形态替换为占位符（只用于日志，不用于响应）。
 * @param {unknown} value
 * @returns {string}
 */
export function redactSecrets(value) {
  return String(value ?? '').replace(TOKEN_LIKE_RE, '<redacted>');
}

/**
 * @param {unknown} raw
 * @param {string} what
 * @returns {Record<string, any>}
 */
function asObject(raw, what) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${what} must be a JSON object`);
  }
  return /** @type {Record<string, any>} */ (raw);
}

/**
 * 拒绝对象里不认识的字段（拼错字段会静默失效，宁可报错）。
 * @param {Record<string, any>} input
 * @param {string[]} allowed
 * @param {string} where
 */
function rejectUnknownKeys(input, allowed, where) {
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${where} has unsupported field(s): ${unknown.join(', ')} (allowed: ${allowed.join(', ')})`);
  }
}

/**
 * @param {unknown} value
 * @param {string} name
 * @param {number} fallback
 * @param {{min?: number, max?: number}} [range]
 * @returns {number}
 */
function normalizeInteger(value, name, fallback, range = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = typeof value === 'number' ? value : Number(value);
  const min = range.min ?? 0;
  const max = range.max ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`invalid ${name} ${JSON.stringify(value)}: expected integer ${min}..${max}`);
  }
  return number;
}

/**
 * 监听地址：基础字符校验（真正的绑定错误由 listen 报）。
 * @param {unknown} value
 * @returns {string}
 */
function normalizeListenHost(value) {
  if (value === undefined || value === null || value === '') return HUB_DEFAULT_LISTEN_HOST;
  const host = String(value).trim();
  if (host === '' || host.length > 255 || !LISTEN_HOST_RE.test(host)) {
    throw new Error(`invalid listenHost ${JSON.stringify(value)}: expected an address such as 127.0.0.1 or 0.0.0.0`);
  }
  return host;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @param {boolean} fallback
 * @returns {boolean}
 */
function normalizeBoolean(value, name, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  if (value === 1 || value === 0) return value === 1;
  throw new Error(`invalid ${name} ${JSON.stringify(value)}: expected boolean (true/false)`);
}

/**
 * R2 的 `HUB_PUBLIC_URL`：官方 hub 的公开 HTTPS 基址（credential 的 aud）。
 *
 * 可为空 = 不启用 R2 设备直连（`/v1/enroll*` 与 device credential 推送一并关闭）；
 * 一旦提供必须是 https 绝对地址、不带 userinfo/query/hash（防止 aud 被伪造/混淆），
 * 并去掉尾斜杠。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizePublicUrl(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') {
    throw new Error('invalid publicUrl: expected an https URL such as https://push.example.com');
  }
  const raw = value.trim();
  if (raw === '') return '';
  if (raw.length > 2048) throw new Error('invalid publicUrl: too long (max 2048 characters)');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid publicUrl ${JSON.stringify(raw)}: expected an https URL such as https://push.example.com`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`invalid publicUrl ${JSON.stringify(raw)}: must use https:// (R2 credential audience 必须是 https)`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('invalid publicUrl: must not contain userinfo (user:password@)');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error('invalid publicUrl: must not contain query string or fragment');
  }
  if (url.hostname === '') throw new Error('invalid publicUrl: missing hostname');
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}`;
}

/**
 * 校验 R2 credential 段：`{ ttlDays }`（默认 30 天，1..90）。
 * @param {unknown} raw
 */
function normalizeHubCredential(raw) {
  if (raw === undefined || raw === null) return { ttlDays: HUB_DEFAULT_CREDENTIAL_TTL_DAYS };
  const input = asObject(raw, 'credential');
  rejectUnknownKeys(input, ['ttlDays'], 'credential');
  return {
    ttlDays: normalizeInteger(input.ttlDays, 'credential.ttlDays', HUB_DEFAULT_CREDENTIAL_TTL_DAYS, { min: 1, max: 90 }),
  };
}

/**
 * 校验 R2 enroll 段：`{ enabled, challengeTtlSeconds }`。
 * @param {unknown} raw
 */
function normalizeHubEnroll(raw) {
  if (raw === undefined || raw === null) {
    return { enabled: HUB_DEFAULT_ENROLL_ENABLED, challengeTtlSeconds: HUB_DEFAULT_ENROLL_CHALLENGE_TTL_SECONDS };
  }
  const input = asObject(raw, 'enroll');
  rejectUnknownKeys(input, ['enabled', 'challengeTtlSeconds'], 'enroll');
  return {
    enabled: normalizeBoolean(input.enabled, 'enroll.enabled', HUB_DEFAULT_ENROLL_ENABLED),
    challengeTtlSeconds: normalizeInteger(
      input.challengeTtlSeconds,
      'enroll.challengeTtlSeconds',
      HUB_DEFAULT_ENROLL_CHALLENGE_TTL_SECONDS,
      { min: 10, max: 900 },
    ),
  };
}

/**
 * 签名 key 路径：显式配置优先，否则 baseDir 下的 `push-hub-signing-key.pem`
 * （有配置文件时即配置文件目录；容器内即 /data/push-hub-signing-key.pem，随 /data 卷持久化）。
 *
 * @param {unknown} raw
 * @param {{baseDir: string}} options
 * @returns {string}
 */
function normalizeSigningKeyFile(raw, options) {
  if (raw !== undefined && raw !== null && raw !== '') {
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new Error('signingKeyFile 必须是非空路径（Ed25519 PKCS#8 PEM，0600）');
    }
    return resolveFromBase(raw.trim(), options.baseDir);
  }
  return resolve(options.baseDir, HUB_DEFAULT_SIGNING_KEY_FILE_NAME);
}

/**
 * 把配置里的相对路径按配置文件目录绝对化。
 * @param {string} value
 * @param {string} baseDir
 * @returns {string}
 */
function resolveFromBase(value, baseDir) {
  return isAbsolute(value) ? value : resolve(baseDir, value);
}

/**
 * 校验 tls 段：要么 {certFile,keyFile}，要么内联 {cert,key}（PEM 文本），二选一。
 * @param {unknown} raw
 * @param {string} baseDir
 * @returns {{certFile: string, keyFile: string} | {cert: string, key: string} | null}
 */
export function normalizeHubTls(raw, baseDir) {
  if (raw === undefined || raw === null) return null;
  const input = asObject(raw, 'tls');
  if (Object.keys(input).length === 0) return null;
  rejectUnknownKeys(input, ['certFile', 'keyFile', 'cert', 'key'], 'tls');
  const hasFile = input.certFile !== undefined || input.keyFile !== undefined;
  const hasInline = input.cert !== undefined || input.key !== undefined;
  if (hasFile && hasInline) {
    throw new Error('tls 只能二选一：{certFile,keyFile} 或内联 {cert,key}');
  }
  if (hasFile) {
    if (typeof input.certFile !== 'string' || input.certFile.trim() === '') {
      throw new Error('tls.certFile 与 tls.keyFile 必须同时提供（证书链 PEM 文件路径）');
    }
    if (typeof input.keyFile !== 'string' || input.keyFile.trim() === '') {
      throw new Error('tls.keyFile 与 tls.certFile 必须同时提供（私钥 PEM 文件路径）');
    }
    return {
      certFile: resolveFromBase(input.certFile.trim(), baseDir),
      keyFile: resolveFromBase(input.keyFile.trim(), baseDir),
    };
  }
  if (hasInline) {
    const cert = typeof input.cert === 'string' ? input.cert : '';
    const key = typeof input.key === 'string' ? input.key : '';
    if (!PEM_CERT_RE.test(cert)) {
      throw new Error('tls.cert 必须是 PEM 证书文本（以 -----BEGIN CERTIFICATE----- 开头），或改用 tls.certFile');
    }
    if (!PEM_KEY_RE.test(key)) {
      throw new Error('tls.key 必须是 PEM 私钥文本（含 -----BEGIN ... PRIVATE KEY-----），或改用 tls.keyFile');
    }
    return { cert, key };
  }
  throw new Error('tls 配置不完整：需要 {certFile,keyFile} 或内联 {cert,key}；不需要 TLS 时请删除 tls 段');
}

/**
 * 校验 apns 段。未配置时返回 {configured:false}（hub 仍可启动，但推送会 503）。
 *
 * 私钥只认两种来源：`keyFile`（推荐，只读挂载的 .p8）或内联 `privateKey`（PEM 文本）。
 * 本函数**不读取文件**、不解析私钥——由 createHubServer 创建 APNs client 时读取一次，
 * 失败只在日志/healthz 里显示 configured=false，不会把密钥内容写进任何输出。
 *
 * @param {unknown} raw
 * @param {string} baseDir
 */
export function normalizeHubApns(raw, baseDir) {
  if (raw === undefined || raw === null) return { configured: false, keyFile: '', privateKey: '', keyId: '', teamId: '', topic: '' };
  const input = asObject(raw, 'apns');
  if (Object.keys(input).length === 0) {
    return { configured: false, keyFile: '', privateKey: '', keyId: '', teamId: '', topic: '' };
  }
  rejectUnknownKeys(input, ['keyFile', 'privateKey', 'keyId', 'teamId', 'topic'], 'apns');
  const hasKeyFile = input.keyFile !== undefined;
  const hasInlineKey = input.privateKey !== undefined;
  if (hasKeyFile && hasInlineKey) {
    throw new Error('apns.keyFile 与 apns.privateKey 只能二选一');
  }
  if (!hasKeyFile && !hasInlineKey) {
    throw new Error('apns 已配置但缺少私钥：请给 apns.keyFile（.p8 路径）或 apns.privateKey（PEM 文本）');
  }
  const keyId = typeof input.keyId === 'string' ? input.keyId.trim() : '';
  const teamId = typeof input.teamId === 'string' ? input.teamId.trim() : '';
  const topic = typeof input.topic === 'string' ? input.topic.trim() : '';
  const missing = [];
  if (keyId === '') missing.push('apns.keyId (Apple Key ID)');
  if (teamId === '') missing.push('apns.teamId (Apple Team ID)');
  if (topic === '') missing.push('apns.topic (官方 App 的 bundle id)');
  if (missing.length > 0) throw new Error(`apns 配置不完整，缺少：${missing.join('、')}`);
  if (!APPLE_ID_RE.test(keyId)) {
    throw new Error('apns.keyId 必须是 10 位字母数字（AuthKey_<KEY_ID>.p8 文件名里的 KEY_ID）');
  }
  if (!APPLE_ID_RE.test(teamId)) {
    throw new Error('apns.teamId 必须是 10 位字母数字（Apple Developer Team ID）');
  }
  if (!BUNDLE_ID_RE.test(topic) || !topic.includes('.')) {
    throw new Error('apns.topic 必须是官方 App 的 bundle id，例如 com.example.dshremote');
  }
  if (hasKeyFile) {
    if (typeof input.keyFile !== 'string' || input.keyFile.trim() === '') {
      throw new Error('apns.keyFile 必须是非空的 .p8 文件路径');
    }
    return {
      configured: true,
      keyFile: resolveFromBase(input.keyFile.trim(), baseDir),
      privateKey: '',
      keyId,
      teamId,
      topic,
    };
  }
  const privateKey = typeof input.privateKey === 'string' ? input.privateKey : '';
  if (!PEM_KEY_RE.test(privateKey)) {
    throw new Error('apns.privateKey 必须是 PKCS#8 PEM 私钥文本（以 -----BEGIN PRIVATE KEY----- 开头），或改用 apns.keyFile');
  }
  return { configured: true, keyFile: '', privateKey, keyId, teamId, topic };
}

/**
 * 校验限流配置（R2 全部层级；契约 §4.5）。
 * 字段名与 hub.json 一致；env 在 applyHubEnv 里映射。
 * @param {unknown} raw
 */
function normalizeHubLimits(raw) {
  const input = raw === undefined || raw === null ? {} : asObject(raw, 'limits');
  const allowed = Object.keys(HUB_LIMIT_DEFAULTS);
  rejectUnknownKeys(input, allowed, 'limits');
  /** @type {Record<string, number>} */
  const limits = {};
  /** 每个字段的合法区间（整数）。 */
  const ranges = {
    maxTokensPerRequest: { min: 1, max: 1000 },
    enrollPerHourPerIp: { min: 1, max: 100_000 },
    enrollPerHourPerDevice: { min: 1, max: 10_000 },
    challengePerHourPerIp: { min: 1, max: 100_000 },
    pushPerMinutePerToken: { min: 1, max: 10_000 },
    pushPerDayPerToken: { min: 1, max: 1_000_000 },
    pushPerMinutePerCredential: { min: 1, max: 10_000 },
    pushPerMinutePerHost: { min: 1, max: 100_000 },
    pushPerMinutePerIp: { min: 1, max: 100_000 },
    pushPerMinuteGlobal: { min: 1, max: 1_000_000 },
  };
  for (const name of allowed) {
    limits[name] = normalizeInteger(input[name], `limits.${name}`, HUB_LIMIT_DEFAULTS[name], ranges[name]);
  }
  return /** @type {{maxTokensPerRequest:number, enrollPerHourPerIp:number, enrollPerHourPerDevice:number, challengePerHourPerIp:number, pushPerMinutePerToken:number, pushPerDayPerToken:number, pushPerMinutePerCredential:number, pushPerMinutePerHost:number, pushPerMinutePerIp:number, pushPerMinuteGlobal:number}} */ (limits);
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
function normalizeLogLevel(raw) {
  if (raw === undefined || raw === null || raw === '') return HUB_DEFAULT_LOG_LEVEL;
  const level = String(raw).trim();
  if (!HUB_LOG_LEVELS.includes(level)) {
    throw new Error(`invalid logLevel ${JSON.stringify(raw)}: expected one of ${HUB_LOG_LEVELS.join(', ')}`);
  }
  return level;
}

/**
 * 应用 `HUB_*` 环境变量（只覆盖显式非空值；返回新对象，不改入参）。
 *
 * 支持的变量：
 *   HUB_LISTEN_HOST / HUB_PORT / HUB_LOG_LEVEL
 *   HUB_TLS_CERT_FILE / HUB_TLS_KEY_FILE
 *   HUB_APNS_KEY_FILE / HUB_APNS_KEY_ID / HUB_APNS_TEAM_ID / HUB_APNS_TOPIC
 *   HUB_PUBLIC_URL / HUB_SIGNING_KEY_FILE / HUB_CREDENTIAL_TTL_DAYS / HUB_ENROLL_*
 *   HUB_MAX_TOKENS_PER_REQUEST 与各层配额（HUB_*_PER_* / HUB_PUSH_PER_DAY_PER_TOKEN）
 *
 * 环境变量里的相对路径按进程 cwd 解析（与配置文件内的相对路径不同）。
 *
 * @param {Record<string, any>} raw
 * @param {Record<string, string | undefined>} [env]
 * @param {{cwd?: string}} [options]
 * @returns {Record<string, any>}
 */
export function applyHubEnv(raw, env = process.env, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  /** @type {Record<string, any>} */
  const config = { ...(raw ?? {}) };
  /** @param {unknown} value */
  const set = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);
  const ensure = (key) => {
    config[key] = config[key] && typeof config[key] === 'object' && !Array.isArray(config[key]) ? { ...config[key] } : {};
    return config[key];
  };
  const resolveEnvPath = (value) => (isAbsolute(value) ? value : resolve(cwd, value));

  const listenHost = set(env.HUB_LISTEN_HOST);
  if (listenHost !== undefined) config.listenHost = listenHost;
  const port = set(env.HUB_PORT);
  if (port !== undefined) config.port = port;
  const logLevel = set(env.HUB_LOG_LEVEL);
  if (logLevel !== undefined) config.logLevel = logLevel;

  const tlsCertFile = set(env.HUB_TLS_CERT_FILE);
  const tlsKeyFile = set(env.HUB_TLS_KEY_FILE);
  if (tlsCertFile !== undefined || tlsKeyFile !== undefined) {
    const tls = ensure('tls');
    if (tlsCertFile !== undefined) tls.certFile = resolveEnvPath(tlsCertFile);
    if (tlsKeyFile !== undefined) tls.keyFile = resolveEnvPath(tlsKeyFile);
  }

  const apnsKeyFile = set(env.HUB_APNS_KEY_FILE);
  const apnsKeyId = set(env.HUB_APNS_KEY_ID);
  const apnsTeamId = set(env.HUB_APNS_TEAM_ID);
  const apnsTopic = set(env.HUB_APNS_TOPIC);
  if (apnsKeyFile !== undefined || apnsKeyId !== undefined || apnsTeamId !== undefined || apnsTopic !== undefined) {
    const apns = ensure('apns');
    if (apnsKeyFile !== undefined) apns.keyFile = resolveEnvPath(apnsKeyFile);
    if (apnsKeyId !== undefined) apns.keyId = apnsKeyId;
    if (apnsTeamId !== undefined) apns.teamId = apnsTeamId;
    if (apnsTopic !== undefined) apns.topic = apnsTopic;
  }

  // ── R2：设备直连（官方 App ↔ hub 登记 / credential）────────────────────────
  const publicUrl = set(env.HUB_PUBLIC_URL);
  if (publicUrl !== undefined) config.publicUrl = publicUrl;
  const signingKeyFile = set(env.HUB_SIGNING_KEY_FILE);
  if (signingKeyFile !== undefined) config.signingKeyFile = resolveEnvPath(signingKeyFile);
  const credentialTtlDays = set(env.HUB_CREDENTIAL_TTL_DAYS);
  if (credentialTtlDays !== undefined) ensure('credential').ttlDays = credentialTtlDays;
  const enrollEnabled = set(env.HUB_ENROLL_ENABLED);
  const challengeTtlSeconds = set(env.HUB_ENROLL_CHALLENGE_TTL_SECONDS);
  if (enrollEnabled !== undefined || challengeTtlSeconds !== undefined) {
    const enroll = ensure('enroll');
    if (enrollEnabled !== undefined) enroll.enabled = enrollEnabled;
    if (challengeTtlSeconds !== undefined) enroll.challengeTtlSeconds = challengeTtlSeconds;
  }

  /** env 名 → limits 字段名（数值统一在 normalizeHubLimits 里校验）。 */
  const limitEnvMap = {
    HUB_MAX_TOKENS_PER_REQUEST: 'maxTokensPerRequest',
    HUB_ENROLL_PER_HOUR_PER_IP: 'enrollPerHourPerIp',
    HUB_ENROLL_PER_HOUR_PER_DEVICE: 'enrollPerHourPerDevice',
    HUB_CHALLENGE_PER_HOUR_PER_IP: 'challengePerHourPerIp',
    HUB_PUSH_PER_MINUTE_PER_TOKEN: 'pushPerMinutePerToken',
    HUB_PUSH_PER_DAY_PER_TOKEN: 'pushPerDayPerToken',
    HUB_PUSH_PER_MINUTE_PER_CREDENTIAL: 'pushPerMinutePerCredential',
    HUB_PUSH_PER_MINUTE_PER_HOST: 'pushPerMinutePerHost',
    HUB_PUSH_PER_MINUTE_PER_IP: 'pushPerMinutePerIp',
    HUB_PUSH_PER_MINUTE_GLOBAL: 'pushPerMinuteGlobal',
  };
  for (const [envName, field] of Object.entries(limitEnvMap)) {
    const value = set(env[envName]);
    if (value !== undefined) ensure('limits')[field] = value;
  }

  return config;
}

/**
 * 校验并规范化 hub 配置。
 *
 * @param {unknown} [raw] 配置对象（通常来自 hub.json）
 * @param {object} [options]
 * @param {string} [options.baseDir] 相对路径与默认签名 key 的基准目录（默认进程 cwd）
 * @param {string} [options.configPath] 配置文件路径（只用于诊断回显）
 * @returns {object} 规范化后的配置（供 createHubServer / CLI 使用）
 */
export function normalizeHubConfig(raw = {}, options = {}) {
  const input = asObject(raw, 'hub config');
  const baseDir = options.baseDir ? resolve(options.baseDir) : process.cwd();
  const configPath = options.configPath ? resolve(options.configPath) : undefined;
  rejectUnknownKeys(
    input,
    ['listenHost', 'port', 'tls', 'apns', 'publicUrl', 'signingKeyFile', 'credential', 'enroll', 'limits', 'logLevel'],
    'hub config',
  );
  return {
    listenHost: normalizeListenHost(input.listenHost),
    port: normalizeInteger(input.port, 'port', HUB_DEFAULT_PORT, { min: 0, max: 65_535 }),
    tls: normalizeHubTls(input.tls, baseDir),
    apns: normalizeHubApns(input.apns, baseDir),
    publicUrl: normalizePublicUrl(input.publicUrl),
    signingKeyFile: normalizeSigningKeyFile(input.signingKeyFile, { baseDir }),
    credential: normalizeHubCredential(input.credential),
    enroll: normalizeHubEnroll(input.enroll),
    limits: normalizeHubLimits(input.limits),
    logLevel: normalizeLogLevel(input.logLevel),
    configPath,
    baseDir,
  };
}

/**
 * 创建 hub 配置：应用 `HUB_*` 环境变量覆盖后再校验/规范化。
 *
 * @param {unknown} [raw] 配置对象（通常来自 hub.json；也可省略只用环境变量）
 * @param {object} [options]
 * @param {string} [options.baseDir] 相对路径与默认签名 key 的基准目录
 * @param {string} [options.configPath] 配置文件路径（未给 baseDir 时，其目录即基准目录）
 * @param {Record<string, string | undefined>} [options.env] 默认 process.env
 * @param {boolean} [options.applyEnv] 默认 true（测试可关）
 * @param {string} [options.cwd] 环境变量里相对路径的基准目录
 */
export function createHubConfig(raw = {}, options = {}) {
  const env = options.env ?? process.env;
  const withEnv = options.applyEnv === false ? /** @type {Record<string, any>} */ (raw ?? {}) : applyHubEnv(
    /** @type {Record<string, any>} */ (raw ?? {}),
    env,
    { cwd: options.cwd ?? process.cwd() },
  );
  // 基准目录优先级：显式 baseDir > cwd > 配置文件所在目录（纯环境变量模式最终退回 process.cwd）。
  const baseDir = options.baseDir ?? options.cwd ?? (options.configPath ? dirname(resolve(options.configPath)) : undefined);
  return normalizeHubConfig(withEnv, { baseDir, configPath: options.configPath });
}

/**
 * 读取 hub.json（JSON 对象）。路径不存在/不可读/非法 JSON 给可操作错误（不含密钥）。
 * @param {string} configPath
 * @returns {{raw: Record<string, any>, path: string}}
 */
export function readHubConfigFile(configPath) {
  const abs = resolve(configPath);
  let text;
  try {
    text = readFileSync(abs, 'utf8');
  } catch (error) {
    const code = error && error.code ? error.code : '';
    throw new Error(
      `cannot read hub config file "${abs}"${code ? ` (${code})` : ''}：`
      + '请检查路径；如果只用环境变量配置，去掉 --config / HUB_CONFIG 即可',
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`hub config file is not valid JSON: ${abs}`);
  }
  return { raw: asObject(parsed, 'hub config'), path: abs };
}

/**
 * CLI/服务入口用：读配置文件（可选）+ 环境变量覆盖 → 规范化配置。
 *
 * 没有配置文件时也能启动（纯环境变量模式）：`serve` 不带 --config、且未设置 HUB_CONFIG。
 *
 * @param {object} [options]
 * @param {string} [options.configPath] 显式配置文件路径（CLI --config）
 * @param {Record<string, string | undefined>} [options.env]
 * @param {string} [options.cwd]
 * @returns {{config: object, configPath: string | undefined}}
 */
export function loadHubConfig(options = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const explicit = options.configPath !== undefined && options.configPath !== null && options.configPath !== ''
    ? String(options.configPath)
    : undefined;
  const fromEnv = typeof env.HUB_CONFIG === 'string' && env.HUB_CONFIG.trim() !== '' ? env.HUB_CONFIG.trim() : undefined;
  const configPath = explicit ?? fromEnv;
  if (configPath === undefined) {
    return { config: createHubConfig({}, { env, cwd }), configPath: undefined };
  }
  const loaded = readHubConfigFile(configPath);
  const config = createHubConfig(loaded.raw, {
    env,
    cwd,
    baseDir: dirname(loaded.path),
    configPath: loaded.path,
  });
  return { config, configPath: loaded.path };
}

/**
 * 读取 TLS 材料（文件或内联 PEM），供 https.createServer 使用。
 * 错误只包含路径/格式说明，不含密钥内容。
 *
 * @param {{certFile: string, keyFile: string} | {cert: string, key: string} | null} tls
 * @returns {{cert: string, key: string} | null}
 */
export function readHubTlsMaterial(tls) {
  if (!tls) return null;
  if (typeof tls.cert === 'string' && typeof tls.key === 'string') return { cert: tls.cert, key: tls.key };
  /** @param {string} file @param {string} what @param {RegExp} marker */
  const readPem = (file, what, marker) => {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      const code = error && error.code ? ` (${error.code})` : '';
      throw new Error(`cannot read TLS ${what} file "${file}"${code}：请检查挂载路径与文件权限`);
    }
    if (!marker.test(text)) {
      throw new Error(`TLS ${what} file "${file}" does not look like a PEM file`);
    }
    return text;
  };
  return {
    cert: readPem(tls.certFile, 'certificate', PEM_CERT_RE),
    key: readPem(tls.keyFile, 'private key', PEM_KEY_RE),
  };
}
