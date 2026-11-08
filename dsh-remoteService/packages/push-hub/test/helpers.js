/**
 * push-hub 测试共用工具（不是测试文件：node --test 只收集 *.test.js）。
 *
 * 约定：全部测试用 **随机端口 + 临时目录 + 假 APNs client + 临时签名 key**，
 * 不触碰真实网络/凭据；R2 的 credential aud 用 example.com 占位符。
 */

import { generateKeyPairSync, sign as signWithKey } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pushEnrollMessage } from 'dsh-remote-protocol';
import {
  createConsoleLogger,
  createHubConfig,
  createHubServer,
} from '../index.js';

/** 测试用假 APNs 配置（不读文件：apnsClient 由测试注入）。 */
export const TEST_APNS_CONFIG = Object.freeze({
  keyFile: '/nonexistent/apns/AuthKey_TESTTEST00.p8',
  keyId: 'ABC123DEF4',
  teamId: 'TEAM123456',
  topic: 'com.example.dshremote.test',
});

/** 测试用 hub 公开地址（credential 的 aud；只用 example.com 占位符）。 */
export const TEST_PUBLIC_URL = 'https://push.example.com';

/**
 * @param {string} [prefix]
 * @returns {string} 临时目录
 */
export function makeTempDir(prefix = 'dsh-push-hub-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * @param {string} dir
 */
export function cleanupDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/** 静默 logger（测试默认）。 */
export function silentLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

/** 记录日志的 logger（用于断言「日志不泄漏 token/credential」）。 */
export function recordingLogger() {
  /** @type {string[]} */
  const lines = [];
  /** @param {string} kind */
  const push = (kind) => (/** @type {string} */ message) => { lines.push(`${kind}: ${message}`); };
  return {
    lines,
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
  };
}

/**
 * 假 APNs client：记录调用，返回预设结果（或由函数按调用生成）。
 *
 * @param {object | ((entries: any[], message: any) => object)} [result]
 * @returns {{calls: Array<{entries: any[], message: any}>, isConfigured: () => boolean, sendToTokens: Function}}
 */
export function makeApnsClient(result) {
  /** @type {Array<{entries: any[], message: any}>} */
  const calls = [];
  return {
    calls,
    isConfigured: () => true,
    async sendToTokens(entries, message) {
      calls.push({ entries, message });
      if (typeof result === 'function') return result(entries, message);
      return result ?? { delivered: entries.length, failed: 0, pruned: [], configErrors: [], errors: [] };
    },
  };
}

/**
 * 起一台测试 hub：临时签名 key + 随机端口 + 注入的假 APNs。
 *
 * @param {object} [options]
 * @param {object | null} [options.apns] config.apns（默认 TEST_APNS_CONFIG；传 null 表示未配置）
 * @param {object | null} [options.apnsClient] 假 APNs client（显式 null = 模拟 APNs 未配置）
 * @param {string | null} [options.publicUrl] R2 的 aud（默认 TEST_PUBLIC_URL；传 null/'' 关闭 R2）
 * @param {string} [options.signingKeyFile] 签名 key 路径（默认临时目录内）
 * @param {object} [options.credential] config.credential（如 {ttlDays: 1}）
 * @param {object} [options.enroll] config.enroll（如 {enabled:false} / {challengeTtlSeconds:10}）
 * @param {object} [options.limits] config.limits（部分字段即可）
 * @param {object} [options.configOverrides] 额外的原始配置字段
 * @param {object} [options.env] 传给 createHubConfig 的环境变量（默认 {}，隔离宿主机 HUB_*）
 * @param {object} [options.logger]
 * @param {() => number} [options.now] 测试时钟（challenge TTL / 限流窗口 / credential exp）
 * @returns {Promise<object>}
 */
export async function startTestHub(options = {}) {
  const dir = makeTempDir();
  const apnsConfig = options.apns === undefined ? TEST_APNS_CONFIG : options.apns;
  const signingKeyFile = options.signingKeyFile ?? join(dir, 'push-hub-signing-key.pem');
  /** @type {Record<string, any>} */
  const rawConfig = {
    ...(options.configOverrides ?? {}),
    listenHost: '127.0.0.1',
    port: 0,
  };
  if (apnsConfig !== null) rawConfig.apns = apnsConfig;
  const publicUrl = options.publicUrl === undefined ? TEST_PUBLIC_URL : options.publicUrl;
  if (publicUrl !== null && publicUrl !== '') rawConfig.publicUrl = publicUrl;
  rawConfig.signingKeyFile = signingKeyFile;
  if (options.credential) rawConfig.credential = options.credential;
  if (options.enroll) rawConfig.enroll = options.enroll;
  if (options.limits) rawConfig.limits = options.limits;
  const config = createHubConfig(rawConfig, { env: options.env ?? {} });
  const apns = Object.hasOwn(options, 'apnsClient') ? options.apnsClient : makeApnsClient();
  const hub = createHubServer({
    config,
    apnsClient: apns,
    logger: options.logger ?? silentLogger(),
    ...(typeof options.now === 'function' ? { now: options.now } : {}),
  });
  const info = await hub.listen();
  return {
    dir,
    signingKeyFile,
    config,
    apns,
    hub,
    info,
    baseUrl: `http://127.0.0.1:${info.port}`,
    /** 关服务 + 清临时目录。 */
    async stop() {
      await hub.close();
      cleanupDir(dir);
    },
  };
}

/**
 * 发 HTTP 请求并解析 JSON（无第三方依赖，Node 22+ 自带 fetch）。
 *
 * @param {string} baseUrl
 * @param {string} path
 * @param {object} [options]
 * @param {'GET'|'POST'|'PUT'|'DELETE'} [options.method]
 * @param {string} [options.token] Bearer token
 * @param {unknown} [options.body] 对象会 JSON 序列化；字符串原样发送
 * @param {Record<string, string>} [options.headers]
 * @returns {Promise<{status: number, headers: Headers, json: any, text: string}>}
 */
export async function requestJson(baseUrl, path, options = {}) {
  /** @type {Record<string, string>} */
  const headers = { ...(options.headers ?? {}) };
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  const hasBody = options.body !== undefined;
  if (hasBody && headers['content-type'] === undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? (hasBody ? 'POST' : 'GET'),
    headers,
    body: hasBody ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : undefined,
  });
  const text = await response.text();
  let json = null;
  try {
    json = text === '' ? null : JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, json, text };
}

// ── R2 设备登记/凭证测试工具 ────────────────────────────────────────────────

/**
 * 生成群体版设备 P-256 密钥对（公钥为 base64url 未压缩点，65B，与 App 一致）。
 * @returns {{privateKey: import('node:crypto').KeyObject, publicKey: import('node:crypto').KeyObject, publicKeyB64Url: string}}
 */
export function createDeviceKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]);
  return { privateKey, publicKey, publicKeyB64Url: raw.toString('base64url') };
}

/**
 * 对契约 §3 的 enroll 消息签名（ECDSA-SHA256，DER，base64url）。
 * @param {{privateKey: import('node:crypto').KeyObject}} deviceKey
 * @param {{challengeId: string, nonce: string, devicePublicKey: string, hostId?: string, token: string, environment: string, bundleId: string}} fields
 * @returns {string}
 */
export function signEnrollMessage(deviceKey, fields) {
  const message = pushEnrollMessage(fields);
  return signWithKey('sha256', message, deviceKey.privateKey).toString('base64url');
}

/**
 * 走完 R2 登记流程：challenge → 用设备私钥签名 → enroll，返回 credential。
 *
 * @param {string} baseUrl
 * @param {object} [options]
 * @param {ReturnType<typeof createDeviceKey>} [options.deviceKey]
 * @param {string} [options.token] APNs device token（64 hex）
 * @param {'development'|'production'} [options.environment]
 * @param {string} [options.bundleId]
 * @param {string} [options.hostId]
 * @returns {Promise<{challenge: any, enrolled: any, deviceKey: any, fields: any, signature: string}>}
 */
export async function enrollTestDevice(baseUrl, options = {}) {
  const deviceKey = options.deviceKey ?? createDeviceKey();
  const token = options.token ?? 'a'.repeat(64);
  const environment = options.environment ?? 'production';
  const bundleId = options.bundleId ?? TEST_APNS_CONFIG.topic;
  const hostId = options.hostId ?? 'h_ab12cd34';
  const challenge = await requestJson(baseUrl, '/v1/enroll/challenge', {
    body: { devicePublicKey: deviceKey.publicKeyB64Url },
  });
  if (challenge.status !== 200) return { challenge, enrolled: null, deviceKey, fields: null, signature: '' };
  const fields = {
    challengeId: challenge.json.challengeId,
    nonce: challenge.json.nonce,
    devicePublicKey: deviceKey.publicKeyB64Url,
    hostId,
    token,
    environment,
    bundleId,
  };
  const signature = signEnrollMessage(deviceKey, fields);
  const enrolled = await requestJson(baseUrl, '/v1/enroll', { body: { ...fields, signature } });
  return { challenge, enrolled, deviceKey, fields, signature };
}

/**
 * 构造一个合法 R2 device credential 推送请求体。
 * @param {string} token
 * @param {object} [overrides]
 */
export function devicePushBody(token, overrides = {}) {
  return { kind: 'turn-end', host: 'h_ab12cd34.relay.example.com', token, ...overrides };
}

export { createConsoleLogger };
