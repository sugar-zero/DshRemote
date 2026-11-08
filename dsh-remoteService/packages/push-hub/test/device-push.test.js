import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import {
  PUSH_CREDENTIAL_TYP,
  PUSH_CREDENTIAL_VERSION,
  sha256Base64Url,
} from 'dsh-remote-protocol';
import {
  HUB_PUSH_PATH,
  createHubServer,
  loadOrCreateSigningKey,
  signCredential,
} from '../index.js';
import {
  TEST_APNS_CONFIG,
  TEST_PUBLIC_URL,
  cleanupDir,
  devicePushBody,
  enrollTestDevice,
  makeApnsClient,
  recordingLogger,
  requestJson,
  silentLogger,
  startTestHub,
} from './helpers.js';

const TOKEN = 'a'.repeat(64);
const TOKEN_2 = 'b'.repeat(64);
const HOST = 'h_ab12cd34.relay.example.com';

/**
 * 登记一台测试设备并返回 credential。
 * @param {any} t startTestHub 返回值
 * @param {{token?: string, environment?: string}} [options]
 */
async function getCredential(t, options = {}) {
  const { enrolled } = await enrollTestDevice(t.baseUrl, {
    token: options.token ?? TOKEN,
    environment: options.environment ?? 'production',
  });
  assert.equal(enrolled.status, 200, `enroll failed: ${JSON.stringify(enrolled.json)}`);
  return enrolled.json.credential;
}

/**
 * 用 hub 自己的签名 key 手工签一份 claims（测 aud/typ/bundle 不一致等分支）。
 * @param {any} t
 * @param {Record<string, unknown>} overrides
 */
function signClaimsWithHubKey(t, overrides = {}) {
  const signing = loadOrCreateSigningKey(t.signingKeyFile, { logger: silentLogger() });
  const nowSec = Math.floor(Date.now() / 1000);
  const claims = {
    v: PUSH_CREDENTIAL_VERSION,
    typ: PUSH_CREDENTIAL_TYP,
    tokenHash: sha256Base64Url(TOKEN),
    env: 'production',
    bundleId: TEST_APNS_CONFIG.topic,
    aud: TEST_PUBLIC_URL,
    jti: `jti-${randomBytes(8).toString('hex')}`,
    iat: nowSec,
    exp: nowSec + 3600,
    ...overrides,
  };
  return signCredential({ privateKey: signing.privateKey, kid: signing.kid, claims });
}

test('device push: 成功 → 通用文案 / 单 token entries / mode=device', async () => {
  const t = await startTestHub();
  try {
    const credential = await getCredential(t);
    assert.equal(t.apns.calls.length, 0, 'enroll 不应触发 APNs');

    const response = await requestJson(t.baseUrl, HUB_PUSH_PATH, {
      token: credential,
      body: devicePushBody(TOKEN, { kind: 'turn-end', host: HOST }),
    });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.deepEqual(response.json, { ok: true, delivered: 1, failed: 0, pruned: [], mode: 'device' });
    assert.equal(t.apns.calls.length, 1);
    assert.deepEqual(t.apns.calls[0].entries, [{ deviceId: '0', token: TOKEN, environment: 'production' }]);
    assert.deepEqual(t.apns.calls[0].message, { kind: 'turn-end', title: 'DSH', body: '任务已完成', host: HOST });
    assert.equal(Object.hasOwn(t.apns.calls[0].message, 'sessionId'), false);

    // waiting-answer 同样是固定通用文案；host 省略时不进 payload。
    const waiting = await requestJson(t.baseUrl, HUB_PUSH_PATH, {
      token: credential,
      body: { kind: 'waiting-answer', token: TOKEN },
    });
    assert.equal(waiting.status, 200);
    assert.deepEqual(t.apns.calls[1].message, { kind: 'waiting-answer', title: 'DSH', body: '正在等待你的回答' });
    assert.equal(Object.hasOwn(t.apns.calls[1].message, 'host'), false);
  } finally {
    await t.stop();
  }
});

test('device push: pruned（APNs 410/Unregistered）透传为 token 字符串', async () => {
  const apns = {
    isConfigured: () => true,
    calls: 0,
    async sendToTokens(entries) {
      this.calls += 1;
      return {
        delivered: 0,
        failed: 1,
        pruned: [{ deviceId: '0', token: entries[0].token }],
        configErrors: [],
        errors: [{ status: 410, reason: 'Unregistered' }],
      };
    },
  };
  const t = await startTestHub({ apnsClient: apns });
  try {
    const credential = await getCredential(t);
    const response = await requestJson(t.baseUrl, HUB_PUSH_PATH, {
      token: credential,
      body: devicePushBody(TOKEN, { host: '' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, {
      ok: true,
      delivered: 0,
      failed: 1,
      pruned: [TOKEN],
      mode: 'device',
    });
  } finally {
    await t.stop();
  }
});

test('device push: token 与 credential 不匹配 → 401 token_mismatch', async () => {
  const t = await startTestHub();
  try {
    const credential = await getCredential(t);
    const response = await requestJson(t.baseUrl, HUB_PUSH_PATH, {
      token: credential,
      body: devicePushBody(TOKEN_2),
    });
    assert.equal(response.status, 401);
    assert.equal(response.json.error.code, 'token_mismatch');
    assert.match(response.json.error.message, /does not match/);
    assert.equal(t.apns.calls.length, 0);
  } finally {
    await t.stop();
  }
});

test('device push: credential 过期 → 401 credential_expired（不调 APNs）', async () => {
  let fakeNow = 1_700_000_000_000;
  const t = await startTestHub({ now: () => fakeNow });
  try {
    const credential = await getCredential(t);
    // 默认 TTL 30 天；推进 31 天后再推。
    fakeNow += 31 * 86_400_000;
    const response = await requestJson(t.baseUrl, HUB_PUSH_PATH, { token: credential, body: devicePushBody(TOKEN) });
    assert.equal(response.status, 401);
    assert.equal(response.json.error.code, 'credential_expired');
    assert.equal(t.apns.calls.length, 0);
  } finally {
    await t.stop();
  }
});

test('device push: environment 与 claims 不一致 → 400 invalid_request', async () => {
  const t = await startTestHub();
  try {
    const credential = await getCredential(t, { environment: 'production' });
    const response = await requestJson(t.baseUrl, HUB_PUSH_PATH, {
      token: credential,
      body: devicePushBody(TOKEN, { environment: 'development' }),
    });
    assert.equal(response.status, 400);
    assert.equal(response.json.error.code, 'invalid_request');
    assert.match(response.json.error.message, /environment/);
  } finally {
    await t.stop();
  }
});

test('device push: 非法 credential（篡改签名 / 格式 / alg）→ 401 invalid_credential', async () => {
  const t = await startTestHub();
  try {
    const credential = await getCredential(t);
    const [header, claims] = credential.split('.');
    const cases = [
      ['篡改签名', `${header}.${claims}.${randomBytes(64).toString('base64url')}`],
      ['格式非法', 'a.b.c'],
      // alg=none 的伪造 credential（签名段随机）。
      ['alg 非 EdDSA', `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' }), 'utf8').toString('base64url')}.${claims}.${randomBytes(64).toString('base64url')}`],
    ];
    for (const [label, badCredential] of cases) {
      const response = await requestJson(t.baseUrl, HUB_PUSH_PATH, { token: badCredential, body: devicePushBody(TOKEN) });
      assert.equal(response.status, 401, `case ${label} 应 401`);
      assert.equal(response.json.error.code, 'invalid_credential', `case ${label} 错误码`);
    }
    // 非三段式 Bearer 一律当非法 device credential（hub 不再识别旧式 relay token）。
    const nonJwt = await requestJson(t.baseUrl, HUB_PUSH_PATH, { token: 'not-a-jwt', body: devicePushBody(TOKEN) });
    assert.equal(nonJwt.status, 401);
    assert.equal(nonJwt.json.error.code, 'invalid_credential');
    assert.match(nonJwt.json.error.message, /not a valid JWT/);
    assert.equal(t.apns.calls.length, 0);
  } finally {
    await t.stop();
  }
});

test('device push: aud/typ 不匹配 → 401 invalid_credential；bundleId 不匹配 → 400 unsupported_bundle_id', async () => {
  const t = await startTestHub();
  try {
    const wrongAud = signClaimsWithHubKey(t, { aud: 'https://other.example.com' });
    const audResponse = await requestJson(t.baseUrl, HUB_PUSH_PATH, { token: wrongAud, body: devicePushBody(TOKEN) });
    assert.equal(audResponse.status, 401);
    assert.equal(audResponse.json.error.code, 'invalid_credential');

    const wrongTyp = signClaimsWithHubKey(t, { typ: 'dsh-session' });
    const typResponse = await requestJson(t.baseUrl, HUB_PUSH_PATH, { token: wrongTyp, body: devicePushBody(TOKEN) });
    assert.equal(typResponse.status, 401);
    assert.equal(typResponse.json.error.code, 'invalid_credential');

    const wrongBundle = signClaimsWithHubKey(t, { bundleId: 'com.example.other.app' });
    const bundleResponse = await requestJson(t.baseUrl, HUB_PUSH_PATH, { token: wrongBundle, body: devicePushBody(TOKEN) });
    assert.equal(bundleResponse.status, 400);
    assert.equal(bundleResponse.json.error.code, 'unsupported_bundle_id');
    assert.equal(t.apns.calls.length, 0);
  } finally {
    await t.stop();
  }
});

test('device push: schema 只接受 kind/host/token/environment（title/body/sessionId/tokens 一律 400）', async () => {
  const t = await startTestHub();
  try {
    const credential = await getCredential(t);
    const base = devicePushBody(TOKEN, { host: HOST });
    const cases = [
      ['title', { ...base, title: '会话标题' }, /unsupported field\(s\): title/],
      ['body', { ...base, body: '摘要' }, /unsupported field\(s\): body/],
      ['sessionId', { ...base, sessionId: 's_1' }, /unsupported field\(s\): sessionId/],
      ['旧式 tokens 数组', { ...base, tokens: [{ token: TOKEN, environment: 'production' }] }, /unsupported field\(s\): tokens/],
      ['kind 非法', { ...base, kind: 'attention' }, /kind must be/],
      ['token 非 64 hex', { ...base, token: 'x'.repeat(64) }, /token must be 64 lowercase hex/],
      ['environment 非法', { ...base, environment: 'prod' }, /environment must be/],
      ['host 太长', { ...base, host: 'h'.repeat(255) }, /host must be shorter than 255/],
    ];
    for (const [label, body, pattern] of cases) {
      const response = await requestJson(t.baseUrl, HUB_PUSH_PATH, { token: credential, body });
      assert.equal(response.status, 400, `case ${label} 应 400`);
      assert.equal(response.json.error.code, 'invalid_request', `case ${label} 错误码`);
      assert.match(response.json.error.message, pattern, `case ${label} 错误信息`);
    }
    assert.equal(t.apns.calls.length, 0);
  } finally {
    await t.stop();
  }
});

test('device push: 各层限流 → 429 + Retry-After，被拒请求不调 APNs', async () => {
  /** @type {Array<{name: string, limits: object, blockedMessage: RegExp, minRetryAfter: number}>} */
  const tiers = [
    {
      name: '每 token 每分钟',
      limits: { pushPerMinutePerToken: 2, pushPerDayPerToken: 1000, pushPerMinutePerCredential: 100, pushPerMinutePerHost: 100, pushPerMinutePerIp: 100, pushPerMinuteGlobal: 100 },
      blockedMessage: /device token per minute/,
      minRetryAfter: 1,
    },
    {
      name: '每 token 每天',
      limits: { pushPerMinutePerToken: 100, pushPerDayPerToken: 2, pushPerMinutePerCredential: 100, pushPerMinutePerHost: 100, pushPerMinutePerIp: 100, pushPerMinuteGlobal: 100 },
      blockedMessage: /device token per day/,
      minRetryAfter: 60,
    },
    {
      name: '每 credential 每分钟',
      limits: { pushPerMinutePerToken: 100, pushPerDayPerToken: 1000, pushPerMinutePerCredential: 2, pushPerMinutePerHost: 100, pushPerMinutePerIp: 100, pushPerMinuteGlobal: 100 },
      blockedMessage: /credential per minute/,
      minRetryAfter: 1,
    },
    {
      name: '每 host 每分钟',
      limits: { pushPerMinutePerToken: 100, pushPerDayPerToken: 1000, pushPerMinutePerCredential: 100, pushPerMinutePerHost: 2, pushPerMinutePerIp: 100, pushPerMinuteGlobal: 100 },
      blockedMessage: /host per minute/,
      minRetryAfter: 1,
    },
    {
      name: '每 IP 每分钟',
      limits: { pushPerMinutePerToken: 100, pushPerDayPerToken: 1000, pushPerMinutePerCredential: 100, pushPerMinutePerHost: 100, pushPerMinutePerIp: 2, pushPerMinuteGlobal: 100 },
      blockedMessage: /client IP per minute/,
      minRetryAfter: 1,
    },
    {
      name: '全局每分钟',
      limits: { pushPerMinutePerToken: 100, pushPerDayPerToken: 1000, pushPerMinutePerCredential: 100, pushPerMinutePerHost: 100, pushPerMinutePerIp: 100, pushPerMinuteGlobal: 2 },
      blockedMessage: /hub-wide per minute/,
      minRetryAfter: 1,
    },
  ];
  for (const tier of tiers) {
    const t = await startTestHub({ limits: tier.limits });
    try {
      const credential = await getCredential(t);
      for (let i = 0; i < 2; i += 1) {
        const ok = await requestJson(t.baseUrl, HUB_PUSH_PATH, { token: credential, body: devicePushBody(TOKEN, { host: HOST }) });
        assert.equal(ok.status, 200, `${tier.name}: 第 ${i + 1} 次应 200，实际 ${ok.status} ${JSON.stringify(ok.json)}`);
      }
      const blocked = await requestJson(t.baseUrl, HUB_PUSH_PATH, { token: credential, body: devicePushBody(TOKEN, { host: HOST }) });
      assert.equal(blocked.status, 429, `${tier.name}: 应 429`);
      assert.equal(blocked.json.error.code, 'rate_limited', `${tier.name}: 错误码`);
      assert.match(blocked.json.error.message, tier.blockedMessage, `${tier.name}: 错误信息`);
      const retryAfter = Number(blocked.headers.get('retry-after'));
      assert.ok(Number.isInteger(retryAfter) && retryAfter >= tier.minRetryAfter, `${tier.name}: retry-after=${retryAfter}`);
      assert.equal(t.apns.calls.length, 2, `${tier.name}: 被拒请求不能到 APNs`);
    } finally {
      await t.stop();
    }
  }
});

test('device push: host 限流按 host 分桶（换 host 不共享额度）', async () => {
  const t = await startTestHub({
    limits: { pushPerMinutePerToken: 100, pushPerDayPerToken: 1000, pushPerMinutePerCredential: 100, pushPerMinutePerHost: 1, pushPerMinutePerIp: 100, pushPerMinuteGlobal: 100 },
  });
  try {
    const credential = await getCredential(t);
    assert.equal((await requestJson(t.baseUrl, HUB_PUSH_PATH, { token: credential, body: devicePushBody(TOKEN, { host: 'h_aaaaaaaa.relay.example.com' }) })).status, 200);
    // 同 host 再推 → 429。
    assert.equal((await requestJson(t.baseUrl, HUB_PUSH_PATH, { token: credential, body: devicePushBody(TOKEN, { host: 'h_aaaaaaaa.relay.example.com' }) })).status, 429);
    // 换 host → 仍允许（token/credential 其它层配额足够）。
    assert.equal((await requestJson(t.baseUrl, HUB_PUSH_PATH, { token: credential, body: devicePushBody(TOKEN, { host: 'h_bbbbbbbb.relay.example.com' }) })).status, 200);
  } finally {
    await t.stop();
  }
});

test('device push: hub 重启后签名 key 复用，已签发 credential 仍有效', async () => {
  const t = await startTestHub();
  // 用第一台 hub 登记拿 credential。
  const credential = await getCredential(t);
  const decodedBefore = JSON.parse(Buffer.from(credential.split('.')[0], 'base64url').toString('utf8'));
  await t.hub.close();
  // 重新用同一份 config（同一签名 key 文件）起一台新 hub：模拟容器重启。
  const apns = makeApnsClient();
  const restarted = createHubServer({ config: t.config, apnsClient: apns, logger: silentLogger() });
  const info = await restarted.listen();
  try {
    const response = await requestJson(`http://127.0.0.1:${info.port}`, HUB_PUSH_PATH, {
      token: credential,
      body: devicePushBody(TOKEN),
    });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.equal(apns.calls.length, 1, '重启后旧 credential 仍能推送（签名 key 持久化）');
    // 新签发的 credential kid 与旧的一致（同一把 key）。
    const { enrolled } = await enrollTestDevice(`http://127.0.0.1:${info.port}`, { token: TOKEN });
    assert.equal(enrolled.status, 200);
    const decodedAfter = JSON.parse(Buffer.from(enrolled.json.credential.split('.')[0], 'base64url').toString('utf8'));
    assert.equal(decodedAfter.kid, decodedBefore.kid);
    // 签名 key 文件保持 0600。
    assert.equal(statSync(t.signingKeyFile).mode & 0o777, 0o600);
  } finally {
    await restarted.close();
    cleanupDir(t.dir);
  }
});

test('device push: R2 未启用（无 HUB_PUBLIC_URL）→ 503 push_unavailable', async () => {
  const t = await startTestHub({ publicUrl: null });
  try {
    const response = await requestJson(t.baseUrl, HUB_PUSH_PATH, { token: 'a.b.c', body: devicePushBody(TOKEN) });
    assert.equal(response.status, 503);
    assert.equal(response.json.error.code, 'push_unavailable');
    assert.match(response.json.error.message, /not enabled/);
  } finally {
    await t.stop();
  }
});

test('device push: 日志不落 token / credential（成功与失败路径）', async () => {
  const logger = recordingLogger();
  const t = await startTestHub({ logger });
  try {
    const credential = await getCredential(t);
    await requestJson(t.baseUrl, HUB_PUSH_PATH, { token: credential, body: devicePushBody(TOKEN, { host: HOST }) });
    // 失败路径：token 不匹配 + 非法 credential。
    await requestJson(t.baseUrl, HUB_PUSH_PATH, { token: credential, body: devicePushBody(TOKEN_2) });
    await requestJson(t.baseUrl, HUB_PUSH_PATH, { token: 'a.b.c', body: devicePushBody(TOKEN) });
    const logs = logger.lines.join('\n');
    assert.match(logs, /mode=device/);
    assert.ok(!logs.includes(TOKEN), '日志不能包含设备 token');
    assert.ok(!logs.includes(TOKEN_2));
    assert.ok(!logs.includes(credential), '日志不能包含 credential');
    assert.ok(!logs.includes('eyJ'), '日志不能包含 JWT 片段');
  } finally {
    await t.stop();
  }
});
