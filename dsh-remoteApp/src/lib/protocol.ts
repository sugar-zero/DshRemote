/**
 * DSH Remote — pairing protocol (client side).
 *
 * Contract sources:
 *  - dsh-remoteService/docs/ADMIN-API.md §2/§3 (tunnel + pairing API, QR URI)
 *  - docs/remote-access-evaluation.zh.md §4.3/§4.4/§4.7 (pairing flow, key hierarchy, app design)
 *
 * Design notes
 *  - This file must stay dependency-free (no React Native, no network) so the
 *    parsing/validation rules can be unit-tested under Node.
 *  - QR URIs are parsed by hand instead of `new URL()`: React Native's URL
 *    polyfill does not reliably support custom schemes (`dshremote://`).
 *  - Pairing URIs carry ONLY a one-time secret (256-bit, <=120s). Long-lived
 *    tokens / browser cookies must never appear in a QR code (see §5.2).
 */

export const PAIRING_SCHEME = 'dshremote';
export const PAIRING_AUTHORITY = 'pair';
export const SUPPORTED_PROTOCOL_VERSION = 1;

/** Protocol version emitted/accepted by this client. */
export type PairingProtocolVersion = typeof SUPPORTED_PROTOCOL_VERSION;

/** Remote tunnel paths served by the host plugin (see ADMIN-API.md §2). */
export const REMOTE_PATHS = {
  pair: '/__dsh_remote/pair',
  pairStatus: '/__dsh_remote/pair/status',
  pushToken: '/__dsh_remote/push-token',
  /** 重启主机 DSH 客户端（设备 mTLS；成功返回 202，见 ADMIN-API.md）。 */
  restart: '/__dsh_remote/restart',
} as const;

/**
 * Local admin API paths (ADMIN-API.md §1). These are registered on the host's
 * loopback DSH web server and are only reachable from an authenticated browser
 * on the host itself. The remote reverse proxy explicitly DENIES
 * `/api/remote-access/*`, so the app must not expect to call these over the
 * relay. Kept here so future native/desktop bridges share one source of truth.
 */
export const ADMIN_BASE_PATH = '/api/remote-access';
export const ADMIN_PATHS = {
  status: `${ADMIN_BASE_PATH}/status`,
  config: `${ADMIN_BASE_PATH}/config`,
  pairingStart: `${ADMIN_BASE_PATH}/pairing/start`,
  pairingCancel: `${ADMIN_BASE_PATH}/pairing/cancel`,
  pairingApprove: `${ADMIN_BASE_PATH}/pairing/approve`,
  pairingQrSvg: `${ADMIN_BASE_PATH}/pairing/qr.svg`,
  devices: `${ADMIN_BASE_PATH}/devices`,
  audit: `${ADMIN_BASE_PATH}/audit`,
} as const;

/** Admin path for revoking one device (`POST /devices/:id/revoke`). */
export function adminDeviceRevokePath(deviceId: string): string {
  return `${ADMIN_PATHS.devices}/${encodeURIComponent(deviceId)}/revoke`;
}

// ---------------------------------------------------------------------------
// Pairing URI
// ---------------------------------------------------------------------------

/**
 * Parsed/validated `dshremote://pair?...` URI.
 *
 * Wire format (ADMIN-API.md §3):
 *   dshremote://pair?v=1&host=<hostId>.<relayDomain>&secret=<base64url 32B>
 *                 &hostfp=<base64url sha256(hostPub)>&exp=<unix seconds>&relay=<relayDomain>
 */
export interface PairingUri {
  /** Protocol version, always 1 for this client. */
  version: PairingProtocolVersion;
  /** `https://${host}` is the tunnel base, e.g. `h_ab12cd34.relay.example.com`. */
  host: string;
  /** One-time pairing secret (base64url, 32 random bytes). Never log it. */
  secret: string;
  /** Full SHA-256 host identity fingerprint, base64url (43 chars). Not a short code. */
  hostFingerprint: string;
  /** Expiry as a Unix timestamp in **milliseconds** (wire value is seconds). */
  expiresAt: number;
  /** Relay base domain, e.g. `relay.example.com`. */
  relayDomain: string;
  /** Original URI text, kept for diagnostics (do not log blindly: contains secret). */
  raw: string;
}

export type PairingUriErrorCode =
  | 'invalid_uri'
  | 'unsupported_scheme'
  | 'unsupported_version'
  | 'missing_field'
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

/**
 * Parse and fully validate a pairing URI.
 *
 * Throws {@link PairingUriError} with a machine-readable `code` and a
 * user-presentable Chinese `message`.
 */
export function parsePairingUri(input: string, options: ParsePairingUriOptions = {}): PairingUri {
  const now = options.now ?? Date.now();
  const raw = input.trim().replace(/^["'<]+|["'>]+$/g, '').trim();
  if (!raw) {
    throw new PairingUriError('invalid_uri', '配对链接为空。');
  }

  const uriMatch = PAIRING_URI_RE.exec(raw);
  if (!uriMatch) {
    throw new PairingUriError(
      'invalid_uri',
      '无法解析配对链接。链接应以 dshremote://pair?v=1&... 开头。',
    );
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
  if (path !== '' && path !== '/') {
    throw new PairingUriError('invalid_uri', `配对链接包含未知路径 "${path}"。`, 'path');
  }
  if (query === undefined || query === '') {
    throw new PairingUriError('missing_field', '配对链接缺少参数。请在主机上重新生成二维码。', 'query');
  }

  const params = parseQueryString(query);

  const require = (name: string): string => {
    const value = params.get(name);
    if (value === undefined || value === '') {
      throw new PairingUriError('missing_field', `配对链接缺少参数 "${name}"，请重新生成二维码。`, name);
    }
    return value;
  };

  const versionRaw = require('v');
  if (versionRaw !== String(SUPPORTED_PROTOCOL_VERSION)) {
    throw new PairingUriError(
      'unsupported_version',
      `配对链接协议版本为 v${versionRaw}，当前 App 仅支持 v${SUPPORTED_PROTOCOL_VERSION}，请升级 App。`,
      'v',
    );
  }

  const host = require('host');
  if (!isValidTunnelHost(host)) {
    throw new PairingUriError('invalid_field', `配对链接中的主机地址无效："${host}"。`, 'host');
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
  const expiresAtSeconds = Number(expiresAtSecondsRaw);
  const expiresAt = expiresAtSeconds * 1000;
  if (!options.allowExpired && expiresAt <= now) {
    throw new PairingUriError('expired', '配对二维码已过期，请在主机上重新生成。', 'exp');
  }

  const relayDomain = require('relay');
  if (!HOSTNAME_RE.test(relayDomain) || relayDomain.length > 253) {
    throw new PairingUriError('invalid_field', `配对链接中的中继域名无效："${relayDomain}"。`, 'relay');
  }

  const hostname = hostnameOf(host);
  const relayLower = relayDomain.toLowerCase();
  if (hostname !== relayLower && !hostname.endsWith(`.${relayLower}`)) {
    throw new PairingUriError(
      'invalid_field',
      `主机地址 "${host}" 不属于中继域名 "${relayDomain}"，链接可能被篡改。`,
      'host',
    );
  }

  return {
    version: SUPPORTED_PROTOCOL_VERSION,
    host: host.toLowerCase(),
    secret,
    hostFingerprint,
    expiresAt,
    relayDomain: relayLower,
    raw,
  };
}

/** Serialize a validated pairing URI (used by dev tools / tests, never by the UI). */
export function buildPairingUri(pairing: Omit<PairingUri, 'raw' | 'version'>): string {
  const params = [
    `v=${SUPPORTED_PROTOCOL_VERSION}`,
    `host=${encodeURIComponent(pairing.host)}`,
    `secret=${encodeURIComponent(pairing.secret)}`,
    `hostfp=${encodeURIComponent(pairing.hostFingerprint)}`,
    `exp=${Math.floor(pairing.expiresAt / 1000)}`,
    `relay=${encodeURIComponent(pairing.relayDomain)}`,
  ];
  return `${PAIRING_SCHEME}://${PAIRING_AUTHORITY}?${params.join('&')}`;
}

/** Milliseconds left before the pairing URI expires (never negative). */
export function pairingTimeLeftMs(pairing: Pick<PairingUri, 'expiresAt'>, now = Date.now()): number {
  return Math.max(0, pairing.expiresAt - now);
}

// ---------------------------------------------------------------------------
// Fingerprint / short-code display helpers
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
 * authoritative (ADMIN-API.md §3: short fingerprints are display-only, never a pin).
 */
export function shortFingerprint(fingerprint: string): string {
  const cleaned = fingerprint.trim().replace(/\s+/g, '');
  if (cleaned.length <= 16) return formatFingerprint(cleaned);
  return `${formatFingerprint(cleaned.slice(0, 8))} … ${formatFingerprint(cleaned.slice(-8))}`;
}

const PAIRING_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32 (no I,L,O,U)
const CROCKFORD_CONFUSABLES: Record<string, string> = { I: '1', L: '1', O: '0' };

/**
 * Normalize a human-typed short code (12-char Crockford base32 backup code, or
 * a SAS shown by the desktop). Tolerates spaces/dashes, lower case and the
 * classic I/L/O confusables. Returns `''` for empty input.
 */
export function normalizeShortCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/[ILO]/g, (char) => CROCKFORD_CONFUSABLES[char] ?? char);
}

/** True when the normalized value is a complete 12-char pairing backup code. */
export function isCompletePairingCode(input: string): boolean {
  const normalized = normalizeShortCode(input);
  return normalized.length === 12 && [...normalized].every((char) => PAIRING_CODE_ALPHABET.includes(char));
}

/** Group a normalized code for display, 4 characters per group. */
export function formatPairingCode(input: string): string {
  const normalized = normalizeShortCode(input);
  const groups = normalized.match(/.{1,4}/g);
  return groups ? groups.join('-') : '';
}

/** Normalize a SAS for comparison (case/space insensitive). */
export function normalizeSas(input: string): string {
  return input.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/** Short fingerprint of a device certificate label or ID, for `DevicesScreen`. */
export function truncateMiddle(value: string, keep = 6): string {
  if (value.length <= keep * 2 + 1) return value;
  return `${value.slice(0, keep)}…${value.slice(-keep)}`;
}

// ---------------------------------------------------------------------------
// API URL helpers
// ---------------------------------------------------------------------------

/** Base URL for the host tunnel: always HTTPS (relay terminates TCP, host terminates TLS). */
export function apiBaseForHost(host: string): string {
  return `https://${host}`;
}

/** Join the tunnel base with an absolute path from {@link REMOTE_PATHS}. */
export function remoteUrl(host: string, path: string): string {
  if (!path.startsWith('/')) throw new Error(`remoteUrl() expects an absolute path, got "${path}"`);
  return `${apiBaseForHost(host)}${path}`;
}

export function pairUrl(host: string): string {
  return remoteUrl(host, REMOTE_PATHS.pair);
}

export function pairStatusUrl(host: string, ticket: string): string {
  return `${remoteUrl(host, REMOTE_PATHS.pairStatus)}?ticket=${encodeURIComponent(ticket)}`;
}

export function pushTokenUrl(host: string): string {
  return remoteUrl(host, REMOTE_PATHS.pushToken);
}

/**
 * 重启主机 DSH 客户端的隧道地址（`POST`，需设备 mTLS；成功返回 202）。
 * 这里只负责发起重启请求；主机恢复后由调用方轮询 `/__dsh_remote/status` 再重载页面。
 */
export function restartHostUrl(host: string): string {
  return remoteUrl(host, REMOTE_PATHS.restart);
}

/**
 * Local admin API URL. Only works from an authenticated browser running on the
 * host itself; the remote tunnel denies these paths (ADMIN-API.md §2).
 */
export function adminUrl(host: string, path: string): string {
  return remoteUrl(host, path);
}

/**
 * URL loaded by the main WebView. `dsh_mobile=1` lets the host's client plugin
 * inject the mobile layout/CSS without shipping a new app (evaluation §4.6).
 */
export function webUiUrl(host: string, options: { mobile?: boolean } = {}): string {
  const mobile = options.mobile ?? true;
  return `https://${host}/${mobile ? '?dsh_mobile=1' : ''}`;
}

// ---------------------------------------------------------------------------
// Tunnel API payload types (ADMIN-API.md §2)
// ---------------------------------------------------------------------------

export type PairPlatform = 'ios' | 'android';

/** Uniform response envelope: `{ ok: true, data } | { ok: false, error }`. */
export type ApiEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

export interface PairRequestBody {
  secret: string;
  csrPem: string;
  deviceName: string;
  platform: PairPlatform;
}

export interface PairedDeviceData {
  status: 'paired';
  deviceId: string;
  certPem: string;
  caPem: string;
  hostName: string;
  hostFingerprint: string;
}

export interface PendingPairData {
  status: 'pending';
  ticket: string;
}

export type PairStartData = PairedDeviceData | PendingPairData;

export type PairTicketStatus = 'pending' | 'paired' | 'denied' | 'expired';

export interface PairStatusData {
  status: PairTicketStatus;
  /** Present when `status === 'paired'`. */
  deviceId?: string;
  certPem?: string;
  caPem?: string;
  hostName?: string;
  hostFingerprint?: string;
  /** Optional human-readable reason for `denied`/`expired`. */
  message?: string;
}

export type PushTokenEnvironment = 'development' | 'production';

export interface PushTokenRequestBody {
  provider: 'expo' | 'apns' | 'fcm';
  token: string;
  /** APNs 环境：开发签名包为 development（sandbox），发布签名包为 production。 */
  environment?: PushTokenEnvironment;
}

/**
 * `POST /__dsh_remote/restart` 成功（202）返回的 envelope data。
 * 主机在接受请求后自行重启 DSH；App 侧继续轮询 `/__dsh_remote/status` 等待恢复。
 */
export interface RestartHostData {
  restarting: true;
  /** 主机选择的重启方式（实现细节，仅用于诊断展示；旧版主机可能不返回）。 */
  mode?: string;
}

/** Admin API device record (ADMIN-API.md §1 `GET /status` / `GET /devices`). */
export interface DeviceRecord {
  id: string;
  name: string;
  platform: PairPlatform | string;
  createdAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
}

/** Subset of `GET /api/remote-access/status` used for type-safe dev bridges. */
export interface AdminStatusData {
  version: string;
  enabled: boolean;
  relay: { url: string; connected: boolean; lastError: string | null };
  host: {
    id: string;
    name: string;
    fingerprint: string;
    publicKey: string;
    domain: string;
    tls: { certFile: string; subject: string; notAfter: string; valid: boolean };
  };
  pairing: {
    active: boolean;
    pairingId: string | null;
    expiresAt: number | null;
    requiresApproval: boolean;
    uri: string | null;
    code: string | null;
    sas: string | null;
  } | null;
  devices: DeviceRecord[];
}
