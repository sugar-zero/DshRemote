/**
 * 自托管 APNs 推送（方案 A）：主机插件直接用 Apple Push Notification service
 * 发送提醒（标题/正文由会话摘要生成并截断），**不经过 relay，也不依赖 Expo 云**。
 *
 * 安全边界：
 * - payload 字段固定为 `aps.alert.{title,body}` + 顶层 `body: {kind, sessionId, host}`：
 *   标题/正文由会话摘要生成并截断；`sessionId`/`host` 仅用于 App 点通知跳转（不含 token/路径/证书）；
 * - `.p8` 私钥只从本地文件读取，JWT 只缓存在内存，不落盘、不写日志；
 * - 设备 token 存 hosts 自己的 push-tokens.json（0600），relay 完全看不到。
 *
 * 协议要点（Apple）：
 * - provider token：ES256 JWT，header `{ alg:'ES256', kid:<KeyID> }`、
 *   claims `{ iss:<TeamID>, iat:<秒> }`；有效期 1 小时，20 分钟内不重复签发 → 这里缓存 50 分钟。
 * - HTTP/2 POST `https://api.sandbox.push.apple.com/3/device/<token>`（开发签名包）
 *   或 `https://api.push.apple.com/3/device/<token>`（发布签名包）。
 * - headers：`authorization: bearer <JWT>`、`apns-topic: <bundleId>`、
 *   `apns-push-type: alert`、`apns-priority: 10`。
 * - 200 = APNs 已接收；**只有 410 / `Unregistered` 才代表设备 token 永久失效**（交给上层清理）。
 *   `BadDeviceToken` / `DeviceTokenNotForTopic` / `InvalidProviderToken` 是配置错误
 *   （apnsTopic/apnsEnvironment/Key ID/Team ID 不匹配），不能当死 token 清理。
 *
 * 零第三方依赖：只使用 node:http2 + node:crypto。
 */

import { readFileSync } from 'node:fs';
import { createPrivateKey, sign as signWithKey } from 'node:crypto';
import { connect } from 'node:http2';

/** APNs 两个环境：开发签名包只能发 sandbox，发布签名包只能发 production。 */
export const APNS_HOSTS = Object.freeze({
  development: 'https://api.sandbox.push.apple.com',
  production: 'https://api.push.apple.com',
});

export const DEFAULT_PUSH_TITLE = 'DSH';
export const DEFAULT_PUSH_BODY = '有任务需要你';
/** 提醒类消息保留 1 小时；设备长时间离线后不再补一条过期提醒。 */
export const DEFAULT_PUSH_TTL_SECONDS = 3600;
/** provider token 缓存 50 分钟（Apple 有效期 1 小时，20 分钟内不要求重签）。 */
export const PROVIDER_TOKEN_TTL_MS = 50 * 60 * 1000;
export const APNS_REQUEST_TIMEOUT_MS = 15_000;

/**
 * APNs 判定为「该设备 token 已永久失效」的返回：只有 410 / `Unregistered`。
 * 其它（BadDeviceToken / DeviceTokenNotForTopic / InvalidProviderToken）说明
 * topic/环境/签名与 App 不匹配，是配置问题，**不能**删设备 token。
 */
const INVALID_TOKEN_REASONS = new Set(['Unregistered']);

/** APNs 判定为「主机侧配置错误」的返回（记录/提示，不清理 token）。 */
const CONFIG_ERROR_REASONS = new Set(['BadDeviceToken', 'DeviceTokenNotForTopic', 'InvalidProviderToken']);

/**
 * @param {string | Buffer} value
 * @returns {string}
 */
function base64url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * 读取并校验 APNs Auth Key（.p8，PKCS#8 EC P-256）。
 * @param {string} keyFile
 */
export function loadPrivateKeyFile(keyFile) {
  const pem = readFileSync(keyFile, 'utf8');
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'ec') {
    throw new Error('APNs 私钥必须是 EC (P-256) 的 .p8 文件（AuthKey_<KEY_ID>.p8）');
  }
  const curve = key.asymmetricKeyDetails?.namedCurve;
  if (curve && curve !== 'prime256v1') {
    throw new Error(`APNs 私钥曲线必须是 P-256（当前 ${curve}）`);
  }
  return key;
}

/**
 * 生成 APNs provider token（ES256 JWT）。
 * 注意：JWS 的 ES256 签名必须是 raw `r||s`，所以 Node 侧要 `dsaEncoding: 'ieee-p1363'`
 * （默认的 DER 编码会被 APNs 拒绝为 InvalidProviderToken）。
 *
 * @param {object} options
 * @param {string} options.keyId APNs Key ID（AuthKey_<KEY_ID>.p8 里的 KEY_ID）
 * @param {string} options.teamId Apple Developer Team ID
 * @param {import('node:crypto').KeyObject} options.privateKey
 * @param {number} [options.now]
 * @returns {string}
 */
export function createProviderToken({ keyId, teamId, privateKey, now = Date.now() }) {
  if (typeof keyId !== 'string' || keyId === '') throw new Error('APNs Key ID 未配置');
  if (typeof teamId !== 'string' || teamId === '') throw new Error('Apple Team ID 未配置');
  if (!privateKey || privateKey.asymmetricKeyType !== 'ec') throw new Error('APNs 私钥无效');
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const claims = base64url(JSON.stringify({ iss: teamId, iat: Math.floor(now / 1000) }));
  const signingInput = `${header}.${claims}`;
  const signature = signWithKey('sha256', Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${base64url(signature)}`;
}

/**
 * 构造 APNs payload：`aps.alert` 放标题/正文，顶层 `body` 放自定义字段。
 * 自定义字段放在 aps 外层，和 Expo 的 `data:{kind}` 语义一致。
 *
 * 自定义数据放在顶层 `body` 字典：expo-notifications 的 iOS 实现只把 APNs
 * `userInfo["body"]` 映射到 JS 的 `notification.request.content.data`（根字段拿不到），
 * App 依赖 `{kind, sessionId, host}` 做「当前会话抑制」与「点通知跳转会话」。
 * 除标题/正文与这三个跳转字段外不附加 token/路径/证书等字段。
 *
 * @param {object} [options]
 * @param {string} [options.title]
 * @param {string} [options.body]
 * @param {string} [options.kind]
 * @param {string} [options.sessionId] 会话 id（点通知跳转用）
 * @param {string} [options.host] 主机访问地址（<hostId>.<relayDomain>[:port]，与 App 的连接记录一致）
 */
export function buildPushMessage({
  title = DEFAULT_PUSH_TITLE,
  body = DEFAULT_PUSH_BODY,
  kind = 'attention',
  sessionId = '',
  host = '',
} = {}) {
  const data = { kind: String(kind ?? 'attention').slice(0, 32) };
  if (typeof sessionId === 'string' && sessionId !== '') data.sessionId = sessionId.slice(0, 128);
  if (typeof host === 'string' && host !== '') data.host = host.slice(0, 255);
  return {
    aps: { alert: { title: String(title).slice(0, 80), body: String(body).slice(0, 200) }, sound: 'default' },
    body: data,
  };
}

/** 解析 APNs 错误响应体里的 reason（例如 BadDeviceToken / InvalidProviderToken）。 */
function parseReason(body) {
  try {
    const parsed = JSON.parse(String(body ?? ''));
    return parsed && typeof parsed === 'object' ? String(parsed.reason ?? '').slice(0, 64) : '';
  } catch {
    return '';
  }
}

/**
 * 单条 APNs 请求（HTTP/2）。抽出为独立函数，便于测试注入。
 *
 * @param {object} options
 * @param {string} options.origin 例如 https://api.sandbox.push.apple.com
 * @param {string} options.path /3/device/<token>
 * @param {Record<string, string>} options.headers
 * @param {string} options.body
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{status: number, body: string}>}
 */
export function http2Request({ origin, path, headers, body, timeoutMs = APNS_REQUEST_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const session = connect(origin);
    let settled = false;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      try { session.close(); } catch { /* ignore */ }
      settle(value);
    };
    session.setTimeout(timeoutMs, () => session.destroy(new Error('APNs 请求超时')));
    session.on('error', (error) => finish(reject, error));
    const request = session.request({ ':method': 'POST', ':path': path, ...headers });
    let status = 0;
    const chunks = [];
    request.setEncoding('utf8');
    request.on('response', (responseHeaders) => {
      status = Number(responseHeaders[':status'] ?? 0);
    });
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => finish(resolve, { status, body: chunks.join('') }));
    request.on('error', (error) => finish(reject, error));
    request.end(body);
  });
}

/**
 * 创建 APNs 发送器。配置变化时由 RemoteService 重建（私钥只读一次）。
 *
 * @param {object} [options]
 * @param {string} [options.keyFile] .p8 路径（必须是仓库外的本地文件，0600）
 * @param {import('node:crypto').KeyObject} [options.privateKey] 测试注入：直接给已读取的私钥
 * @param {string} [options.keyId]
 * @param {string} [options.teamId]
 * @param {string} [options.topic] App bundle ID（例如 com.example.app）
 * @param {'auto'|'development'|'production'} [options.environment] auto = 按设备注册时上报的环境
 * @param {() => number} [options.now] 测试注入
 * @param {typeof http2Request} [options.sendRequest] 测试注入
 * @param {typeof createProviderToken} [options.createToken] 测试注入
 */
export function createApnsClient(options = {}) {
  const keyFile = String(options.keyFile ?? '').trim();
  const keyId = String(options.keyId ?? '').trim();
  const teamId = String(options.teamId ?? '').trim();
  const topic = String(options.topic ?? '').trim();
  const environment = options.environment === 'development' || options.environment === 'production'
    ? options.environment
    : 'auto';
  const now = options.now ?? Date.now;
  const sendRequest = options.sendRequest ?? http2Request;
  const createToken = options.createToken ?? createProviderToken;

  let privateKey;
  let keyError = '';
  if (options.privateKey) {
    privateKey = options.privateKey;
  } else if (keyFile !== '') {
    try {
      privateKey = loadPrivateKeyFile(keyFile);
    } catch (error) {
      keyError = error?.message ?? String(error);
    }
  } else {
    keyError = 'APNs 私钥路径未配置';
  }

  /** @type {{token: string, expiresAt: number}} */
  let providerTokenCache = { token: '', expiresAt: 0 };

  function isConfigured() {
    return Boolean(privateKey && keyId !== '' && teamId !== '' && topic !== '');
  }

  function providerToken() {
    if (!isConfigured()) throw new Error(keyError || 'APNs 配置不完整');
    const timestamp = now();
    if (providerTokenCache.token !== '' && timestamp < providerTokenCache.expiresAt) return providerTokenCache.token;
    const token = createToken({ keyId, teamId, privateKey, now: timestamp });
    providerTokenCache = { token, expiresAt: timestamp + PROVIDER_TOKEN_TTL_MS };
    return token;
  }

  /**
   * 给一批设备 token 发送一条提醒。
   *
   * 返回里：
   * - `pruned`：只有 410 / `Unregistered` 的设备才会出现，条目是**实际失败的那个 token**
   *   `{deviceId, token}`，供上层做「token 未轮换才删除」的安全清理；
   * - `configErrors`：APNs 判为配置问题的原因（BadDeviceToken / DeviceTokenNotForTopic /
   *   InvalidProviderToken，去重）。这些**不能**清理设备 token，只需提示检查 apnsTopic /
   *   apnsEnvironment / Key ID / Team ID。
   *
   * @param {Array<{deviceId?: string, token: string, environment?: string}>} entries
   * @param {{kind?: string, title?: string, body?: string, sessionId?: string, host?: string}} [message]
   *   标题/正文由会话摘要生成；sessionId/host 供 App 做通知跳转。
   * @returns {Promise<{
   *   delivered: number,
   *   failed: number,
   *   pruned: Array<{deviceId: string, token: string}>,
   *   configErrors: string[],
   *   errors: Array<{status?: number, reason: string}>,
   *   skipped?: string,
   * }>}
   */
  async function sendToTokens(entries, {
    kind = 'attention',
    title = DEFAULT_PUSH_TITLE,
    body = DEFAULT_PUSH_BODY,
    sessionId = '',
    host = '',
  } = {}) {
    const tokens = (Array.isArray(entries) ? entries : []).filter((entry) => entry && typeof entry.token === 'string' && entry.token !== '');
    if (tokens.length === 0) return { delivered: 0, failed: 0, pruned: [], configErrors: [], errors: [], skipped: 'no-tokens' };
    if (!isConfigured()) {
      return { delivered: 0, failed: 0, pruned: [], configErrors: [], errors: [{ reason: keyError || '未配置 APNs' }], skipped: 'not-configured' };
    }
    const payload = JSON.stringify(buildPushMessage({ title, body, kind, sessionId, host }));
    let token;
    try {
      token = providerToken();
    } catch (error) {
      return {
        delivered: 0,
        failed: tokens.length,
        pruned: [],
        configErrors: [],
        errors: [{ reason: error?.message ?? String(error) }],
      };
    }
    const issuedAt = Math.floor(now() / 1000);
    /** 同一会话的多条提醒在通知中心折叠（APNs 限制 64 字节，sessionId 超长时省略）。 */
    const collapseId = typeof sessionId === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(sessionId) ? sessionId : '';
    const results = await Promise.all(tokens.map(async (entry) => {
      const target = environment === 'auto'
        ? (entry.environment === 'development' ? 'development' : 'production')
        : environment;
      const path = `/3/device/${entry.token}`;
      const headers = {
        authorization: `bearer ${token}`,
        'apns-topic': topic,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-expiration': String(issuedAt + DEFAULT_PUSH_TTL_SECONDS),
        'content-type': 'application/json',
      };
      if (collapseId !== '') headers['apns-collapse-id'] = collapseId;
      try {
        const response = await sendRequest({
          origin: APNS_HOSTS[target],
          path,
          headers,
          body: payload,
          timeoutMs: APNS_REQUEST_TIMEOUT_MS,
        });
        const status = Number(response?.status ?? 0);
        if (status === 200) return { ok: true };
        const reason = parseReason(response?.body);
        const invalid = status === 410 || INVALID_TOKEN_REASONS.has(reason);
        const configError = CONFIG_ERROR_REASONS.has(reason);
        return { ok: false, status, reason, invalid, configError, deviceId: entry.deviceId, token: entry.token };
      } catch (error) {
        return {
          ok: false,
          status: 0,
          reason: error?.message ?? 'transport-error',
          invalid: false,
          configError: false,
          deviceId: entry.deviceId,
          token: entry.token,
        };
      }
    }));

    let delivered = 0;
    let failed = 0;
    const pruned = [];
    const configErrors = [];
    const errors = [];
    for (const result of results) {
      if (result.ok) {
        delivered += 1;
        continue;
      }
      failed += 1;
      if (result.invalid && result.deviceId) pruned.push({ deviceId: String(result.deviceId), token: String(result.token) });
      if (result.configError && result.reason && !configErrors.includes(result.reason)) configErrors.push(result.reason);
      const reason = `${result.status ? `${result.status} ` : ''}${result.reason || 'unknown'}`.trim();
      if (!errors.some((entry) => entry.reason === reason)) errors.push({ status: result.status, reason });
    }
    return { delivered, failed, pruned, configErrors, errors };
  }

  return {
    isConfigured,
    sendToTokens,
    /** 最近一次私钥/配置错误（不含密钥内容）。 */
    get error() { return keyError; },
    /** 供诊断页/测试查看当前生效的 provider 环境。 */
    environment,
  };
}
