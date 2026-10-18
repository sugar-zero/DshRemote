/**
 * host token 存储（POC：纯 JSON 文件，0600）。
 *
 * 目标：不引入数据库依赖，但保证：
 *   - token 用 CSPRNG 生成，只在 `token create` 时向 stdout 打印一次；
 *   - 落盘权限 0600（目录 0700），原子写入（tmp + rename）；
 *   - relay 进程每次握手时按需重读文件，因此 CLI 签发/吊销无需重启 relay
 *     （已建立的控制连接不受影响，需主机重连后生效）。
 */

import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  openSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

/** tokens 文件默认权限。 */
export const TOKENS_FILE_MODE = 0o600;
/** tokens 目录权限。 */
export const TOKENS_DIR_MODE = 0o700;
/** 随机 host token 字节数（base64url 后 43 字符）。 */
export const HOST_TOKEN_BYTES = 32;

// hostId 会成为 DNS 首标签（<hostId>.<relayDomain>），因此限制为 DNS label 字符集；
// 历史文档中的示例（h_ab12cd34）含下划线，这里保留兼容。
const HOST_ID_RE = /^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$/;
const TOKENS_FILE_NAME = 'tokens.json';

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

/** 生成新的 host token（32 字节 CSPRNG → base64url）。 */
export function generateHostToken() {
  return randomBytes(HOST_TOKEN_BYTES).toString('base64url');
}

/**
 * 默认 tokens 文件位置：有 --config 时用 config 所在目录，否则用 cwd。
 * @param {string | undefined} configPath
 * @returns {string}
 */
export function defaultTokensFile(configPath) {
  return configPath
    ? join(dirname(resolve(configPath)), TOKENS_FILE_NAME)
    : resolve(process.cwd(), TOKENS_FILE_NAME);
}

/**
 * 解析 tokens 文件路径（绝对化）。
 * @param {string} file
 * @param {string} [baseDir]
 * @returns {string}
 */
export function resolveTokensFile(file, baseDir = process.cwd()) {
  return isAbsolute(file) ? file : resolve(baseDir, file);
}

/**
 * 读取 store；文件不存在返回空 store；损坏抛错（避免静默丢 token）。
 * store 形态：{ version: 1, tokens: { [hostId]: { token, createdAt, updatedAt? } } }
 * @param {string} file
 * @returns {{version: number, tokens: Record<string, {token: string, createdAt: number, updatedAt?: number}>}}
 */
export function readTokenStore(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { version: 1, tokens: {} };
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`tokens file is not valid JSON: ${file}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`tokens file malformed (expected object): ${file}`);
  }

  const rawTokens = parsed.tokens && typeof parsed.tokens === 'object' && !Array.isArray(parsed.tokens)
    ? parsed.tokens
    : parsed; // 兼容 { "<hostId>": "token" } 这种最简形态

  /** @type {Record<string, {token: string, createdAt: number, updatedAt?: number}>} */
  const tokens = {};
  for (const [key, value] of Object.entries(rawTokens)) {
    if (key === 'version') continue;
    let hostId;
    try {
      hostId = normalizeHostId(key);
    } catch {
      continue; // 忽略历史脏数据
    }
    if (typeof value === 'string') {
      tokens[hostId] = { token: value, createdAt: 0 };
    } else if (value && typeof value === 'object' && typeof value.token === 'string') {
      tokens[hostId] = {
        token: value.token,
        createdAt: Number(value.createdAt) || 0,
        updatedAt: Number(value.updatedAt) || undefined,
      };
    }
  }
  return { version: 1, tokens };
}

/**
 * 原子写入 store（同目录 tmp → rename），并强制 0600。
 * @param {string} file
 * @param {{version?: number, tokens: Record<string, {token: string, createdAt: number, updatedAt?: number}>}} store
 * @returns {string} file
 */
export function writeTokenStore(file, store) {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: TOKENS_DIR_MODE });

  const tmp = join(dir, `.${basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const data = `${JSON.stringify({ version: 1, tokens: store.tokens ?? {} }, null, 2)}\n`;
  const fd = openSync(tmp, 'w', TOKENS_FILE_MODE);
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, TOKENS_FILE_MODE);
  try {
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  chmodSync(file, TOKENS_FILE_MODE);
  return file;
}

/**
 * 读取 hostId → token 映射（relay 握手校验用）。
 * @param {string} file
 * @returns {Record<string, string>}
 */
export function loadHostTokens(file) {
  if (!file) return {};
  const store = readTokenStore(file);
  /** @type {Record<string, string>} */
  const map = {};
  for (const [hostId, entry] of Object.entries(store.tokens)) map[hostId] = entry.token;
  return map;
}

/**
 * 创建或轮换 host token；返回明文 token（只在此刻可见）。
 * @param {string} file
 * @param {string} rawHostId
 * @returns {{hostId: string, token: string, rotated: boolean}}
 */
export function createHostToken(file, rawHostId) {
  const hostId = normalizeHostId(rawHostId);
  const store = readTokenStore(file);
  const existing = store.tokens[hostId];
  const token = generateHostToken();
  store.tokens[hostId] = {
    token,
    createdAt: existing?.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
  writeTokenStore(file, store);
  return { hostId, token, rotated: Boolean(existing) };
}

/** 掩码显示 token（list 用，绝不打印完整 token）。 */
export function maskToken(token) {
  const value = String(token ?? '');
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/**
 * 列出已签发的 host（token 掩码）。
 * @param {string} file
 * @returns {Array<{hostId: string, maskedToken: string, createdAt: number, updatedAt?: number}>}
 */
export function listHostTokens(file) {
  const store = readTokenStore(file);
  return Object.entries(store.tokens)
    .map(([hostId, entry]) => ({
      hostId,
      maskedToken: maskToken(entry.token),
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    }))
    .sort((a, b) => a.hostId.localeCompare(b.hostId));
}

/**
 * 吊销 host token；不存在返回 false（CLI 据此给非零退出码）。
 * @param {string} file
 * @param {string} rawHostId
 * @returns {boolean}
 */
export function revokeHostToken(file, rawHostId) {
  const hostId = normalizeHostId(rawHostId);
  const store = readTokenStore(file);
  if (!Object.hasOwn(store.tokens, hostId)) return false;
  delete store.tokens[hostId];
  writeTokenStore(file, store);
  return true;
}
