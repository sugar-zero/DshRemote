import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRelay, createHostToken, revokeHostToken, startRelay } from '../index.js';
import { ControlClient } from './helpers/control-client.js';
import { generateSelfSignedCert, silentLogger } from './helpers/certs.js';

/** @param {Record<string, any>} [overrides] */
function baseOptions(overrides = {}) {
  return {
    domain: 'relay.test',
    dataPort: 0,
    controlPort: 0,
    httpPort: 0,
    dataHost: '127.0.0.1',
    dev: true,
    logger: silentLogger,
    ...overrides,
  };
}

test('refuses to start without TLS outside dev mode', async () => {
  await assert.rejects(
    createRelay({
      domain: 'relay.test',
      dataPort: 0,
      controlPort: 0,
      httpPort: 0,
      dataHost: '127.0.0.1',
      hostTokens: { poc: 'token' },
      logger: silentLogger,
    }),
    /refusing to start relay without TLS/,
  );
});

test('rejects host.hello with a bad token, then accepts the right token', async () => {
  const relay = await createRelay(baseOptions({ hostTokens: { poc: 'right-token' } }));
  try {
    const bad = await ControlClient.connect(`ws://127.0.0.1:${relay.controlPort}/control`);
    bad.sendJson({ t: 'host.hello', protocolVersion: 1, hostId: 'poc', token: 'wrong-token', hostName: 'bad' });
    const errorMsg = await bad.nextJson();
    assert.equal(errorMsg.t, 'error');
    assert.equal(errorMsg.code, 'unauthorized');
    assert.deepEqual(await bad.waitClose(), { code: 1008, reason: 'unauthorized' });
    assert.deepEqual(relay.onlineHostIds(), [], 'failed auth must not register the host');

    const good = await ControlClient.connect(`ws://127.0.0.1:${relay.controlPort}/control`);
    good.sendJson({ t: 'host.hello', protocolVersion: 1, hostId: 'poc', token: 'right-token', hostName: 'Test Mac' });
    const ready = await good.nextJson();
    assert.equal(ready.t, 'host.ready');
    assert.equal(ready.protocolVersion, 1);
    assert.equal(ready.hostId, 'poc');
    assert.equal(ready.domain, 'relay.test');
    assert.equal(ready.hostname, 'poc.relay.test');
    assert.equal(ready.dataPort, relay.dataPort);
    assert.deepEqual(relay.onlineHostIds(), ['poc']);
    assert.deepEqual(relay.health(), { ok: true, domain: 'relay.test', hosts: ['poc'] });
    good.close();
  } finally {
    await relay.close();
  }
});

test('rejects unknown hostId, wrong protocol version and wrong websocket path', async () => {
  const relay = await createRelay(baseOptions({ hostTokens: { poc: 'right-token' } }));
  try {
    const unknownHost = await ControlClient.connect(`ws://127.0.0.1:${relay.controlPort}/control`);
    unknownHost.sendJson({ t: 'host.hello', protocolVersion: 1, hostId: 'nope', token: 'right-token' });
    const unknownError = await unknownHost.nextJson();
    assert.equal(unknownError.t, 'error');
    assert.equal(unknownError.code, 'unauthorized');
    await unknownHost.waitClose();

    const badVersion = await ControlClient.connect(`ws://127.0.0.1:${relay.controlPort}/control`);
    badVersion.sendJson({ t: 'host.hello', protocolVersion: 99, hostId: 'poc', token: 'right-token' });
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
  }
});

test('a new control connection replaces the old one for the same hostId', async () => {
  const relay = await createRelay(baseOptions({ hostTokens: { poc: 'right-token' } }));
  try {
    const first = await ControlClient.connect(`ws://127.0.0.1:${relay.controlPort}/control`);
    first.sendJson({ t: 'host.hello', protocolVersion: 1, hostId: 'poc', token: 'right-token' });
    assert.equal((await first.nextJson()).t, 'host.ready');

    const second = await ControlClient.connect(`ws://127.0.0.1:${relay.controlPort}/control`);
    second.sendJson({ t: 'host.hello', protocolVersion: 1, hostId: 'poc', token: 'right-token' });
    assert.equal((await second.nextJson()).t, 'host.ready');

    const replacement = await first.nextJson();
    assert.equal(replacement.t, 'error');
    assert.equal(replacement.code, 'replaced');
    const closed = await first.waitClose();
    assert.equal(closed.code, 4001);
    assert.deepEqual(relay.onlineHostIds(), ['poc'], 'hostId stays registered exactly once');
    second.close();
  } finally {
    await relay.close();
  }
});

test('drops a host that stops answering heartbeats', async () => {
  const relay = await createRelay(baseOptions({
    hostTokens: { poc: 'right-token' },
    heartbeatIntervalMs: 50,
    heartbeatTimeoutMs: 150,
  }));
  try {
    const client = await ControlClient.connect(`ws://127.0.0.1:${relay.controlPort}/control`);
    client.sendJson({ t: 'host.hello', protocolVersion: 1, hostId: 'poc', token: 'right-token' });
    assert.equal((await client.nextJson()).t, 'host.ready');

    const heartbeat = await client.nextJson(2000);
    assert.equal(heartbeat?.t, 'host.heartbeat');

    const closed = await client.waitClose(3000);
    assert.equal(closed.code, 4002, 'silent host is dropped with heartbeat-timeout close code');
    assert.deepEqual(relay.onlineHostIds(), []);
  } finally {
    await relay.close();
  }
});

test('tokensFile is re-read on every host.hello (CLI create/revoke takes effect without restart)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-relay-tokens-'));
  const tokensFile = join(dir, 'tokens.json');
  const relay = await createRelay(baseOptions({ tokensFile }));
  try {
    const created = createHostToken(tokensFile, 'h_file');

    const client = await ControlClient.connect(`ws://127.0.0.1:${relay.controlPort}/control`);
    client.sendJson({ t: 'host.hello', protocolVersion: 1, hostId: created.hostId, token: created.token });
    const ready = await client.nextJson();
    assert.equal(ready.t, 'host.ready');
    assert.equal(ready.hostId, 'h_file');
    client.close();
    await client.waitClose();

    assert.equal(revokeHostToken(tokensFile, 'h_file'), true);
    const rejected = await ControlClient.connect(`ws://127.0.0.1:${relay.controlPort}/control`);
    rejected.sendJson({ t: 'host.hello', protocolVersion: 1, hostId: 'h_file', token: created.token });
    const errorMsg = await rejected.nextJson();
    assert.equal(errorMsg.code, 'unauthorized');
    await rejected.waitClose();
  } finally {
    await relay.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('production mode serves the control plane over wss (TLS terminated by relay)', async () => {
  const credentials = generateSelfSignedCert({ commonName: 'relay.test', sans: ['relay.test'] });
  // startRelay 是 CLI/config 入口的语义：生产（非 dev）必须提供 TLS 材料。
  const relay = await startRelay({
    domain: 'relay.test',
    dataPort: 0,
    controlPort: 0,
    httpPort: 0,
    dataHost: '127.0.0.1',
    hostTokens: { poc: 'right-token' },
    tls: { cert: credentials.cert, key: credentials.key },
    logger: silentLogger,
  });
  try {
    assert.equal(relay.dev, false);
    // wss 自签证书：客户端显式关闭校验（生产是 LE 证书 + 正常校验）
    const client = await ControlClient.connect(
      `wss://127.0.0.1:${relay.controlPort}/control`,
      { rejectUnauthorized: false },
    );
    client.sendJson({ t: 'host.hello', protocolVersion: 1, hostId: 'poc', token: 'right-token' });
    const ready = await client.nextJson();
    assert.equal(ready.t, 'host.ready');
    assert.deepEqual(relay.onlineHostIds(), ['poc']);
    client.close();
  } finally {
    await relay.close();
    credentials.cleanup();
  }
});
