/**
 * hub 稳定的 API 错误码与 HTTP 状态映射。
 *
 * - 错误码是**对外契约**（App / 主机依赖它做分支），不要随意改字符串；
 * - 响应体统一 `{ ok:false, error:{ code, message } }`；
 * - message 只描述格式/原因，**绝不**包含 token / credential / 密钥。
 *
 * 契约：docs/group-push-r2-contract.zh.md §4。
 */

/** 稳定的 API 错误码（响应 JSON 的 error.code）。 */
export const HUB_ERROR = Object.freeze({
  // ── 通用 ──
  INVALID_REQUEST: 'invalid_request',
  RATE_LIMITED: 'rate_limited',
  PUSH_UNAVAILABLE: 'push_unavailable',
  INTERNAL: 'internal',
  NOT_FOUND: 'not_found',
  METHOD_NOT_ALLOWED: 'method_not_allowed',
  // ── device credential 推送 ──
  INVALID_CREDENTIAL: 'invalid_credential',
  CREDENTIAL_EXPIRED: 'credential_expired',
  TOKEN_MISMATCH: 'token_mismatch',
  UNSUPPORTED_BUNDLE_ID: 'unsupported_bundle_id',
  // ── 设备登记（/v1/enroll*）──
  CHALLENGE_EXPIRED: 'challenge_expired',
  CHALLENGE_USED: 'challenge_used',
  INVALID_SIGNATURE: 'invalid_signature',
  ENROLL_DISABLED: 'enroll_disabled',
});

/**
 * 错误码 → HTTP 状态码。
 * - 401：凭据类失败（App 应重新登记/换 credential）；
 * - 400：请求字段/签名/挑战类失败（App 应修正请求或换 challenge）；
 * - 429：限流（带 Retry-After）；503：能力未启用/不可用。
 */
export const HUB_ERROR_STATUS = Object.freeze({
  [HUB_ERROR.INVALID_REQUEST]: 400,
  [HUB_ERROR.RATE_LIMITED]: 429,
  [HUB_ERROR.PUSH_UNAVAILABLE]: 503,
  [HUB_ERROR.INTERNAL]: 500,
  [HUB_ERROR.NOT_FOUND]: 404,
  [HUB_ERROR.METHOD_NOT_ALLOWED]: 405,
  [HUB_ERROR.INVALID_CREDENTIAL]: 401,
  [HUB_ERROR.CREDENTIAL_EXPIRED]: 401,
  [HUB_ERROR.TOKEN_MISMATCH]: 401,
  [HUB_ERROR.UNSUPPORTED_BUNDLE_ID]: 400,
  [HUB_ERROR.CHALLENGE_EXPIRED]: 400,
  [HUB_ERROR.CHALLENGE_USED]: 400,
  [HUB_ERROR.INVALID_SIGNATURE]: 400,
  [HUB_ERROR.ENROLL_DISABLED]: 503,
});

/**
 * 取错误码对应的 HTTP 状态（未知码按 500）。
 * @param {string} code
 * @returns {number}
 */
export function statusForError(code) {
  return HUB_ERROR_STATUS[code] ?? 500;
}

/**
 * 统一错误响应体。
 * @param {string} code
 * @param {string} message
 * @returns {{ok: false, error: {code: string, message: string}}}
 */
export function errorPayload(code, message) {
  return { ok: false, error: { code, message } };
}
