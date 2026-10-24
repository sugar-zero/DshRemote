/**
 * DSH Remote — pairing flow (client side skeleton).
 *
 * Flow (docs/remote-access-evaluation.zh.md §4.3, ADMIN-API.md §2):
 *   1. QR scan yields `dshremote://pair?...` (parsed by `protocol.ts`).
 *   2. App generates a device key pair + CSR. In the final design the private
 *      key is generated in the Secure Enclave / Android Keystore and never
 *      leaves native code; this POC calls the `dsh-mtls` native module and
 *      throws a typed `unsupported` error until the CSR milestone lands.
 *   3. POST `https://<host>/__dsh_remote/pair` with
 *      `{ secret, csrPem, deviceName, platform }`.
 *        - `{ok:true,data:{status:'paired',...}}` → certificate issued.
 *        - `{ok:true,data:{status:'pending', ticket}}` → wait for desktop approval.
 *   4. Poll `GET /__dsh_remote/pair/status?ticket=...` until
 *      `paired | denied | expired`.
 *   5. Persist host metadata + certificate PEM in SecureStore/Keychain and
 *      configure the native mTLS identity label.
 *
 * Transport is injectable:
 *   - Default `FetchPairingTransport` uses RN `fetch` (works for the pairing
 *     path, which the host allows without a client certificate).
 *   - Once the native module can do mTLS on arbitrary requests, a
 *     `NativeMtlsPairingTransport` can be plugged in for `/pair/status` and
 *     future authenticated calls without touching callers. See
 *     `createNativeMtlsTransportPlaceholder()`.
 */

import { Platform } from 'react-native';
import {
  isBase64UrlOfLength,
  pairStatusUrl,
  pairUrl,
  pushTokenUrl,
  type PairedDeviceData,
  type PairingUri,
  type PairRequestBody,
  type PairPlatform,
  type PairStartData,
  type PairStatusData,
  type PairTicketStatus,
  type PushTokenRequestBody,
} from './protocol';
import {
  saveCertificate,
  saveConnection,
  type StoredConnection,
} from './store';
import {
  DshMtlsUnavailableError,
  generateCsr as nativeGenerateCsr,
  installCertificate as nativeInstallCertificate,
  requestWithClientCert,
  setClientIdentity as nativeSetClientIdentity,
} from '../../modules/dsh-mtls/src';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type PairingErrorCode =
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'http'
  | 'protocol'
  | 'invalid_request'
  | 'unauthorized'
  | 'rate_limited'
  | 'denied'
  | 'expired'
  | 'unsupported'
  | 'fingerprint_mismatch'
  | 'invalid_uri';

export interface PairingErrorOptions {
  status?: number;
  retryable?: boolean;
  detail?: unknown;
}

/** Typed, user-presentable pairing failure. */
export class PairingError extends Error {
  readonly code: PairingErrorCode;
  readonly status?: number;
  readonly retryable: boolean;
  readonly detail?: unknown;

  constructor(code: PairingErrorCode, message: string, options: PairingErrorOptions = {}) {
    super(message);
    this.name = 'PairingError';
    this.code = code;
    this.status = options.status;
    this.retryable = options.retryable ?? (code === 'network' || code === 'timeout');
    this.detail = options.detail;
    Object.setPrototypeOf(this, PairingError.prototype);
  }
}

/** Convert any thrown value into a `PairingError` while preserving useful text. */
export function toPairingError(error: unknown): PairingError {
  if (error instanceof PairingError) return error;
  if (error instanceof Error) {
    return new PairingError('protocol', error.message || '配对失败，请重试。', { detail: error });
  }
  return new PairingError('protocol', '配对失败，请重试。', { detail: error });
}

// ---------------------------------------------------------------------------
// Transport abstraction
// ---------------------------------------------------------------------------

/** Raw transport response; the pairing layer owns envelope + protocol validation. */
export interface PairingHttpResponse {
  status: number;
  /** Parsed JSON body, or `null` when the body was empty/non-JSON. */
  body: unknown;
}

export interface PairingRequestParams {
  url: string;
  body: PairRequestBody;
  signal?: AbortSignal;
}

export interface PairingStatusParams {
  url: string;
  signal?: AbortSignal;
}

/**
 * Transport used by the pairing layer.
 *
 * `fetch` is the POC default. The final `NativeMtlsPairingTransport` will do the
 * same calls through the native module so that the device certificate is
 * presented on every request after pairing; injecting it here means screens
 * don't change.
 */
export interface PairingTransport {
  /** Short identifier for diagnostics, e.g. `fetch`. */
  readonly kind: string;
  requestPairing(params: PairingRequestParams): Promise<PairingHttpResponse>;
  fetchPairingStatus(params: PairingStatusParams): Promise<PairingHttpResponse>;
}

export interface FetchPairingTransportOptions {
  /** Per-request timeout. Pairing secrets expire after 120s; default is conservative. */
  timeoutMs?: number;
  /** Injectable fetch for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Extra headers (e.g. a client-generated request id for host-side logs). */
  headers?: Record<string, string>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

function parseJsonOrNull(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

/**
 * `fetch`-based transport. Works for `/__dsh_remote/pair` (no client cert
 * required by the host) and for status polling in a POC host that leaves the
 * pairing route open. The relay/tunnel must be reachable over HTTPS.
 */
export class FetchPairingTransport implements PairingTransport {
  readonly kind = 'fetch';
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly headers: Record<string, string>;

  constructor(options: FetchPairingTransportOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.headers = options.headers ?? {};
  }

  private async send(
    url: string,
    init: RequestInit,
    externalSignal?: AbortSignal,
  ): Promise<PairingHttpResponse> {
    if (externalSignal?.aborted) {
      throw new PairingError('aborted', '配对已取消。');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = () => controller.abort();
    externalSignal?.addEventListener('abort', onAbort);

    try {
      const response = await this.fetchImpl(url, {
        ...init,
        headers: { accept: 'application/json', ...this.headers, ...init.headers },
        signal: controller.signal,
      });
      const text = await response.text();
      return { status: response.status, body: parseJsonOrNull(text) };
    } catch (error) {
      if (isAbortError(error)) {
        if (externalSignal?.aborted) throw new PairingError('aborted', '配对已取消。');
        throw new PairingError('timeout', `连接主机超时（${Math.round(this.timeoutMs / 1000)}s）。请检查网络与主机是否在线。`, {
          retryable: true,
          detail: error,
        });
      }
      throw new PairingError(
        'network',
        '无法连接主机。请确认手机已联网、主机在线，且当前网络可以访问中继域名。',
        { retryable: true, detail: error },
      );
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onAbort);
    }
  }

  async requestPairing({ url, body, signal }: PairingRequestParams): Promise<PairingHttpResponse> {
    return this.send(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      signal,
    );
  }

  async fetchPairingStatus({ url, signal }: PairingStatusParams): Promise<PairingHttpResponse> {
    return this.send(url, { method: 'GET' }, signal);
  }
}

/** Default transport used by screens. */
export const defaultPairingTransport: PairingTransport = new FetchPairingTransport();

/**
 * Placeholder for the future native mTLS transport.
 *
 * Real implementation (next milestone) will call a native `fetchWithClientCert`
 * function that presents the `SecIdentity` / Keystore key configured via
 * `setClientIdentity(label)`. That transport is required for:
 *   - `/__dsh_remote/pair/status` on hosts that require mTLS there,
 *   - `/__dsh_remote/push-token`,
 *   - any authenticated bootstrap calls made outside the WebView.
 */
export function createNativeMtlsTransportPlaceholder(): PairingTransport {
  const unavailable = async (): Promise<never> => {
    throw new PairingError(
      'unsupported',
      '原生 mTLS 传输尚未实现（POC：请使用默认 fetch 传输；正式版由 modules/dsh-mtls 提供）。',
    );
  };
  return {
    kind: 'native-mtls-placeholder',
    requestPairing: unavailable,
    fetchPairingStatus: unavailable,
  };
}

// ---------------------------------------------------------------------------
// Native CSR (device identity)
// ---------------------------------------------------------------------------

/**
 * Loudly-marked placeholder used ONLY to exercise the pairing transport against
 * a mock host in development. The real app must send a genuine PKCS#10 CSR from
 * the native module; the host is expected to reject this value.
 */
export const POC_PLACEHOLDER_CSR =
  '-----BEGIN CERTIFICATE REQUEST-----\n' +
  'POC-PLACEHOLDER-NOT-A-REAL-CSR-REPLACE-WITH-NATIVE-MODULE\n' +
  '-----END CERTIFICATE REQUEST-----\n';

export interface DeviceCsr {
  csrPem: string;
  /** Keychain/Keystore label for the generated private key, if native code returned one. */
  certRef?: string;
  /** `placeholder` marks the dev-only path so callers can warn the user. */
  source: 'native' | 'placeholder';
}

/**
 * Create the device key pair + CSR through the native module.
 *
 * Private keys are generated in native code (Secure Enclave / Keystore) and are
 * never returned to JS — only the CSR PEM is.
 */
export async function createDeviceCsr(
  commonName: string,
  options: { allowPlaceholder?: boolean } = {},
): Promise<DeviceCsr> {
  try {
    const result = await nativeGenerateCsr(commonName);
    return { csrPem: result.csrPem, certRef: result.label, source: 'native' };
  } catch (error) {
    if (options.allowPlaceholder && error instanceof DshMtlsUnavailableError) {
      return { csrPem: POC_PLACEHOLDER_CSR, source: 'placeholder' };
    }
    if (error instanceof DshMtlsUnavailableError) {
      throw new PairingError(
        'unsupported',
        '设备密钥生成需要原生模块（modules/dsh-mtls），当前构建未包含它。' +
          '请使用 `npx expo run:ios` 构建 dev client，或打开 POC 调试选项使用占位 CSR。',
        { detail: error },
      );
    }
    throw new PairingError('protocol', '生成设备证书请求（CSR）失败。', { detail: error });
  }
}

// ---------------------------------------------------------------------------
// Envelope + payload validation
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Accept both the documented envelope (`{ok:true,data}`) and a bare payload, so
 * the app tolerates host implementations that respond without the envelope.
 */
function unwrapData(body: unknown): unknown {
  if (!isRecord(body)) {
    throw new PairingError('protocol', '主机返回了无法识别的响应。');
  }
  if (typeof body.ok === 'boolean') {
    if (body.ok === false) {
      const error = isRecord(body.error) ? body.error : {};
      const code = typeof error.code === 'string' ? error.code : 'unknown';
      const message = typeof error.message === 'string' ? error.message : '主机拒绝了本次请求。';
      throw new PairingError('http', message, { detail: { code } });
    }
    return body.data;
  }
  return body;
}

function requireString(source: Record<string, unknown>, field: string, label: string): string {
  const value = source[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new PairingError('protocol', `主机响应缺少字段 "${label}"。`);
  }
  return value;
}

function looksLikePem(value: string, label: 'CERTIFICATE' | 'CERTIFICATE REQUEST'): boolean {
  return value.includes(`-----BEGIN ${label}-----`) && value.includes(`-----END ${label}-----`);
}

function mapHttpStatus(status: number, message: string): PairingError {
  if (status === 400 || status === 422) {
    return new PairingError('invalid_request', message || '主机认为配对请求无效（secret/CSR 可能已过期）。', { status });
  }
  if (status === 401 || status === 403) {
    return new PairingError('unauthorized', message || '配对密钥无效或已被使用，请在主机上重新生成二维码。', { status });
  }
  if (status === 404) {
    return new PairingError('unsupported', message || '主机未开启远程访问或路径不存在（/__dsh_remote/pair）。', { status });
  }
  if (status === 409 || status === 410) {
    return new PairingError('expired', message || '配对会话已结束或已过期。', { status });
  }
  if (status === 429) {
    return new PairingError('rate_limited', message || '尝试过于频繁，请稍后再试。', { status, retryable: true });
  }
  return new PairingError('http', message || `主机返回 HTTP ${status}。`, { status });
}

function readPairedDeviceData(data: unknown): PairedDeviceData {
  if (!isRecord(data)) {
    throw new PairingError('protocol', '主机响应格式错误（paired 数据缺失）。');
  }
  if (data.status !== 'paired') {
    throw new PairingError('protocol', `主机响应状态不是 paired（实际为 ${String(data.status)}）。`);
  }
  const certPem = requireString(data, 'certPem', 'certPem');
  const caPem = requireString(data, 'caPem', 'caPem');
  if (!looksLikePem(certPem, 'CERTIFICATE') || !looksLikePem(caPem, 'CERTIFICATE')) {
    throw new PairingError('protocol', '主机返回的设备证书/CA 不是合法 PEM。');
  }
  const deviceId = requireString(data, 'deviceId', 'deviceId');
  const hostName = typeof data.hostName === 'string' ? data.hostName : hostNameFallback(deviceId);
  const hostFingerprint = requireString(data, 'hostFingerprint', 'hostFingerprint');
  if (!isBase64UrlOfLength(hostFingerprint, 32)) {
    throw new PairingError('protocol', '主机响应中的 hostFingerprint 格式无效。');
  }
  return { status: 'paired', deviceId, certPem, caPem, hostName, hostFingerprint };
}

function hostNameFallback(deviceId: string): string {
  return `DSH 主机（${deviceId}）`;
}

function readPairStartData(data: unknown): PairStartData {
  if (!isRecord(data)) {
    throw new PairingError('protocol', '主机响应格式错误。');
  }
  if (data.status === 'paired') return readPairedDeviceData(data);
  if (data.status === 'pending') {
    const ticket = requireString(data, 'ticket', 'ticket');
    return { status: 'pending', ticket };
  }
  throw new PairingError('protocol', `未知的配对状态 "${String(data.status)}"。`);
}

function readPairStatusData(data: unknown): PairStatusData {
  if (!isRecord(data)) {
    throw new PairingError('protocol', '主机状态响应格式错误。');
  }
  const status = data.status;
  if (status !== 'pending' && status !== 'paired' && status !== 'denied' && status !== 'expired') {
    throw new PairingError('protocol', `未知的配对状态 "${String(status)}"。`);
  }
  switch (status) {
    case 'pending':
      return { status };
    case 'denied':
      return { status, message: typeof data.message === 'string' ? data.message : undefined };
    case 'expired':
      return { status, message: typeof data.message === 'string' ? data.message : undefined };
    case 'paired': {
      const paired = readPairedDeviceData({ ...data, status: 'paired' });
      return {
        status: 'paired',
        deviceId: paired.deviceId,
        certPem: paired.certPem,
        caPem: paired.caPem,
        hostName: paired.hostName,
        hostFingerprint: paired.hostFingerprint,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Pairing API calls
// ---------------------------------------------------------------------------

export interface RequestPairingOptions {
  pairing: PairingUri;
  deviceName: string;
  platform: PairPlatform;
  csrPem: string;
  transport?: PairingTransport;
  signal?: AbortSignal;
}

export type PairStartResult =
  | { kind: 'paired'; device: PairedDeviceData }
  | { kind: 'pending'; ticket: string };

/** One-shot `POST /__dsh_remote/pair`. */
export async function requestPairing(options: RequestPairingOptions): Promise<PairStartResult> {
  const { pairing, deviceName, platform, csrPem } = options;
  const transport = options.transport ?? defaultPairingTransport;
  if (!csrPem || !looksLikePem(csrPem, 'CERTIFICATE REQUEST')) {
    throw new PairingError('invalid_request', '设备证书请求（CSR）格式无效。');
  }
  const body: PairRequestBody = { secret: pairing.secret, csrPem, deviceName, platform };

  let response: PairingHttpResponse;
  try {
    response = await transport.requestPairing({ url: pairUrl(pairing.host), body, signal: options.signal });
  } catch (error) {
    throw toPairingError(error);
  }

  if (response.status < 200 || response.status >= 300) {
    throw mapHttpStatus(response.status, extractErrorMessage(response.body));
  }
  const data = unwrapData(response.body);
  const start = readPairStartData(data);
  if (start.status === 'pending') return { kind: 'pending', ticket: start.ticket };

  verifyHostFingerprint(pairing, start.hostFingerprint);
  return { kind: 'paired', device: start };
}

function extractErrorMessage(body: unknown): string {
  if (!isRecord(body)) return '';
  if (isRecord(body.error) && typeof body.error.message === 'string') return body.error.message;
  if (typeof body.message === 'string') return body.message;
  return '';
}

function verifyHostFingerprint(pairing: PairingUri, returnedFingerprint: string): void {
  if (returnedFingerprint !== pairing.hostFingerprint) {
    throw new PairingError(
      'fingerprint_mismatch',
      '主机指纹与二维码不一致：连接可能被中间人劫持，已中止配对。请重新生成二维码并在主机上确认。',
    );
  }
}

export interface WaitForPairingOptions {
  pairing: PairingUri;
  ticket: string;
  transport?: PairingTransport;
  signal?: AbortSignal;
  /** Poll interval in ms (default 1500). */
  intervalMs?: number;
  /** Extra safety timeout on top of the pairing URI expiry (default 120s). */
  timeoutMs?: number;
  /** Phase callback for UI (request animation of state changes). */
  onPhase?: (phase: 'pending' | 'polling') => void;
}

const DEFAULT_POLL_INTERVAL_MS = 1500;
const DEFAULT_POLL_TIMEOUT_MS = 120_000;

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new PairingError('aborted', '配对已取消。'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new PairingError('aborted', '配对已取消。'));
    };
    signal?.addEventListener('abort', onAbort);
  });
}

/**
 * Poll `/__dsh_remote/pair/status?ticket=...` until the desktop approves/denies,
 * the ticket expires, or the caller aborts. Resolves with the issued device data.
 */
export async function waitForPairing(options: WaitForPairingOptions): Promise<PairedDeviceData> {
  const transport = options.transport ?? defaultPairingTransport;
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Math.min(
    options.pairing.expiresAt,
    Date.now() + (options.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS),
  );
  options.onPhase?.('pending');

  for (;;) {
    if (options.signal?.aborted) throw new PairingError('aborted', '配对已取消。');
    if (Date.now() >= deadline) {
      throw new PairingError('timeout', '等待桌面端确认超时。请在主机上重新生成二维码后再试。', { retryable: true });
    }
    options.onPhase?.('polling');
    let response: PairingHttpResponse;
    try {
      response = await transport.fetchPairingStatus({
        url: pairStatusUrl(options.pairing.host, options.ticket),
        signal: options.signal,
      });
    } catch (error) {
      throw toPairingError(error);
    }
    if (response.status < 200 || response.status >= 300) {
      throw mapHttpStatus(response.status, extractErrorMessage(response.body));
    }
    const status = readPairStatusData(unwrapData(response.body));
    switch (status.status) {
      case 'pending':
        await delay(intervalMs, options.signal);
        continue;
      case 'denied':
        throw new PairingError('denied', status.message ?? '桌面端拒绝了本次配对。', { retryable: true });
      case 'expired':
        throw new PairingError('expired', status.message ?? '配对会话已过期，请重新生成二维码。');
      case 'paired': {
        const device: PairedDeviceData = {
          status: 'paired',
          deviceId: status.deviceId ?? '',
          certPem: status.certPem ?? '',
          caPem: status.caPem ?? '',
          hostName: status.hostName ?? '',
          hostFingerprint: status.hostFingerprint ?? '',
        };
        const validated = readPairedDeviceData({ ...device, status: 'paired' });
        verifyHostFingerprint(options.pairing, validated.hostFingerprint);
        return validated;
      }
    }
  }
}

export interface PairDeviceOptions extends Omit<RequestPairingOptions, 'csrPem'> {
  csrPem?: string;
  /** Dev-only fallback: send the loud placeholder CSR instead of failing. */
  allowPlaceholderCsr?: boolean;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  onPhase?: (phase: 'requesting' | 'pending' | 'polling' | 'paired') => void;
}

export interface PairedDeviceResult {
  device: PairedDeviceData;
  connection: StoredConnection;
  /** True when the placeholder CSR was used (POC wiring test only). */
  usedPlaceholderCsr: boolean;
}

/**
 * Full pairing flow: CSR → POST /pair → (poll) → verify fingerprint → persist.
 * This is what `PairingScreen` calls.
 */
export async function pairDevice(options: PairDeviceOptions): Promise<PairedDeviceResult> {
  const { pairing, deviceName, platform } = options;
  options.onPhase?.('requesting');

  const csr = options.csrPem
    ? { csrPem: options.csrPem, source: 'native' as const, certRef: undefined }
    : await createDeviceCsr(deviceName || 'DSH Remote device', {
        allowPlaceholder: options.allowPlaceholderCsr ?? false,
      });

  const start = await requestPairing({
    pairing,
    deviceName,
    platform,
    csrPem: csr.csrPem,
    transport: options.transport,
    signal: options.signal,
  });

  let device: PairedDeviceData;
  if (start.kind === 'paired') {
    device = start.device;
  } else {
    device = await waitForPairing({
      pairing,
      ticket: start.ticket,
      transport: options.transport,
      signal: options.signal,
      intervalMs: options.pollIntervalMs,
      timeoutMs: options.pollTimeoutMs,
      onPhase: options.onPhase ? (phase) => options.onPhase?.(phase) : undefined,
    });
  }

  options.onPhase?.('paired');
  const connection = await persistPairedDevice({
    pairing,
    device,
    deviceName,
    certRef: csr.certRef,
  });
  return { device, connection, usedPlaceholderCsr: csr.source === 'placeholder' };
}

/** Persist host metadata + certificate PEM after a successful pairing. */
export async function persistPairedDevice(params: {
  pairing: PairingUri;
  device: PairedDeviceData;
  deviceName: string;
  certRef?: string;
}): Promise<StoredConnection> {
  const { pairing, device, deviceName } = params;
  const connection: StoredConnection = {
    host: pairing.host,
    relayDomain: pairing.relayDomain,
    hostFingerprint: device.hostFingerprint,
    deviceId: device.deviceId,
    deviceName,
    certRef: params.certRef,
    hostName: device.hostName,
    pairedAt: Date.now(),
  };
  await saveConnection(connection);
  await saveCertificate({
    certPem: device.certPem,
    caPem: device.caPem,
    storedAt: Date.now(),
  }, device.hostFingerprint);
  // 原生 CSR 流程：把主机签发的证书装回 Keychain 并关联设备私钥（label=certRef）。
  if (params.certRef) {
    try {
      await nativeInstallCertificate(device.certPem, params.certRef);
      await nativeSetClientIdentity(params.certRef);
      connection.certRef = params.certRef;
    } catch (error) {
      // 配对本身已成功；证书安装失败时让诊断页/重新配对处理，不丢失主机侧记录。
      console.warn('[dsh-remote] installCertificate failed:', error);
    }
  }
  return connection;
}

/**
 * Register the Expo push token with the host (`POST /__dsh_remote/push-token`).
 * Requires mTLS, therefore requires the native transport (next milestone).
 */
export async function registerPushToken(options: {
  host: string;
  token: string;
  provider?: PushTokenRequestBody['provider'];
  /** 注入原生 mTLS 传输的测试替身；缺省走 dsh-mtls 原生模块。 */
  requestWithCert?: typeof requestWithClientCert;
  signal?: AbortSignal;
}): Promise<void> {
  const request = options.requestWithCert ?? requestWithClientCert;
  const response = await request({
    url: pushTokenUrl(options.host),
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: options.provider ?? 'expo', token: options.token }),
  });
  if (response.status !== 200) {
    throw new PairingError('http', `推送 token 注册失败：HTTP ${response.status}`, { status: response.status });
  }
}

// ---------------------------------------------------------------------------
// Platform / device helpers
// ---------------------------------------------------------------------------

/** Pairing platform value; web preview is mapped to `ios` (POC UI only). */
export function currentPairPlatform(): PairPlatform {
  return Platform.OS === 'android' ? 'android' : 'ios';
}

/** Human-readable default device name used before the user edits it. */
export function defaultDeviceName(): string {
  return Platform.OS === 'android' ? '我的 Android 设备' : '我的 iPhone';
}
