/**
 * DSH Remote — 群体服务版（A 模式，token 鉴权）配对/会话协议（客户端）。
 *
 * 本 App 只支持群体版：配对二维码是 v2（`dshremote://pair?v=2&...&auth=token`），
 * 设备身份是「配对注册的 P-256 设备密钥 + relay 签发的短时 token」，不再有设备证书 /
 * mTLS（classic/单体模式已从 App 中删除）。
 *
 * Contract sources:
 *  - docs/group-service-design.zh.md（群体服务版设计）
 *  - dsh-remoteService/packages/relay/README.md §10（edge auth 端点）
 *
 * Design notes
 *  - This file must stay dependency-free (no React Native, no network) so the
 *    parsing/validation rules can be unit-tested under Node.
 *  - QR URIs are parsed by hand instead of `new URL()`: React Native's URL
 *    polyfill does not reliably support custom schemes (`dshremote://`).
 *  - Pairing URIs carry ONLY a one-time secret (256-bit, <=120s). Long-lived
 *    tokens / browser cookies must never appear in a QR code.
 */

export const PAIRING_SCHEME = 'dshremote';
export const PAIRING_AUTHORITY = 'pair';

/** Remote tunnel paths served by the host plugin (群体版：配对 + 已鉴权内部接口). */
export const REMOTE_PATHS = {
  pair: '/__dsh_remote/pair',
  pairStatus: '/__dsh_remote/pair/status',
  /** 已鉴权设备可读的主机状态（含「重启主机」组件开关 restart.enabled）。 */
  status: '/__dsh_remote/status',
  /** 请求主机重启 DSH 客户端（需组件已启用；成功 202）。 */
  restart: '/__dsh_remote/restart',
  /** 登记本机 APNs device token（主机再转给 relay；需群体版会话 token）。 */
  pushToken: '/__dsh_remote/push-token',
} as const;

/** Pairing URI protocol version for the group (A-mode) flow. */
export const PAIRING_URI_VERSION_GROUP = 2;
/** `auth=token` marker in a v2 pairing URI. */
export const PAIR_AUTH_TOKEN = 'token';
/** Session cookie name; must stay `__Host-` prefixed (host-only, Secure). */
export const GROUP_SESSION_COOKIE = '__Host-dsh_session';
/** Relay edge auth endpoints (terminated by the deployment's relay, not the host). */
export const GROUP_PATHS = {
  challenge: '/__group/auth/challenge',
  token: '/__group/auth/token',
} as const;

export type PairingUriErrorCode =
  | 'invalid_uri'
  | 'unsupported_scheme'
  | 'unsupported_version'
  | 'invalid_field'
  | 'expired';

export class PairingUriError extends Error {
  readonly code: PairingUriErrorCode;
  readonly field?: string;

  constructor(code: PairingUriErrorCode, message: string, field?: string) {
    super(message);
    this.name = 'PairingUriError';
    this.code = code;
    this.field = field;
    Object.setPrototypeOf(this, PairingUriError.prototype);
  }
}

// Relay base domains are strict DNS names.
const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/i;
// Tunnel hosts are `<hostId>.<relayDomain>`, and host ids are documented as
// `h_ab12cd34` (underscore) — so allow `_` inside tunnel host labels.
const TUNNEL_HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)(?:\.(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?))*$/i;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const PAIRING_URI_RE = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#[\s\S]*)?$/;
const GROUP_HOST_ID_RE = /^h_[a-z0-9]{6,30}$/;

function base64UrlByteLength(value: string): number {
  if (!BASE64URL_RE.test(value)) return -1;
  if (value.length % 4 === 1) return -1;
  const padding = (4 - (value.length % 4)) % 4;
  return Math.floor(((value.length + padding) * 3) / 4) - padding;
}

/** True when `value` decodes to exactly `byteLength` bytes of base64url data. */
export function isBase64UrlOfLength(value: string, byteLength: number): boolean {
  return base64UrlByteLength(value) === byteLength;
}

/**
 * Validate a host of the form `hostname` or `hostname:port` (port allowed only
 * for local/dev relays). IPv6 literals are intentionally unsupported in the POC.
 */
export function isValidTunnelHost(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 260) return false;
  if (/[/\\@?#\s]/.test(trimmed)) return false;
  const match = /^([^:]+)(?::(\d{1,5}))?$/.exec(trimmed);
  if (!match) return false;
  const hostname = match[1];
  const port = match[2];
  if (hostname === undefined || !TUNNEL_HOSTNAME_RE.test(hostname)) return false;
  if (port !== undefined) {
    const portNumber = Number(port);
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) return false;
  }
  return true;
}

function hostnameOf(host: string): string {
  const match = /^([^:]+)(?::\d{1,5})?$/.exec(host);
  return (match?.[1] ?? host).toLowerCase();
}

function parseQueryString(query: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const part of query.split('&')) {
    if (!part) continue;
    const equals = part.indexOf('=');
    const rawKey = equals < 0 ? part : part.slice(0, equals);
    const rawValue = equals < 0 ? '' : part.slice(equals + 1);
    let key: string;
    let value: string;
    try {
      key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
      value = decodeURIComponent(rawValue.replace(/\+/g, ' '));
    } catch {
      throw new PairingUriError('invalid_uri', '配对链接包含无法解码的百分号转义（URL 可能被截断）。');
    }
    if (entries.has(key)) {
      throw new PairingUriError('invalid_uri', `配对链接包含重复参数 "${key}"。`, key);
    }
    entries.set(key, value);
  }
  return entries;
}

export interface ParsePairingUriOptions {
  /** Clock override for tests. Defaults to `Date.now()`. */
  now?: number;
  /** Parse even if the URI is expired (used to render a readable error). */
  allowExpired?: boolean;
}

/** Parsed group-mode pairing URI (`dshremote://pair?v=2&...&auth=token`). */
export interface GroupPairingUri {
  mode: 'group';
  version: typeof PAIRING_URI_VERSION_GROUP;
  /** `<hostId>.<relayDomain>` (no port; the port is carried separately). */
  host: string;
  /** Mobile access port assigned by the service (default 11443). */
  port: number;
  /** One-time pairing secret (base64url, 32 random bytes). Never log it. */
  secret: string;
  /** Full SHA-256 host identity fingerprint, base64url. */
  hostFingerprint: string;
  /** Expiry in **milliseconds** (wire value is seconds). */
  expiresAt: number;
  relayDomain: string;
  hostId: string;
  raw: string;
}

/**
 * Parse and fully validate a v2 group-mode pairing URI.
 *
 * Throws {@link PairingUriError} with a machine-readable `code` and a
 * user-presentable Chinese `message`.
 */
export function parseGroupPairingUri(input: string, options: ParsePairingUriOptions = {}): GroupPairingUri {
  const now = options.now ?? Date.now();
  const raw = input.trim().replace(/^["'<]+|["'>]+$/g, '').trim();
  if (!raw) throw new PairingUriError('invalid_uri', '配对链接为空。');
  const uriMatch = PAIRING_URI_RE.exec(raw);
  if (!uriMatch) {
    throw new PairingUriError('invalid_uri', '无法解析配对链接。链接应以 dshremote://pair?v=2&... 开头。');
  }
  const scheme = uriMatch[1] ?? '';
  const authority = uriMatch[2] ?? '';
  const path = uriMatch[3] ?? '';
  const query = uriMatch[4];
  if (scheme.toLowerCase() !== PAIRING_SCHEME) {
    throw new PairingUriError('unsupported_scheme', `不支持的链接协议 "${scheme}"，应为 ${PAIRING_SCHEME}://。`);
  }
  if (authority.toLowerCase() !== PAIRING_AUTHORITY) {
    throw new PairingUriError('invalid_uri', '这不是配对链接（dshremote://pair/...）。', 'authority');
  }
  if (path !== '' && path !== '/') throw new PairingUriError('invalid_uri', `配对链接包含未知路径 "${path}"。`, 'path');
  if (query === undefined || query === '') {
    throw new PairingUriError('invalid_uri', '配对链接缺少参数。请在主机上重新生成二维码。', 'query');
  }

  const params = parseQueryString(query);
  const require = (name: string): string => {
    const value = params.get(name);
    if (value === undefined || value === '') {
      throw new PairingUriError('invalid_uri', `配对链接缺少参数 "${name}"，请重新生成二维码。`, name);
    }
    return value;
  };

  const versionRaw = require('v');
  if (versionRaw !== String(PAIRING_URI_VERSION_GROUP)) {
    throw new PairingUriError(
      'unsupported_version',
      `配对链接协议版本为 v${versionRaw}，当前 App 仅支持 v${PAIRING_URI_VERSION_GROUP}（群体版）。`,
      'v',
    );
  }
  const auth = require('auth');
  if (auth !== PAIR_AUTH_TOKEN) {
    throw new PairingUriError('invalid_field', `群体版配对链接的 auth 参数应为 "${PAIR_AUTH_TOKEN}"。`, 'auth');
  }

  const host = require('host');
  if (!isValidTunnelHost(host) || host.includes(':')) {
    throw new PairingUriError('invalid_field', `配对链接中的主机地址无效："${host}"。`, 'host');
  }

  const portRaw = require('port');
  if (!/^\d{1,5}$/.test(portRaw)) {
    throw new PairingUriError('invalid_field', '配对链接中的端口格式无效。', 'port');
  }
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new PairingUriError('invalid_field', `配对链接中的端口无效："${portRaw}"。`, 'port');
  }

  const secret = require('secret');
  if (!isBase64UrlOfLength(secret, 32)) {
    throw new PairingUriError('invalid_field', '配对密钥格式无效（应为 32 字节 base64url）。', 'secret');
  }
  const hostFingerprint = require('hostfp');
  if (!isBase64UrlOfLength(hostFingerprint, 32)) {
    throw new PairingUriError('invalid_field', '主机指纹格式无效（应为 43 位 base64url）。', 'hostfp');
  }
  const expiresAtSecondsRaw = require('exp');
  if (!/^\d{1,12}$/.test(expiresAtSecondsRaw)) {
    throw new PairingUriError('invalid_field', '配对链接的过期时间格式无效。', 'exp');
  }
  const expiresAt = Number(expiresAtSecondsRaw) * 1000;
  if (!options.allowExpired && expiresAt <= now) {
    throw new PairingUriError('expired', '配对二维码已过期，请在主机上重新生成。', 'exp');
  }

  const relayDomain = require('relay');
  if (!HOSTNAME_RE.test(relayDomain) || relayDomain.length > 253) {
    throw new PairingUriError('invalid_field', `配对链接中的中继域名无效："${relayDomain}"。`, 'relay');
  }
  const hostId = require('hostid');
  if (!GROUP_HOST_ID_RE.test(hostId)) {
    throw new PairingUriError('invalid_field', `配对链接中的主机 ID 无效："${hostId}"。`, 'hostid');
  }

  const hostname = hostnameOf(host);
  const relayLower = relayDomain.toLowerCase();
  const expectedHost = `${hostId}.${relayLower}`.toLowerCase();
  if (hostname !== expectedHost) {
    throw new PairingUriError(
      'invalid_field',
      `主机地址 "${host}" 与服务端下发的主机 ID/中继域名（${expectedHost}）不一致，链接可能被篡改。`,
      'host',
    );
  }

  return {
    mode: 'group',
    version: PAIRING_URI_VERSION_GROUP,
    host: hostname,
    port,
    secret,
    hostFingerprint,
    expiresAt,
    relayDomain: relayLower,
    hostId,
    raw,
  };
}

/** Milliseconds left before the pairing URI expires (never negative). */
export function pairingTimeLeftMs(pairing: Pick<GroupPairingUri, 'expiresAt'>, now = Date.now()): number {
  return Math.max(0, pairing.expiresAt - now);
}

// ---------------------------------------------------------------------------
// Fingerprint display helpers
// ---------------------------------------------------------------------------

/** Format a base64url fingerprint into space-separated groups for human reading. */
export function formatFingerprint(fingerprint: string, groupSize = 4): string {
  const cleaned = fingerprint.trim().replace(/\s+/g, '');
  if (!cleaned) return '';
  const groups = cleaned.match(new RegExp(`.{1,${groupSize}}`, 'g'));
  return groups ? groups.join(' ') : cleaned;
}

/**
 * Short fingerprint for eyeballing against the desktop UI. The full value stays
 * authoritative (short fingerprints are display-only, never a pin).
 */
export function shortFingerprint(fingerprint: string): string {
  const cleaned = fingerprint.trim().replace(/\s+/g, '');
  if (cleaned.length <= 16) return formatFingerprint(cleaned);
  return `${formatFingerprint(cleaned.slice(0, 8))} … ${formatFingerprint(cleaned.slice(-8))}`;
}

/** Shorten a long id/label for display (e.g. device id / key label). */
export function truncateMiddle(value: string, keep = 6): string {
  if (value.length <= keep * 2 + 1) return value;
  return `${value.slice(0, keep)}…${value.slice(-keep)}`;
}

// ---------------------------------------------------------------------------
// Group service URLs + payload types
// ---------------------------------------------------------------------------

export type PairPlatform = 'ios' | 'android';

/** Origin of the group tunnel for a host/port (`https://<host>[:<port>]`, 443 omitted). */
export function groupOrigin(host: string, port: number): string {
  const safePort = Number.isInteger(port) && port > 0 && port <= 65535 ? port : 443;
  return safePort === 443 ? `https://${host}` : `https://${host}:${safePort}`;
}

export function groupPairUrl(host: string, port: number): string {
  return `${groupOrigin(host, port)}${REMOTE_PATHS.pair}`;
}

export function groupPairStatusUrl(host: string, port: number, ticket: string): string {
  return `${groupOrigin(host, port)}${REMOTE_PATHS.pairStatus}?ticket=${encodeURIComponent(ticket)}`;
}

export function groupAuthChallengeUrl(host: string, port: number): string {
  return `${groupOrigin(host, port)}${GROUP_PATHS.challenge}`;
}

export function groupAuthTokenUrl(host: string, port: number): string {
  return `${groupOrigin(host, port)}${GROUP_PATHS.token}`;
}

/**
 * `GET /__dsh_remote/status`：已鉴权设备可读的主机状态。
 * 群体版用 `Authorization: Bearer <短时 token>`（不再使用设备证书 / mTLS）。
 */
export function groupStatusUrl(host: string, port: number): string {
  return `${groupOrigin(host, port)}${REMOTE_PATHS.status}`;
}

/**
 * `POST /__dsh_remote/restart`：请求主机重启 DSH 客户端。
 * 需要主机侧「允许手机重启主机 DSH」组件已启用；幂等由主机侧去重窗口保证。
 */
export function groupRestartUrl(host: string, port: number): string {
  return `${groupOrigin(host, port)}${REMOTE_PATHS.restart}`;
}

/**
 * `POST /__dsh_remote/push-token`：登记本机 APNs device token。
 * 需要群体版会话 token（原生请求带 `__Host-dsh_session` cookie / Bearer）。
 */
export function groupPushTokenUrl(host: string, port: number): string {
  return `${groupOrigin(host, port)}${REMOTE_PATHS.pushToken}`;
}

/** Main WebView URL: same mobile shell, with the service-assigned port. */
export function groupWebUiUrl(host: string, port: number, options: { mobile?: boolean } = {}): string {
  const mobile = options.mobile ?? true;
  return `${groupOrigin(host, port)}/${mobile ? '?dsh_mobile=1' : ''}`;
}

export interface GroupPairedDeviceData {
  status: 'paired';
  auth: 'token';
  deviceId: string;
  hostId: string;
  relayDomain: string;
  mobilePort: number;
  devicePublicKey?: string;
  hostName?: string;
  hostFingerprint?: string;
}

export type GroupPairTicketStatus = 'pending' | 'paired' | 'denied' | 'expired';

export interface GroupPairStatusData {
  status: GroupPairTicketStatus;
  ticket?: string;
  sas?: string;
  expiresAt?: number;
  deviceId?: string;
  hostId?: string;
  relayDomain?: string;
  mobilePort?: number;
  hostName?: string;
  hostFingerprint?: string;
  message?: string;
}

/** Short-lived edge session returned by `POST /__group/auth/token`. */
export interface GroupSessionToken {
  token: string;
  /** Epoch ms when the token expires (refresh before this). */
  expiresAt: number;
}

export interface GroupChallengeData {
  nonce: string;
  expiresAt: number;
  hostId?: string;
  deviceId?: string;
}

/**
 * 推送通道模式（与 relay `group.push.mode` 一致）：
 *   - `self`：部署方自己的 APNs key（可带会话摘要与 sessionId）；
 *   - `official`：官方中央推送 hub（仅通用文案，不带 sessionId）。
 */
export type GroupPushMode = 'self' | 'official';

/** `POST /__dsh_remote/push-token` 成功时 `data` 的内容（主机转发 relay 的结果）。 */
export interface GroupPushTokenData {
  registered?: boolean;
  mode?: GroupPushMode | '';
  /** R2（host-plugin 0.2.6+）：设备 token 的推送通道。 */
  channel?: GroupPushMode | '';
}

// ---------------------------------------------------------------------------
// R2：官方推送设备登记（App ↔ 官方 hub）
//
// 与 `dsh-remoteService/packages/protocol` 0.3.1 的常量/消息格式逐字节一致：
// App 用设备私钥对 pushEnrollMessage 签名 → hub 签发 per-device credential →
// App 把 credential 交给主机，主机直连 hub 推送（见 docs/group-push-r2-contract.zh.md §3/§5）。
// ---------------------------------------------------------------------------

/** R2 设备登记签名消息版本（App 与 hub 必须逐字节一致）。 */
export const PUSH_ENROLL_VERSION = 'dshremote-push-enroll-v1';
/** R2 官方 hub 路径。 */
export const PUSH_ENROLL_CHALLENGE_PATH = '/v1/enroll/challenge';
export const PUSH_ENROLL_PATH = '/v1/enroll';

export interface PushEnrollMessageInput {
  challengeId: string;
  nonce: string;
  /** base64url 未压缩 P-256 公钥（65 字节）。 */
  devicePublicKey: string;
  /** 主机 ID（可为空串）。 */
  hostId?: string;
  /** APNs device token（64 位小写 hex）。 */
  token: string;
  environment: string;
  bundleId: string;
}

/**
 * 构造 R2 登记签名消息：UTF-8、`\n` 连接、**无末尾换行**。
 * 必须与 server `pushEnrollMessage()` 完全一致（否则 hub 验签失败）。
 */
export function pushEnrollMessage(input: PushEnrollMessageInput): string {
  return [
    PUSH_ENROLL_VERSION,
    input.challengeId,
    input.nonce,
    input.devicePublicKey,
    input.hostId ?? '',
    input.token,
    input.environment,
    input.bundleId,
  ].join('\n');
}

/** R2：主机 status 里单通道的登记情况（不包含 token / credential）。 */
export interface GroupPushChannelStatusData {
  /** 该通道已登记的设备 token 数。 */
  devices?: number;
  /** 最近一次发送/登记失败原因（可读，不含 token）。 */
  lastError?: string | null;
  /** 官方通道：主机记录的 hub 基址（部署信息，不含凭据）。 */
  hub?: string;
}

/** `status.push.mode`：R2 起两台设备可能混用，故新增 `mixed`。 */
export type GroupPushServerMode = GroupPushMode | 'mixed' | '';

/**
 * 主机 `/__dsh_remote/status` 的 `push` 字段（host-plugin 上报的推送状态）。
 *
 * - 旧版 Host（≤0.2.5）只有扁平字段 `serverEnabled/mode/tokens/lastError`；
 * - R2（0.2.6+）扩展为按通道的 `self` / `official` 对象（见契约 §6.3）；
 * 两种形态都兼容，字段全部可选、缺省即未知。
 */
export interface GroupPushServerStatusData {
  /** 主机侧「推送提醒」开关。 */
  enabled?: boolean;
  /** 推送通道服务方（v1 固定 apns）。 */
  provider?: string;
  /** relay 是否开启推送（来自 push.registered，legacy self）。 */
  serverEnabled?: boolean;
  /** 主机推送通道：self / official / mixed（旧版 Host 可能为空）。 */
  mode?: GroupPushServerMode;
  /** 主机本机已上报的设备 token 数（legacy 扁平字段）。 */
  tokens?: number;
  /** 可读错误（不含 token）。 */
  lastError?: string | null;
  /** R2：走 relay 的自部署设备登记情况。 */
  self?: GroupPushChannelStatusData;
  /** R2：直连官方 hub 的官方设备登记情况。 */
  official?: GroupPushChannelStatusData;
}

/**
 * `GET /__dsh_remote/status` 的 `data`（群体版，Bearer token 鉴权）。
 *
 * 主机插件在 loopback 明文代理里逐请求验签 token；响应字段是诊断/能力信息。
 * 其中 `restart.enabled` 决定 App 顶栏是否显示「重启主机 DSH」按钮
 * （Host 设置 → 组件 → 允许手机重启主机 DSH，默认关闭）。
 */
export interface GroupHostStatusData {
  hostId?: string;
  hostName?: string;
  /** `<hostId>.<relayDomain>`（服务端下发）。 */
  domain?: string;
  auth?: string;
  relayConnected?: boolean;
  devices?: { total?: number; active?: number };
  /** 「重启主机」组件状态；旧版 Host 没有该字段。 */
  restart?: { enabled?: boolean };
  /** 推送状态；旧版 Host 没有该字段。 */
  push?: GroupPushServerStatusData;
}

/**
 * `POST /__dsh_remote/restart` 成功（202）返回的 envelope data。
 * 主机接受请求后自行重启 DSH；App 侧继续轮询 `/__dsh_remote/status` 等待恢复。
 */
export interface RestartHostData {
  restarting: true;
  /** 主机选择的重启方式（实现细节，仅用于诊断；旧版主机可能不返回）。 */
  mode?: string;
}
