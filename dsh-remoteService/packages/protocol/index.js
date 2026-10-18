/**
 * dsh-remote-protocol —— DSH 远程访问（方案 B2）共享协议。
 *
 * 本文件保持零外部依赖（仅 node:crypto），可同时被 relay、host plugin 与 POC 脚本使用。
 * App（React Native）内部有一份等价实现：packages 不跨运行时共享代码，但语义/常量必须一致。
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

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
