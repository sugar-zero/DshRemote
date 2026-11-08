/**
 * R2：官方推送与 relay 解耦（host-plugin 0.2.6，契约 `docs/group-push-r2-contract.zh.md` §6）。
 *
 * 覆盖：
 * - `POST /__dsh_remote/push-token` 新字段（channel/bundleId/hubEndpoint/credential）校验；
 *   self 旧 body 兼容、official 不需要 relay 连接、仅内存存储；
 * - status.push 新形状 {enabled,self,official,mode}，不含 token/credential；
 * - 发送分流：self → relay（connector.sendPushIntent）；official → 逐设备直连官方 hub
 *   （mock fetch；Bearer credential；body {kind,host,token}；10s 超时、不重试；pruned 清设备）；
 * - 混合设备自动分流、只 official 时不向 relay 发、只 self 时不碰 hub、通道切换清理。
 *
 * 全部假 relay / mock hub（不连真 relay、不发真推送、无真实 token/credential）。
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import {
  GROUP_SESSION_COOKIE,
  PUSH_SEND_PATH,
  PUSH_TOKEN_PATH,
  STATUS_PATH,
  signGroupSessionToken,
} from 'dsh-remote-protocol';
import {
  GroupHostRuntime,
  isPushCredentialLike,
  normalizePushHubEndpoint,
  saveGroupRegistration,
} from '../lib/group.js';
import { withTempHome } from './helpers.js';

const HOST_ID = 'h_pushtest02';
const RELAY_DOMAIN = 'relay.test';
const FQDN = `${HOST_ID}.${RELAY_DOMAIN}`;
const SELF_DEVICE_ID = 'd_selfdevice01';
const OFFICIAL_DEVICE_ID = 'd_officialdev02';
const SELF_TOKEN = 'a'.repeat(64);
const OFFICIAL_TOKEN = 'b'.repeat(64);
const BUNDLE_ID = 'com.example.dshremote';
const HUB = 'https://push.example.com';
/** 三段式 JWT 形态的假 credential（不参与验签，仅测试透传）。 */
const CREDENTIAL = 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJ2IjoxLCJ0eXAiOiJkc2gtcHVzaC1kZXZpY2UifQ.c2lnbmF0dXJl';

/** relay 侧 Ed25519 签名密钥（host 只保存公钥做离线验签）。 */
function makeRelaySigningKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

/** 发一条 HTTP 请求到 loopback 明文代理。 */
function plainJsonRequest({ port, path, method = 'GET', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path, method, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: response.statusCode, json, text });
      });
    });
    request.on('error', reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

/** 假 connector：记录 push.register 与 push.send；可模拟连接状态与 relay 回执。 */
function fakeConnector({ connected = true, registerResult = { ok: true, mode: 'self', enabled: true } } = {}) {
  const calls = [];
  const removed = [];
  const intents = [];
  return {
    connected,
    calls,
    removed,
    intents,
    isConnected() { return this.connected === true; },
    stop() {},
    syncGroupDevices() { return true; },
    async registerPushToken(entry) {
      calls.push(entry);
      return typeof registerResult === 'function' ? registerResult(entry) : registerResult;
    },
    removePushToken(deviceId) { removed.push(String(deviceId)); },
    sendPushIntent(intent) {
      if (!this.isConnected()) return false;
      intents.push(intent);
      return true;
    },
  };
}

/** 已注册 + loopback 明文代理就绪的运行时（两台设备：self/official 各可登记）。 */
async function setupRuntime({ fetchImpl, hubTimeoutMs, connector, pushDetail = false } = {}) {
  const home = withTempHome();
  const relayKey = makeRelaySigningKey();
  saveGroupRegistration({
    serviceUrl: 'https://relay.example.com:19443',
    hostId: HOST_ID,
    hostToken: 'test-host-token',
    relayDomain: RELAY_DOMAIN,
    mobilePort: 11443,
    tokenPublicKey: relayKey.publicKeyPem,
    hostName: 'Push R2 Test Host',
  });
  const auditEntries = [];
  const logs = [];
  const deviceIds = [SELF_DEVICE_ID, OFFICIAL_DEVICE_ID];
  const devices = {
    list: () => deviceIds.map((id) => ({ id, name: id, platform: 'ios', groupPublicKey: `pk-${id}`, revokedAt: null })),
    touchById: () => {},
  };
  const runtime = new GroupHostRuntime({
    config: { pushEnabled: true, groupPlainPort: 0, ...(pushDetail ? { pushDetail: true } : {}) },
    devices,
    proxy: {
      handle: async () => { throw new Error('unexpected proxy request'); },
      handleUpgrade: () => { throw new Error('unexpected ws upgrade'); },
    },
    audit: { append: (entry) => auditEntries.push(entry) },
    log: (message) => logs.push(message),
    version: '0.2.6-test',
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(Number(hubTimeoutMs) > 0 ? { hubTimeoutMs: Number(hubTimeoutMs) } : {}),
  });
  await runtime.startPlainProxy();
  if (connector !== undefined) runtime.connector = connector;
  const tokens = Object.fromEntries(deviceIds.map((deviceId) => [
    deviceId,
    signGroupSessionToken({ privateKey: relayKey.privateKey, hostId: HOST_ID, deviceId }).token,
  ]));
  return { home, runtime, tokens, auditEntries, logs };
}

async function teardown(env) {
  try { await env.runtime.stop(); } catch { /* ignore */ }
  env.home.cleanup();
}

const SELF_BODY = Object.freeze({ provider: 'apns', token: SELF_TOKEN, environment: 'development' });

function officialBody(token = OFFICIAL_TOKEN, overrides = {}) {
  return {
    provider: 'apns',
    token,
    environment: 'production',
    channel: 'official',
    bundleId: BUNDLE_ID,
    hubEndpoint: HUB,
    credential: CREDENTIAL,
    ...overrides,
  };
}

function pushRequest(env, { deviceId = OFFICIAL_DEVICE_ID, body, method = 'POST', headers = {} }) {
  return plainJsonRequest({
    port: env.runtime.plainPort,
    path: PUSH_TOKEN_PATH,
    method,
    headers: {
      host: FQDN,
      cookie: `${GROUP_SESSION_COOKIE}=${env.tokens[deviceId]}`,
      'content-type': 'application/json',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** 收集 hub 请求的 mock fetch；handler 决定响应。 */
function makeHubFetch(handler = () => ({ ok: true, status: 200, json: async () => ({ ok: true, delivered: 1, failed: 0, pruned: [] }) })) {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const record = {
      url: String(url),
      method: init.method,
      headers: init.headers ?? {},
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    requests.push(record);
    return handler(record);
  };
  return { requests, fetchImpl };
}

test('R2：hubEndpoint/credential 校验 helper（https、≤2048、无 userinfo/query/hash；三段式 JWT ≤4096）', () => {
  assert.equal(normalizePushHubEndpoint('https://push.example.com'), 'https://push.example.com');
  assert.equal(normalizePushHubEndpoint('https://push.example.com/'), 'https://push.example.com');
  assert.equal(normalizePushHubEndpoint(' https://push.example.com/hub/ '), 'https://push.example.com/hub');
  assert.equal(normalizePushHubEndpoint('https://push.example.com:8443'), 'https://push.example.com:8443');
  for (const bad of [
    undefined, '', 'http://push.example.com', 'ftp://push.example.com',
    'https://user:pass@push.example.com', 'https://push.example.com?x=1', 'https://push.example.com/#x',
    `https://push.example.com/${'a'.repeat(2100)}`,
  ]) {
    assert.throws(() => normalizePushHubEndpoint(bad), (error) => error.code === 'invalid-hub-endpoint', `应拒绝 ${String(bad).slice(0, 60)}`);
  }

  assert.equal(isPushCredentialLike(CREDENTIAL), true);
  for (const bad of ['', 'a.b', 'a.b.c.d', 'a b.c.d', `${'a'.repeat(4100)}.b.c`]) {
    assert.equal(isPushCredentialLike(bad), false, `应拒绝 credential ${String(bad).slice(0, 40)}`);
  }
});

test('R2 push-token official：校验通过后内存登记（无需 relay），status 分流字段不含 token/credential', async () => {
  const env = await setupRuntime({ fetchImpl: async () => { throw new Error('登记阶段不应请求 hub'); } });
  try {
    const response = await pushRequest(env, { body: officialBody() });
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(response.json, {
      ok: true,
      data: { registered: true, channel: 'official', mode: 'official' },
    });
    const push = env.runtime.status().push;
    assert.deepEqual(push, {
      enabled: true,
      detail: false,
      self: { devices: 0, lastError: null },
      official: { devices: 1, lastError: null, hub: HUB },
      mode: 'official',
    });
    const statusJson = JSON.stringify(env.runtime.status());
    assert.equal(statusJson.includes(OFFICIAL_TOKEN), false, 'status 不能暴露 token');
    assert.equal(statusJson.includes(CREDENTIAL), false, 'status 不能暴露 credential');
    assert.equal(statusJson.includes(BUNDLE_ID), false, 'status 不暴露 bundleId（仅路由提示）');
    assert.equal(env.logs.some((line) => line.includes(OFFICIAL_TOKEN) || line.includes(CREDENTIAL)), false, '日志不能出现 token/credential');

    // 远程 status 同样（App 设置页读它）
    const remote = await plainJsonRequest({
      port: env.runtime.plainPort,
      path: STATUS_PATH,
      headers: { host: FQDN, cookie: `${GROUP_SESSION_COOKIE}=${env.tokens[OFFICIAL_DEVICE_ID]}` },
    });
    assert.equal(remote.status, 200, remote.text);
    assert.deepEqual(remote.json.data.push, push);
    assert.equal(JSON.stringify(remote.json).includes(OFFICIAL_TOKEN), false);
    assert.equal(JSON.stringify(remote.json).includes(CREDENTIAL), false);

    // 审计只有结果/channel，不含 token/credential
    const okAudit = env.auditEntries.find((entry) => entry.action === 'push-token' && entry.result === 'ok');
    assert.equal(okAudit?.hash, 'official');
    assert.equal(JSON.stringify(env.auditEntries).includes(OFFICIAL_TOKEN), false);
    assert.equal(JSON.stringify(env.auditEntries).includes(CREDENTIAL), false);
  } finally {
    await teardown(env);
  }
});

test('R2 push-token official：缺字段/非法字段一律 400 invalid-body，且不落任何设备记录', async () => {
  const env = await setupRuntime();
  try {
    const badBodies = [
      { ...officialBody(), bundleId: undefined },
      { ...officialBody(), bundleId: 'ab' },
      { ...officialBody(), bundleId: 'bad bundle' },
      { ...officialBody(), hubEndpoint: undefined },
      { ...officialBody(), hubEndpoint: 'http://push.example.com' },
      { ...officialBody(), hubEndpoint: 'https://push.example.com?x=1' },
      { ...officialBody(), hubEndpoint: 'https://user:pass@push.example.com' },
      { ...officialBody(), hubEndpoint: `https://push.example.com/${'a'.repeat(2100)}` },
      { ...officialBody(), credential: undefined },
      { ...officialBody(), credential: 'not-a-jwt' },
      { ...officialBody(), credential: 'a.b.c.d' },
      { ...officialBody(), credential: `${'a'.repeat(4100)}.b.c` },
    ];
    for (const body of badBodies) {
      const response = await pushRequest(env, { body });
      assert.equal(response.status, 400, `${JSON.stringify(body).slice(0, 120)} → ${response.status} ${response.text}`);
      assert.equal(response.json.error.code, 'invalid-body');
    }
    const push = env.runtime.status().push;
    assert.equal(push.detail, false);
    assert.equal(push.official.devices, 0);
    assert.equal(push.mode, '');
  } finally {
    await teardown(env);
  }
});

test('R2 混合设备：self + official 同机登记 → status mode=mixed、计数正确、通道切换清理 relay 缓存', async () => {
  const connector = fakeConnector();
  const env = await setupRuntime({ connector });
  try {
    const selfResponse = await pushRequest(env, { deviceId: SELF_DEVICE_ID, body: SELF_BODY });
    assert.equal(selfResponse.status, 200, selfResponse.text);
    assert.deepEqual(selfResponse.json.data, { registered: true, channel: 'self', mode: 'self' });
    assert.equal(connector.calls.length, 1);

    const officialResponse = await pushRequest(env, { body: officialBody() });
    assert.equal(officialResponse.status, 200, officialResponse.text);
    assert.equal(connector.calls.length, 1, 'official 登记不能触发 relay push.register');

    let push = env.runtime.status().push;
    assert.deepEqual(push, {
      enabled: true,
      detail: false,
      self: { devices: 1, lastError: null },
      official: { devices: 1, lastError: null, hub: HUB },
      mode: 'mixed',
    });

    // 同一设备从 self 改 official：不再把 token 补报 relay（connector 缓存清理）
    const switched = await pushRequest(env, { deviceId: SELF_DEVICE_ID, body: officialBody(SELF_TOKEN) });
    assert.equal(switched.status, 200, switched.text);
    assert.ok(connector.removed.includes(SELF_DEVICE_ID), '通道切换应清理 relay token 缓存');
    push = env.runtime.status().push;
    assert.equal(push.self.devices, 0);
    assert.equal(push.official.devices, 2);
    assert.equal(push.mode, 'official');
  } finally {
    await teardown(env);
  }
});

test('R2 分流：self → relay 一条 push.send；official → 逐设备直连 hub（Bearer credential，body 含 kind/host/token/sessionId）', async () => {
  const connector = fakeConnector();
  const hub = makeHubFetch();
  const env = await setupRuntime({ connector, fetchImpl: hub.fetchImpl });
  try {
    assert.equal((await pushRequest(env, { deviceId: SELF_DEVICE_ID, body: SELF_BODY })).status, 200);
    assert.equal((await pushRequest(env, { body: officialBody() })).status, 200);

    const summary = await env.runtime.deliverPush({
      id: 'push-1',
      kind: 'turn-end',
      title: '会话标题',
      body: '摘要正文',
      sessionId: 's_1',
    });

    // self：一条 relay push.send（R1 行为不变，title/body/sessionId 原样）
    assert.equal(connector.intents.length, 1);
    assert.deepEqual(connector.intents[0], {
      id: 'push-1',
      kind: 'turn-end',
      title: '会话标题',
      body: '摘要正文',
      sessionId: 's_1',
    });

    // official：逐设备直连 hub
    assert.equal(hub.requests.length, 1);
    const request = hub.requests[0];
    assert.equal(request.url, `${HUB}${PUSH_SEND_PATH}`);
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.authorization, `Bearer ${CREDENTIAL}`);
    assert.match(String(request.headers['content-type']), /application\/json/);
    assert.deepEqual(request.body, { kind: 'turn-end', host: FQDN, token: OFFICIAL_TOKEN, sessionId: 's_1' });

    assert.deepEqual(summary, {
      self: { devices: 1, sent: 1 },
      official: { devices: 1, sent: 1, failed: 0, pruned: 0 },
    });
    assert.equal(env.runtime.status().push.official.lastError, null);
    assert.equal(env.runtime.status().push.self.lastError, null);
  } finally {
    await teardown(env);
  }
});

test('R2 分流：pushDetail=true 时 official 请求带 title/body；关闭时只带 kind/host/token', async () => {
  const hub = makeHubFetch();
  const env = await setupRuntime({ fetchImpl: hub.fetchImpl, pushDetail: true });
  try {
    assert.equal((await pushRequest(env, { body: officialBody() })).status, 200);
    await env.runtime.deliverPush({
      id: 'push-detail',
      kind: 'error',
      title: '清理缓存',
      body: '部署步骤超时',
      sessionId: 's_1',
    });
    assert.deepEqual(hub.requests[0].body, {
      kind: 'error', host: FQDN, token: OFFICIAL_TOKEN, title: '清理缓存', body: '部署步骤超时',
      sessionId: 's_1',
    });
    assert.equal(Object.hasOwn(hub.requests[0].body, 'content'), false);

    // 关闭时（默认）不发送 title/body，即使 deliverPush 收到了它们。
    const hub2 = makeHubFetch();
    const env2 = await setupRuntime({ fetchImpl: hub2.fetchImpl });
    try {
      assert.equal((await pushRequest(env2, { body: officialBody() })).status, 200);
      await env2.runtime.deliverPush({ id: 'x', kind: 'turn-end', title: 'T', body: 'B' });
      assert.deepEqual(hub2.requests[0].body, { kind: 'turn-end', host: FQDN, token: OFFICIAL_TOKEN });
    } finally {
      await teardown(env2);
    }
  } finally {
    await teardown(env);
  }
});

test('R2 分流：只有 official 设备时不向 relay 发 push.send；只有 self 设备时不请求 hub', async () => {
  // 只有 official
  const connector = fakeConnector();
  const hub = makeHubFetch();
  const officialEnv = await setupRuntime({ connector, fetchImpl: hub.fetchImpl });
  try {
    assert.equal((await pushRequest(officialEnv, { body: officialBody() })).status, 200);
    const summary = await officialEnv.runtime.deliverPush({ id: 'p1', kind: 'waiting-answer' });
    assert.equal(connector.intents.length, 0, '没有 self 设备时不能向 relay 发空意图');
    assert.equal(hub.requests.length, 1);
    assert.deepEqual(hub.requests[0].body, { kind: 'waiting-answer', host: FQDN, token: OFFICIAL_TOKEN });
    assert.deepEqual(summary.self, { devices: 0, sent: 0 });
  } finally {
    await teardown(officialEnv);
  }

  // 只有 self
  const connector2 = fakeConnector();
  const hub2 = makeHubFetch();
  const selfEnv = await setupRuntime({ connector: connector2, fetchImpl: hub2.fetchImpl });
  try {
    assert.equal((await pushRequest(selfEnv, { deviceId: SELF_DEVICE_ID, body: SELF_BODY })).status, 200);
    const summary = await selfEnv.runtime.deliverPush({ id: 'p2', kind: 'turn-end' });
    assert.equal(connector2.intents.length, 1);
    assert.equal(hub2.requests.length, 0, '没有 official 设备时不能请求 hub');
    assert.deepEqual(summary.official, { devices: 0, sent: 0, failed: 0, pruned: 0 });
  } finally {
    await teardown(selfEnv);
  }
});

test('R2 分流：hub 失败/429 不重试，写 official.lastError；self 仍正常发', async () => {
  const connector = fakeConnector();
  const hub = makeHubFetch(() => ({
    ok: false,
    status: 429,
    json: async () => ({ ok: false, error: { code: 'rate_limited', message: 'slow down' } }),
  }));
  const env = await setupRuntime({ connector, fetchImpl: hub.fetchImpl });
  try {
    assert.equal((await pushRequest(env, { deviceId: SELF_DEVICE_ID, body: SELF_BODY })).status, 200);
    assert.equal((await pushRequest(env, { body: officialBody() })).status, 200);
    const summary = await env.runtime.deliverPush({ id: 'p3', kind: 'turn-end' });
    assert.equal(hub.requests.length, 1, '失败不重试');
    assert.deepEqual(summary.self, { devices: 1, sent: 1 });
    assert.deepEqual(summary.official, { devices: 1, sent: 0, failed: 1, pruned: 0 });
    const push = env.runtime.status().push;
    assert.equal(push.self.lastError, null);
    assert.match(push.official.lastError, /rate_limited/);
    // 记录里仍保留该设备（失败不删 token，等 App 续期/重试）
    assert.equal(push.official.devices, 1);
  } finally {
    await teardown(env);
  }
});

test('R2 分流：hub 超时（10s 默认/测试注入更短）只记状态，不重试', async () => {
  const connector = fakeConnector();
  // 永不 resolve 的 fetch：验证 race 超时（不依赖 fetch 是否实现 AbortSignal）
  const fetchImpl = () => new Promise(() => {});
  const env = await setupRuntime({ connector, fetchImpl, hubTimeoutMs: 30 });
  try {
    assert.equal((await pushRequest(env, { body: officialBody() })).status, 200);
    const startedAt = Date.now();
    const summary = await env.runtime.deliverPush({ id: 'p4', kind: 'turn-end' });
    assert.ok(Date.now() - startedAt < 2000, '超时应快速返回');
    assert.deepEqual(summary.official, { devices: 1, sent: 0, failed: 1, pruned: 0 });
    assert.match(env.runtime.status().push.official.lastError, /timeout/);
  } finally {
    await teardown(env);
  }
});

test('R2 分流：hub 返回 pruned:[token] → 删除对应设备记录（App 需重新登记）', async () => {
  const connector = fakeConnector();
  const hub = makeHubFetch(() => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, delivered: 0, failed: 1, pruned: [OFFICIAL_TOKEN] }),
  }));
  const env = await setupRuntime({ connector, fetchImpl: hub.fetchImpl });
  try {
    assert.equal((await pushRequest(env, { body: officialBody() })).status, 200);
    assert.equal(env.runtime.status().push.official.devices, 1);
    const summary = await env.runtime.deliverPush({ id: 'p5', kind: 'turn-end' });
    assert.deepEqual(summary.official, { devices: 1, sent: 1, failed: 0, pruned: 1 });
    const push = env.runtime.status().push;
    assert.equal(push.detail, false);
    assert.equal(push.official.devices, 0);
    assert.equal(push.mode, '');
    assert.match(push.official.lastError, /token 已失效/);
    // hub 只发通用文案：body 里不能有 title/body/sessionId
    assert.deepEqual(Object.keys(hub.requests[0].body).sort(), ['host', 'kind', 'token']);
  } finally {
    await teardown(env);
  }
});

test('R2 分流：无设备时 deliverPush 不产生任何发送（relay/hub 都不碰）', async () => {
  const connector = fakeConnector();
  const hub = makeHubFetch();
  const env = await setupRuntime({ connector, fetchImpl: hub.fetchImpl });
  try {
    const summary = await env.runtime.deliverPush({ id: 'p6', kind: 'turn-end' });
    assert.deepEqual(summary, {
      self: { devices: 0, sent: 0 },
      official: { devices: 0, sent: 0, failed: 0, pruned: 0 },
    });
    assert.equal(connector.intents.length, 0);
    assert.equal(hub.requests.length, 0);
  } finally {
    await teardown(env);
  }
});
