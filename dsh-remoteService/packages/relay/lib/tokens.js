/**
 * hostId / host token 辅助（群体服务版）。
 *
 * 0.3.0 起 relay 只服务群体版：主机由邀请码自助注册，host token 只以 SHA-256 存在
 * group.json 里（见 lib/group.js）。classic 时代的 tokens.json 存储/CLI（create/list/
 * revoke、tokensFile、hostTokens 配置）已全部删除，本文件只保留群体版仍需要的两个能力：
 *
 *   - hostId 规范化/校验（hostId 会成为 DNS 首标签 <hostId>.<relayDomain>）；
 *   - host token 随机生成（32 字节 CSPRNG → base64url，注册时签发一次）。
 */

import { randomBytes } from 'node:crypto';

/** 随机 host token 字节数（base64url 后 43 字符）。 */
export const HOST_TOKEN_BYTES = 32;

// hostId 会成为 DNS 首标签（<hostId>.<relayDomain>），因此限制为 DNS label 字符集；
// 历史文档中的示例（h_ab12cd34）含下划线，这里保留兼容。
const HOST_ID_RE = /^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$/;

/**
 * 规范化 hostId：小写、去首尾空白、校验字符集。
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeHostId(raw) {
  const id = String(raw ?? '').trim().toLowerCase();
  if (!HOST_ID_RE.test(id)) {
    throw new Error(
      `invalid hostId ${JSON.stringify(String(raw ?? ''))}: must be 1-63 chars of [a-z0-9_-], start/end alphanumeric`,
    );
  }
  return id;
}

/**
 * @param {unknown} raw
 * @returns {boolean}
 */
export function isValidHostId(raw) {
  try {
    normalizeHostId(raw);
    return true;
  } catch {
    return false;
  }
}

/** 生成新的 host token（32 字节 CSPRNG → base64url；只在注册响应里出现一次）。 */
export function generateHostToken() {
  return randomBytes(HOST_TOKEN_BYTES).toString('base64url');
}
