import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify as verifySignature } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  APNS_HOSTS,
  buildPushMessage,
  createApnsClient,
  createProviderToken,
} from '../lib/apns.js';

const KEY_ID = 'ABC123DEF4';
const TEAM_ID = 'TEAM123456';
const TOPIC = 'com.example.dshremote';
const NOW = 1_700_000_000_000;

function makeEcKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { privateKey, publicKey };
}

function fromBase64url(segment) {
  return Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function decodeSegment(segment) {
  return JSON.parse(fromBase64url(segment).toString('utf8'));
}

test('APNs provider token: ES256 JWT with raw r||s signature', () => {
  const { privateKey, publicKey } = makeEcKey();
  const token = createProviderToken({ keyId: KEY_ID, teamId: TEAM_ID, privateKey, now: NOW });
  const [header, claims, signature] = token.split('.');
  assert.equal(token.split('.').length, 3);
  assert.deepEqual(decodeSegment(header), { alg: 'ES256', kid: KEY_ID });
  assert.deepEqual(decodeSegment(claims), { iss: TEAM_ID, iat: Math.floor(NOW / 1000) });
  const valid = verifySignature(
    'sha256',
    Buffer.from(`${header}.${claims}`),
    { key: publicKey, dsaEncoding: 'ieee-p1363' },
    fromBase64url(signature),
  );
  assert.equal(valid, true, '签名必须是 raw r||s（ieee-p1363），DER 会被 APNs 拒绝');
});

test('APNs payload: session-derived title/body + 跳转数据放在 body 字典', () => {
  const message = buildPushMessage({
    title: '修复登录 bug',
    body: '已修好登录重定向，跑完测试',
    kind: 'failure',
    sessionId: 's_1',
    host: 'h_ab12cd34.relay.example.com',
  });
  assert.deepEqual(message.aps.alert, { title: '修复登录 bug', body: '已修好登录重定向，跑完测试' });
  assert.equal(message.aps.sound, 'default');
  assert.deepEqual(message.body, {
    kind: 'failure',
    sessionId: 's_1',
    host: 'h_ab12cd34.relay.example.com',
  }, 'expo iOS 只把 userInfo.body 映射到 content.data');
  assert.deepEqual(Object.keys(message).sort(), ['aps', 'body'], 'payload 只包含 aps 与 body 字典');
  const serialized = JSON.stringify(message);
  assert.ok(!serialized.includes('/Users/'));
});

test('APNs client: routes by environment, caches provider token, sends expected headers/payload', async () => {
  const { privateKey } = makeEcKey();
  const requests = [];
  let signs = 0;
  let clock = NOW;
  const client = createApnsClient({
    privateKey,
    keyId: KEY_ID,
    teamId: TEAM_ID,
    topic: TOPIC,
    title: 'DSH',
    body: '有任务需要你',
    now: () => clock,
    createToken: (options) => {
      signs += 1;
      return createProviderToken(options);
    },
    sendRequest: async (request) => {
      requests.push(request);
      return { status: 200, body: '' };
    },
  });
  assert.equal(client.isConfigured(), true);

  const tokenA = 'a'.repeat(64);
  const tokenB = 'b'.repeat(64);
  const summary = await client.sendToTokens([
    { deviceId: 'd_dev', token: tokenA, environment: 'development' },
    { deviceId: 'd_prod', token: tokenB, environment: 'production' },
  ], {
    kind: 'attention',
    title: '修复登录 bug',
    body: '已修好登录重定向，跑完测试',
    sessionId: 's_1',
    host: 'h_ab12cd34.relay.example.com',
  });
  assert.equal(summary.delivered, 2);
  assert.equal(summary.failed, 0);
  assert.equal(signs, 1, '同一批 token 只签一次 JWT');
  assert.equal(requests.length, 2);

  assert.equal(requests[0].origin, APNS_HOSTS.development, '开发签名包必须走 sandbox');
  assert.equal(requests[1].origin, APNS_HOSTS.production);
  assert.equal(requests[0].path, `/3/device/${tokenA}`);
  assert.equal(requests[1].path, `/3/device/${tokenB}`);
  for (const request of requests) {
    assert.match(request.headers.authorization, /^bearer [^.]+\.[^.]+\.[^.]+$/);
    assert.equal(request.headers['apns-topic'], TOPIC);
    assert.equal(request.headers['apns-push-type'], 'alert');
    assert.equal(request.headers['apns-priority'], '10');
    assert.equal(request.headers['content-type'], 'application/json');
    assert.match(request.headers['apns-expiration'], /^\d+$/);
    assert.equal(request.headers['apns-collapse-id'], 's_1', '同一会话的通知用 apns-collapse-id 折叠');
    const payload = JSON.parse(request.body);
    assert.deepEqual(payload.aps.alert, { title: '修复登录 bug', body: '已修好登录重定向，跑完测试' });
    assert.deepEqual(payload.body, {
      kind: 'attention',
      sessionId: 's_1',
      host: 'h_ab12cd34.relay.example.com',
    });
  }
  assert.equal(requests[0].headers.authorization, requests[1].headers.authorization, '同一批共享缓存的 provider token');

  // 缓存期内不重签
  await client.sendToTokens([{ deviceId: 'd_dev', token: tokenA, environment: 'development' }]);
  assert.equal(signs, 1);
  // 超过 50 分钟后重签
  clock += 51 * 60 * 1000;
  await client.sendToTokens([{ deviceId: 'd_dev', token: tokenA, environment: 'development' }]);
  assert.equal(signs, 2);
  assert.notEqual(requests[2].headers.authorization, requests[3].headers.authorization);
  // 没有 sessionId（或超长）时不发 apns-collapse-id（APNs 限制 64 字节）
  await client.sendToTokens([{ deviceId: 'd_dev', token: tokenA, environment: 'development' }]);
  assert.equal(requests[4].headers['apns-collapse-id'], undefined);
  await client.sendToTokens([{ deviceId: 'd_dev', token: tokenA, environment: 'development' }], { sessionId: 'x'.repeat(65) });
  assert.equal(requests[5].headers['apns-collapse-id'], undefined);
});

test('APNs client: fixed environment override wins over per-token environment', async () => {
  const { privateKey } = makeEcKey();
  const origins = [];
  const client = createApnsClient({
    privateKey, keyId: KEY_ID, teamId: TEAM_ID, topic: TOPIC, environment: 'development',
    sendRequest: async (request) => { origins.push(request.origin); return { status: 200, body: '' }; },
  });
  await client.sendToTokens([{ deviceId: 'd', token: 'c'.repeat(64), environment: 'production' }]);
  assert.deepEqual(origins, [APNS_HOSTS.development]);
});

test('APNs client: prunes only 410/Unregistered; env/topic/JWT failures are config errors', async () => {
  const { privateKey } = makeEcKey();
  const replies = [
    { status: 200, body: '' },
    { status: 410, body: JSON.stringify({ reason: 'Unregistered' }) },
    { status: 400, body: JSON.stringify({ reason: 'BadDeviceToken' }) },
    { status: 400, body: JSON.stringify({ reason: 'DeviceTokenNotForTopic' }) },
    { status: 429, body: JSON.stringify({ reason: 'TooManyRequests' }) },
    { status: 403, body: JSON.stringify({ reason: 'InvalidProviderToken' }) },
  ];
  let index = 0;
  const tokens = {
    d_ok: '1'.repeat(64),
    d_gone: '2'.repeat(64),
    d_bad: '3'.repeat(64),
    d_topic: '4'.repeat(64),
    d_rate: '5'.repeat(64),
    d_jwt: '6'.repeat(64),
  };
  const client = createApnsClient({
    privateKey, keyId: KEY_ID, teamId: TEAM_ID, topic: TOPIC,
    sendRequest: async () => replies[index++],
  });
  const summary = await client.sendToTokens(
    Object.entries(tokens).map(([deviceId, token]) => ({ deviceId, token })),
    { kind: 'failure' },
  );
  assert.equal(summary.delivered, 1);
  assert.equal(summary.failed, 5);
  // 只有 410/Unregistered 进入 pruned，且携带实际失败的那个 token
  assert.deepEqual(summary.pruned, [{ deviceId: 'd_gone', token: tokens.d_gone }]);
  // BadDeviceToken / DeviceTokenNotForTopic / InvalidProviderToken 是配置错误，不清理 token
  assert.deepEqual(summary.configErrors, ['BadDeviceToken', 'DeviceTokenNotForTopic', 'InvalidProviderToken']);
  assert.ok(summary.errors.some((entry) => entry.reason.includes('DeviceTokenNotForTopic')));
  assert.ok(summary.errors.some((entry) => entry.reason.includes('429')));
  assert.ok(summary.errors.some((entry) => entry.reason.includes('InvalidProviderToken')));
});

test('APNs client: 410 with an unexpected reason still prunes; 400 BadDeviceToken never does', async () => {
  const { privateKey } = makeEcKey();
  // APNs 偶发 410 但 body 里没有 reason（或 reason 不认识）时，按 HTTP 语义仍算 token 失效。
  const replies = [
    { status: 410, body: '' },
    { status: 400, body: JSON.stringify({ reason: 'BadDeviceToken' }) },
  ];
  let index = 0;
  const client = createApnsClient({
    privateKey, keyId: KEY_ID, teamId: TEAM_ID, topic: TOPIC,
    sendRequest: async () => replies[index++],
  });
  const goneToken = '9'.repeat(64);
  const keptToken = '8'.repeat(64);
  const summary = await client.sendToTokens([
    { deviceId: 'd_gone', token: goneToken },
    { deviceId: 'd_kept', token: keptToken },
  ], { kind: 'attention' });
  assert.deepEqual(summary.pruned, [{ deviceId: 'd_gone', token: goneToken }]);
  assert.deepEqual(summary.configErrors, ['BadDeviceToken']);
  assert.deepEqual(summary.errors.map((entry) => entry.status), [410, 400]);
});

test('APNs client: unconfigured / invalid key reports readable errors without sending', async () => {
  const empty = createApnsClient({});
  assert.equal(empty.isConfigured(), false);
  assert.equal(empty.error, 'APNs 私钥路径未配置');
  const notConfigured = await empty.sendToTokens([{ deviceId: 'd', token: 'a'.repeat(64) }]);
  assert.equal(notConfigured.delivered, 0);
  assert.equal(notConfigured.failed, 0);
  assert.equal(notConfigured.skipped, 'not-configured');
  assert.deepEqual(notConfigured.pruned, []);
  assert.deepEqual(notConfigured.configErrors, []);

  const dir = mkdtempSync(join(tmpdir(), 'dsh-apns-test-'));
  try {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const keyPath = join(dir, 'wrong-key.p8');
    writeFileSync(keyPath, rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const wrong = createApnsClient({ keyFile: keyPath, keyId: KEY_ID, teamId: TEAM_ID, topic: TOPIC });
    assert.equal(wrong.isConfigured(), false);
    assert.match(wrong.error, /EC/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('APNs client: empty token list short-circuits', async () => {
  const { privateKey } = makeEcKey();
  const client = createApnsClient({ privateKey, keyId: KEY_ID, teamId: TEAM_ID, topic: TOPIC });
  const summary = await client.sendToTokens([], { kind: 'attention' });
  assert.deepEqual(summary, { delivered: 0, failed: 0, pruned: [], configErrors: [], errors: [], skipped: 'no-tokens' });
});
