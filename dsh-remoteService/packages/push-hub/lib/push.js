/**
 * /v1/push 的请求形态（0.3.0 起只保留 device credential）：
 *   `{kind, host?, token, environment?}` + `Authorization: Bearer <deviceCredential>`。
 *
 * 内容策略：只接受 kind/host/token/environment，**拒绝 title/body/sessionId 等任何会话内容
 * 字段**；文案由 hub 侧 `genericPushContent` 固定。
 */

import { genericPushContent } from 'dsh-remote-apns';
import { isPushEnvironment } from 'dsh-remote-protocol';

/** 固定的通用文案 kind（与协议 PUSH_KINDS 一致）。 */
export const HUB_PUSH_KINDS = Object.freeze(['turn-end', 'waiting-answer']);
/** APNs device token 形态（64 位小写 hex）。 */
const APNS_DEVICE_TOKEN_RE = /^[0-9a-f]{64}$/;
/** host 字段上限（<255 字符，与 apns payload 截断一致）。 */
const HOST_MAX_LENGTH = 254;

/**
 * 校验（可选的）host 字段。
 * @param {unknown} raw
 * @returns {{ok: true, host: string} | {ok: false, message: string}}
 */
function normalizeHost(raw) {
  if (raw === undefined || raw === null) return { ok: true, host: '' };
  if (typeof raw !== 'string') return { ok: false, message: 'host must be a string (<255 characters)' };
  if (raw.length > HOST_MAX_LENGTH) {
    return { ok: false, message: `host must be shorter than 255 characters (got ${raw.length})` };
  }
  if (/[\u0000-\u001f\u007f]/.test(raw)) return { ok: false, message: 'host must not contain control characters' };
  return { ok: true, host: raw.trim() };
}

/**
 * 校验 device credential 模式的推送请求体：`{kind, host?, token, environment?}`。
 * environment 可省略（以 credential 的 claims.env 为准）；提供时必须与 claims.env 一致，
 * 一致性由 hub-server 校验（这里只校验格式）。
 *
 * @param {unknown} body
 * @returns {{ok: true, kind: string, host: string, token: string, environment: string}
 *   | {ok: false, message: string}}
 */
export function validateDevicePushRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, message: 'request body must be a JSON object' };
  }
  const record = /** @type {Record<string, any>} */ (body);
  const allowedFields = ['kind', 'host', 'token', 'environment'];
  const unknownFields = Object.keys(record).filter((key) => !allowedFields.includes(key));
  if (unknownFields.length > 0) {
    return {
      ok: false,
      message: `unsupported field(s): ${unknownFields.join(', ')}；device credential push 只接受 kind/host/token/environment`
        + '（不接收 title/body/sessionId 等会话内容）',
    };
  }
  if (!HUB_PUSH_KINDS.includes(record.kind)) {
    return { ok: false, message: 'kind must be "turn-end" or "waiting-answer"' };
  }
  const hostResult = normalizeHost(record.host);
  if (!hostResult.ok) return { ok: false, message: hostResult.message };
  if (typeof record.token !== 'string' || !APNS_DEVICE_TOKEN_RE.test(record.token)) {
    return { ok: false, message: 'token must be 64 lowercase hex characters (APNs device token)' };
  }
  let environment = '';
  if (record.environment !== undefined && record.environment !== null && record.environment !== '') {
    if (!isPushEnvironment(record.environment)) {
      return { ok: false, message: 'environment must be "development" or "production"' };
    }
    environment = record.environment;
  }
  return { ok: true, kind: record.kind, host: hostResult.host, token: record.token, environment };
}

/**
 * 调 APNs 发送并归一化结果（pruned 语义与 APNs 错误分类在这里统一）。
 *
 * @param {{sendToTokens: Function}} apns
 * @param {{kind: string, host: string, entries: Array<{deviceId: string, token: string, environment: string}>}} input
 * @returns {Promise<{skipped?: string, delivered: number, failed: number, pruned: string[],
 *   configErrors: string[], errors: Array<{reason: string}>}>}
 */
export async function sendPushNotifications(apns, { kind, host, entries }) {
  const content = genericPushContent(kind);
  /** @type {Record<string, string>} */
  const message = { kind, title: content.title, body: content.body };
  if (host !== '') message.host = host;
  const result = await apns.sendToTokens(entries, message);
  /** @type {string[]} */
  const pruned = [];
  if (Array.isArray(result && result.pruned)) {
    for (const entry of result.pruned) {
      const value = typeof entry === 'string' ? entry : entry && entry.token;
      if (typeof value === 'string' && value !== '') pruned.push(value);
    }
  }
  return {
    ...(result && result.skipped ? { skipped: String(result.skipped) } : {}),
    delivered: Number.isInteger(result && result.delivered) ? result.delivered : 0,
    failed: Number.isInteger(result && result.failed) ? result.failed : 0,
    pruned,
    configErrors: Array.isArray(result && result.configErrors) ? result.configErrors : [],
    errors: Array.isArray(result && result.errors) ? result.errors : [],
  };
}
