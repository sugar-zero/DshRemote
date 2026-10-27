/**
 * 群体服务版（A 模式）P1 切片 2：边缘 TLS 终止 + 出站隧道。
 *
 * 覆盖：边缘 TLS 通配证书握手、SNI→hostId 路由、离线主机拒绝、未认证模式 dev-only、
 * 控制面隧道 stream（host.open/host.opened + 二进制帧）、大帧传输不阻塞心跳、优雅关闭。
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import tls from 'node:tls';
import {
  CONTROL_PATH,
  FRAME_TYPE,
  GROUP_EDGE_STREAM_KIND,
  RELAY_MSG,
  decodeFrame,
  encodeFrame,
} from 'dsh-remote-protocol';
import { createInvite, createRelay, registerHost } from '../index.js';
import { ControlClient } from './helpers/control-client.js';
import { generateSelfSignedCert, silentLogger } from './helpers/certs.js';

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-relay-tunnel-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * 起一个 group 模式 + 边缘 TLS 的 relay（dev/未认证；仅供测试）。
 * @param {{group?: Record<string, any>, relay?: Record<string, any>}} [overrides]
 */
async function startEdgeRelay(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-relay-tunnel-'));
  const cert = generateSelfSignedCert({
    commonName: '*.relay.test',
    sans: ['relay.test', '*.relay.test', 'other.test'],
  });
  const file = join(dir, 'group.json');
  const groupOverrides = { ...(overrides.group ?? {}) };
  const edgeOverrides = groupOverrides.edge ?? {};
  delete groupOverrides.edge;
  const group = {
    file,
    mobilePort: 11443,
    maxHosts: 50,
    registration: {
      enabled: true,
      maxAttemptsPerMinutePerIp: 20,
      maxAttemptsPerMinute: 200,
      bodyLimitBytes: 8192,
    },
    edge: {
      enabled: true,
      port: 0,
      tls: { cert: cert.cert, key: cert.key },
      allowUnauthenticated: true,
      ...edgeOverrides,
    },
    ...groupOverrides,
  };
  const relay = await createRelay({
    domain: 'relay.test',
    dataPort: 0,
    controlPort: 0,
    httpPort: 0,
    dataHost: '127.0.0.1',
    dev: true,
    logger: silentLogger,
    mode: 'group',
    group,
    handshakeTimeoutMs: 3000,
    heartbeatIntervalMs: 20,
    heartbeatTimeoutMs: 300,
    openTimeoutMs: 3000,
    ...(overrides.relay ?? {}),
  });
  return {
    relay,
    file,
    cert,
    async cleanup() {
      await relay.close();
      cert.cleanup();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * 假主机：连接控制面，回 host.opened，并把 DATA 帧原样回显（用于隧道压测）。
 * @param {{controlPort: number}} relay
 * @param {string} hostId
 * @param {string} token
 */
async function startEchoHost(relay, hostId, token) {
  const client = await ControlClient.connect(`ws://127.0.0.1:${relay.controlPort}${CONTROL_PATH}`);
  client.sendJson({ t: RELAY_MSG.HOST_HELLO, protocolVersion: 1, hostId, token, hostName: 'Echo Host' });
  const ready = await client.nextJson();
  assert.equal(ready.t, RELAY_MSG.HOST_READY, 'fake host must authenticate against the group store');

  const seen = { opens: 0, kinds: new Set() };
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const item = await client.nextRaw(2000);
      if (!item) break;
      if (item.isBinary) {
        const frame = decodeFrame(item.data);
        if (!frame) continue;
        if (frame.type === FRAME_TYPE.DATA) {
          client.ws.send(encodeFrame(FRAME_TYPE.DATA, frame.streamId, frame.payload), { binary: true });
        }
        continue;
      }
      const msg = JSON.parse(item.data.toString('utf8'));
      if (msg.t === RELAY_MSG.HOST_OPEN) {
        seen.opens += 1;
        seen.kinds.add(msg.kind);
        client.sendJson({ t: RELAY_MSG.HOST_OPENED, streamId: msg.streamId });
      }
      // host.close / host.heartbeat 忽略
    }
  })();

  // 模拟真实主机：只要隧道在传数据，就持续给 relay 喂心跳（证明大帧不会阻塞控制面）。
  const heartbeat = setInterval(() => {
    if (!stopped) client.sendJson({ t: RELAY_MSG.HOST_HEARTBEAT, ts: Date.now() });
  }, 10);
  heartbeat.unref?.();

  return {
    client,
    seen,
    loop,
    stop() {
      stopped = true;
      clearInterval(heartbeat);
      client.close();
    },
  };
}

/** 边缘 TLS 客户端：发 payload，等回显。 */
function edgeEcho({ port, servername, ca, payload, timeoutMs = 15_000 }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      { host: '127.0.0.1', port, servername, ca, rejectUnauthorized: true },
      () => {
        const chunks = [];
        let received = 0;
        socket.on('data', (chunk) => {
          chunks.push(chunk);
          received += chunk.length;
          if (received >= payload.length) {
            const echoed = Buffer.concat(chunks).subarray(0, payload.length);
            socket.end();
            resolve(echoed);
          }
        });
        socket.on('error', reject);
        socket.write(payload);
      },
    );
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('timed out waiting for edge echo'));
    }, timeoutMs);
    timer.unref?.();
    socket.once('close', () => clearTimeout(timer));
  });
}

/** 构造一段带合法 HTTP 请求头的探测 payload（relay 边缘会先解析头，再原样转发给主机）。 */
function httpProbe(body) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  const head = Buffer.from('GET /probe HTTP/1.1\r\nHost: relay.test\r\nConnection: close\r\n\r\n', 'utf8');
  return Buffer.concat([head, payload]);
}

/** 边缘 TLS 客户端：读一段 HTTP 响应文本（用于错误路径断言）。 */
function edgeHttp(port, servername, ca) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      { host: '127.0.0.1', port, servername, ca, rejectUnauthorized: true },
      () => socket.write('GET / HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n'),
    );
    let text = '';
    socket.on('data', (chunk) => {
      text += chunk.toString('utf8');
    });
    socket.on('error', reject);
    socket.on('close', () => resolve(text));
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('timed out waiting for edge http response'));
    }, 5000);
    timer.unref?.();
    socket.once('close', () => clearTimeout(timer));
  });
}

test('config: edge requires TLS and unauthenticated edge is dev-only', async () => {
  const base = { domain: 'relay.test', dataPort: 0, controlPort: 0, httpPort: 0, dataHost: '127.0.0.1', logger: silentLogger };
  const cert = generateSelfSignedCert({ commonName: '*.relay.test', sans: ['*.relay.test'] });
  try {
    const file = join(tmpdir(), `dsh-edge-config-${process.pid}.json`);
    await assert.rejects(
      createRelay({ ...base, dev: true, mode: 'group', group: { file, edge: { enabled: true, port: 0 } } }),
      /edge requires TLS/,
    );
    await assert.rejects(
      createRelay({
        ...base,
        dev: false,
        tls: { cert: cert.cert, key: cert.key },
        mode: 'group',
        group: { file, edge: { enabled: true, port: 0, tls: { cert: cert.cert, key: cert.key }, allowUnauthenticated: true } },
      }),
      /allowUnauthenticated is dev-only/,
    );
  } finally {
    cert.cleanup();
  }
});

test('edge TLS → 隧道：小消息 + 8MB 大帧回显，期间心跳不断（主机不被踢）', async () => {
  const context = await startEdgeRelay();
  const host = { id: '' };
  let fakeHost;
  try {
    const invite = createInvite(context.file, { note: 'tunnel test', maxUses: 1 });
    const registration = registerHost({ file: context.file, inviteCode: invite.code, hostName: 'Tunnel Host' });
    host.id = registration.hostId;
    fakeHost = await startEchoHost(context.relay, registration.hostId, registration.hostToken);

    // 小消息往返（HTTP 头 + 业务字节，主机原样回显）
    const small = httpProbe('hello-edge');
    const smallEcho = await edgeEcho({
      port: context.relay.edgePort,
      servername: `${registration.hostId}.relay.test`,
      ca: context.cert.cert,
      payload: small,
    });
    assert.equal(Buffer.compare(smallEcho, small), 0, 'edge must forward the request head and body unchanged');

    // 大帧回显（模拟会话历史快照级别）：8MB 随机字节，逐字节校验。
    const bigPayload = httpProbe(randomBytes(8 * 1024 * 1024));
    const echoed = await edgeEcho({
      port: context.relay.edgePort,
      servername: `${registration.hostId}.relay.test`,
      ca: context.cert.cert,
      payload: bigPayload,
      timeoutMs: 30_000,
    });
    assert.equal(echoed.length, bigPayload.length, 'all bytes must round-trip');
    assert.equal(Buffer.compare(echoed, bigPayload), 0, 'echo payload must be byte-identical');

    // 心跳未断：主机仍在在线列表里（若大帧阻塞控制面，host 会被 heartbeat timeout 踢掉）。
    assert.deepEqual(context.relay.onlineHostIds(), [registration.hostId]);
    assert.equal(fakeHost.seen.opens, 2, 'one tunnel stream per edge connection');
    assert.deepEqual([...fakeHost.seen.kinds], [GROUP_EDGE_STREAM_KIND], 'host.open must carry the group-edge kind');
  } finally {
    fakeHost?.stop();
    await context.cleanup();
  }
});

test('edge 错误路径：未知 SNI 421、离线主机 502、未认证请求 401', async () => {
  const context = await startEdgeRelay();
  try {
    // 非 <hostId>.<domain> 的 SNI → 421（没有可路由的 hostId）
    const unknownSni = await edgeHttp(context.relay.edgePort, 'other.test', context.cert.cert);
    assert.match(unknownSni, /^HTTP\/1\.1 421 /);
    // hostId 合法但主机未注册/离线 → 502
    const unregistered = await edgeHttp(context.relay.edgePort, 'h_unregistered.relay.test', context.cert.cert);
    assert.match(unregistered, /^HTTP\/1\.1 502 /);

    const offline = await edgeHttp(context.relay.edgePort, 'h_offline1234.relay.test', context.cert.cert);
    assert.match(offline, /^HTTP\/1\.1 502 /);
  } finally {
    await context.cleanup();
  }

  // 生产默认（未认证关闭）：主机在线但请求没有会话 cookie → 401，而不是放行
  const strict = await startEdgeRelay({ group: { edge: { allowUnauthenticated: false } } });
  let strictHost;
  try {
    const invite = createInvite(strict.file, {});
    const registration = registerHost({ file: strict.file, inviteCode: invite.code, hostName: 'Strict Host' });
    strictHost = await startEchoHost(strict.relay, registration.hostId, registration.hostToken);
    const rejected = await edgeHttp(strict.relay.edgePort, `${registration.hostId}.relay.test`, strict.cert.cert);
    assert.match(rejected, /^HTTP\/1\.1 401 /);
  } finally {
    strictHost?.stop();
    await strict.cleanup();
  }
});

test('主机断线后边缘连接被清理，新连接得到 502', async () => {
  const context = await startEdgeRelay();
  try {
    const invite = createInvite(context.file, {});
    const registration = registerHost({ file: context.file, inviteCode: invite.code, hostName: 'Tunnel Host' });
    const fakeHost = await startEchoHost(context.relay, registration.hostId, registration.hostToken);
    const probe = httpProbe('before-disconnect');
    const ok = await edgeEcho({
      port: context.relay.edgePort,
      servername: `${registration.hostId}.relay.test`,
      ca: context.cert.cert,
      payload: probe,
    });
    assert.equal(Buffer.compare(ok, probe), 0);

    fakeHost.stop();
    // 等 relay 把 host 标记离线（control close 立即生效）
    for (let i = 0; i < 100 && context.relay.onlineHostIds().length > 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(context.relay.onlineHostIds(), []);

    const after = await edgeHttp(context.relay.edgePort, `${registration.hostId}.relay.test`, context.cert.cert);
    assert.match(after, /^HTTP\/1\.1 502 /);
  } finally {
    await context.cleanup();
  }
});
