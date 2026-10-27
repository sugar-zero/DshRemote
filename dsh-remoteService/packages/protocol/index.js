/**
 * dsh-remote-protocol —— DSH 远程访问（方案 B2）共享协议。
 *
 * 本文件保持零外部依赖（仅 node:crypto），可同时被 relay、host plugin 与 POC 脚本使用。
 * App（React Native）内部有一份等价实现：packages 不跨运行时共享代码，但语义/常量必须一致。
 */
import { createHash, createHmac, createPrivateKey, createPublicKey, randomBytes, sign, timingSafeEqual, verify } from 'node:crypto';

/** 协议版本；relay 与 host plugin 握手时校验。 */
export const PROTOCOL_VERSION = 1;

/** relay 控制面 WebSocket 路径。 */
export const CONTROL_PATH = '/control';
/** 主机插件在 DSH 本机 webServer 上注册的管理 API 前缀（仅本机浏览器可访问）。 */
export const ADMIN_BASE = '/api/remote-access';
/** 主机插件 TLS 监听上的远程内部路径前缀（App 经中继访问）。 */
export const TUNNEL_BASE = '/__dsh_remote';
export const PAIR_PATH = `${TUNNEL_BASE}/pair`;
export const PAIR_STATUS_PATH = `${TUNNEL_BASE}/pair/status`;
export const PAIR_APPROVE_PATH = `${TUNNEL_BASE}/pair/approve`;
export const PUSH_TOKEN_PATH = `${TUNNEL_BASE}/push-token`;
export const STATUS_PATH = `${TUNNEL_BASE}/status`;
export const AUDIT_PATH = `${TUNNEL_BASE}/audit`;
export const DEVICES_PATH = `${TUNNEL_BASE}/devices`;
export const DEVICE_REVOKE_PATH_PREFIX = `${TUNNEL_BASE}/devices/`;
/** 远程触发主机 DSH 客户端重启（App「重启主机」入口；仅 POST，成功 202）。 */
export const RESTART_PATH = `${TUNNEL_BASE}/restart`;

/** 配对二维码 URI scheme。 */
export const PAIR_URI_SCHEME = 'dshremote';
export const PAIR_URI_VERSION = 1;

/** 主机名后缀约定：<hostId>.<relayDomain>。 */
export function hostFqdn(hostId, relayDomain) {
  return `${hostId}.${relayDomain}`;
}

/** SHA-256 → base64url（无填充）。 */
export function sha256Base64Url(value) {
  const buf = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
  return buf.length >= 0 ? createHash('sha256').update(buf).digest('base64url') : '';
}

/** 把完整指纹切成可读分组（仅用于屏幕人工核对，不是 pin）。 */
export function shortFingerprint(base64urlHash, groups = 4, groupSize = 4) {
  const clean = String(base64urlHash).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const out = [];
  for (let i = 0; i < groups && i * groupSize < clean.length; i += 1) {
    out.push(clean.slice(i * groupSize, (i + 1) * groupSize));
  }
  return out.join(' · ');
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** 字节 → Crockford base32 字符串（去掉易混字符 I/L/O/U）。 */
export function base32Encode(bytes, length = 12) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < length) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length >= length) break;
  }
  if (out.length < length && bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out.padEnd(length, '0').slice(0, length);
}

/** 生成 12 位、约 60 bit 的备用配对码（屏幕人工输入兜底；唯一信任仍是一次性密钥）。 */
export function pairingCode(secretBytes) {
  const raw = Buffer.isBuffer(secretBytes) ? secretBytes : Buffer.from(secretBytes);
  return base32Encode(raw, 12);
}

/** 生成 32 字节一次性配对密钥（base64url）。 */
export function newPairingSecret() {
  return randomBytes(32).toString('base64url');
}

/**
 * SAS 短码：绑定 secret + 主机公钥 + 设备公钥，供桌面/手机屏幕对照。
 * @returns {string} 形如 `K7QM-3F9D` 的 8 位短码。
 */
export function pairingSas(secret, hostPublicKeyB64Url, devicePublicKeyB64Url) {
  const mac = createHmac('sha256', String(secret))
    .update(`${hostPublicKeyB64Url}\n${devicePublicKeyB64Url}\ndsh-pair`, 'utf8')
    .digest();
  const raw = base32Encode(mac, 8);
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

/** 常量时间字符串比较（长度不同也走比较，避免早退）。 */
export function safeEqualStrings(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  const len = Math.max(ab.length, bb.length);
  const aPad = Buffer.alloc(len);
  const bPad = Buffer.alloc(len);
  ab.copy(aPad);
  bb.copy(bPad);
  return timingSafeEqual(aPad, bPad) && ab.length === bb.length;
}

/**
 * 构造配对二维码 URI（单行、百分号编码）。
 * @param {{host: string, secret: string, hostFingerprint: string, expiresAt: number, relayDomain?: string}} opts
 */
export function buildPairingUri({ host, secret, hostFingerprint, expiresAt, relayDomain }) {
  const url = new URL(`${PAIR_URI_SCHEME}://pair`);
  url.searchParams.set('v', String(PAIR_URI_VERSION));
  url.searchParams.set('host', host);
  url.searchParams.set('secret', secret);
  url.searchParams.set('hostfp', hostFingerprint);
  url.searchParams.set('exp', String(Math.floor(expiresAt / 1000)));
  if (relayDomain) url.searchParams.set('relay', relayDomain);
  return url.href;
}

/** 解析配对 URI；无效时抛错。 */
export function parsePairingUri(uri) {
  const url = new URL(String(uri));
  if (url.protocol !== `${PAIR_URI_SCHEME}:`) throw new Error('不是 DSH 远程配对 URI');
  if (url.hostname !== 'pair') throw new Error('配对 URI 必须使用 dshremote://pair');
  const version = Number(url.searchParams.get('v') ?? '0');
  if (version !== PAIR_URI_VERSION) throw new Error(`不支持的配对协议版本 ${String(version)}`);
  const host = url.searchParams.get('host');
  const secret = url.searchParams.get('secret');
  const hostFingerprint = url.searchParams.get('hostfp');
  const exp = Number(url.searchParams.get('exp') ?? '0');
  if (!host || !secret || !hostFingerprint || !Number.isFinite(exp)) throw new Error('配对 URI 缺少字段');
  return { version, host, secret, hostFingerprint, expiresAt: exp * 1000, relayDomain: url.searchParams.get('relay') ?? undefined };
}

/** relay 控制面消息类型（JSON text frame）。 */
export const RELAY_MSG = Object.freeze({
  HOST_HELLO: 'host.hello',
  HOST_READY: 'host.ready',
  HOST_HEARTBEAT: 'host.heartbeat',
  HOST_OPEN: 'host.open',
  HOST_OPENED: 'host.opened',
  HOST_CLOSE: 'host.close',
  PUSH_REGISTER: 'push.register',
  PUSH_SEND: 'push.send',
  PUSH_RESULT: 'push.result',
  HOST_STATUS: 'host.status',
  DEVICE_SYNC: 'device.sync',
  DEVICE_SYNCED: 'device.synced',
  DEVICE_REVOKE: 'device.revoke',
  DEVICE_REVOKED: 'device.revoked',
  ERROR: 'error',
});

/** relay ↔ host 数据面二进制帧：1 字节类型 + 4 字节大端 streamId + payload。 */
export const FRAME_TYPE = Object.freeze({ DATA: 1, CLOSE: 2 });
export const FRAME_HEADER_BYTES = 5;

export function encodeFrame(type, streamId, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const out = Buffer.allocUnsafe(FRAME_HEADER_BYTES + body.length);
  out.writeUInt8(type, 0);
  out.writeUInt32BE(streamId >>> 0, 1);
  body.copy(out, FRAME_HEADER_BYTES);
  return out;
}

export function decodeFrame(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length < FRAME_HEADER_BYTES) return undefined;
  return {
    type: b.readUInt8(0),
    streamId: b.readUInt32BE(1),
    payload: b.subarray(FRAME_HEADER_BYTES),
  };
}

/** 规范化 relay 根地址（ws/wss → http/https 无关；只接受 scheme + host[:port]）。 */
export function normalizeRelayUrl(raw) {
  const url = new URL(String(raw));
  if (!['wss:', 'ws:', 'https:', 'http:'].includes(url.protocol)) throw new Error('relay 地址必须是 ws(s):// 或 http(s)://');
  return `${url.protocol}//${url.host}`;
}

/** 默认管理 API 路径（与 docs/ADMIN-API.md 保持一致）。 */
export const ADMIN_ROUTES = Object.freeze({
  status: `${ADMIN_BASE}/status`,
  config: `${ADMIN_BASE}/config`,
  pairingStart: `${ADMIN_BASE}/pairing/start`,
  pairingCancel: `${ADMIN_BASE}/pairing/cancel`,
  pairingApprove: `${ADMIN_BASE}/pairing/approve`,
  pairingQrSvg: `${ADMIN_BASE}/pairing/qr.svg`,
  devices: `${ADMIN_BASE}/devices`,
  revokeDevice: `${ADMIN_BASE}/devices/:id/revoke`,
  audit: `${ADMIN_BASE}/audit`,
});

// ---------------------------------------------------------------------------
// 群体服务版（A 模式，2026-10-27 起）
// ---------------------------------------------------------------------------
// 与 main 的 B2 协议并存：main 用配对 URI v1 + 设备 mTLS；群体版用服务端
// 自助注册（邀请码 → 服务端分配 hostId/hostToken）+ 短时 token（QR v2）。
// 常量由 relay / host plugin / App 共用；App 内部需保持等价实现。

/** 群体服务版注册协议版本。 */
export const GROUP_PROTOCOL_VERSION = 1;

/** relay 控制面上的自助注册路径（POST JSON）。 */
export const GROUP_REGISTER_PATH = '/__group/register';

/** 群体版默认手机访问端口（部署方可配置；relay 边缘终止 TLS 后使用）。 */
export const GROUP_DEFAULT_MOBILE_PORT = 11443;

/** 注册请求体上限（字节）。 */
export const GROUP_REGISTER_BODY_LIMIT_BYTES = 8 * 1024;

/** 注册错误码（relay 返回 / host plugin 提示共用）。 */
export const GROUP_REGISTER_ERROR = Object.freeze({
  INVALID_REQUEST: 'invalid_request',
  INVALID_INVITE: 'invalid_invite',
  INVITE_EXPIRED: 'invite_expired',
  INVITE_EXHAUSTED: 'invite_exhausted',
  RATE_LIMITED: 'rate_limited',
  REGISTRATION_DISABLED: 'registration_disabled',
  HOST_LIMIT: 'host_limit',
});

const GROUP_HOST_ID_RE = /^h_[a-z0-9]{6,30}$/;

/** 服务端管理的 hostId 生成（DNS 首标签安全、大小写/易混字符已排除）。 */
export function generateGroupHostId() {
  return `h_${base32Encode(randomBytes(6), 10).toLowerCase()}`;
}

/** 校验服务端分配的 hostId 形态。 */
export function isGroupHostId(raw) {
  return typeof raw === 'string' && GROUP_HOST_ID_RE.test(raw);
}

/** 友好名称规范化：去掉控制字符、trim、最长 64 字符；空串表示未命名。 */
export function normalizeGroupHostName(raw) {
  const value = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return value.slice(0, 64);
}

/** host.open 的 kind：群体版边缘 TLS 终止后的隧道流（relay 终止 TLS，主机侧接本地明文代理）。 */
export const GROUP_EDGE_STREAM_KIND = 'group-edge';


// ---------------------------------------------------------------------------
// 群体服务版：设备会话鉴权（P1 切片 3）
// ---------------------------------------------------------------------------
// 设备密钥 = P-256（Secure Enclave / Keystore）；配对时把公钥（未压缩点 65B，
// base64url）注册给主机，主机同步到 relay；设备用私钥签 nonce 换短时 token；
// token 由 relay 的 Ed25519 私钥签名，主机用 relay 公钥逐请求校验（无需信任握手来源）。

/** relay 边缘上的设备鉴权接口（TLS 已由 relay 终止）。 */
export const GROUP_AUTH_CHALLENGE_PATH = '/__group/auth/challenge';
export const GROUP_AUTH_TOKEN_PATH = '/__group/auth/token';

/** 会话 cookie 名（必须 __Host- 前缀 + host-only + Secure）。 */
export const GROUP_SESSION_COOKIE = '__Host-dsh_session';

/** 会话 token 版本与前缀。 */
export const GROUP_SESSION_TOKEN_VERSION = 1;
/** 默认 token 有效期（15 分钟；配置允许 1–120 分钟）。 */
export const GROUP_SESSION_DEFAULT_TTL_MS = 15 * 60 * 1000;
/** 默认 challenge 有效期（2 分钟）。 */
export const GROUP_CHALLENGE_DEFAULT_TTL_MS = 2 * 60 * 1000;

const GROUP_DEVICE_ID_RE = /^d_[a-z0-9]{6,40}$/;

/** 生成设备 ID（服务端/主机生成均可；DNS 无关，仅作稳定标识）。 */
export function newGroupDeviceId() {
  return `d_${randomBytes(8).toString('hex')}`;
}

/** 校验设备 ID 形态。 */
export function isValidGroupDeviceId(raw) {
  return typeof raw === 'string' && GROUP_DEVICE_ID_RE.test(raw);
}

/** 设备 challenge 签名的消息（绑定 host + device + nonce，防跨主机重放）。 */
export function groupDeviceChallengeMessage(hostId, deviceId, nonce) {
  return Buffer.from(`${hostId}\n${deviceId}\n${nonce}`, 'utf8');
}

/** base64url 未压缩 P-256 公钥点（0x04 || X || Y）→ KeyObject。 */
export function groupDevicePublicKeyObject(publicKeyB64Url) {
  const raw = Buffer.from(String(publicKeyB64Url ?? ''), 'base64url');
  if (raw.length !== 65 || raw[0] !== 0x04) {
    throw new Error('group device public key must be an uncompressed P-256 point (65 bytes, base64url)');
  }
  const x = raw.subarray(1, 33).toString('base64url');
  const y = raw.subarray(33, 65).toString('base64url');
  try {
    return createPublicKey({ key: { kty: 'EC', crv: 'P-256', x, y }, format: 'jwk' });
  } catch {
    throw new Error('group device public key is not a valid P-256 point');
  }
}

/** 校验设备对消息的 ECDSA-SHA256 签名（DER，base64url）。 */
export function verifyGroupDeviceSignature({ publicKey, message, signature }) {
  try {
    const key = groupDevicePublicKeyObject(publicKey);
    return verify('sha256', Buffer.isBuffer(message) ? message : Buffer.from(String(message), 'utf8'), key, Buffer.from(String(signature ?? ''), 'base64url'));
  } catch {
    return false;
  }
}

/** 新 challenge nonce（32B base64url）。 */
export function newGroupChallenge() {
  return randomBytes(32).toString('base64url');
}

/**
 * 签发短时会话 token（Ed25519）。
 * @param {{privateKey: import('node:crypto').KeyObject | string, hostId: string, deviceId: string, iat?: number, ttlMs?: number}} options
 * @returns {{token: string, payload: {v:number, hostId:string, deviceId:string, iat:number, exp:number}}}
 */
export function signGroupSessionToken({ privateKey, hostId, deviceId, iat = Date.now(), ttlMs = GROUP_SESSION_DEFAULT_TTL_MS }) {
  const key = typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey;
  const payload = {
    v: GROUP_SESSION_TOKEN_VERSION,
    hostId: String(hostId),
    deviceId: String(deviceId),
    iat: Math.floor(iat / 1000),
    exp: Math.floor((iat + ttlMs) / 1000),
  };
  const version = `v${GROUP_SESSION_TOKEN_VERSION}`;
  const body = `${version}.${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
  const signature = sign(null, Buffer.from(body, 'utf8'), key).toString('base64url');
  return { token: `${body}.${signature}`, payload };
}

/**
 * 校验会话 token（Ed25519 公钥 PEM/KeyObject；校验版本/签名/过期/可选 hostId）。
 * @param {{token: string, publicKey: import('node:crypto').KeyObject | string, now?: number, hostId?: string}} options
 * @returns {{v:number, hostId:string, deviceId:string, iat:number, exp:number} | undefined}
 */
export function verifyGroupSessionToken({ token, publicKey, now = Date.now(), hostId }) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3 || parts[0] !== `v${GROUP_SESSION_TOKEN_VERSION}`) return undefined;
  const [version, body, signature] = parts;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (!payload || payload.v !== GROUP_SESSION_TOKEN_VERSION) return undefined;
  let key;
  try {
    key = typeof publicKey === 'string' ? createPublicKey(publicKey) : publicKey;
  } catch {
    return undefined;
  }
  let ok = false;
  try {
    ok = verify(null, Buffer.from(`${version}.${body}`, 'utf8'), key, Buffer.from(signature, 'base64url'));
  } catch {
    ok = false;
  }
  if (!ok) return undefined;
  if (hostId !== undefined && payload.hostId !== String(hostId)) return undefined;
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now) return undefined;
  return payload;
}

/** 解析 Cookie 头为对象（同名取第一个）。 */
export function parseCookieHeader(headerValue) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const part of String(headerValue ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || Object.hasOwn(out, name)) continue;
    out[name] = part.slice(eq + 1).trim();
  }
  return out;
}
