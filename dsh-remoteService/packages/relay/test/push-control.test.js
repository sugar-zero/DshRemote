/**
 * 控制面推送往返（0.4.0，只有 self）：push.register / push.send 经已鉴权控制连接，
 * 以及 device.revoke / device.sync / admin revokeHost 后的 token 清理。
 *
 * 用 dev relay（控制面 ws） + 临时 group.json + 注入的假 APNs：
 *   - relay 用部署方自己的 APNs key 直连 Apple（测试注入发送器）；
 *   - R2 起官方 App 推送直连官方 hub，不经过 relay，本文件没有 official/hub 用例。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RELAY_MSG } from 'dsh-remote-protocol';
import { createInvite, createRelay, registerHost } from '../index.js';
import { ControlClient } from './helpers/control-client.js';
import { generateSelfSignedCert, silentLogger } from './helpers/certs.js';

const DEVICE_A = 'd_0000000001';
const ADMIN_TOKEN = 'test-admin-token-value-123456';
const TOKEN_A = 'a'.repeat(64);

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-relay-push-control-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 注册一台测试主机（写 group.json，relay 每次握手重读）。 */
function registerTestHost(file) {
  const invite = createInvite(file, { note: 'push control test', maxUses: 1 });
  return registerHost({ file, inviteCode: invite.code, hostName: 'Push Host' });
}

/** 合法 self 模式 push 配置。 */
function selfPush(overrides = {}) {
  return {
    enabled: true,
    mode: 'self',
    content: 'generic',
    cooldownSeconds: 0,
    self: {
      keyFile: '/data/apns/AuthKey_TESTKEYID1.p8',
      keyId: 'TESTKEYID1',
      teamId: 'TESTTEAMID',
      topic: 'com.example.app',
      environment: 'auto',
    },
    ...overrides,
  };
}

/** 假 APNs 发送器：默认全部成功。 */
function fakeApns(handler) {
  const calls = [];
  return {
    calls,
    isConfigured: () => true,
    async sendToTokens(entries, message) {
      calls.push({ entries: entries.map((entry) => ({ ...entry })), message: message ? { ...message } : {} });
      if (handler) return handler(entries, message);
      return { delivered: entries.length, failed: 0, pruned: [], configErrors: [], errors: [] };
    },
  };
}

/**
 * 起 relay（dev；控制面 ws）。
 * @param {{push?: Record<string, any>, relay?: Record<string, any>, pushClients?: Record<string, any>,
 *   adminToken?: string, edge?: boolean}} [options] edge=true 时额外起边缘 TLS（device.sync 需要 groupAuth）
 */
async function startPushRelay(options = {}) {
  const temp = tempDir();
  const file = join(temp.dir, 'group.json');
  /** @type {{cleanup: () => void} | undefined} */
  let cert;
  const edge = { enabled: false };
  if (options.edge === true) {
    cert = generateSelfSignedCert({ commonName: '*.relay.test', sans: ['relay.test', '*.relay.test'] });
    Object.assign(edge, {
      enabled: true,
      port: 0,
      tls: { cert: cert.cert, key: cert.key },
      allowUnauthenticated: true,
    });
  }
  const relay = await createRelay({
    domain: 'relay.test',
    controlPort: 0,
    httpPort: 0,
    listenHost: '127.0.0.1',
    dev: true,
    logger: silentLogger,
    group: {
      file,
      edge,
      adminToken: options.adminToken,
      push: options.push ?? selfPush(),
    },
    pushClients: options.pushClients,
    heartbeatIntervalMs: 30_000,
    heartbeatTimeoutMs: 60_000,
    ...(options.relay ?? {}),
  });
  return {
    relay,
    file,
    temp,
    async cleanup() {
      await relay.close();
      cert?.cleanup();
      temp.cleanup();
    },
  };
}

/** 连接控制面并完成 host.hello。 */
async function connectHost(relay, host) {
  const client = await ControlClient.connect(`ws://127.0.0.1:${relay.controlPort}/control`);
  client.sendJson({ t: RELAY_MSG.HOST_HELLO, protocolVersion: 1, hostId: host.hostId, token: host.hostToken, hostName: 'Push Host' });
  const ready = await client.nextJson();
  assert.equal(ready.t, RELAY_MSG.HOST_READY);
  return client;
}

/** 等下一条指定类型的控制消息（跳过心跳）。 */
async function nextMessage(client, type, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msg = await client.nextJson(Math.max(1, deadline - Date.now()));
    if (!msg) throw new Error('control connection closed unexpectedly');
    if (msg.t === type) return msg;
  }
  throw new Error(`timed out waiting for control message ${type}`);
}

/** GET /healthz（不经过 DNS，直接打 httpPort）。 */
async function getHealthz(relay) {
  const response = await fetch(`http://127.0.0.1:${relay.httpPort}/healthz`);
  assert.equal(response.status, 200);
  return response.json();
}

/** 注册一个 APNs device token（经控制连接，返回 push.registered）。 */
async function registerToken(client, overrides = {}) {
  client.sendJson({
    t: RELAY_MSG.PUSH_REGISTER,
    deviceId: DEVICE_A,
    provider: 'apns',
    token: TOKEN_A,
    environment: 'development',
    ...overrides,
  });
  return nextMessage(client, RELAY_MSG.PUSH_REGISTERED);
}

// ---------------------------------------------------------------------------
// self 模式往返
// ---------------------------------------------------------------------------

test('push.register / push.send 往返，/healthz 带推送摘要且不含 token', async () => {
  const apns = fakeApns();
  const context = await startPushRelay({ pushClients: { apnsClient: apns } });
  const host = registerTestHost(context.file);
  const client = await connectHost(context.relay, host);
  try {
    const registered = await registerToken(client);
    assert.deepEqual(registered, {
      t: RELAY_MSG.PUSH_REGISTERED,
      ok: true,
      deviceId: DEVICE_A,
      mode: 'self',
      enabled: true,
    });

    const health = await getHealthz(context.relay);
    assert.deepEqual(health.push, { enabled: true, mode: 'self', tokens: 1 });
    assert.ok(!JSON.stringify(health).includes(TOKEN_A), '/healthz 不得泄露 device token');

    client.sendJson({
      t: RELAY_MSG.PUSH_SEND,
      id: 'intent-1',
      kind: 'turn-end',
      title: '会话标题',
      body: '摘要',
      sessionId: 'sess-1',
    });
    const result = await nextMessage(client, RELAY_MSG.PUSH_RESULT);
    assert.equal(result.id, 'intent-1');
    assert.equal(result.ok, true);
    assert.equal(result.delivered, 1);
    assert.equal(result.failed, 0);
    assert.deepEqual(result.pruned, []);
    assert.equal(result.mode, 'self');
    assert.equal(result.skipped, undefined);

    assert.equal(apns.calls.length, 1);
    assert.equal(apns.calls[0].entries.length, 1);
    assert.equal(apns.calls[0].entries[0].token, TOKEN_A);
    assert.equal(apns.calls[0].message.title, 'DSH', 'generic 模式用固定文案');
    assert.equal(apns.calls[0].message.body, '任务已完成');
  } finally {
    client.close();
    await context.cleanup();
  }
});

test('push.send：没有设备 token 时返回 skipped=no-tokens（ok:true，host 不重试）', async () => {
  const apns = fakeApns();
  const context = await startPushRelay({ pushClients: { apnsClient: apns } });
  const host = registerTestHost(context.file);
  const client = await connectHost(context.relay, host);
  try {
    client.sendJson({ t: RELAY_MSG.PUSH_SEND, id: 'intent-empty', kind: 'turn-end' });
    const result = await nextMessage(client, RELAY_MSG.PUSH_RESULT);
    assert.equal(result.ok, true);
    assert.equal(result.skipped, 'no-tokens');
    assert.equal(apns.calls.length, 0);
  } finally {
    client.close();
    await context.cleanup();
  }
});

test('push.send：APNs 失效 token（410）→ push.result.pruned 且 token 从摘要里消失', async () => {
  const apns = fakeApns(() => ({
    delivered: 0,
    failed: 1,
    pruned: [{ deviceId: DEVICE_A, token: TOKEN_A }],
    configErrors: [],
    errors: [],
  }));
  const context = await startPushRelay({ pushClients: { apnsClient: apns } });
  const host = registerTestHost(context.file);
  const client = await connectHost(context.relay, host);
  try {
    await registerToken(client);
    client.sendJson({ t: RELAY_MSG.PUSH_SEND, id: 'intent-prune', kind: 'turn-end' });
    const result = await nextMessage(client, RELAY_MSG.PUSH_RESULT);
    assert.equal(result.ok, true);
    assert.deepEqual(result.pruned, [DEVICE_A]);
    assert.deepEqual((await getHealthz(context.relay)).push, { enabled: true, mode: 'self', tokens: 0 });
  } finally {
    client.close();
    await context.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 撤销 / 同步清 token
// ---------------------------------------------------------------------------

test('device.revoke 后该设备推送 token 立即失效（后续 push.send 为 no-tokens）', async () => {
  const apns = fakeApns();
  const context = await startPushRelay({ pushClients: { apnsClient: apns } });
  const host = registerTestHost(context.file);
  const client = await connectHost(context.relay, host);
  try {
    await registerToken(client);
    assert.equal((await getHealthz(context.relay)).push.tokens, 1);

    client.sendJson({ t: RELAY_MSG.DEVICE_REVOKE, deviceId: DEVICE_A });
    const revoked = await nextMessage(client, RELAY_MSG.DEVICE_REVOKED);
    assert.equal(revoked.deviceId, DEVICE_A);
    assert.deepEqual((await getHealthz(context.relay)).push, { enabled: true, mode: 'self', tokens: 0 });

    client.sendJson({ t: RELAY_MSG.PUSH_SEND, id: 'intent-after-revoke', kind: 'turn-end' });
    const result = await nextMessage(client, RELAY_MSG.PUSH_RESULT);
    assert.equal(result.skipped, 'no-tokens');
    assert.equal(apns.calls.length, 0);
  } finally {
    client.close();
    await context.cleanup();
  }
});

test('device.sync 全量覆盖后，不在册设备的推送 token 被清理', async () => {
  const apns = fakeApns();
  // device.sync 需要 groupAuth（仅在启用边缘平面时创建）→ 这里额外起边缘 TLS（dev/未认证）。
  const context = await startPushRelay({ pushClients: { apnsClient: apns }, edge: true });
  const host = registerTestHost(context.file);
  const client = await connectHost(context.relay, host);
  try {
    await registerToken(client);
    assert.equal((await getHealthz(context.relay)).push.tokens, 1);

    client.sendJson({ t: RELAY_MSG.DEVICE_SYNC, devices: [] });
    const synced = await nextMessage(client, RELAY_MSG.DEVICE_SYNCED);
    assert.equal(synced.ok, true);
    assert.deepEqual((await getHealthz(context.relay)).push, { enabled: true, mode: 'self', tokens: 0 });
  } finally {
    client.close();
    await context.cleanup();
  }
});

test('admin 撤销主机后推送 token 清空（后台 /state 也带摘要）', async () => {
  const apns = fakeApns();
  const context = await startPushRelay({ pushClients: { apnsClient: apns }, adminToken: ADMIN_TOKEN });
  const host = registerTestHost(context.file);
  const client = await connectHost(context.relay, host);
  try {
    await registerToken(client);

    const state = await fetch(`http://127.0.0.1:${context.relay.controlPort}/__admin/api/state`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    assert.equal(state.status, 200);
    const stateJson = await state.json();
    assert.deepEqual(stateJson.data.push, { enabled: true, mode: 'self', tokens: 1 });

    const revoke = await fetch(
      `http://127.0.0.1:${context.relay.controlPort}/__admin/api/hosts/${host.hostId}/revoke`,
      { method: 'POST', headers: { authorization: `Bearer ${ADMIN_TOKEN}` } },
    );
    assert.equal(revoke.status, 200);
    assert.equal((await revoke.json()).data.revoked, true);
    assert.deepEqual((await getHealthz(context.relay)).push, { enabled: true, mode: 'self', tokens: 0 });
  } finally {
    client.close();
    await context.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 鉴权 / 降级
// ---------------------------------------------------------------------------

test('未完成 host.hello 的连接不能 push（push.send 被拒绝，APNs 不被调用）', async () => {
  const apns = fakeApns();
  const context = await startPushRelay({ pushClients: { apnsClient: apns } });
  try {
    const client = await ControlClient.connect(`ws://127.0.0.1:${context.relay.controlPort}/control`);
    client.sendJson({ t: RELAY_MSG.PUSH_SEND, id: 'intent-anon', kind: 'turn-end' });
    const error = await client.nextJson();
    assert.equal(error.t, RELAY_MSG.ERROR);
    assert.equal(error.code, 'expected_hello');
    await client.waitClose();
    assert.equal(apns.calls.length, 0);
  } finally {
    await context.cleanup();
  }
});

test('relay 未开推送：register 回 push_disabled，send 回 skipped=push_disabled', async () => {
  const apns = fakeApns();
  const context = await startPushRelay({
    push: selfPush({ enabled: false }),
    pushClients: { apnsClient: apns },
  });
  const host = registerTestHost(context.file);
  const client = await connectHost(context.relay, host);
  try {
    const registered = await registerToken(client);
    assert.equal(registered.ok, false);
    assert.equal(registered.code, 'push_disabled');

    client.sendJson({ t: RELAY_MSG.PUSH_SEND, id: 'intent-disabled', kind: 'turn-end' });
    const result = await nextMessage(client, RELAY_MSG.PUSH_RESULT);
    assert.equal(result.ok, true);
    assert.equal(result.skipped, 'push_disabled');
    assert.equal(apns.calls.length, 0);
    assert.deepEqual((await getHealthz(context.relay)).push, { enabled: false, mode: 'self', tokens: 0 });
  } finally {
    client.close();
    await context.cleanup();
  }
});
