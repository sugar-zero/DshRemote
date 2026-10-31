/**
 * 群体服务版（A 模式）注册/开通：存储 + 业务逻辑。
 *
 * P1 切片范围：邀请码 → 主机自助注册（服务端分配 hostId / hostToken / mobilePort）。
 * 边缘 TLS 终止、出站隧道、短时 token 鉴权在后续切片接入（复用同一 GroupRegistrationService）。
 *
 * 存储：单一 JSON 文件（默认 <config 目录>/group.json，0600，原子写）：
 *   {
 *     version: 1,
 *     invites: { [inviteId]: { code, codeHash, note, createdAt, expiresAt, maxUses, usedBy, revokedAt } },
 *     hosts:   { [hostId]:   { hostTokenHash, hostName, mobilePort, createdAt, updatedAt, revokedAt } }
 *   }
 *
 * 安全约定（与 docs/group-service-design.zh.md 对应）：
 *   - invite code 明文存 group.json（0600）以便后台/CLI 随时查看复制；host token 只存 SHA-256（base64url）。
 *     group.json 因此属于敏感文件（含邀请码），泄露后应撤销全部邀请码并重建；
 *   - 文件 0600、目录 0700、tmp+rename 原子写；
 *   - relay 进程每次注册请求重读文件，CLI 发放/撤销邀请无需重启 relay；
 *   - 注册是**邀请制**：没有有效邀请码一律拒绝，绝不开放公开注册。
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  CONTROL_PATH,
  GROUP_DEFAULT_MOBILE_PORT,
  GROUP_REGISTER_BODY_LIMIT_BYTES,
  GROUP_REGISTER_ERROR,
  generateGroupHostId,
  isGroupHostId,
  normalizeGroupHostName,
  sha256Base64Url,
} from 'dsh-remote-protocol';
import { generateHostToken, normalizeHostId } from './tokens.js';

/** group.json 文件权限。 */
export const GROUP_STORE_FILE_MODE = 0o600;
/** group 存储目录权限。 */
export const GROUP_STORE_DIR_MODE = 0o700;
/** 默认存储文件名。 */
export const GROUP_STORE_FILE_NAME = 'group.json';
/** 邀请码默认有效期（7 天；0 = 永不过期）。 */
export const GROUP_INVITE_DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 单次邀请默认可用次数。 */
export const GROUP_INVITE_DEFAULT_MAX_USES = 1;
/** 注册限速窗口。 */
export const GROUP_RATE_WINDOW_MS = 60_000;

/**
 * 注册失败错误：带稳定错误码（返回给 host plugin / 日志用）。
 */
export class GroupRegistrationError extends Error {
  /**
   * @param {string} code GROUP_REGISTER_ERROR 之一
   * @param {string} [message]
   * @param {{retryAfterSec?: number}} [options]
   */
  constructor(code, message, options = {}) {
    super(message ?? code);
    this.name = 'GroupRegistrationError';
    this.code = code;
    /** @type {number | undefined} */
    this.retryAfterSec = options.retryAfterSec;
  }
}

/** 错误码 → HTTP 状态码。 */
const STATUS_BY_CODE = Object.freeze({
  [GROUP_REGISTER_ERROR.INVALID_REQUEST]: 400,
  [GROUP_REGISTER_ERROR.INVALID_INVITE]: 403,
  [GROUP_REGISTER_ERROR.INVALID_TOKEN]: 401,
  [GROUP_REGISTER_ERROR.HOST_NOT_FOUND]: 404,
  [GROUP_REGISTER_ERROR.HOST_REVOKED]: 403,
  [GROUP_REGISTER_ERROR.INVITE_EXPIRED]: 403,
  [GROUP_REGISTER_ERROR.INVITE_EXHAUSTED]: 403,
  [GROUP_REGISTER_ERROR.RATE_LIMITED]: 429,
  [GROUP_REGISTER_ERROR.REGISTRATION_DISABLED]: 403,
  [GROUP_REGISTER_ERROR.HOST_LIMIT]: 409,
});

/** @param {string} code */
export function groupErrorStatus(code) {
  return STATUS_BY_CODE[code] ?? 500;
}

/**
 * 默认 group.json 位置：有 --config 时用 config 所在目录，否则用 cwd。
 * @param {string | undefined} configPath
 */
export function defaultGroupFile(configPath) {
  return configPath
    ? join(dirname(resolve(configPath)), GROUP_STORE_FILE_NAME)
    : resolve(process.cwd(), GROUP_STORE_FILE_NAME);
}

/**
 * 解析 group.json 路径（绝对化）。
 * @param {string} file
 * @param {string} [baseDir]
 */
export function resolveGroupFile(file, baseDir = process.cwd()) {
  return isAbsolute(file) ? file : resolve(baseDir, file);
}

/** @returns {{version: number, invites: Record<string, any>, hosts: Record<string, any>}} */
function emptyStore() {
  return { version: 1, invites: {}, hosts: {} };
}

/**
 * 读取 store；文件不存在返回空 store；损坏抛错（避免静默丢主机/邀请）。
 * @param {string} file
 */
export function readGroupStore(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return emptyStore();
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`group store is not valid JSON: ${file}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`group store malformed (expected object): ${file}`);
  }
  const invites = parsed.invites && typeof parsed.invites === 'object' && !Array.isArray(parsed.invites)
    ? parsed.invites
    : {};
  const hosts = parsed.hosts && typeof parsed.hosts === 'object' && !Array.isArray(parsed.hosts)
    ? parsed.hosts
    : {};
  return { version: 1, invites, hosts };
}

/**
 * 原子写入 store（同目录 tmp → rename），强制 0600。
 * @param {string} file
 * @param {{invites: Record<string, any>, hosts: Record<string, any>}} store
 */
export function writeGroupStore(file, store) {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: GROUP_STORE_DIR_MODE });
  const tmp = join(dir, `.${basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const data = `${JSON.stringify({ version: 1, invites: store.invites ?? {}, hosts: store.hosts ?? {} }, null, 2)}\n`;
  const fd = openSync(tmp, 'w', GROUP_STORE_FILE_MODE);
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, GROUP_STORE_FILE_MODE);
  try {
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  chmodSync(file, GROUP_STORE_FILE_MODE);
  return file;
}

/** 服务端分配的 hostId 是否已被占用（含已撤销，避免复用）。 */
function hostIdTaken(store, hostId) {
  return Object.hasOwn(store.hosts, hostId);
}

/** 生成一个未被占用的 hostId。 */
function allocateHostId(store) {
  for (let i = 0; i < 100; i += 1) {
    const candidate = generateGroupHostId();
    if (isGroupHostId(candidate) && !hostIdTaken(store, candidate)) return candidate;
  }
  throw new Error('cannot allocate a unique hostId');
}

/**
 * 创建邀请码（只在返回值里出现一次明文 code）。
 * @param {string} file
 * @param {{note?: string, maxUses?: number, expiresInMs?: number, now?: number}} [options]
 */
export function createInvite(file, options = {}) {
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const maxUses = options.maxUses === undefined ? GROUP_INVITE_DEFAULT_MAX_USES : Number(options.maxUses);
  if (!Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > 1000) {
    throw new Error('maxUses 必须是 1..1000 的整数');
  }
  const expiresInMs = options.expiresInMs === undefined ? GROUP_INVITE_DEFAULT_TTL_MS : Number(options.expiresInMs);
  if (!Number.isFinite(expiresInMs) || expiresInMs < 0) throw new Error('expiresInMs 必须 >= 0（0 = 永不过期）');
  const note = String(options.note ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);

  const inviteId = `inv_${randomBytes(5).toString('hex')}`;
  const code = randomBytes(32).toString('base64url');
  const store = readGroupStore(file);
  store.invites[inviteId] = {
    // 明文保存邀请码：部署方后台/CLI 需要随时查看与复制（group.json 本身 0600）
    code,
    codeHash: sha256Base64Url(code),
    note,
    createdAt: now,
    expiresAt: expiresInMs > 0 ? now + expiresInMs : 0,
    maxUses,
    usedBy: [],
    revokedAt: 0,
  };
  writeGroupStore(file, store);
  return {
    inviteId,
    code,
    note,
    createdAt: now,
    expiresAt: store.invites[inviteId].expiresAt,
    maxUses,
  };
}

/**
 * 列邀请（包含明文 code；旧记录只有 codeHash 时 code 为 undefined）。
 * @param {string} file
 * @param {{now?: number}} [options]
 */
export function listInvites(file, options = {}) {
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const store = readGroupStore(file);
  return Object.entries(store.invites)
    .map(([inviteId, invite]) => {
      const usedBy = Array.isArray(invite.usedBy) ? invite.usedBy : [];
      const revoked = Number(invite.revokedAt) > 0;
      const expired = Number(invite.expiresAt) > 0 && now >= Number(invite.expiresAt);
      const remaining = Math.max(0, Number(invite.maxUses) - usedBy.length);
      return {
        inviteId,
        code: typeof invite.code === 'string' && invite.code !== '' ? invite.code : undefined,
        note: invite.note ?? '',
        createdAt: Number(invite.createdAt) || 0,
        expiresAt: Number(invite.expiresAt) || 0,
        maxUses: Number(invite.maxUses) || 0,
        used: usedBy.length,
        remaining,
        revoked,
        expired,
      };
    })
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * 按 inviteId 或明文 code 撤销邀请。
 * @param {string} file
 * @param {string} inviteIdOrCode
 * @param {{now?: number}} [options]
 */
export function revokeInvite(file, inviteIdOrCode, options = {}) {
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const raw = String(inviteIdOrCode ?? '').trim();
  if (raw === '') return false;
  const store = readGroupStore(file);
  let inviteId = raw;
  if (!Object.hasOwn(store.invites, inviteId)) {
    const codeHash = sha256Base64Url(raw);
    inviteId = Object.keys(store.invites).find((id) => store.invites[id].codeHash === codeHash) ?? '';
  }
  if (!inviteId || !Object.hasOwn(store.invites, inviteId)) return false;
  store.invites[inviteId].revokedAt = now;
  writeGroupStore(file, store);
  return true;
}

/** 活跃（未撤销）主机数。 */
function activeHostCount(store) {
  return Object.values(store.hosts).filter((host) => !Number(host.revokedAt)).length;
}

/**
 * 列主机（不含 token hash）。
 * @param {string} file
 */
export function listHosts(file) {
  const store = readGroupStore(file);
  return Object.entries(store.hosts)
    .map(([hostId, host]) => ({
      hostId,
      hostName: host.hostName ?? '',
      mobilePort: Number(host.mobilePort) || GROUP_DEFAULT_MOBILE_PORT,
      createdAt: Number(host.createdAt) || 0,
      updatedAt: Number(host.updatedAt) || 0,
      revoked: Number(host.revokedAt) > 0,
      revokedAt: Number(host.revokedAt) || 0,
    }))
    .sort((a, b) => a.hostId.localeCompare(b.hostId));
}

/**
 * 读取单个主机记录（内部用；含 token hash，不对外打印）。
 * @param {string} file
 * @param {string} rawHostId
 */
export function getHostRecord(file, rawHostId) {
  const hostId = normalizeHostId(rawHostId);
  const store = readGroupStore(file);
  const host = store.hosts[hostId];
  return host ? { hostId, ...host } : undefined;
}

/**
 * 撤销主机（保留记录，hostId 不复用）。
 * @param {string} file
 * @param {string} rawHostId
 * @param {{now?: number}} [options]
 */
export function revokeHost(file, rawHostId, options = {}) {
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const hostId = normalizeHostId(rawHostId);
  const store = readGroupStore(file);
  const host = store.hosts[hostId];
  if (!host) return false;
  host.revokedAt = now;
  host.updatedAt = now;
  writeGroupStore(file, store);
  return true;
}

/**
 * 校验主机 token（后续 host 隧道握手用；token 只存 hash）。
 * @param {string} file
 * @param {string} rawHostId
 * @param {string} token
 */
export function verifyHostToken(file, rawHostId, token) {
  const record = getHostRecord(file, rawHostId);
  if (!record || Number(record.revokedAt) > 0) return false;
  if (typeof record.hostTokenHash !== 'string' || record.hostTokenHash === '') return false;
  const expected = sha256Base64Url(String(token ?? ''));
  // 常量时间比较（长度相同；不同则直接 false，避免无意义开销）。
  return expected.length === record.hostTokenHash.length && timingSafeEqualString(expected, record.hostTokenHash);
}

/** @param {string} a @param {string} b */
function timingSafeEqualString(a, b) {
  // 避免额外引入协议依赖：这里用 crypto.timingSafeEqual（长度已校验）。
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}


/**
 * 已注册主机刷新注册信息（hostToken 鉴权，不消耗邀请码）：
 * 服务端改了 mobilePort（或其它下发参数）后，主机可用它同步，无需重新注册。
 * @param {string} file
 * @param {{hostId: string, hostToken: string, mobilePort?: number, now?: number}} options
 */
export function refreshHost(file, options = {}) {
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const hostId = normalizeHostId(options.hostId);
  const token = String(options.hostToken ?? '');
  if (token === '') throw new GroupRegistrationError(GROUP_REGISTER_ERROR.INVALID_REQUEST, 'hostToken is required');
  const store = readGroupStore(file);
  const record = store.hosts[hostId];
  if (!record) throw new GroupRegistrationError(GROUP_REGISTER_ERROR.HOST_NOT_FOUND, 'host is not registered');
  if (Number(record.revokedAt) > 0) throw new GroupRegistrationError(GROUP_REGISTER_ERROR.HOST_REVOKED, 'host has been revoked');
  const expected = sha256Base64Url(token);
  const saved = typeof record.hostTokenHash === 'string' ? record.hostTokenHash : '';
  if (saved === '' || expected.length !== saved.length || !timingSafeEqualString(expected, saved)) {
    throw new GroupRegistrationError(GROUP_REGISTER_ERROR.INVALID_TOKEN, 'host token is not valid');
  }
  const port = options.mobilePort === undefined ? Number(record.mobilePort) || undefined : Number(options.mobilePort);
  if (port !== undefined) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new GroupRegistrationError(GROUP_REGISTER_ERROR.INVALID_REQUEST, 'mobilePort must be 1..65535');
    }
    record.mobilePort = port;
  }
  record.updatedAt = now;
  writeGroupStore(file, store);
  return {
    hostId,
    hostName: record.hostName ?? '',
    mobilePort: Number(record.mobilePort) || undefined,
    createdAt: Number(record.createdAt) || 0,
  };
}

/**
 * 找出可用的邀请（按 code hash 匹配）；不返回 code 本身。
 * @param {any} store
 * @param {string} code
 * @param {number} now
 * @returns {{inviteId: string, invite: any}}
 */
function findUsableInvite(store, code, now) {
  const codeHash = sha256Base64Url(code);
  const found = Object.entries(store.invites).find(([, invite]) => invite.codeHash === codeHash);
  if (!found) throw new GroupRegistrationError(GROUP_REGISTER_ERROR.INVALID_INVITE, 'invite code is not valid');
  const [inviteId, invite] = found;
  if (Number(invite.revokedAt) > 0) throw new GroupRegistrationError(GROUP_REGISTER_ERROR.INVALID_INVITE, 'invite has been revoked');
  if (Number(invite.expiresAt) > 0 && now >= Number(invite.expiresAt)) {
    throw new GroupRegistrationError(GROUP_REGISTER_ERROR.INVITE_EXPIRED, 'invite has expired');
  }
  const usedBy = Array.isArray(invite.usedBy) ? invite.usedBy : [];
  if (usedBy.length >= Number(invite.maxUses)) {
    throw new GroupRegistrationError(GROUP_REGISTER_ERROR.INVITE_EXHAUSTED, 'invite has no remaining uses');
  }
  return { inviteId, invite };
}

/**
 * 注册一台主机：消费邀请、分配 hostId、签发 hostToken（明文只出现一次）。
 * @param {object} options
 * @param {string} options.file
 * @param {string} options.inviteCode
 * @param {string} [options.hostName]
 * @param {number} [options.mobilePort]
 * @param {number} [options.maxHosts]
 * @param {number} [options.now]
 * @returns {{hostId: string, hostToken: string, hostName: string, mobilePort: number}}
 */
export function registerHost(options) {
  const {
    file,
    inviteCode,
    hostName,
    mobilePort = GROUP_DEFAULT_MOBILE_PORT,
    maxHosts = 200,
    now = Date.now(),
  } = options;
  if (typeof inviteCode !== 'string' || inviteCode.trim() === '' || inviteCode.length > 200) {
    throw new GroupRegistrationError(GROUP_REGISTER_ERROR.INVALID_REQUEST, 'inviteCode is required');
  }
  const port = Number(mobilePort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new GroupRegistrationError(GROUP_REGISTER_ERROR.INVALID_REQUEST, 'mobilePort must be 1..65535');
  }
  const store = readGroupStore(file);
  const { inviteId, invite } = findUsableInvite(store, String(inviteCode).trim(), now);
  if (activeHostCount(store) >= Number(maxHosts)) {
    throw new GroupRegistrationError(GROUP_REGISTER_ERROR.HOST_LIMIT, 'host limit reached');
  }

  const hostId = allocateHostId(store);
  const hostToken = generateHostToken();
  const friendlyName = normalizeGroupHostName(hostName);
  store.hosts[hostId] = {
    hostTokenHash: sha256Base64Url(hostToken),
    hostName: friendlyName,
    mobilePort: port,
    createdAt: now,
    updatedAt: now,
    revokedAt: 0,
  };
  if (!Array.isArray(invite.usedBy)) invite.usedBy = [];
  invite.usedBy.push({ hostId, at: now });
  writeGroupStore(file, store);
  return { hostId, hostToken, hostName: friendlyName, mobilePort: port };
}

/** 滚动窗口限速器（单进程内存；relay 重启后清空）。 */
class SlidingWindowLimiter {
  /**
   * @param {{perKeyPerMinute: number, globalPerMinute: number, now?: () => number}} options
   */
  constructor({ perKeyPerMinute, globalPerMinute, now = () => Date.now() }) {
    this.perKeyPerMinute = perKeyPerMinute;
    this.globalPerMinute = globalPerMinute;
    this.now = now;
    /** @type {Map<string, number[]>} */
    this.byKey = new Map();
    /** @type {number[]} */
    this.global = [];
  }

  /** 记录一次尝试；超限抛 RATE_LIMITED。 */
  hit(key) {
    const now = this.now();
    const cutoff = now - GROUP_RATE_WINDOW_MS;
    const entries = (this.byKey.get(key) ?? []).filter((ts) => ts > cutoff);
    this.global = this.global.filter((ts) => ts > cutoff);
    if (entries.length >= this.perKeyPerMinute || this.global.length >= this.globalPerMinute) {
      const perKeyWait = entries.length >= this.perKeyPerMinute ? entries[0] + GROUP_RATE_WINDOW_MS - now : 0;
      const globalWait = this.global.length >= this.globalPerMinute ? this.global[0] + GROUP_RATE_WINDOW_MS - now : 0;
      const retryAfterSec = Math.max(1, Math.ceil(Math.max(perKeyWait, globalWait) / 1000));
      throw new GroupRegistrationError(GROUP_REGISTER_ERROR.RATE_LIMITED, 'too many registration attempts', { retryAfterSec });
    }
    entries.push(now);
    this.byKey.set(key, entries);
    this.global.push(now);
  }
}

/**
 * 注册 HTTP 服务：挂在 relay 控制面（HTTPS/dev-http）上，供 host plugin 自助开通。
 */
export class GroupRegistrationService {
  /**
   * @param {object} options
   * @param {string} options.file group.json 路径
   * @param {number} [options.mobilePort]
   * @param {number} [options.maxHosts]
   * @param {{enabled?: boolean, maxAttemptsPerMinutePerIp?: number, maxAttemptsPerMinute?: number, bodyLimitBytes?: number}} [options.registration]
   * @param {any} [options.logger]
   * @param {() => number} [options.now]
   * @param {() => number} [options.getControlPort] 实际监听的控制面端口（注册响应里下发 WSS 地址用）
   * @param {number} [options.publicControlPort] 公网控制面端口（nginx/端口映射后的端口）
   */
  constructor(options) {
    this.file = options.file;
    this.relayDomain = typeof options.relayDomain === 'string' ? options.relayDomain : '';
    this.mobilePort = options.mobilePort ?? GROUP_DEFAULT_MOBILE_PORT;
    this.maxHosts = options.maxHosts ?? 200;
    const registration = options.registration ?? {};
    this.enabled = registration.enabled !== false;
    this.bodyLimitBytes = registration.bodyLimitBytes ?? GROUP_REGISTER_BODY_LIMIT_BYTES;
    this.logger = options.logger ?? { info() {}, warn() {}, error() {}, debug() {} };
    this.now = options.now ?? (() => Date.now());
    /** @type {string | undefined} relay 会话 token 签名公钥（PEM）；主机用它逐请求校验 token。 */
    this.tokenPublicKey = typeof options.tokenPublicKey === 'string' && options.tokenPublicKey !== '' ? options.tokenPublicKey : undefined;
    /** @type {() => number | undefined} */
    this.getControlPort = typeof options.getControlPort === 'function' ? options.getControlPort : () => undefined;
    /** @type {number | undefined} 公网控制面端口（不配则用实际监听端口）。 */
    this.publicControlPort = Number.isInteger(options.publicControlPort) && options.publicControlPort > 0
      ? options.publicControlPort
      : undefined;
    this.limiter = new SlidingWindowLimiter({
      perKeyPerMinute: registration.maxAttemptsPerMinutePerIp ?? 10,
      globalPerMinute: registration.maxAttemptsPerMinute ?? 120,
      now: this.now,
    });
  }

  /**
   * 处理一次注册（供 HTTP 层与测试调用）。
   * @param {{body: any, clientKey: string}} input
   */
  register({ body, clientKey }) {
    if (!this.enabled) throw new GroupRegistrationError(GROUP_REGISTER_ERROR.REGISTRATION_DISABLED, 'registration is disabled');
    this.limiter.hit(String(clientKey ?? 'unknown'));
    const payload = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const inviteCode = typeof payload.inviteCode === 'string' ? payload.inviteCode : '';
    if (inviteCode === '') throw new GroupRegistrationError(GROUP_REGISTER_ERROR.INVALID_REQUEST, 'inviteCode is required');
    return registerHost({
      file: this.file,
      inviteCode,
      hostName: payload.hostName,
      mobilePort: this.mobilePort,
      maxHosts: this.maxHosts,
      now: this.now(),
    });
  }

  /**
   * 注册响应里下发的控制面 WSS 地址（主机隧道用）：
   *   - scheme 跟随本次注册请求（https → wss / http → ws，兼容 dev）；
   *   - host 取请求 Host（生产=relay 域名；dev=127.0.0.1）；
   *   - 端口优先 group.publicControlPort（nginx/端口映射后的公网端口），否则取实际监听端口。
   * 职责分离后，注册 API 端口 ≠ 控制面 WSS 端口，主机必须用这个地址回连隧道。
   * @param {import('node:http').IncomingMessage} req
   */
  #controlUrl(req) {
    const hostHeader = typeof req.headers?.host === 'string' ? req.headers.host.trim() : '';
    if (hostHeader === '') return undefined;
    let hostname;
    try {
      hostname = new URL(`https://${hostHeader}`).hostname;
    } catch {
      return undefined;
    }
    if (hostname === '') return undefined;
    const port = this.publicControlPort ?? Number(this.getControlPort());
    if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
    const scheme = req.socket && /** @type {any} */ (req.socket).encrypted ? 'wss' : 'ws';
    return `${scheme}://${hostname}:${port}${CONTROL_PATH}`;
  }

  /**
   * 刷新已注册主机的下发信息（hostToken 鉴权，不消耗邀请码）。
   * @param {{body: any, clientKey: string, hostToken: string}} input
   */
  refresh({ body, clientKey, hostToken }) {
    this.limiter.hit(String(clientKey ?? 'unknown'));
    const payload = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const result = refreshHost(this.file, {
      hostId: payload.hostId,
      hostToken,
      mobilePort: this.mobilePort,
      now: this.now(),
    });
    return result;
  }

  /**
   * 处理 POST /__group/refresh（hostToken 鉴权；返回最新 mobilePort/controlUrl 等）。
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {string} [clientKey]
   */
  async handleRefreshHttp(req, res, clientKey) {
    try {
      if (req.method !== 'POST') {
        return sendJson(res, 405, { ok: false, error: { code: GROUP_REGISTER_ERROR.INVALID_REQUEST, message: 'method not allowed' } }, { allow: 'POST' });
      }
      const auth = typeof req.headers.authorization === 'string' ? req.headers.authorization.trim() : '';
      const match = /^Bearer\s+(.+)$/i.exec(auth);
      const hostToken = match ? match[1].trim() : '';
      if (hostToken === '') {
        return sendJson(res, 401, { ok: false, error: { code: GROUP_REGISTER_ERROR.INVALID_TOKEN, message: 'host token is required' } });
      }
      const body = await readJsonBody(req, this.bodyLimitBytes);
      const result = this.refresh({ body, clientKey: clientKey ?? req.socket.remoteAddress ?? 'unknown', hostToken });
      const controlUrl = this.#controlUrl(req);
      this.logger.info(`group: refreshed host ${result.hostId} (mobilePort=${result.mobilePort})`);
      return sendJson(res, 200, {
        ok: true,
        protocolVersion: 1,
        hostId: result.hostId,
        hostName: result.hostName,
        relayDomain: this.relayDomain,
        mobilePort: result.mobilePort,
        ...(controlUrl ? { controlUrl } : {}),
        ...(this.tokenPublicKey ? { tokenPublicKey: this.tokenPublicKey } : {}),
      });
    } catch (err) {
      if (err instanceof GroupRegistrationError) {
        const status = groupErrorStatus(err.code);
        return sendJson(res, status, { ok: false, error: { code: err.code, message: err.message } });
      }
      this.logger.error(`group: refresh failed: ${err && err.message ? err.message : String(err)}`);
      return sendJson(res, 500, { ok: false, error: { code: 'internal', message: 'refresh failed' } });
    }
  }

  /**
   * 处理 POST 注册请求（响应 200 JSON；错误返回稳定 code）。
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {string} [clientKey]
   */
  async handleHttp(req, res, clientKey) {
    try {
      if (req.method !== 'POST') {
        return sendJson(res, 405, { ok: false, error: { code: GROUP_REGISTER_ERROR.INVALID_REQUEST, message: 'method not allowed' } }, { allow: 'POST' });
      }
      const body = await readJsonBody(req, this.bodyLimitBytes);
      const result = this.register({ body, clientKey: clientKey ?? req.socket.remoteAddress ?? 'unknown' });
      this.logger.info(`group: registered host ${result.hostId}${result.hostName ? ` (name: ${result.hostName})` : ''}`);
      const controlUrl = this.#controlUrl(req);
      return sendJson(res, 200, {
        ok: true,
        protocolVersion: 1,
        hostId: result.hostId,
        hostToken: result.hostToken,
        hostName: result.hostName,
        relayDomain: this.relayDomain,
        mobilePort: result.mobilePort,
        ...(controlUrl ? { controlUrl } : {}),
        ...(this.tokenPublicKey ? { tokenPublicKey: this.tokenPublicKey } : {}),
      });
    } catch (err) {
      if (err instanceof GroupRegistrationError) {
        const status = groupErrorStatus(err.code);
        const headers = err.retryAfterSec ? { 'retry-after': String(err.retryAfterSec) } : undefined;
        return sendJson(res, status, { ok: false, error: { code: err.code, message: err.message } }, headers);
      }
      this.logger.error(`group: registration failed: ${err && err.message ? err.message : String(err)}`);
      return sendJson(res, 500, { ok: false, error: { code: 'internal', message: 'registration failed' } });
    }
  }
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limit
 * @returns {Promise<any>}
 */
function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('data', (chunk) => {
      if (settled || tooLarge) return;
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (tooLarge) {
        reject(new GroupRegistrationError(GROUP_REGISTER_ERROR.INVALID_REQUEST, 'request body too large'));
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw === '') return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new GroupRegistrationError(GROUP_REGISTER_ERROR.INVALID_REQUEST, 'request body must be valid JSON'));
      }
    });
    req.on('error', fail);
  });
}

/** @param {import('node:http').ServerResponse} res @param {number} status @param {any} body @param {Record<string,string>} [headers] */
function sendJson(res, status, body, headers) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
    ...(headers ?? {}),
  });
  res.end(payload);
}
