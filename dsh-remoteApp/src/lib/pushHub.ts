/**
 * pushHub.ts — R2 官方推送：**设备凭证登记**（App ↔ 官方 hub）。
 *
 * R2 把「官方推送授权」从 relay 移到「官方 App ↔ 官方 hub」：官方 App 用群体版
 * 设备私钥（Secure Enclave / AndroidKeyStore 里的 P-256）向官方 hub 证明身份，换一张
 * per-device credential（JWT），再把 credential 交给主机；主机直连 hub 推送。
 * 契约见根目录 `docs/group-push-r2-contract.zh.md` §3/§4/§5.2。
 *
 * 流程（仅在 `PUSH_CHANNEL === 'official'` 且构建内置了 hub 地址时执行）：
 *   1. 读 SecureStore 里缓存的 credential（key = hash(endpoint|token|hostId)）：
 *      剩余有效期 > 24h 直接复用；
 *   2. `POST {endpoint}/v1/enroll/challenge` `{devicePublicKey}` → `{challengeId, nonce}`；
 *   3. 构造与契约 §3 **逐字节一致**的 `pushEnrollMessage()`（UTF-8、`\n` 连接、无末尾换行）→
 *      base64 → `signGroupDeviceMessage(label, base64)`（原生 P-256 ECDSA-SHA256）；
 *   4. `POST {endpoint}/v1/enroll` → 保存 `{credential, expiresAt}`（SecureStore）。
 *
 * 失败语义：返回可读 `error`，由 `push.ts` 记录为「官方推送暂不可用：<原因>」；
 * **不阻塞进入主机、不回退 relay 转发**（避免重复推送），进入主机/回前台时自动重试。
 *
 * 安全约束：
 *   - APNs device token / credential **不打印、不写日志**；
 *   - SecureStore 只存 credential + expiresAt（key 是 token 摘要 hash，不存 token 明文）；
 *   - hub 地址只来自构建常量（`pushConfig.ts`），运行时不接受用户输入。
 */

import * as SecureStore from 'expo-secure-store';

import {
  encodeAsciiToBase64,
  readGroupDevicePublicKey,
  signGroupDeviceMessage,
} from './group';
import {
  PUSH_ENROLL_CHALLENGE_PATH,
  PUSH_ENROLL_PATH,
  pushEnrollMessage,
} from './protocol';
import type { PushEnvironment } from './push';
import type { StoredConnection } from './store';

/** SecureStore key 前缀：value 只含 credential/expiresAt（不含 token）。 */
const CREDENTIAL_STORAGE_PREFIX = 'dshremote.push.credential.';

/** credential 剩余有效期超过该值时直接复用（契约 §5.2.2：剩余 >24h）。 */
export const CREDENTIAL_REUSE_MARGIN_MS = 24 * 60 * 60 * 1000;

const HUB_REQUEST_TIMEOUT_MS = 15_000;
/** challenge 过期/被用掉等可重试错误最多换 2 次 challenge。 */
const ENROLL_ATTEMPTS = 2;

const APNS_TOKEN_RE = /^[0-9a-f]{64}$/;
const BUNDLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$/;
/** hub credential 是三段式 JWT 字符串，服务端上限 4096 字符（见契约 §6.1）。 */
const CREDENTIAL_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MAX_CREDENTIAL_LENGTH = 4096;

/** 官方 hub 签发的设备凭证（不打印、不落盘到明文 key）。 */
export interface OfficialPushCredential {
  /** hub 签发的 per-device JWT（交给主机，主机直连 hub 时作 Bearer）。 */
  credential: string;
  /** 过期时间（epoch ms）。 */
  expiresAt: number;
  /** 本次使用的 hub 基址（构建常量）。 */
  endpoint: string;
  /** true = 直接复用了 SecureStore 缓存，没有重新登记。 */
  cached?: boolean;
}

export interface OfficialCredentialResult {
  ok: boolean;
  credentials?: OfficialPushCredential;
  /** 可读失败原因（不含 token / credential）。 */
  error?: string;
  /** 失败是否可重试（限流/网络/挑战过期）；push.ts 用于状态文案。 */
  retryable?: boolean;
}

export interface EnrollOfficialOptions {
  /** 官方 hub 公开基址（来自构建常量，已去尾斜杠）。 */
  endpoint: string;
  connection: StoredConnection;
  /** APNs device token（64 位小写十六进制；只在请求 body 里出现）。 */
  token: string;
  environment: PushEnvironment;
  /** iOS bundle id / Android package（expo-application applicationId）。 */
  bundleId: string;
}

interface CachedCredential {
  credential: string;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// 小工具（纯函数；不含网络/存储副作用）
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

/** bundle id：3..155 字符，仅字母数字/./-，首尾字母数字（与 server isValidBundleId 一致）。 */
export function isValidBundleId(value: string): boolean {
  return typeof value === 'string' && value.length >= 3 && value.length <= 155 && BUNDLE_ID_RE.test(value);
}

function isValidHubEndpoint(value: string): boolean {
  if (!/^https:\/\/[^\s]+$/i.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '' && url.search === '' && url.hash === '';
  } catch {
    return false;
  }
}

/**
 * 非加密摘要（FNV-1a 32 位），**仅用于 SecureStore 缓存 key**：
 * 契约要求 key 用 `endpoint|token|hostId` 的 hash，避免把 APNs token 明文写进 key。
 * 这里不需要抗碰撞（缓存只有几条），不进日志、不对外暴露。
 */
function fnv1aHex(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function credentialCacheKey(endpoint: string, token: string, hostId: string): string {
  return `${CREDENTIAL_STORAGE_PREFIX}${fnv1aHex(`${endpoint}|${token}|${hostId}`)}.v1`;
}

/** hub 返回的 expiresAt 兼容 epoch ms / 秒；非法返回 null。 */
function normalizeExpiresAt(raw: unknown): number | null {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value < 1_000_000_000_000 ? Math.round(value * 1000) : Math.round(value);
}

interface HubErrorEnvelope {
  code?: string;
  message?: string;
}

function readHubErrorEnvelope(body: unknown): HubErrorEnvelope {
  if (!isRecord(body) || !isRecord(body.error)) return {};
  return {
    code: typeof body.error.code === 'string' ? body.error.code : undefined,
    message: typeof body.error.message === 'string' ? body.error.message : undefined,
  };
}

/** `{ok:true,...}` 直接取 body（hub 的 challenge/enroll 成功响应是扁平结构）。 */
function isOkBody(body: unknown): body is Record<string, unknown> {
  return isRecord(body) && body.ok === true;
}

// ---------------------------------------------------------------------------
// SecureStore 缓存（只存 credential；失败不影响登记流程）
// ---------------------------------------------------------------------------

async function readCachedCredential(key: string): Promise<CachedCredential | null> {
  try {
    const raw = await SecureStore.getItemAsync(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    const credential = typeof parsed.credential === 'string' ? parsed.credential : '';
    const expiresAt = normalizeExpiresAt(parsed.expiresAt);
    if (credential === '' || expiresAt === null) return null;
    return { credential, expiresAt };
  } catch {
    return null;
  }
}

async function writeCachedCredential(key: string, cached: CachedCredential): Promise<void> {
  try {
    await SecureStore.setItemAsync(
      key,
      JSON.stringify({ v: 1, credential: cached.credential, expiresAt: cached.expiresAt }),
    );
  } catch {
    // 安全存储不可用时本次仍可用 credential；下次重新登记即可。
  }
}

// ---------------------------------------------------------------------------
// 官方 hub HTTP（公开 HTTPS；不带任何会话/设备凭据，签名在 body 里）
// ---------------------------------------------------------------------------

interface HubJsonResponse {
  status: number;
  body: unknown;
}

/**
 * POST JSON 到官方 hub。错误文案**不包含**请求/响应原文（body 里有 token/credential）。
 */
async function postHubJson(url: string, body: unknown, timeoutMs = HUB_REQUEST_TIMEOUT_MS): Promise<HubJsonResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
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
    return { status: response.status, body: parsed };
  } catch (error) {
    if (isRecord(error) && error.name === 'AbortError') {
      throw new Error(`连接官方推送服务超时（${Math.round(timeoutMs / 1000)}s）`);
    }
    throw new Error('无法连接官方推送服务，请确认手机已联网');
  } finally {
    clearTimeout(timer);
  }
}

function describeHubFailure(status: number, body: unknown): OfficialCredentialResult {
  const envelope = readHubErrorEnvelope(body);
  switch (envelope.code) {
    case 'rate_limited':
      // 限流立即重试没有意义：交给上层 60s 节流/下一次进入主机时再试。
      return { ok: false, error: '官方推送服务限流，请稍后再试', retryable: false };
    case 'challenge_expired':
    case 'challenge_used':
      return { ok: false, error: '官方登记挑战已过期，正在重试', retryable: true };
    case 'invalid_signature':
      return {
        ok: false,
        error: '设备签名未通过官方推送服务校验（设备密钥可能已变化，请重新进入主机后重试）',
      };
    case 'unsupported_bundle_id':
      return { ok: false, error: '官方推送服务不接受当前 App bundle id（官方构建配置不匹配）' };
    case 'enroll_disabled':
      return { ok: false, error: '官方推送服务当前未开启设备登记' };
    default:
      return {
        ok: false,
        error: `官方推送登记失败（HTTP ${status}${envelope.code ? `，${envelope.code}` : ''}）`,
        retryable: status >= 500 || status === 429,
      };
  }
}

// ---------------------------------------------------------------------------
// 登记主流程
// ---------------------------------------------------------------------------

/**
 * 取得（或复用缓存的）官方推送设备 credential。
 *
 * 调用前提：已拿到 APNs device token + environment + 当前连接（hostId/deviceKeyLabel）。
 * 任何失败都只返回 `{ok:false,error}`，**不抛错、不回退 relay**。
 */
export async function getOfficialPushCredential(
  options: EnrollOfficialOptions,
): Promise<OfficialCredentialResult> {
  const endpoint = (options.endpoint ?? '').trim().replace(/\/+$/, '');
  if (endpoint === '') {
    return { ok: false, error: '官方推送通道未配置（构建未内置 hub 地址）' };
  }
  if (!isValidHubEndpoint(endpoint)) {
    return { ok: false, error: '官方推送地址无效（必须是 https 基址，且不含用户信息/查询参数）' };
  }
  const bundleId = options.bundleId ?? '';
  if (!isValidBundleId(bundleId)) {
    return { ok: false, error: '无法识别 App bundle id，官方推送登记已跳过' };
  }
  const token = (options.token ?? '').trim().toLowerCase();
  if (!APNS_TOKEN_RE.test(token)) {
    return { ok: false, error: 'APNs device token 格式异常，官方推送登记已跳过' };
  }
  const hostId = options.connection.hostId ?? '';
  const label = options.connection.deviceKeyLabel ?? '';
  if (label === '') {
    return { ok: false, error: '缺少设备密钥标签，无法向官方推送服务登记' };
  }

  // 1) 缓存命中（剩余 >24h 直接复用）。
  const cacheKey = credentialCacheKey(endpoint, token, hostId);
  const cached = await readCachedCredential(cacheKey);
  if (cached && cached.expiresAt - Date.now() > CREDENTIAL_REUSE_MARGIN_MS) {
    return {
      ok: true,
      credentials: { credential: cached.credential, expiresAt: cached.expiresAt, endpoint, cached: true },
    };
  }

  // 2) 设备公钥（Sendable 私钥不出安全区，公钥可以给 hub）。
  const devicePublicKey = await readGroupDevicePublicKey(label);
  if (!devicePublicKey) {
    return {
      ok: false,
      error: '本机缺少群体版设备公钥，无法向官方推送服务登记（请重新进入主机；密钥丢失需重新配对）',
    };
  }

  let last: OfficialCredentialResult = { ok: false, error: '官方推送登记失败' };
  for (let attempt = 0; attempt < ENROLL_ATTEMPTS; attempt += 1) {
    try {
      // 2.1) 取一次性 challenge。
      const challengeResponse = await postHubJson(`${endpoint}${PUSH_ENROLL_CHALLENGE_PATH}`, { devicePublicKey });
      if (challengeResponse.status !== 200 || !isOkBody(challengeResponse.body)) {
        last = describeHubFailure(challengeResponse.status, challengeResponse.body);
        if (last.retryable && attempt + 1 < ENROLL_ATTEMPTS) continue;
        return last;
      }
      const challengeId = typeof challengeResponse.body.challengeId === 'string'
        ? challengeResponse.body.challengeId
        : '';
      const nonce = typeof challengeResponse.body.nonce === 'string' ? challengeResponse.body.nonce : '';
      if (challengeId === '' || nonce === '') {
        return { ok: false, error: '官方推送服务返回了无法识别的登记挑战' };
      }

      // 2.2) 构造与契约 §3 逐字节一致的签名消息，用设备私钥签名。
      const message = pushEnrollMessage({
        challengeId,
        nonce,
        devicePublicKey,
        hostId,
        token,
        environment: options.environment,
        bundleId,
      });
      let signature: string;
      try {
        signature = await signGroupDeviceMessage(label, encodeAsciiToBase64(message));
      } catch (error) {
        return { ok: false, error: `设备签名失败：${errorText(error)}` };
      }

      // 2.3) 提交登记，hub 验签后签发 credential。
      const enrollResponse = await postHubJson(`${endpoint}${PUSH_ENROLL_PATH}`, {
        challengeId,
        nonce,
        devicePublicKey,
        hostId,
        token,
        environment: options.environment,
        bundleId,
        signature,
      });
      if (enrollResponse.status !== 200 || !isOkBody(enrollResponse.body)) {
        last = describeHubFailure(enrollResponse.status, enrollResponse.body);
        if (last.retryable && attempt + 1 < ENROLL_ATTEMPTS) continue;
        return last;
      }
      const credential = typeof enrollResponse.body.credential === 'string'
        ? enrollResponse.body.credential
        : '';
      const expiresAt = normalizeExpiresAt(enrollResponse.body.expiresAt);
      if (
        credential === ''
        || credential.length > MAX_CREDENTIAL_LENGTH
        || !CREDENTIAL_RE.test(credential)
        || expiresAt === null
        || expiresAt <= Date.now()
      ) {
        return { ok: false, error: '官方推送服务返回了无效的设备凭证' };
      }

      // 2.4) 缓存 credential（value 只有 credential/expiresAt，不含 token）。
      await writeCachedCredential(cacheKey, { credential, expiresAt });
      return { ok: true, credentials: { credential, expiresAt, endpoint } };
    } catch (error) {
      last = { ok: false, error: errorText(error), retryable: true };
      if (attempt + 1 < ENROLL_ATTEMPTS) continue;
      return last;
    }
  }
  return last;
}
