/**
 * Group service (A mode) — JS side of the token-auth flow.
 *
 * Group mode replaces the device mTLS certificate with:
 *   - pairing: native P-256 key pair → POST /__dsh_remote/pair {secret, publicKey}
 *   - session: POST /__group/auth/challenge → native ECDSA signature →
 *     POST /__group/auth/token → short-lived token → `__Host-dsh_session` cookie
 *
 * Security rules (see docs/group-service-design.zh.md §7/§10):
 *   - the P-256 private key never leaves Secure Enclave / AndroidKeyStore;
 *   - the session token lives in memory + the WebView cookie store only — it is
 *     never persisted to SecureStore and never logged;
 *   - pairing/session requests only go to the host origin derived from the QR
 *     (https + service-assigned port), never to an arbitrary URL.
 */

import {
  GROUP_SESSION_COOKIE,
  groupAuthChallengeUrl,
  groupAuthTokenUrl,
  groupOrigin,
  groupPairStatusUrl,
  groupPairUrl,
  type GroupChallengeData,
  type GroupPairedDeviceData,
  type GroupPairingUri,
  type GroupPairStatusData,
  type GroupSessionToken,
  type PairPlatform,
} from './protocol';
import { persistGroupPairedDevice } from './pairing';
import type { StoredConnection } from './store';
import * as nativeModule from '../../modules/dsh-mtls/src';

// ---------------------------------------------------------------------------
// Native bridge (contract: modules/dsh-mtls — implemented by the native task)
// ---------------------------------------------------------------------------

interface GroupNativeModuleApi {
  generateGroupDeviceKey?(label?: string): Promise<{
    publicKey?: unknown;
    publicKeyB64Url?: unknown;
    label?: unknown;
  }>;
  signGroupChallenge?(label: string, messageBase64: string): Promise<unknown>;
  setSessionCookie?(options: {
    url: string;
    name: string;
    value: string;
    maxAgeSeconds: number;
  }): Promise<unknown>;
  clearGroupDeviceKey?(label?: string): Promise<unknown>;
}

// Namespace cast: the native module may be an older build without the group
// APIs; we must fail with a readable error instead of a compile-time import.
const nativeApi = nativeModule as unknown as GroupNativeModuleApi;

/** True when the current build links the native group-auth functions. */
export function isGroupNativeAvailable(): boolean {
  return (
    typeof nativeApi.generateGroupDeviceKey === 'function' &&
    typeof nativeApi.signGroupChallenge === 'function' &&
    typeof nativeApi.setSessionCookie === 'function'
  );
}

function requireGroupNative(): Required<
  Pick<GroupNativeModuleApi, 'generateGroupDeviceKey' | 'signGroupChallenge' | 'setSessionCookie'>
> {
  if (!isGroupNativeAvailable()) {
    throw new GroupPairingError(
      'native_unavailable',
      '当前 App 构建没有链接群体版原生能力（设备密钥/签名/Cookie）。请使用包含 modules/dsh-mtls 新版本的原生构建，而不是 Expo Go。',
    );
  }
  return nativeApi as Required<
    Pick<GroupNativeModuleApi, 'generateGroupDeviceKey' | 'signGroupChallenge' | 'setSessionCookie'>
  >;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type GroupPairingErrorCode =
  | 'native_unavailable'
  | 'invalid_request'
  | 'invalid_response'
  | 'network'
  | 'timeout'
  | 'http'
  | 'denied'
  | 'expired'
  | 'pending_timeout'
  | 'aborted'
  | 'fingerprint_mismatch'
  | 'not_paired';

export class GroupPairingError extends Error {
  readonly code: GroupPairingErrorCode;
  readonly status?: number;
  readonly retryable?: boolean;

  constructor(
    code: GroupPairingErrorCode,
    message: string,
    options: { status?: number; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = 'GroupPairingError';
    this.code = code;
    this.status = options.status;
    this.retryable = options.retryable;
    Object.setPrototypeOf(this, GroupPairingError.prototype);
  }
}

/** Map any thrown value into a {@link GroupPairingError} with a readable message. */
export function toGroupPairingError(error: unknown): GroupPairingError {
  if (error instanceof GroupPairingError) return error;
  if (error instanceof Error) {
    return new GroupPairingError('invalid_response', error.message || '群体服务操作失败，请重试。');
  }
  return new GroupPairingError('invalid_response', '群体服务操作失败，请重试。');
}

// ---------------------------------------------------------------------------
// HTTP helpers (fetch; bounded timeout + readable errors)
// ---------------------------------------------------------------------------

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 1_500;
const DEFAULT_POLL_TIMEOUT_MS = 120_000;
/** Refresh the session token when less than this much validity remains. */
const SESSION_REFRESH_MARGIN_MS = 60_000;

interface JsonHttpResult {
  status: number;
  body: unknown;
  /** 原始响应文本（截断到 512B，仅用于错误提示，不落盘）。 */
  text: string;
  /** 诊断用的响应头子集（判断 401 是 relay/host/代理 哪一层返回）。 */
  headers: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readEnvelopeError(body: unknown): { code?: string; message?: string } {
  if (!isRecord(body)) return {};
  if (isRecord(body.error)) {
    return {
      code: typeof body.error.code === 'string' ? body.error.code : undefined,
      message: typeof body.error.message === 'string' ? body.error.message : undefined,
    };
  }
  return { message: typeof body.message === 'string' ? body.message : undefined };
}

/** `{ok:true,data}` envelope → data; otherwise return the body as-is. */
function unwrapData(body: unknown): unknown {
  if (isRecord(body) && body.ok === true && 'data' in body) return body.data;
  return body;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new GroupPairingError('aborted', '操作已取消。'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new GroupPairingError('aborted', '操作已取消。'));
    };
    signal?.addEventListener('abort', onAbort);
  });
}

async function fetchJson(
  url: string,
  init: { method: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal },
): Promise<JsonHttpResult> {
  if (init.signal?.aborted) throw new GroupPairingError('aborted', '操作已取消。');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_REQUEST_TIMEOUT_MS);
  const onExternalAbort = () => controller.abort();
  init.signal?.addEventListener('abort', onExternalAbort);
  try {
    const response = await fetch(url, {
      method: init.method,
      headers: init.body === undefined ? { accept: 'application/json' } : {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed: unknown = null;
    if (text.trim() !== '') {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = null;
      }
    }
    const headers: Record<string, string> = {};
    for (const name of ['server', 'via', 'www-authenticate', 'content-type', 'x-powered-by']) {
      const value = response.headers.get(name);
      if (value) headers[name] = value;
    }
    return { status: response.status, body: parsed, text: text.slice(0, 512), headers };
  } catch (error) {
    if (isRecord(error) && error.name === 'AbortError') {
      if (init.signal?.aborted) throw new GroupPairingError('aborted', '操作已取消。');
      throw new GroupPairingError(
        'timeout',
        `连接主机超时（${Math.round(DEFAULT_REQUEST_TIMEOUT_MS / 1000)}s）。请确认手机已联网、主机在线。`,
        { retryable: true },
      );
    }
    throw new GroupPairingError(
      'network',
      '无法连接主机。请确认手机已联网、主机在线，且当前网络可以访问中继域名。',
      { retryable: true },
    );
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', onExternalAbort);
  }
}

function requireHttpOk(result: JsonHttpResult, action: string, context?: string): unknown {
  if (result.status >= 200 && result.status < 300) return unwrapData(result.body);
  const envelope = readEnvelopeError(result.body);
  const where = context ? `\n请求：${context}` : '';
  // 服务端正常情况下 401 都会带 JSON message；若没有，附上原始响应/头，便于判断是
  // relay、host 还是手机侧代理返回的 401（排查「配对后立刻 401」时非常关键）。
  let diagnostics = '';
  if (result.status === 401 || result.status === 403) {
    const bodySnippet = result.text.trim() === '' ? '<empty>' : result.text.trim().replace(/\s+/g, ' ');
    const headerText = Object.entries(result.headers).map(([k, v]) => `${k}=${v}`).join('; ');
    diagnostics = `\n响应：HTTP ${result.status} ${bodySnippet}${headerText ? ` [${headerText}]` : ''}`;
  }
  const detail = `${envelope.message ?? ''}${where}${diagnostics}`;
  if (result.status === 401 || result.status === 403) {
    throw new GroupPairingError('http', `${envelope.message ?? `${action}被主机拒绝（HTTP ${result.status}）。`}${where}${diagnostics}`, {
      status: result.status,
      retryable: false,
    });
  }
  if (result.status === 429) {
    throw new GroupPairingError('http', `${envelope.message ?? '请求过于频繁，请稍后再试。'}${where}`, {
      status: result.status,
      retryable: true,
    });
  }
  throw new GroupPairingError(
    'http',
    envelope.message ?? `${action}失败（HTTP ${result.status}）。`,
    { status: result.status, retryable: result.status >= 500 },
  );
}

// ---------------------------------------------------------------------------
// Device key + challenge message helpers
// ---------------------------------------------------------------------------

export interface GroupDeviceKey {
  /** P-256 uncompressed point (65 bytes), base64url. */
  publicKey: string;
  /** Keychain/Keystore label used by signGroupChallenge; persist as connection.certRef. */
  label: string;
}

/** Deterministic per-host Keychain/Keystore label for the group device key. */
export function defaultGroupDeviceLabel(host: string): string {
  const safe = host
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '_')
    .slice(0, 80);
  return `com.dsh.remote.group.${safe || 'host'}`;
}

/**
 * Generate (or reuse) the P-256 group device key. The private key stays native;
 * only the public key + label cross the bridge.
 */
export async function generateGroupDeviceKey(label?: string): Promise<GroupDeviceKey> {
  const api = requireGroupNative();
  const raw = await api.generateGroupDeviceKey(label);
  if (!isRecord(raw)) {
    throw new GroupPairingError('invalid_response', '原生模块没有返回设备公钥。');
  }
  const publicKeyRaw = raw.publicKey ?? raw.publicKeyB64Url;
  if (typeof publicKeyRaw !== 'string' || publicKeyRaw === '') {
    throw new GroupPairingError('invalid_response', '原生模块没有返回设备公钥。');
  }
  const resolvedLabel = typeof raw.label === 'string' && raw.label !== '' ? raw.label : label;
  if (!resolvedLabel) {
    throw new GroupPairingError('invalid_response', '原生模块没有返回设备密钥标签。');
  }
  return { publicKey: publicKeyRaw, label: resolvedLabel };
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64Char(index: number): string {
  return BASE64_ALPHABET.charAt(index & 0x3f);
}

function byteAt(bytes: number[], index: number): number {
  const value = bytes[index];
  return value === undefined ? 0 : value;
}

/** base64(utf8) for the challenge message (ASCII-only: hostId/deviceId/nonce). */
export function encodeChallengeMessage(value: string): string {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code > 0x7f) {
      throw new GroupPairingError('invalid_request', '挑战消息包含非 ASCII 字符，无法编码。');
    }
    bytes.push(code);
  }
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const b0 = byteAt(bytes, index);
    const b1 = byteAt(bytes, index + 1);
    const b2 = byteAt(bytes, index + 2);
    out += base64Char(b0 >> 2);
    out += base64Char(((b0 & 0x03) << 4) | (b1 >> 4));
    out += index + 1 < bytes.length ? base64Char(((b1 & 0x0f) << 2) | (b2 >> 6)) : '=';
    out += index + 2 < bytes.length ? base64Char(b2) : '=';
  }
  return out;
}

/** Challenge message signed by the device key: `<hostId>\n<deviceId>\n<nonce>` (base64). */
export function buildChallengeMessageBase64(hostId: string, deviceId: string, nonce: string): string {
  return encodeChallengeMessage(`${hostId}\n${deviceId}\n${nonce}`);
}

async function signChallenge(label: string, hostId: string, deviceId: string, nonce: string): Promise<string> {
  const api = requireGroupNative();
  const rawSignature: unknown = await api.signGroupChallenge(
    label,
    buildChallengeMessageBase64(hostId, deviceId, nonce),
  );
  // 原生 wrapper 目前返回 `{ signature }`；兼容直接返回字符串的旧实现。
  const signature = typeof rawSignature === 'string'
    ? rawSignature
    : isRecord(rawSignature) && typeof rawSignature.signature === 'string'
      ? rawSignature.signature
      : '';
  if (signature === '') {
    throw new GroupPairingError('invalid_response', '原生模块没有返回设备签名。');
  }
  return signature;
}

// ---------------------------------------------------------------------------
// Group pairing
// ---------------------------------------------------------------------------

export type GroupPairPhase = 'requesting' | 'pending' | 'polling' | 'paired';

export interface PairGroupDeviceOptions {
  pairing: GroupPairingUri;
  deviceName: string;
  platform: PairPlatform;
  /** Keychain/Keystore label; defaults to {@link defaultGroupDeviceLabel}. */
  label?: string;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  onPhase?: (phase: GroupPairPhase) => void;
  onPending?: (pending: { ticket: string; sas?: string; expiresAt?: number }) => void;
}

export interface GroupPairedDeviceResult {
  device: GroupPairedDeviceData;
  connection: StoredConnection;
  deviceKeyLabel: string;
}

function readPairedData(data: unknown): GroupPairedDeviceData {
  if (!isRecord(data) || data.status !== 'paired') {
    throw new GroupPairingError('invalid_response', '主机返回了无法识别的配对结果。');
  }
  const deviceId = typeof data.deviceId === 'string' ? data.deviceId : '';
  if (!/^d_[a-z0-9]{6,40}$/.test(deviceId)) {
    throw new GroupPairingError('invalid_response', '主机返回的设备 ID 无效。');
  }
  const mobilePort = Number(data.mobilePort);
  return {
    status: 'paired',
    auth: 'token',
    deviceId,
    hostId: typeof data.hostId === 'string' ? data.hostId : '',
    relayDomain: typeof data.relayDomain === 'string' ? data.relayDomain : '',
    mobilePort: Number.isInteger(mobilePort) && mobilePort >= 1 && mobilePort <= 65535 ? mobilePort : 0,
    devicePublicKey: typeof data.devicePublicKey === 'string' ? data.devicePublicKey : undefined,
    hostName: typeof data.hostName === 'string' ? data.hostName : undefined,
    hostFingerprint: typeof data.hostFingerprint === 'string' ? data.hostFingerprint : undefined,
  };
}

function verifyGroupHostFingerprint(pairing: GroupPairingUri, returned: string | undefined): void {
  if (!returned) return; // QR already carries the authoritative fingerprint
  if (returned !== pairing.hostFingerprint) {
    throw new GroupPairingError(
      'fingerprint_mismatch',
      '主机指纹与二维码不一致：连接可能被中间人劫持，已中止配对。请重新生成二维码并在主机上确认。',
    );
  }
}

function readPendingStatus(data: unknown): GroupPairStatusData {
  if (!isRecord(data) || typeof data.status !== 'string') {
    throw new GroupPairingError('invalid_response', '主机返回了无法识别的配对状态。');
  }
  const status = data.status;
  if (status !== 'pending' && status !== 'paired' && status !== 'denied' && status !== 'expired') {
    throw new GroupPairingError('invalid_response', `主机返回了未知配对状态："${status}"。`);
  }
  return {
    status,
    ticket: typeof data.ticket === 'string' ? data.ticket : undefined,
    sas: typeof data.sas === 'string' ? data.sas : undefined,
    expiresAt: Number.isFinite(Number(data.expiresAt)) ? Number(data.expiresAt) : undefined,
    deviceId: typeof data.deviceId === 'string' ? data.deviceId : undefined,
    hostId: typeof data.hostId === 'string' ? data.hostId : undefined,
    relayDomain: typeof data.relayDomain === 'string' ? data.relayDomain : undefined,
    mobilePort: Number.isFinite(Number(data.mobilePort)) ? Number(data.mobilePort) : undefined,
    hostName: typeof data.hostName === 'string' ? data.hostName : undefined,
    hostFingerprint: typeof data.hostFingerprint === 'string' ? data.hostFingerprint : undefined,
    message: typeof data.message === 'string' ? data.message : undefined,
  };
}

/**
 * Full group pairing flow: generate P-256 key → POST /pair → (poll pending) →
 * fingerprint check → persist connection. Resolves with the stored connection.
 */
export async function pairGroupDevice(options: PairGroupDeviceOptions): Promise<GroupPairedDeviceResult> {
  const { pairing, deviceName, platform } = options;
  const label = options.label ?? defaultGroupDeviceLabel(pairing.host);
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  options.onPhase?.('requesting');

  const key = await generateGroupDeviceKey(label);
  const initial = await fetchJson(groupPairUrl(pairing.host, pairing.port), {
    method: 'POST',
    body: { secret: pairing.secret, publicKey: key.publicKey, deviceName, platform },
    signal: options.signal,
  });
  const startData = requireHttpOk(initial, '提交配对请求');
  if (!isRecord(startData) || typeof startData.status !== 'string') {
    throw new GroupPairingError('invalid_response', '主机返回了无法识别的配对结果。');
  }

  let paired: GroupPairedDeviceData | null = null;
  if (startData.status === 'paired') {
    paired = readPairedData(startData);
  } else if (startData.status === 'pending') {
    const ticket = typeof startData.ticket === 'string' ? startData.ticket : '';
    if (!ticket) throw new GroupPairingError('invalid_response', '主机没有返回配对确认票据。');
    options.onPhase?.('pending');
    options.onPending?.({
      ticket,
      sas: typeof startData.sas === 'string' ? startData.sas : undefined,
      expiresAt: Number.isFinite(Number(startData.expiresAt)) ? Number(startData.expiresAt) : undefined,
    });
    paired = await waitForGroupPairing({
      pairing,
      ticket,
      intervalMs: pollIntervalMs,
      timeoutMs: options.pollTimeoutMs,
      signal: options.signal,
      onPhase: options.onPhase,
    });
  } else {
    throw new GroupPairingError('invalid_response', `主机返回了未知配对状态："${startData.status}"。`);
  }

  verifyGroupHostFingerprint(pairing, paired.hostFingerprint);
  if (paired.hostId && paired.hostId !== pairing.hostId) {
    throw new GroupPairingError('invalid_response', '主机返回的主机 ID 与二维码不一致，已中止配对。');
  }
  options.onPhase?.('paired');
  const connection = await persistGroupPairedDevice({
    pairing,
    device: paired,
    deviceName,
    deviceKeyLabel: key.label,
  });
  resetGroupSessionCache();
  return { device: paired, connection, deviceKeyLabel: key.label };
}

interface WaitGroupPairingOptions {
  pairing: GroupPairingUri;
  ticket: string;
  intervalMs: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onPhase?: (phase: GroupPairPhase) => void;
}

async function waitForGroupPairing(options: WaitGroupPairingOptions): Promise<GroupPairedDeviceData> {
  const now = Date.now();
  const deadline = Math.min(options.pairing.expiresAt, now + (options.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS));
  for (;;) {
    if (options.signal?.aborted) throw new GroupPairingError('aborted', '配对已取消。');
    if (Date.now() >= deadline) {
      throw new GroupPairingError('pending_timeout', '等待主机确认超时。请在主机上重新生成二维码后再试。', {
        retryable: true,
      });
    }
    options.onPhase?.('polling');
    const response = await fetchJson(groupPairStatusUrl(options.pairing.host, options.pairing.port, options.ticket), {
      method: 'GET',
      signal: options.signal,
    });
    const status = readPendingStatus(requireHttpOk(response, '查询配对状态'));
    if (status.status === 'pending') {
      await sleep(options.intervalMs, options.signal);
      continue;
    }
    if (status.status === 'denied') {
      throw new GroupPairingError('denied', status.message ?? '主机拒绝了本次配对。', { retryable: true });
    }
    if (status.status === 'expired') {
      throw new GroupPairingError('expired', status.message ?? '配对会话已过期，请重新生成二维码。');
    }
    return readPairedData(status);
  }
}

// ---------------------------------------------------------------------------
// Session (short-lived token + `__Host-dsh_session` cookie)
// ---------------------------------------------------------------------------

interface CachedGroupSession extends GroupSessionToken {
  key: string;
  hostId: string;
}

let cachedSession: CachedGroupSession | undefined;

/** 并发 ensureGroupSession 单飞：避免首次进入时重复 challenge/token 互相消费。 */
let inflightSessionEnsure: { key: string; promise: Promise<GroupSessionToken> } | null = null;

function sessionCacheKey(host: string, port: number, deviceId: string): string {
  return `${host}|${port}|${deviceId}`;
}

/** Drop the in-memory session cache (e.g. after re-pairing or clearing cache). */
export function resetGroupSessionCache(): void {
  cachedSession = undefined;
}

export interface GroupSessionParams {
  host: string;
  port: number;
  hostId: string;
  deviceId: string;
  /** Keychain/Keystore label of the group device key (connection.certRef). */
  label: string;
  signal?: AbortSignal;
  /** Clock override for tests. */
  now?: number;
}

export interface GroupSessionCookieParams {
  host: string;
  port: number;
  token: string;
  expiresAt: number;
  now?: number;
}

/**
 * Inject the session token as a `__Host-dsh_session` cookie into the shared
 * WKWebView/WebView cookie store (native side). Token is never written to logs
 * or persistent storage.
 */
export async function injectGroupSessionCookie(params: GroupSessionCookieParams): Promise<void> {
  const api = requireGroupNative();
  const now = params.now ?? Date.now();
  const maxAgeSeconds = Math.max(1, Math.floor((params.expiresAt - now) / 1000));
  await api.setSessionCookie({
    url: `${groupOrigin(params.host, params.port)}/`,
    name: GROUP_SESSION_COOKIE,
    value: params.token,
    maxAgeSeconds,
  });
}

/**
 * Request a fresh short-lived token: challenge → native signature → token →
 * cookie injection. Always hits the network; prefer {@link ensureGroupSessionIfNeeded}
 * in UI code.
 */
export async function ensureGroupSession(params: GroupSessionParams): Promise<GroupSessionToken> {
  const now = params.now ?? Date.now();
  if (!params.hostId) throw new GroupPairingError('invalid_request', '缺少主机 ID，无法获取访问令牌。');
  if (!params.deviceId) throw new GroupPairingError('invalid_request', '缺少设备 ID，无法获取访问令牌。');
  if (!params.label) throw new GroupPairingError('invalid_request', '缺少设备密钥标签，无法获取访问令牌。');

  const challengeUrl = groupAuthChallengeUrl(params.host, params.port);
  const challengeResponse = await fetchJson(challengeUrl, {
    method: 'POST',
    body: { deviceId: params.deviceId },
    signal: params.signal,
  });
  const challengeData = requireHttpOk(challengeResponse, '获取认证挑战', challengeUrl);
  if (!isRecord(challengeData) || typeof challengeData.nonce !== 'string' || challengeData.nonce === '') {
    throw new GroupPairingError('invalid_response', '服务端没有返回有效的认证挑战。');
  }
  const challenge = challengeData as unknown as GroupChallengeData;

  const signature = await signChallenge(params.label, params.hostId, params.deviceId, challenge.nonce);

  const tokenUrl = groupAuthTokenUrl(params.host, params.port);
  const tokenResponse = await fetchJson(tokenUrl, {
    method: 'POST',
    body: { deviceId: params.deviceId, nonce: challenge.nonce, signature },
    signal: params.signal,
  });
  const tokenData = requireHttpOk(tokenResponse, '获取访问令牌', tokenUrl);
  if (!isRecord(tokenData) || typeof tokenData.token !== 'string' || tokenData.token === '') {
    throw new GroupPairingError('invalid_response', '服务端没有返回有效的访问令牌。');
  }
  const expiresAt = Number(tokenData.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    throw new GroupPairingError('invalid_response', '服务端返回的访问令牌有效期无效。');
  }

  await injectGroupSessionCookie({
    host: params.host,
    port: params.port,
    token: tokenData.token,
    expiresAt,
    now,
  });
  const session: CachedGroupSession = {
    key: sessionCacheKey(params.host, params.port, params.deviceId),
    hostId: params.hostId,
    token: tokenData.token,
    expiresAt,
  };
  cachedSession = session;
  return { token: session.token, expiresAt: session.expiresAt };
}

/**
 * Ensure a valid session: reuse the in-memory token (re-injecting the cookie)
 * while it has enough validity left, otherwise request a fresh one.
 */
/**
 * 会话获取中值得短暂重试的错误（配对/重连后 relay 设备表尚未同步等）。
 * 404 unknown_device 只重试一次：刚配对时可能是 device.sync 还没到 relay；
 * 若仍 404，说明这台设备在主机侧已被删除/重置，继续重试没有意义，应提示重新配对。
 */
function isRetryableSessionError(error: unknown, attempt: number): boolean {
  if (error instanceof GroupPairingError) {
    if (error.code === 'network' || error.code === 'timeout') return true;
    if (error.code === 'http') {
      if (error.status === 404) return attempt < 1;
      return error.status === 401 || error.status === 429 || error.status === 502 || error.status === 503;
    }
  }
  return false;
}

export async function ensureGroupSessionIfNeeded(
  params: GroupSessionParams,
  options: { minValidityMs?: number; forceRefresh?: boolean } = {},
): Promise<GroupSessionToken> {
  const now = params.now ?? Date.now();
  const minValidityMs = options.minValidityMs ?? SESSION_REFRESH_MARGIN_MS;
  const key = sessionCacheKey(params.host, params.port, params.deviceId);
  if (!options.forceRefresh && cachedSession && cachedSession.key === key && cachedSession.hostId === params.hostId) {
    if (cachedSession.expiresAt - now > minValidityMs) {
      try {
        await injectGroupSessionCookie({
          host: params.host,
          port: params.port,
          token: cachedSession.token,
          expiresAt: cachedSession.expiresAt,
          now,
        });
        return { token: cachedSession.token, expiresAt: cachedSession.expiresAt };
      } catch {
        // Cookie injection failed (native unavailable): fall through to a fresh session.
      }
    }
  }
  if (inflightSessionEnsure !== null && inflightSessionEnsure.key === key) {
    return inflightSessionEnsure.promise;
  }
  const promise = (async () => {
    const delays = [250, 600, 1200];
    let lastError;
    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
      try {
        return await ensureGroupSession(params);
      } catch (error) {
        lastError = error;
        // 配对后立即进入时：relay 可能还没收到 host 的 device.sync（404 unknown_device），
        // 或 challenge/token 处于瞬时竞争（401）；这些都属于可重试错误，
        // 短暂退避后重试，避免把刚配对就 401 的体验暴露给用户。
        if (attempt >= delays.length || !isRetryableSessionError(error, attempt)) throw error;
        await sleep(delays[attempt] ?? 1200, params.signal);
      }
    }
    throw lastError;
  })();
  inflightSessionEnsure = { key, promise };
  try {
    return await promise;
  } finally {
    if (inflightSessionEnsure !== null && inflightSessionEnsure.promise === promise) {
      inflightSessionEnsure = null;
    }
  }
}

/** True when the cached session for this host/device still has >60s validity. */
export function hasValidGroupSession(params: Pick<GroupSessionParams, 'host' | 'port' | 'deviceId'>, now = Date.now()): boolean {
  if (!cachedSession) return false;
  if (cachedSession.key !== sessionCacheKey(params.host, params.port, params.deviceId)) return false;
  return cachedSession.expiresAt - now > SESSION_REFRESH_MARGIN_MS;
}
