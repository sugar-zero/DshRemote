/**
 * R2 设备登记（/v1/enroll/challenge + /v1/enroll）的纯逻辑：
 * challenge/nonce 一次性存储、请求字段校验、设备 P-256 PoP 验签。
 *
 * 契约：docs/group-push-r2-contract.zh.md §3 / §4.1 / §4.2。
 *
 * 安全要点：
 * - nonce **一次性**、默认 120s TTL；消费后记录到 used（防重放），过期后视为 expired；
 * - 挑战只存内存（Map），重启清零 = 客户端重新 challenge（契约允许）；
 * - nonce 用常量时间比较；签名用协议包的 verifyGroupDeviceSignature（P-256 ECDSA-SHA256 DER）；
 * - 字段错误信息只描述格式，**绝不回显 token 值**。
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  groupDevicePublicKeyObject,
  isPushEnvironment,
  isValidApnsDeviceToken,
  isValidBundleId,
  pushEnrollMessage,
  verifyGroupDeviceSignature,
} from 'dsh-remote-protocol';

/** challengeId 随机字节数（16B → 22 字符 base64url）。 */
export const HUB_CHALLENGE_ID_BYTES = 16;
/** nonce 随机字节数（32B → 43 字符 base64url，与群体版其它 challenge 一致）。 */
export const HUB_CHALLENGE_NONCE_BYTES = 32;
/** 默认 challenge TTL（契约 §4.1：120s）。 */
export const HUB_DEFAULT_CHALLENGE_TTL_MS = 120_000;
/** pending challenge 上限（防内存耗尽；正常量级远小于此）。 */
export const HUB_DEFAULT_MAX_PENDING_CHALLENGES = 10_000;

const CHALLENGE_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{20,128}$/;
const HOST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SIGNATURE_RE = /^[A-Za-z0-9_-]{20,256}$/;

/** challenge 请求允许的字段。 */
const CHALLENGE_FIELDS = ['devicePublicKey'];
/** enroll 请求允许的字段。 */
const ENROLL_FIELDS = ['challengeId', 'nonce', 'devicePublicKey', 'hostId', 'token', 'environment', 'bundleId', 'signature'];

/**
 * @param {unknown} raw
 * @returns {boolean}
 */
export function isValidChallengeId(raw) {
  return typeof raw === 'string' && CHALLENGE_ID_RE.test(raw);
}

/**
 * @param {unknown} raw
 * @returns {boolean}
 */
export function isValidEnrollNonce(raw) {
  return typeof raw === 'string' && NONCE_RE.test(raw);
}

/**
 * hostId 可选：`h_ab12cd34` 形态（`[A-Za-z0-9_-]{1,64}`）。
 * @param {unknown} raw
 * @returns {boolean}
 */
export function isValidEnrollHostId(raw) {
  return typeof raw === 'string' && HOST_ID_RE.test(raw);
}

/**
 * 常量时间字符串比较（长度不同也走完整比较）。
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function constantTimeEquals(a, b) {
  const ab = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  const length = Math.max(ab.length, bb.length, 1);
  const aPad = Buffer.alloc(length);
  const bPad = Buffer.alloc(length);
  ab.copy(aPad);
  bb.copy(bPad);
  return timingSafeEqual(aPad, bPad) && ab.length === bb.length;
}

/**
 * challenge 存储：pending（未使用）+ used（已消费，保留一个 TTL 用于返回 challenge_used）。
 */
export class ChallengeStore {
  /**
   * @param {object} [options]
   * @param {number} [options.ttlMs]
   * @param {() => number} [options.now]
   * @param {number} [options.maxPending]
   */
  constructor({ ttlMs = HUB_DEFAULT_CHALLENGE_TTL_MS, now = Date.now, maxPending = HUB_DEFAULT_MAX_PENDING_CHALLENGES } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.maxPending = maxPending;
    /** @type {Map<string, {nonce: string, devicePublicKey: string, createdAt: number, expiresAt: number}>} */
    this.pending = new Map();
    /** @type {Map<string, number>} challengeId → 记录过期时间（用于重放提示） */
    this.used = new Map();
  }

  /** 惰性清理过期条目。 */
  purge() {
    const now = this.now();
    for (const [id, record] of this.pending) {
      if (record.expiresAt <= now) this.pending.delete(id);
    }
    for (const [id, expiresAt] of this.used) {
      if (expiresAt <= now) this.used.delete(id);
    }
  }

  /**
   * 签发一个一次性 challenge（不绑定 devicePublicKey；契约 §4.1 只做格式校验）。
   * @param {string} [devicePublicKey]
   * @returns {{challengeId: string, nonce: string, expiresAt: number, devicePublicKey: string}}
   */
  issue(devicePublicKey = '') {
    this.purge();
    if (this.pending.size >= this.maxPending) {
      const error = new Error('too many pending enroll challenges');
      // @ts-ignore 与 hub-server 的错误码约定一致
      error.code = 'rate_limited';
      throw error;
    }
    const now = this.now();
    const challengeId = randomBytes(HUB_CHALLENGE_ID_BYTES).toString('base64url');
    const nonce = randomBytes(HUB_CHALLENGE_NONCE_BYTES).toString('base64url');
    const record = { nonce, devicePublicKey, createdAt: now, expiresAt: now + this.ttlMs };
    this.pending.set(challengeId, record);
    return { challengeId, nonce, expiresAt: record.expiresAt, devicePublicKey };
  }

  /**
   * 查询 challenge 状态（不消费）。
   * @param {string} challengeId
   * @returns {{status: 'ok', nonce: string, expiresAt: number, devicePublicKey: string}
   *   | {status: 'expired'} | {status: 'used'}}
   */
  lookup(challengeId) {
    this.purge();
    const record = this.pending.get(challengeId);
    if (record) {
      if (record.expiresAt <= this.now()) {
        this.pending.delete(challengeId);
        return { status: 'expired' };
      }
      return { status: 'ok', nonce: record.nonce, expiresAt: record.expiresAt, devicePublicKey: record.devicePublicKey };
    }
    if (this.used.has(challengeId)) return { status: 'used' };
    return { status: 'expired' };
  }

  /**
   * 消费 challenge（成功 enroll 后调用）：从 pending 删除并记入 used。
   * @param {string} challengeId
   */
  consume(challengeId) {
    this.purge();
    const record = this.pending.get(challengeId);
    this.pending.delete(challengeId);
    this.used.set(challengeId, this.now() + this.ttlMs);
    return Boolean(record);
  }

  get pendingCount() {
    return this.pending.size;
  }

  get usedCount() {
    return this.used.size;
  }

  reset() {
    this.pending.clear();
    this.used.clear();
  }
}

/**
 * 校验 `POST /v1/enroll/challenge` 请求体。
 * @param {unknown} body
 * @returns {{ok: true, devicePublicKey: string} | {ok: false, message: string}}
 */
export function validateChallengeRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, message: 'request body must be a JSON object' };
  }
  const record = /** @type {Record<string, any>} */ (body);
  const unknown = Object.keys(record).filter((key) => !CHALLENGE_FIELDS.includes(key));
  if (unknown.length > 0) {
    return { ok: false, message: `unsupported field(s): ${unknown.join(', ')} (allowed: devicePublicKey)` };
  }
  const devicePublicKey = record.devicePublicKey;
  if (devicePublicKey === undefined || devicePublicKey === null || devicePublicKey === '') {
    return { ok: true, devicePublicKey: '' };
  }
  if (typeof devicePublicKey !== 'string') {
    return { ok: false, message: 'devicePublicKey must be a base64url-encoded uncompressed P-256 point (65 bytes)' };
  }
  try {
    groupDevicePublicKeyObject(devicePublicKey);
  } catch {
    return { ok: false, message: 'devicePublicKey must be a base64url-encoded uncompressed P-256 point (65 bytes)' };
  }
  return { ok: true, devicePublicKey };
}

/**
 * 校验 `POST /v1/enroll` 请求体（字段格式；challenge/签名/bundle 由调用方继续校验）。
 *
 * 顺序与契约 §4.2 一致：challengeId → nonce → devicePublicKey → token → environment →
 * bundleId → hostId → signature。
 *
 * @param {unknown} body
 * @returns {{ok: true, fields: {challengeId: string, nonce: string, devicePublicKey: string, hostId: string, token: string, environment: string, bundleId: string, signature: string}}
 *   | {ok: false, message: string}}
 */
export function validateEnrollRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, message: 'request body must be a JSON object' };
  }
  const record = /** @type {Record<string, any>} */ (body);
  const unknown = Object.keys(record).filter((key) => !ENROLL_FIELDS.includes(key));
  if (unknown.length > 0) {
    return { ok: false, message: `unsupported field(s): ${unknown.join(', ')}` };
  }
  if (!isValidChallengeId(record.challengeId)) {
    return { ok: false, message: 'challengeId must be a base64url string (16..128 chars) from /v1/enroll/challenge' };
  }
  if (!isValidEnrollNonce(record.nonce)) {
    return { ok: false, message: 'nonce must be a base64url string (20..128 chars) from /v1/enroll/challenge' };
  }
  if (typeof record.devicePublicKey !== 'string') {
    return { ok: false, message: 'devicePublicKey must be a base64url-encoded uncompressed P-256 point (65 bytes)' };
  }
  try {
    groupDevicePublicKeyObject(record.devicePublicKey);
  } catch {
    return { ok: false, message: 'devicePublicKey must be a base64url-encoded uncompressed P-256 point (65 bytes)' };
  }
  if (!isValidApnsDeviceToken(record.token)) {
    return { ok: false, message: 'token must be 64 lowercase hex characters (APNs device token)' };
  }
  if (!isPushEnvironment(record.environment)) {
    return { ok: false, message: 'environment must be "development" or "production"' };
  }
  if (!isValidBundleId(record.bundleId)) {
    return { ok: false, message: 'bundleId must be a valid bundle id (3..155 chars, letters/digits/./-)' };
  }
  let hostId = '';
  if (record.hostId !== undefined && record.hostId !== null && record.hostId !== '') {
    if (!isValidEnrollHostId(record.hostId)) {
      return { ok: false, message: 'hostId must match [A-Za-z0-9_-]{1,64}' };
    }
    hostId = record.hostId;
  }
  if (typeof record.signature !== 'string' || !SIGNATURE_RE.test(record.signature)) {
    return { ok: false, message: 'signature must be a base64url-encoded ECDSA-SHA256 signature' };
  }
  return {
    ok: true,
    fields: {
      challengeId: record.challengeId,
      nonce: record.nonce,
      devicePublicKey: record.devicePublicKey,
      hostId,
      token: record.token,
      environment: record.environment,
      bundleId: record.bundleId,
      signature: record.signature,
    },
  };
}

/**
 * 校验设备对 enroll 消息的 P-256 签名（PoP）。
 *
 * 消息字节由协议包 `pushEnrollMessage` 生成，与 App 侧完全一致（UTF-8，`\n` 连接，无末尾换行）。
 *
 * @param {{challengeId: string, nonce: string, devicePublicKey: string, hostId?: string,
 *          token: string, environment: string, bundleId: string, signature: string}} fields
 * @returns {boolean}
 */
export function verifyEnrollSignature(fields) {
  const message = pushEnrollMessage({
    challengeId: fields.challengeId,
    nonce: fields.nonce,
    devicePublicKey: fields.devicePublicKey,
    hostId: fields.hostId ?? '',
    token: fields.token,
    environment: fields.environment,
    bundleId: fields.bundleId,
  });
  return verifyGroupDeviceSignature({
    publicKey: fields.devicePublicKey,
    message,
    signature: fields.signature,
  });
}
