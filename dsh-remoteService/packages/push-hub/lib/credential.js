/**
 * R2 device credential：Ed25519 签名 key 管理 + JWT 签发/校验。
 *
 * 契约：docs/group-push-r2-contract.zh.md §4.2 / §4.5。
 *
 * - hub 用 Ed25519 私钥签 JWT（`alg: EdDSA`），App/主机只透传、hub 自己校验；
 * - 私钥是 PKCS#8 PEM，存 `HUB_SIGNING_KEY_FILE`（默认在 baseDir，容器内 `/data`），
 *   文件 0600、目录 0700；**不存在时自动生成**（首次启动），之后保持不变（kid 稳定）；
 * - claims 绑定 tokenHash + hostId + environment + bundleId + aud(publicUrl) + exp；
 * - 任何时刻都不把私钥/credential 写日志或响应（credential 只在 /v1/enroll 成功响应里返回一次）。
 */

import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  PUSH_CREDENTIAL_TYP,
  PUSH_CREDENTIAL_VERSION,
  isPushEnvironment,
  sha256Base64Url,
} from 'dsh-remote-protocol';

/** 签名 key 文件权限（只允许服务用户读写）。 */
export const HUB_SIGNING_KEY_FILE_MODE = 0o600;
/** 签名 key 目录权限。 */
export const HUB_SIGNING_KEY_DIR_MODE = 0o700;
/** credential header 的 alg（Ed25519；RFC 8037 名字）。 */
export const HUB_CREDENTIAL_ALG = 'EdDSA';
/** kid 长度（公钥 SPKI 的 sha256 base64url 前缀；够区分单一/轮换 key）。 */
const KID_LENGTH = 16;

/**
 * @param {unknown} value
 * @returns {string}
 */
function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/**
 * 由公钥推导稳定的 kid（重启后不变；轮换 key 后自动变化）。
 * @param {import('node:crypto').KeyObject} publicKey
 * @returns {string}
 */
export function signingKeyId(publicKey) {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return sha256Base64Url(der).slice(0, KID_LENGTH);
}

/**
 * 解析签名私钥（只接受 Ed25519）。错误信息不含密钥内容。
 * @param {string} pem
 * @param {string} file
 * @returns {import('node:crypto').KeyObject}
 */
function parseSigningKey(pem, file) {
  let key;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new Error(`signing key file "${file}" is not a valid PEM private key（期望 Ed25519 PKCS#8）`);
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(`signing key file "${file}" must be an Ed25519 PKCS#8 key (got ${key.asymmetricKeyType ?? 'unknown'})`);
  }
  return key;
}

/**
 * 收紧已存在签名 key 的权限（0600）；失败只告警（例如只读挂载）。
 * @param {string} file
 * @param {any} logger
 */
function tightenKeyPermissions(file, logger) {
  try {
    const mode = statSync(file).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      chmodSync(file, HUB_SIGNING_KEY_FILE_MODE);
      logger.warn(`signing key file "${file}" 权限过宽（${mode.toString(8)}），已收紧为 600`);
    }
  } catch (error) {
    logger.warn(`signing key file "${file}" 无法收紧权限：${error && error.message ? error.message : String(error)}`);
  }
}

/**
 * 加载或自动生成 Ed25519 签名 key。
 *
 * @param {string} file `HUB_SIGNING_KEY_FILE`
 * @param {{logger?: any}} [options]
 * @returns {{privateKey: import('node:crypto').KeyObject, publicKey: import('node:crypto').KeyObject, kid: string, file: string, generated: boolean}}
 */
export function loadOrCreateSigningKey(file, options = {}) {
  const logger = options.logger ?? { info() {}, warn() {}, error() {} };
  if (typeof file !== 'string' || file.trim() === '') {
    throw new Error('signingKeyFile 未配置（R2 需要 Ed25519 签名 key）');
  }
  const target = resolve(file);
  let generated = false;
  /** @type {string | undefined} */
  let pem;
  try {
    pem = readFileSync(target, 'utf8');
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      const code = error && error.code ? ` (${error.code})` : '';
      throw new Error(`cannot read signing key file "${target}"${code}：检查挂载路径与权限`);
    }
  }
  if (pem === undefined) {
    const { privateKey } = generateKeyPairSync('ed25519');
    const exported = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    mkdirSync(dirname(target), { recursive: true, mode: HUB_SIGNING_KEY_DIR_MODE });
    try {
      // wx：并发启动时只有一个进程生成，其它进程读同一个文件。
      writeFileSync(target, exported, { mode: HUB_SIGNING_KEY_FILE_MODE, flag: 'wx' });
      generated = true;
    } catch (error) {
      if (!error || error.code !== 'EEXIST') {
        const code = error && error.code ? ` (${error.code})` : '';
        throw new Error(`cannot write signing key file "${target}"${code}：检查 /data 挂载与目录权限`);
      }
    }
    pem = readFileSync(target, 'utf8');
  }
  const privateKey = parseSigningKey(pem, target);
  const publicKey = createPublicKey(privateKey);
  if (generated) {
    // writeFileSync 的 mode 已生效；这里再兜底一次（不受 umask 影响）。
    try {
      chmodSync(target, HUB_SIGNING_KEY_FILE_MODE);
    } catch {
      /* 失败不影响签名；下一次启动会再尝试收紧 */
    }
    logger.info(`credential signing key: generated "${target}" (0600)`);
  } else {
    // 已存在的 key：检查权限，过宽则收紧并告警。
    tightenKeyPermissions(target, logger);
  }
  const kid = signingKeyId(publicKey);
  return { privateKey, publicKey, kid, file: target, generated };
}

/**
 * 签发一个 EdDSA JWT。
 *
 * @param {object} options
 * @param {import('node:crypto').KeyObject} options.privateKey
 * @param {string} options.kid
 * @param {Record<string, unknown>} options.claims
 * @returns {string}
 */
export function signCredential({ privateKey, kid, claims }) {
  const header = { alg: HUB_CREDENTIAL_ALG, typ: 'JWT', kid };
  const signingInput = `${base64urlJson(header)}.${base64urlJson(claims)}`;
  const signature = sign(null, Buffer.from(signingInput, 'utf8'), privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}

/**
 * 解析 JWT（不做验签）。失败抛错，错误信息不含 credential 原文。
 * @param {string} credential
 * @returns {{header: Record<string, any>, claims: Record<string, any>, signingInput: string, signature: Buffer}}
 */
export function decodeCredential(credential) {
  if (typeof credential !== 'string') throw new Error('credential must be a string');
  const parts = credential.split('.');
  if (parts.length !== 3 || parts.some((part) => part === '')) {
    throw new Error('credential must be a three-part JWT');
  }
  let header;
  let claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new Error('credential is not valid base64url JSON');
  }
  if (header === null || typeof header !== 'object' || Array.isArray(header)) throw new Error('credential header must be a JSON object');
  if (claims === null || typeof claims !== 'object' || Array.isArray(claims)) throw new Error('credential claims must be a JSON object');
  return {
    header,
    claims,
    signingInput: `${parts[0]}.${parts[1]}`,
    signature: Buffer.from(parts[2], 'base64url'),
  };
}

/**
 * 校验 device credential（签名/类型/有效期/aud/bundleId/字段完整性）。
 *
 * 返回的 `code` 与 HUB_ERROR 字符串一致（invalid_credential / credential_expired /
 * unsupported_bundle_id），由 hub-server 映射到 HTTP 状态。
 *
 * @param {object} options
 * @param {import('node:crypto').KeyObject} options.publicKey
 * @param {string} options.credential
 * @param {string} options.audience 期望的 aud（HUB_PUBLIC_URL）
 * @param {string} [options.bundleId] 期望的 bundle id（hub 的 apns.topic）
 * @param {() => number} [options.now]
 * @returns {{ok: true, claims: Record<string, any>, header: Record<string, any>}
 *   | {ok: false, code: string, message: string}}
 */
export function verifyCredential({ publicKey, credential, audience, bundleId = '', now = Date.now }) {
  /** @param {string} code @param {string} message */
  const fail = (code, message) => ({ ok: false, code, message });
  let decoded;
  try {
    decoded = decodeCredential(credential);
  } catch {
    return fail('invalid_credential', 'credential is not a valid JWT');
  }
  const { header, claims, signingInput, signature } = decoded;
  if (header.alg !== HUB_CREDENTIAL_ALG) {
    return fail('invalid_credential', `credential alg must be ${HUB_CREDENTIAL_ALG}`);
  }
  let signatureOk = false;
  try {
    signatureOk = verify(null, Buffer.from(signingInput, 'utf8'), publicKey, signature);
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) return fail('invalid_credential', 'credential signature is invalid');
  if (claims.typ !== PUSH_CREDENTIAL_TYP || claims.v !== PUSH_CREDENTIAL_VERSION) {
    return fail('invalid_credential', 'credential is not a dsh device credential');
  }
  const exp = Number(claims.exp);
  if (!Number.isFinite(exp)) return fail('invalid_credential', 'credential exp is missing');
  if (exp * 1000 <= now()) return fail('credential_expired', 'credential has expired');
  if (typeof claims.aud !== 'string' || claims.aud === '' || claims.aud !== audience) {
    return fail('invalid_credential', 'credential audience mismatch');
  }
  if (bundleId !== '' && claims.bundleId !== bundleId) {
    return fail('unsupported_bundle_id', 'credential bundleId does not match this hub');
  }
  if (typeof claims.tokenHash !== 'string' || claims.tokenHash === '') {
    return fail('invalid_credential', 'credential tokenHash is missing');
  }
  if (!isPushEnvironment(claims.env)) {
    return fail('invalid_credential', 'credential env is invalid');
  }
  if (typeof claims.jti !== 'string' || claims.jti === '') {
    return fail('invalid_credential', 'credential jti is missing');
  }
  return { ok: true, claims, header };
}

/**
 * 签发 per-device credential（enroll 成功后调用）。
 *
 * @param {object} options
 * @param {import('node:crypto').KeyObject} options.privateKey
 * @param {string} options.kid
 * @param {string} options.audience HUB_PUBLIC_URL
 * @param {number} options.ttlDays
 * @param {string} options.tokenHash sha256Base64Url(APNs token)
 * @param {string} options.environment development|production
 * @param {string} options.bundleId
 * @param {string} [options.hostId]
 * @param {() => number} [options.now]
 * @returns {{credential: string, claims: Record<string, any>, expiresAt: number}}
 */
export function issueDeviceCredential({
  privateKey,
  kid,
  audience,
  ttlDays,
  tokenHash,
  environment,
  bundleId,
  hostId = '',
  now = Date.now,
}) {
  const iat = Math.floor(now() / 1000);
  const exp = iat + Math.round(ttlDays * 86_400);
  /** @type {Record<string, unknown>} */
  const claims = {
    v: PUSH_CREDENTIAL_VERSION,
    typ: PUSH_CREDENTIAL_TYP,
    tokenHash,
    env: environment,
    bundleId,
    ...(hostId !== '' ? { hostId } : {}),
    aud: audience,
    jti: randomUUID(),
    iat,
    exp,
  };
  return {
    credential: signCredential({ privateKey, kid, claims }),
    claims,
    expiresAt: exp * 1000,
  };
}
