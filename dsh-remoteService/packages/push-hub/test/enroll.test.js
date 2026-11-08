import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { sha256Base64Url } from 'dsh-remote-protocol';
import {
  HUB_DEFAULT_CREDENTIAL_TTL_DAYS,
  HUB_ENROLL_CHALLENGE_PATH,
  HUB_ENROLL_PATH,
  HUB_HEALTH_PATH,
  decodeCredential,
} from '../index.js';
import {
  TEST_APNS_CONFIG,
  TEST_PUBLIC_URL,
  createDeviceKey,
  enrollTestDevice,
  recordingLogger,
  requestJson,
  signEnrollMessage,
  startTestHub,
} from './helpers.js';

const TOKEN = 'a'.repeat(64);

test('enroll: POST /v1/enroll/challenge 签发一次性 nonce（TTL 120s、字段形态）', async () => {
  const t = await startTestHub();
  try {
    const before = Date.now();
    const response = await requestJson(t.baseUrl, HUB_ENROLL_CHALLENGE_PATH, { body: {} });
    const after = Date.now();
    assert.equal(response.status, 200);
    assert.equal(response.json.ok, true);
    assert.match(response.json.challengeId, /^[A-Za-z0-9_-]{22}$/);
    assert.match(response.json.nonce, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(response.json.expiresAt >= before + 120_000 - 5_000);
    assert.ok(response.json.expiresAt <= after + 120_000 + 5_000);
    assert.equal(Object.hasOwn(response.json, 'credential'), false);

    // devicePublicKey 可选；合法 P-256 点接受。
    const deviceKey = createDeviceKey();
    const withKey = await requestJson(t.baseUrl, HUB_ENROLL_CHALLENGE_PATH, { body: { devicePublicKey: deviceKey.publicKeyB64Url } });
    assert.equal(withKey.status, 200);

    // 非法/多余字段 400 invalid_request。
    const badKey = await requestJson(t.baseUrl, HUB_ENROLL_CHALLENGE_PATH, { body: { devicePublicKey: 'not-a-point' } });
    assert.equal(badKey.status, 400);
    assert.equal(badKey.json.error.code, 'invalid_request');
    const extra = await requestJson(t.baseUrl, HUB_ENROLL_CHALLENGE_PATH, { body: { devicePublicKey: deviceKey.publicKeyB64Url, foo: 1 } });
    assert.equal(extra.status, 400);
    assert.equal(extra.json.error.code, 'invalid_request');
  } finally {
    await t.stop();
  }
});

test('enroll: 完整链路（P-256 PoP）→ credential claims 与契约一致', async () => {
  const t = await startTestHub();
  try {
    const deviceKey = createDeviceKey();
    const { challenge, enrolled } = await enrollTestDevice(t.baseUrl, {
      deviceKey,
      token: TOKEN,
      environment: 'production',
      bundleId: TEST_APNS_CONFIG.topic,
      hostId: 'h_ab12cd34',
    });
    assert.equal(challenge.status, 200);
    assert.equal(enrolled.status, 200, JSON.stringify(enrolled.json));
    assert.equal(enrolled.json.ok, true);
    assert.deepEqual(enrolled.json.hub, { endpoint: TEST_PUBLIC_URL, topic: TEST_APNS_CONFIG.topic });
    assert.equal(typeof enrolled.json.expiresAt, 'number');
    assert.equal(enrolled.json.credential.split('.').length, 3);

    const decoded = decodeCredential(enrolled.json.credential);
    assert.equal(decoded.header.alg, 'EdDSA');
    assert.equal(decoded.header.typ, 'JWT');
    assert.match(decoded.header.kid, /^[A-Za-z0-9_-]{16}$/);
    const claims = decoded.claims;
    assert.equal(claims.v, 1);
    assert.equal(claims.typ, 'dsh-push-device');
    assert.equal(claims.tokenHash, sha256Base64Url(TOKEN));
    assert.equal(claims.env, 'production');
    assert.equal(claims.bundleId, TEST_APNS_CONFIG.topic);
    assert.equal(claims.hostId, 'h_ab12cd34');
    assert.equal(claims.aud, TEST_PUBLIC_URL);
    assert.match(claims.jti, /^[0-9a-f-]{36}$/);
    assert.equal(claims.exp - claims.iat, HUB_DEFAULT_CREDENTIAL_TTL_DAYS * 86_400, '默认 TTL 30 天');
    assert.equal(enrolled.json.expiresAt, claims.exp * 1000);

    // 同一设备再次登记会拿到新 credential（jti/iat 不同），旧 challenge 已消费。
    const second = await enrollTestDevice(t.baseUrl, { deviceKey, token: TOKEN });
    assert.equal(second.enrolled.status, 200);
    assert.notEqual(decodeCredential(second.enrolled.json.credential).claims.jti, claims.jti);
  } finally {
    await t.stop();
  }
});

test('enroll: challenge 一次性（重复提交 → challenge_used）', async () => {
  const t = await startTestHub();
  try {
    const deviceKey = createDeviceKey();
    const { fields, signature } = await enrollTestDevice(t.baseUrl, { deviceKey, token: TOKEN });
    const replay = await requestJson(t.baseUrl, HUB_ENROLL_PATH, { body: { ...fields, signature } });
    assert.equal(replay.status, 400);
    assert.equal(replay.json.error.code, 'challenge_used');
    assert.match(replay.json.error.message, /new one/);
  } finally {
    await t.stop();
  }
});

test('enroll: challenge 过期 / 未知 → challenge_expired', async () => {
  let fakeNow = 1_700_000_000_000;
  const t = await startTestHub({ now: () => fakeNow });
  try {
    const deviceKey = createDeviceKey();
    const challenge = await requestJson(t.baseUrl, HUB_ENROLL_CHALLENGE_PATH, { body: { devicePublicKey: deviceKey.publicKeyB64Url } });
    assert.equal(challenge.status, 200);
    const fields = {
      challengeId: challenge.json.challengeId,
      nonce: challenge.json.nonce,
      devicePublicKey: deviceKey.publicKeyB64Url,
      hostId: '',
      token: TOKEN,
      environment: 'production',
      bundleId: TEST_APNS_CONFIG.topic,
    };
    const signature = signEnrollMessage(deviceKey, fields);
    // TTL 120s：推进 121s 后过期。
    fakeNow += 121_000;
    const expired = await requestJson(t.baseUrl, HUB_ENROLL_PATH, { body: { ...fields, signature } });
    assert.equal(expired.status, 400);
    assert.equal(expired.json.error.code, 'challenge_expired');

    // 未知 challengeId（格式合法）同样视为过期。
    const unknownFields = {
      ...fields,
      challengeId: randomBytes(16).toString('base64url'),
    };
    const unknownSignature = signEnrollMessage(deviceKey, unknownFields);
    const unknown = await requestJson(t.baseUrl, HUB_ENROLL_PATH, { body: { ...unknownFields, signature: unknownSignature } });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.json.error.code, 'challenge_expired');
  } finally {
    await t.stop();
  }
});

test('enroll: nonce 不一致 / 设备签名无效 → invalid_signature（400）', async () => {
  const t = await startTestHub();
  try {
    const deviceKey = createDeviceKey();
    const challenge = await requestJson(t.baseUrl, HUB_ENROLL_CHALLENGE_PATH, { body: { devicePublicKey: deviceKey.publicKeyB64Url } });
    const fields = {
      challengeId: challenge.json.challengeId,
      nonce: challenge.json.nonce,
      devicePublicKey: deviceKey.publicKeyB64Url,
      hostId: '',
      token: TOKEN,
      environment: 'production',
      bundleId: TEST_APNS_CONFIG.topic,
    };
    const signature = signEnrollMessage(deviceKey, fields);
    // 换掉 body 里的 nonce（签名是对原 nonce 签的）→ nonce 常量时间比较失败。
    const tampered = { ...fields, nonce: randomBytes(32).toString('base64url'), signature };
    const nonceMismatch = await requestJson(t.baseUrl, HUB_ENROLL_PATH, { body: tampered });
    assert.equal(nonceMismatch.status, 400);
    assert.equal(nonceMismatch.json.error.code, 'invalid_signature');
    assert.match(nonceMismatch.json.error.message, /nonce/);

    // 用另一把设备私钥签名（公钥仍报合法值）→ 验签失败。
    const otherKey = createDeviceKey();
    const wrongSignature = signEnrollMessage(otherKey, fields);
    const badSig = await requestJson(t.baseUrl, HUB_ENROLL_PATH, { body: { ...fields, signature: wrongSignature } });
    assert.equal(badSig.status, 400);
    assert.equal(badSig.json.error.code, 'invalid_signature');
  } finally {
    await t.stop();
  }
});

test('enroll: bundleId 不是本 hub 官方 topic → unsupported_bundle_id（400）', async () => {
  const t = await startTestHub();
  try {
    const deviceKey = createDeviceKey();
    const { enrolled } = await enrollTestDevice(t.baseUrl, {
      deviceKey,
      token: TOKEN,
      bundleId: 'com.example.not-official.app',
    });
    assert.equal(enrolled.status, 400);
    assert.equal(enrolled.json.error.code, 'unsupported_bundle_id');
    assert.match(enrolled.json.error.message, /bundleId/);
  } finally {
    await t.stop();
  }
});

test('enroll: 字段校验（400 invalid_request，响应不回显 token 值）', async () => {
  const t = await startTestHub();
  try {
    const deviceKey = createDeviceKey();
    const challenge = await requestJson(t.baseUrl, HUB_ENROLL_CHALLENGE_PATH, { body: { devicePublicKey: deviceKey.publicKeyB64Url } });
    const base = {
      challengeId: challenge.json.challengeId,
      nonce: challenge.json.nonce,
      devicePublicKey: deviceKey.publicKeyB64Url,
      hostId: 'h_ab12cd34',
      token: TOKEN,
      environment: 'production',
      bundleId: TEST_APNS_CONFIG.topic,
    };
    const signature = signEnrollMessage(deviceKey, base);
    const badCases = [
      ['token 大写', { ...base, token: 'A'.repeat(64) }, /token must be 64 lowercase hex/],
      ['token 位数', { ...base, token: 'a'.repeat(63) }, /token must be 64 lowercase hex/],
      ['environment 非法', { ...base, environment: 'prod' }, /environment must be/],
      ['bundleId 非法', { ...base, bundleId: 'no' }, /bundleId must be a valid bundle id/],
      ['hostId 非法', { ...base, hostId: 'bad host!' }, /hostId must match/],
      ['challengeId 非法', { ...base, challengeId: 'short' }, /challengeId must be/],
      ['nonce 非法', { ...base, nonce: 'short' }, /nonce must be/],
      ['devicePublicKey 非法', { ...base, devicePublicKey: 'not-a-point' }, /devicePublicKey must be/],
      ['signature 形态非法', { ...base, signature: 'x' }, /signature must be a base64url/],
    ];
    for (const [label, body, pattern] of badCases) {
      // 每设备（tokenHash）限速默认 5/h：每个 case 用不同的合法 token 避免撞上限速桶，
      // 这样断言的是字段校验而不是 429。
      const response = await requestJson(t.baseUrl, HUB_ENROLL_PATH, {
        body: {
          ...body,
          token: body.token === TOKEN ? randomBytes(32).toString('hex') : body.token,
          signature: body.signature ?? signature,
        },
      });
      assert.equal(response.status, 400, `case ${label} 应 400，实际 ${response.status} ${JSON.stringify(response.json)}`);
      assert.equal(response.json.error.code, 'invalid_request', `case ${label} 错误码`);
      assert.match(response.json.error.message, pattern, `case ${label} 错误信息`);
      assert.ok(!JSON.stringify(response.json).includes(TOKEN), `case ${label} 不能回显 token`);
    }

    // 多余字段（含 title/body/sessionId 类内容）直接 400。
    const extra = await requestJson(t.baseUrl, HUB_ENROLL_PATH, { body: { ...base, signature, title: 'x' } });
    assert.equal(extra.status, 400);
    assert.equal(extra.json.error.code, 'invalid_request');
    // 非 JSON / JSON 数组。
    const notJson = await requestJson(t.baseUrl, HUB_ENROLL_PATH, { headers: { 'content-type': 'application/json' }, body: '{nope' });
    assert.equal(notJson.status, 400);
    assert.match(notJson.json.error.message, /valid JSON/);
    const arrayBody = await requestJson(t.baseUrl, HUB_ENROLL_PATH, { body: [] });
    assert.equal(arrayBody.status, 400);
    assert.match(arrayBody.json.error.message, /JSON object/);
  } finally {
    await t.stop();
  }
});

test('enroll: 未启用（HUB_ENROLL_ENABLED=false / 未配置 HUB_PUBLIC_URL）→ 503 enroll_disabled', async () => {
  const disabled = await startTestHub({ enroll: { enabled: false } });
  try {
    const challenge = await requestJson(disabled.baseUrl, HUB_ENROLL_CHALLENGE_PATH, { body: {} });
    assert.equal(challenge.status, 503);
    assert.equal(challenge.json.error.code, 'enroll_disabled');
    const enroll = await requestJson(disabled.baseUrl, HUB_ENROLL_PATH, { body: {} });
    assert.equal(enroll.status, 503);
    assert.equal(enroll.json.error.code, 'enroll_disabled');
  } finally {
    await disabled.stop();
  }

  // 没有 HUB_PUBLIC_URL = R2 未启用：enroll / device 推送一并关闭。
  const r2Disabled = await startTestHub({ publicUrl: null });
  try {
    const challenge = await requestJson(r2Disabled.baseUrl, HUB_ENROLL_CHALLENGE_PATH, { body: {} });
    assert.equal(challenge.status, 503);
    assert.equal(challenge.json.error.code, 'enroll_disabled');
    const health = await requestJson(r2Disabled.baseUrl, HUB_HEALTH_PATH);
    assert.deepEqual(health.json.credential, { enabled: false, ttlDays: 30 });
    assert.deepEqual(health.json.enroll, { enabled: false });
  } finally {
    await r2Disabled.stop();
  }
});

test('enroll: 限流（IP 20/h、tokenHash 5/h、challenge IP 60/h）→ 429 + Retry-After', async () => {
  // IP 限速。
  const ipLimited = await startTestHub({ limits: { enrollPerHourPerIp: 2, enrollPerHourPerDevice: 100, challengePerHourPerIp: 100 } });
  try {
    for (let i = 0; i < 2; i += 1) {
      const response = await requestJson(ipLimited.baseUrl, HUB_ENROLL_PATH, { body: {} });
      assert.equal(response.status, 400, '前两次是字段错误而非限流');
    }
    const blocked = await requestJson(ipLimited.baseUrl, HUB_ENROLL_PATH, { body: {} });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.json.error.code, 'rate_limited');
    assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
  } finally {
    await ipLimited.stop();
  }

  // 每设备（tokenHash）限速：同一 token 第二次 enroll 被拒（即使第一次 200）。
  const deviceLimited = await startTestHub({ limits: { enrollPerHourPerIp: 100, enrollPerHourPerDevice: 1, challengePerHourPerIp: 100 } });
  try {
    const first = await enrollTestDevice(deviceLimited.baseUrl, { token: TOKEN });
    assert.equal(first.enrolled.status, 200);
    const second = await enrollTestDevice(deviceLimited.baseUrl, { token: TOKEN });
    assert.equal(second.enrolled.status, 429);
    assert.equal(second.enrolled.json.error.code, 'rate_limited');
  } finally {
    await deviceLimited.stop();
  }

  // challenge IP 限速。
  const challengeLimited = await startTestHub({ limits: { challengePerHourPerIp: 2 } });
  try {
    assert.equal((await requestJson(challengeLimited.baseUrl, HUB_ENROLL_CHALLENGE_PATH, { body: {} })).status, 200);
    assert.equal((await requestJson(challengeLimited.baseUrl, HUB_ENROLL_CHALLENGE_PATH, { body: {} })).status, 200);
    const blocked = await requestJson(challengeLimited.baseUrl, HUB_ENROLL_CHALLENGE_PATH, { body: {} });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.json.error.code, 'rate_limited');
  } finally {
    await challengeLimited.stop();
  }
});

test('enroll: 日志不落 token / credential / signature', async () => {
  const logger = recordingLogger();
  const t = await startTestHub({ logger });
  try {
    const { signature, enrolled } = await enrollTestDevice(t.baseUrl, { token: TOKEN });
    assert.equal(enrolled.status, 200);
    const logs = logger.lines.join('\n');
    assert.match(logs, /enroll: credential issued/);
    assert.ok(!logs.includes(TOKEN), '日志不能包含设备 token');
    assert.ok(!logs.includes(enrolled.json.credential), '日志不能包含 credential');
    assert.ok(!logs.includes(signature), '日志不能包含签名');
    assert.ok(!logs.includes(JSON.stringify({ token: TOKEN })));
  } finally {
    await t.stop();
  }
});
