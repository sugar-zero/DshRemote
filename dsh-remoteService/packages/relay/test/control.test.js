/**
 * 控制面 WSS（主机出站隧道）：host.hello 鉴权（group.json 注册 token）、握手超时、
 * 心跳、同 hostId 替换、生产 wss。
 *
 * 0.3.0 起 relay 只服务群体版：主机必须先凭邀请码注册（createInvite + registerHost），
 * classic 的 tokens.json / hostTokens 已删除。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createInvite, createRelay, registerHost, revokeHost, startRelay } from '../index.js';
import { ControlClient } from './helpers/control-client.js';
import { generateSelfSignedCert, silentLogger } from './helpers/certs.js';

function tempGroup() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-relay-control-'));
  const file = join(dir, 'group.json');
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * 注册一台测试主机（写 group.json，relay 每次握手重读）。
 * @param {string} file
 * @param {string} [hostName]
 */
function registerTestHost(file, hostName = 'Test Host') {
  const invite = createInvite(file, { note: 'control test', maxUses: 1 });
  return registerHost({ file, inviteCode: invite.code, hostName });
}

/** @param {string} file @param {Record<string, any>} [overrides] */
function baseOptions(file, overrides = {}) {
  return {
    domain: 'relay.test',
    controlPort: 0,
    httpPort: 0,
    listenHost: '127.0.0.1',
    dev: true,
    logger: silentLogger,
    group: { file, edge: { enabled: false } },
    ...overrides,
  };
}

test('refuses to start without TLS outside dev mode', async () => {
  const temp = tempGroup();
  try {
    await assert.rejects(
      createRelay({
        domain: 'relay.test',
        controlPort: 0,
        httpPort: 0,
        listenHost: '127.0.0.1',
        logger: silentLogger,
        group: { file: temp.file, edge: { enabled: false } },
      }),
      /refusing to start relay without TLS/,
    );
  } finally {
    temp.cleanup();
  }
});

test('rejects host.hello with a bad token, then accepts the registered token', async () => {
  const temp = tempGroup();
  const host = registerTestHost(temp.file);
  const relay = await createRelay(baseOptions(temp.file));
  try {
    const bad = await ControlClient.connect(`ws://127.0.0.1:${relay.controlPort}/control`);
    bad.sendJson({ t: 'host.hello', protocolVersion: 1, hostId: host.hostId, token: 'wrong-token', hostName: 'bad' });
    const errorMsg = await bad.nextJson();
    assert.equal(errorMsg.t, 'error');
    assert.equal(errorMsg.code, 'unauthorized');
    assert.deepEqual(await bad.waitClose(), { code: 1008, reason: 'unauthorized' });
    assert.deepEqual(relay.onlineHostIds(), [], 'failed auth must not register the host');

    const good = await ControlClient.connect(`ws://127.0.0.1:${relay.controlPort}/control`);
    good.sendJson({ t: 'host.hello', protocolVersion: 1, hostId: host.hostId, token: host.hostToken, hostName: 'Test Mac' });
    const ready = await good.nextJson();
    assert.equal(ready.t, 'host.ready');
    assert.equal(ready.protocolVersion, 1);
    assert.equal(ready.hostId, host.hostId);
    assert.equal(ready.domain, 'relay.test');
    assert.equal(ready.hostname, `${host.hostId}.relay.test`);
    assert.equal(ready.dataPort, undefined, 'classic dataPort must no longer be advertised');
    assert.deepEqual(relay.onlineHostIds(), [host.hostId]);
    assert.deepEqual(relay.health(), {
      ok: true,
      domain: 'relay.test',
      hosts: [host.hostId],
      // 0.3.1 起 /healthz（及 health()）带服务端推送摘要；未配置推送时 enabled=false。
      push: { enabled: false, mode: 'self', tokens: 0 },
    });
    good.close();
  } finally {
    await relay.close();
    temp.cleanup();
  }
});

test('rejects unknown hostId, wrong protocol version and wrong websocket path', async () => {
  const temp = tempGroup();
  const host = registerTestHost(temp.file);
  const relay = await createRelay(baseOptions(temp.file));
  try {
    const unknownHost = await ControlClient.connect(`ws://127.0.0.1:${relay.controlPort}/control`);
    unknownHost.sendJson({ t: 'host.hello', protocolVersion: 1, hostId: 'h_nope', token: host.hostToken });
    const unknownError = await unknownHost.nextJson();
    assert.equal(unknownError.t, 'error');
    assert.equal(unknownError.code, 'unauthorized');
    await unknownHost.waitClose();

    const badVersion = await ControlClient.connect(`ws://127.0.0.1:${relay.controlPort}/control`);
    badVersion.sendJson({ t: 'host.hello', protocolVersion: 99, hostId: host.hostId, token: host.hostToken });
    const versionError = await badVersion.nextJson();
    assert.equal(versionError.t, 'error');
    assert.equal(versionError.code, 'unsupported_protocol_version');
    await badVersion.waitClose();

    await assert.rejects(
      ControlClient.connect(`ws://127.0.0.1:${relay.controlPort}/not-control`),
      /unexpected HTTP response 404/,
    );
  } finally {
    await relay.close();
    temp.cleanup();
  }
});

test('a new control connection replaces the old one for the same hostId', async () => {
  const temp = tempGroup();
  const host = registerTestHost(temp.file);
  const relay = await createRelay(baseOptions(temp.file));
  try {
    const first = await ControlClient.connect(`ws://127.0.0.1:${relay.controlPort}/control`);
    first.sendJson({ t: 'host.hello', protocolVersion: 1, hostId: host.hostId, token: host.hostToken });
    assert.equal((await first.nextJson()).t, 'host.ready');

    const second = await ControlClient.connect(`ws://127.0.0.1:${relay.controlPort}/control`);
    second.sendJson({ t: 'host.hello', protocolVersion: 1, hostId: host.hostId, token: host.hostToken });
    assert.equal((await second.nextJson()).t, 'host.ready');

    const replacement = await first.nextJson();
    assert.equal(replacement.t, 'error');
    assert.equal(replacement.code, 'replaced');
    const closed = await first.waitClose();
    assert.equal(closed.code, 4001);
    assert.deepEqual(relay.onlineHostIds(), [host.hostId], 'hostId stays registered exactly once');
    second.close();
  } finally {
    await relay.close();
    temp.cleanup();
  }
});

test('drops a host that stops answering heartbeats', async () => {
  const temp = tempGroup();
  const host = registerTestHost(temp.file);
  const relay = await createRelay(baseOptions(temp.file, {
    heartbeatIntervalMs: 50,
    heartbeatTimeoutMs: 150,
  }));
  try {
    const client = await ControlClient.connect(`ws://127.0.0.1:${relay.controlPort}/control`);
    client.sendJson({ t: 'host.hello', protocolVersion: 1, hostId: host.hostId, token: host.hostToken });
    assert.equal((await client.nextJson()).t, 'host.ready');

    const heartbeat = await client.nextJson(2000);
    assert.equal(heartbeat?.t, 'host.heartbeat');

    const closed = await client.waitClose(3000);
    assert.equal(closed.code, 4002, 'silent host is dropped with heartbeat-timeout close code');
    assert.deepEqual(relay.onlineHostIds(), []);
  } finally {
    await relay.close();
    temp.cleanup();
  }
});

test('group.json is re-read on every host.hello (register/revoke takes effect without restart)', async () => {
  const temp = tempGroup();
  const relay = await createRelay(baseOptions(temp.file));
  try {
    // relay 启动后注册（邀请码 → hostToken 写盘即生效）
    const registered = registerTestHost(temp.file, 'Late Host');
    const client = await ControlClient.connect(`ws://127.0.0.1:${relay.controlPort}/control`);
    client.sendJson({ t: 'host.hello', protocolVersion: 1, hostId: registered.hostId, token: registered.hostToken });
    const ready = await client.nextJson();
    assert.equal(ready.t, 'host.ready');
    assert.equal(ready.hostId, registered.hostId);
    client.close();
    await client.waitClose();

    // 撤销后同一个 token 立即被拒绝（下一次握手重读 group.json）
    assert.equal(revokeHost(temp.file, registered.hostId), true);
    const rejected = await ControlClient.connect(`ws://127.0.0.1:${relay.controlPort}/control`);
    rejected.sendJson({ t: 'host.hello', protocolVersion: 1, hostId: registered.hostId, token: registered.hostToken });
    const errorMsg = await rejected.nextJson();
    assert.equal(errorMsg.code, 'unauthorized');
    await rejected.waitClose();
  } finally {
    await relay.close();
    temp.cleanup();
  }
});

test('production mode serves the control plane over wss (TLS terminated by relay)', async () => {
  const temp = tempGroup();
  const host = registerTestHost(temp.file);
  const credentials = generateSelfSignedCert({ commonName: 'relay.test', sans: ['relay.test'] });
  // startRelay 是 CLI/config 入口的语义：生产（非 dev）必须提供 TLS 材料。
  const relay = await startRelay({
    domain: 'relay.test',
    controlPort: 0,
    httpPort: 0,
    listenHost: '127.0.0.1',
    tls: { cert: credentials.cert, key: credentials.key },
    logger: silentLogger,
    group: { file: temp.file, edge: { enabled: false } },
  });
  try {
    assert.equal(relay.dev, false);
    // wss 自签证书：客户端显式关闭校验（生产是 LE 证书 + 正常校验）
    const client = await ControlClient.connect(
      `wss://127.0.0.1:${relay.controlPort}/control`,
      { rejectUnauthorized: false },
    );
    client.sendJson({ t: 'host.hello', protocolVersion: 1, hostId: host.hostId, token: host.hostToken });
    const ready = await client.nextJson();
    assert.equal(ready.t, 'host.ready');
    assert.deepEqual(relay.onlineHostIds(), [host.hostId]);
    client.close();
  } finally {
    await relay.close();
    credentials.cleanup();
    temp.cleanup();
  }
});
