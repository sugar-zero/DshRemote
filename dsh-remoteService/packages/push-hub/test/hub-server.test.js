import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  HUB_HEALTH_PATH,
  HUB_PUSH_PATH,
  SlidingWindowLimiter,
  createHubConfig,
  createHubServer,
} from '../index.js';
import {
  TEST_APNS_CONFIG,
  cleanupDir,
  devicePushBody,
  enrollTestDevice,
  makeApnsClient,
  makeTempDir,
  recordingLogger,
  requestJson,
  silentLogger,
  startTestHub,
} from './helpers.js';

/** 一个合法 APNs device token（64 位小写 hex）。 */
const DEVICE_TOKEN = 'a'.repeat(64);

/**
 * 登记一台测试设备并返回 credential。
 * @param {any} t startTestHub 返回值
 */
async function getCredential(t) {
  const { enrolled } = await enrollTestDevice(t.baseUrl, { token: DEVICE_TOKEN });
  assert.equal(enrolled.status, 200, `enroll failed: ${JSON.stringify(enrolled.json)}`);
  return enrolled.json.credential;
}

test('hub: GET /healthz 报告能力/配额摘要，且不含任何 token/密钥', async () => {
  const t = await startTestHub();
  try {
    const response = await requestJson(t.baseUrl, HUB_HEALTH_PATH);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.json.ok, true);
    assert.deepEqual(response.json.apns, { configured: true, topic: TEST_APNS_CONFIG.topic });
    assert.deepEqual(response.json.credential, { enabled: true, ttlDays: 30 });
    assert.deepEqual(response.json.enroll, { enabled: true });
    // 0.3.0：hub 不识别 relay，healthz 不再有 legacy / relays 字段。
    assert.equal(Object.hasOwn(response.json, 'legacy'), false);
    assert.equal(Object.hasOwn(response.json, 'relays'), false);
    // R2 配额默认值（契约 §4.5 / load-evaluation §4）——不含任何 per-relay 配额。
    assert.equal(response.json.limits.maxTokensPerRequest, 20);
    assert.equal(response.json.limits.pushPerMinutePerToken, 6);
    assert.equal(response.json.limits.pushPerDayPerToken, 120);
    assert.equal(response.json.limits.pushPerMinutePerCredential, 6);
    assert.equal(response.json.limits.pushPerMinutePerHost, 30);
    assert.equal(response.json.limits.pushPerMinutePerIp, 60);
    assert.equal(response.json.limits.pushPerMinuteGlobal, 120);
    assert.equal(response.json.limits.enrollPerHourPerIp, 20);
    assert.equal(response.json.limits.enrollPerHourPerDevice, 5);
    assert.equal(response.json.limits.challengePerHourPerIp, 60);
    const serialized = JSON.stringify(response.json);
    assert.ok(!serialized.includes(TEST_APNS_CONFIG.keyFile));
    assert.ok(!serialized.includes('tokenHash'));
    assert.ok(!serialized.includes('-----BEGIN'));
    assert.ok(!serialized.includes('eyJ')); // 不含任何 JWT/credential
  } finally {
    await t.stop();
  }
});

test('hub: APNs 未配置（私钥不可读）→ healthz configured=false，推送返回 503 push_unavailable', async () => {
  const dir = makeTempDir();
  const config = createHubConfig({
    listenHost: '127.0.0.1',
    port: 0,
    publicUrl: 'https://push.example.com',
    signingKeyFile: join(dir, 'push-hub-signing-key.pem'),
    apns: { ...TEST_APNS_CONFIG, keyFile: join(dir, 'missing-AuthKey.p8') },
  }, { env: {} });
  // 不注入 apnsClient：走真实的 createApnsClient（读不到 .p8 → configured=false）。
  const hub = createHubServer({ config, logger: silentLogger() });
  const info = await hub.listen();
  const baseUrl = `http://127.0.0.1:${info.port}`;
  try {
    const health = await requestJson(baseUrl, HUB_HEALTH_PATH);
    assert.equal(health.json.apns.configured, false);
    // 登记不走 APNs，仍能拿到 credential；推送时才 503。
    const { enrolled } = await enrollTestDevice(baseUrl, { token: DEVICE_TOKEN });
    assert.equal(enrolled.status, 200, JSON.stringify(enrolled.json));
    const push = await requestJson(baseUrl, HUB_PUSH_PATH, {
      token: enrolled.json.credential,
      body: devicePushBody(DEVICE_TOKEN),
    });
    assert.equal(push.status, 503);
    assert.equal(push.json.ok, false);
    assert.equal(push.json.error.code, 'push_unavailable');
  } finally {
    await hub.close();
    cleanupDir(dir);
  }
});

test('hub: 路由/方法（404、405、GET /v1/push）', async () => {
  const t = await startTestHub();
  try {
    const notFound = await requestJson(t.baseUrl, '/');
    assert.equal(notFound.status, 404);
    assert.equal(notFound.json.error.code, 'not_found');

    const healthPost = await requestJson(t.baseUrl, HUB_HEALTH_PATH, { method: 'POST', body: {} });
    assert.equal(healthPost.status, 405);
    assert.equal(healthPost.headers.get('allow'), 'GET, HEAD');
    assert.equal(healthPost.json.error.code, 'method_not_allowed');

    const pushGet = await requestJson(t.baseUrl, HUB_PUSH_PATH);
    assert.equal(pushGet.status, 405);
    assert.equal(pushGet.headers.get('allow'), 'POST');
  } finally {
    await t.stop();
  }
});

test('hub: /v1/push 只接受 device credential（缺失 / 旧式 relay token / 伪 JWT 一律 401 invalid_credential）', async () => {
  const logger = recordingLogger();
  const t = await startTestHub({ logger });
  try {
    // 缺 Bearer。
    const missing = await requestJson(t.baseUrl, HUB_PUSH_PATH, { body: devicePushBody(DEVICE_TOKEN) });
    assert.equal(missing.status, 401);
    assert.equal(missing.json.error.code, 'invalid_credential');
    assert.match(missing.json.error.message, /missing bearer/);

    // 回归：旧式 relay token 形态（43 字符 base64url，非 JWT）——hub 不再识别 relay。
    const relayToken = 'Z'.repeat(43);
    const relayShape = await requestJson(t.baseUrl, HUB_PUSH_PATH, { token: relayToken, body: devicePushBody(DEVICE_TOKEN) });
    assert.equal(relayShape.status, 401);
    assert.equal(relayShape.json.error.code, 'invalid_credential');
    assert.match(relayShape.json.error.message, /not a valid JWT/);

    // 三段式但不是本 hub 签发的 credential。
    const forged = await requestJson(t.baseUrl, HUB_PUSH_PATH, { token: 'a.b.c', body: devicePushBody(DEVICE_TOKEN) });
    assert.equal(forged.status, 401);
    assert.equal(forged.json.error.code, 'invalid_credential');

    assert.equal(t.apns.calls.length, 0, '任何鉴权失败的请求都不能到达 APNs');
    // 日志同样不回显这些凭据。
    const logs = logger.lines.join('\n');
    assert.ok(logs.length > 0);
    assert.ok(!logs.includes(relayToken), '日志不能包含旧式 relay token');
    assert.ok(!logs.includes('a.b.c'));
  } finally {
    await t.stop();
  }
});

test('hub: 请求体上限 16KB → 413 invalid_request（device credential）', async () => {
  const t = await startTestHub();
  try {
    const credential = await getCredential(t);
    const tooLarge = JSON.stringify({ kind: 'turn-end', token: DEVICE_TOKEN }).padEnd(17 * 1024, 'x');
    const response = await requestJson(t.baseUrl, HUB_PUSH_PATH, {
      token: credential,
      headers: { 'content-type': 'application/json' },
      body: tooLarge,
    });
    assert.equal(response.status, 413);
    assert.equal(response.json.error.code, 'invalid_request');
    assert.match(response.json.error.message, /exceeds 16384 bytes/);
    assert.equal(t.apns.calls.length, 0);
  } finally {
    await t.stop();
  }
});

test('hub: APNs 抛错 → 500 internal（响应不回显异常文本，日志脱敏）', async () => {
  const secret = `SECRET-${DEVICE_TOKEN}`;
  const apns = {
    isConfigured: () => true,
    async sendToTokens() { throw new Error(`boom ${secret}`); },
  };
  const logger = recordingLogger();
  const t = await startTestHub({ apnsClient: apns, logger });
  try {
    const credential = await getCredential(t);
    const response = await requestJson(t.baseUrl, HUB_PUSH_PATH, {
      token: credential,
      body: devicePushBody(DEVICE_TOKEN),
    });
    assert.equal(response.status, 500);
    assert.deepEqual(response.json, { ok: false, error: { code: 'internal', message: 'internal error' } });
    assert.ok(!JSON.stringify(response.json).includes(secret));
    assert.ok(!logger.lines.join('\n').includes(DEVICE_TOKEN));
  } finally {
    await t.stop();
  }
});

test('hub: TLS 文件缺失时 listen 给可操作错误（不静默降级为明文）', async () => {
  const dir = makeTempDir();
  try {
    const config = createHubConfig({
      listenHost: '127.0.0.1',
      port: 0,
      tls: { certFile: join(dir, 'missing-fullchain.pem'), keyFile: join(dir, 'missing-privkey.pem') },
    }, { env: {} });
    const hub = createHubServer({ config, apnsClient: makeApnsClient(), logger: silentLogger() });
    await assert.rejects(() => hub.listen(), /cannot read TLS certificate file/);
    await hub.close();
  } finally {
    cleanupDir(dir);
  }
});

test('limiter: 滑动窗口滚动后恢复配额（单元）', () => {
  let now = 1_700_000_000_000;
  const limiter = new SlidingWindowLimiter({ limit: 2, windowMs: 60_000, now: () => now });
  assert.deepEqual(limiter.take('r_1'), { allowed: true, retryAfterMs: 0 });
  assert.deepEqual(limiter.take('r_1'), { allowed: true, retryAfterMs: 0 });
  const blocked = limiter.take('r_1');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterMs, 60_000);
  // 另一个 key 不受影响。
  assert.equal(limiter.take('r_2').allowed, true);
  // 窗口滚动：旧的记录过期，重新允许一个窗口内的 limit 次。
  now += 60_000;
  assert.equal(limiter.take('r_1').allowed, true);
  assert.equal(limiter.take('r_1').allowed, true);
  assert.equal(limiter.take('r_1').allowed, false);
  limiter.reset('r_1');
  assert.equal(limiter.take('r_1').allowed, true);
});
