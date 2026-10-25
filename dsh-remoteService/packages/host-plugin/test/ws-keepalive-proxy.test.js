import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import { withTempHome, makeCsr, tlsRequestNoClientCert } from './helpers.js';
import { splitUpgradeResponseHead } from '../lib/proxy.js';

/** 等一个谓词成立；超时抛错。 */
function waitFor(predicate, timeoutMs = 5000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        const value = predicate();
        if (value) { resolve(value); return; }
      } catch (error) { reject(error); return; }
      if (Date.now() - start > timeoutMs) { reject(new Error('timeout')); return; }
      setTimeout(tick, 10);
    };
    tick();
  });
}

test('splitUpgradeResponseHead：头不完整返回 null，完整后切出 status/header/rest', () => {
  assert.equal(splitUpgradeResponseHead(Buffer.from('HTTP/1.1 101 Switching')), null);
  const full = Buffer.from('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n\u0000\u0001');
  const parsed = splitUpgradeResponseHead(full);
  assert.ok(parsed);
  assert.equal(parsed.status, 101);
  assert.equal(parsed.header.toString('latin1'), 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n');
  assert.deepEqual(parsed.rest, Buffer.from([0x00, 0x01]));
  const rejected = splitUpgradeResponseHead(Buffer.from('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n'));
  assert.equal(rejected.status, 403);
  const garbage = splitUpgradeResponseHead(Buffer.alloc(80 * 1024, 0x41));
  assert.ok(garbage?.overflow);
});

test('WS 代理：101 响应头之后的帧扫描生效——客户端 autoPong=false 时也替链路回 Pong', async () => {
  const home = withTempHome();
  let upstream;
  let wsServer;
  let remote;
  let client;
  try {
    const { loadOrCreateHostIdentity, loadOrCreateDeviceCa, loadOrCreateDevServerCert, signDeviceCertificate } = await import('../lib/identity.js');
    const { DeviceStore } = await import('../lib/devices.js');
    const { PairingManager } = await import('../lib/pairing.js');
    const { DshProxy } = await import('../lib/proxy.js');
    const { createRemoteServer } = await import('../lib/server.js');

    upstream = http.createServer((req, res) => {
      if (req.url.startsWith('/?token=')) {
        res.writeHead(303, { 'set-cookie': ['dsh-auth-test=ok; Path=/; HttpOnly'], location: './' });
        res.end();
        return;
      }
      res.writeHead(200); res.end('ok');
    });
    wsServer = new WebSocketServer({ noServer: true });
    let upstreamPongs = 0;
    let openedServerSocket;
    upstream.on('upgrade', (req, socket, head) => {
      wsServer.handleUpgrade(req, socket, head, (ws) => {
        openedServerSocket = ws;
        ws.on('pong', () => { upstreamPongs += 1; });
        ws.send('server-hello');
      });
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamPort = upstream.address().port;

    const identity = loadOrCreateHostIdentity();
    const ca = loadOrCreateDeviceCa();
    const devices = new DeviceStore();
    const fqdn = 'h_test.relay.test';
    const devCert = loadOrCreateDevServerCert(fqdn);
    const config = { hostId: 'h_test', relayDomain: 'relay.test', hostName: 'Test Mac', requireApproval: false };
    const audit = { append() {} };
    const pairing = new PairingManager({ identity, ca, devices, audit, getConfig: () => config });
    const proxy = new DshProxy({
      getUpstream: () => ({ protocol: 'http:', host: '127.0.0.1', port: upstreamPort }),
      authenticatedUrl: () => `http://127.0.0.1:${upstreamPort}/?token=test-token`,
      denyPrefixes: ['/connect', '/oauth', '/open-in-app', '/api/remote-access', '/__dsh_remote'],
      getMaxRequestBytes: () => 4 * 1024 * 1024,
      audit,
    });
    remote = createRemoteServer({
      certPem: devCert.certPem,
      keyPem: devCert.keyPem,
      caCertPem: ca.certPem,
      devices,
      pairing,
      proxy,
      audit,
      getConfig: () => config,
      savePushToken: () => {},
      getStatus: () => ({ tls: null, relayConnected: true, version: '0.1.0-test' }),
    });
    const { port } = await remote.listen(0, '127.0.0.1');

    const deviceCsr = makeCsr('Test iPhone');
    const signed = signDeviceCertificate({ ca, csrPem: deviceCsr.csrPem, deviceId: 'd_test01', commonName: 'Test iPhone' });
    devices.add({ id: 'd_test01', name: 'Test iPhone', platform: 'ios', serial: signed.serial, notAfter: signed.notAfter });

    const pingsSeenByClient = [];
    client = new WebSocket(`wss://127.0.0.1:${port}/api/remote.mux`, [], {
      servername: fqdn,
      ca: devCert.certPem,
      cert: signed.certPem,
      key: deviceCsr.privateKeyPem,
      rejectUnauthorized: true,
      autoPong: false, // 关键：客户端不回 Pong，只有代理伪造的 Pong 能到达上游
    });
    client.on('ping', (payload) => pingsSeenByClient.push(payload.toString()));
    const messages = [];
    client.on('message', (data) => messages.push(data.toString()));

    await waitFor(() => client.readyState === WebSocket.OPEN);
    await waitFor(() => messages.includes('server-hello'));

    // 先来一个大消息，确保帧扫描能跨过数据帧（历史快照场景）
    const big = 'x'.repeat(200 * 1024);
    openedServerSocket.send(big);
    await waitFor(() => messages.includes(big));

    // 上游每 100ms ping 一次；客户端 autoPong=false，代理应代答
    const pingTimer = setInterval(() => {
      if (openedServerSocket.readyState === WebSocket.OPEN) openedServerSocket.ping('hb');
    }, 100);
    try {
      await waitFor(() => upstreamPongs > 0, 4000);
      assert.ok(upstreamPongs > 0, '代理应替隧道链路回 Pong');
      assert.ok(pingsSeenByClient.length > 0, 'Ping 仍应原样转发给客户端');
    } finally {
      clearInterval(pingTimer);
    }
  } finally {
    try { client?.terminate(); } catch { /* ignore */ }
    for (const c of wsServer?.clients ?? []) { try { c.terminate(); } catch { /* ignore */ } }
    if (wsServer) await new Promise((resolve) => wsServer.close(() => resolve()));
    if (upstream) await new Promise((resolve) => upstream.close(resolve));
    try { await remote?.close(); } catch { /* ignore */ }
    home.cleanup();
  }
});

test('WS 代理：上游拒绝升级（非 101）时原样转发响应、不启用心跳代答', async () => {
  const home = withTempHome();
  let upstream;
  let remote;
  let client;
  try {
    const { loadOrCreateHostIdentity, loadOrCreateDeviceCa, loadOrCreateDevServerCert, signDeviceCertificate } = await import('../lib/identity.js');
    const { DeviceStore } = await import('../lib/devices.js');
    const { PairingManager } = await import('../lib/pairing.js');
    const { DshProxy } = await import('../lib/proxy.js');
    const { createRemoteServer } = await import('../lib/server.js');

    upstream = http.createServer((req, res) => {
      if (req.url.startsWith('/?token=')) {
        res.writeHead(303, { 'set-cookie': ['dsh-auth-test=ok; Path=/; HttpOnly'], location: './' });
        res.end();
        return;
      }
      res.writeHead(200); res.end('ok');
    });
    upstream.on('upgrade', (req, socket) => {
      socket.end('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n');
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamPort = upstream.address().port;

    const identity = loadOrCreateHostIdentity();
    const ca = loadOrCreateDeviceCa();
    const devices = new DeviceStore();
    const fqdn = 'h_test.relay.test';
    const devCert = loadOrCreateDevServerCert(fqdn);
    const config = { hostId: 'h_test', relayDomain: 'relay.test', hostName: 'Test Mac', requireApproval: false };
    const auditEntries = [];
    const audit = { append: (entry) => auditEntries.push(entry) };
    const pairing = new PairingManager({ identity, ca, devices, audit, getConfig: () => config });
    const proxy = new DshProxy({
      getUpstream: () => ({ protocol: 'http:', host: '127.0.0.1', port: upstreamPort }),
      authenticatedUrl: () => `http://127.0.0.1:${upstreamPort}/?token=test-token`,
      denyPrefixes: [],
      getMaxRequestBytes: () => 4 * 1024 * 1024,
      audit,
    });
    remote = createRemoteServer({
      certPem: devCert.certPem,
      keyPem: devCert.keyPem,
      caCertPem: ca.certPem,
      devices,
      pairing,
      proxy,
      audit,
      getConfig: () => config,
      savePushToken: () => {},
      getStatus: () => ({ tls: null, relayConnected: true, version: '0.1.0-test' }),
    });
    const { port } = await remote.listen(0, '127.0.0.1');

    const deviceCsr = makeCsr('Test iPhone');
    const signed = signDeviceCertificate({ ca, csrPem: deviceCsr.csrPem, deviceId: 'd_test01', commonName: 'Test iPhone' });
    devices.add({ id: 'd_test01', name: 'Test iPhone', platform: 'ios', serial: signed.serial, notAfter: signed.notAfter });

    let rejectedStatus = 0;
    client = new WebSocket(`wss://127.0.0.1:${port}/api/remote.mux`, [], {
      servername: fqdn,
      ca: devCert.certPem,
      cert: signed.certPem,
      key: deviceCsr.privateKeyPem,
      rejectUnauthorized: true,
    });
    client.on('unexpected-response', (_req, res) => { rejectedStatus = res.statusCode; res.resume(); });
    client.on('error', () => {});
    await waitFor(() => rejectedStatus === 403, 5000);
    assert.equal(rejectedStatus, 403);
    await waitFor(() => auditEntries.find((entry) => entry.action === 'ws-upgrade-failed' && entry.result === 'upstream-403'), 2000);

    // 顺带确认无证书仍然被 mTLS 拦住（代理未破坏原有安全语义）
    const noCert = await tlsRequestNoClientCert({ port, servername: fqdn, caPem: devCert.certPem, path: '/' });
    assert.equal(noCert.status, 403);
  } finally {
    try { client?.terminate(); } catch { /* ignore */ }
    if (upstream) await new Promise((resolve) => upstream.close(resolve));
    try { await remote?.close(); } catch { /* ignore */ }
    home.cleanup();
  }
});

test('WS 代理：下行拥塞（代理暂停读上游）时主动定时 Pong，避免 DSH 心跳误杀', async () => {
  const { EventEmitter } = await import('node:events');
  const net = await import('node:net');
  const home = withTempHome();
  let upstream;
  let cookieServer;
  try {
    const { loadOrCreateDeviceCa } = await import('../lib/identity.js');
    const ca = loadOrCreateDeviceCa();

    // 上游：token 交换 + WS 101 后静默；记录 101 之后收到的字节
    const afterUpgrade = [];
    let gotRequest = false;
    upstream = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.on('data', (chunk) => {
        if (!gotRequest) {
          const text = chunk.toString('latin1');
          if (text.includes('\r\n\r\n')) {
            gotRequest = true;
            const rest = Buffer.from(text.slice(text.indexOf('\r\n\r\n') + 4), 'latin1');
            if (rest.length > 0) afterUpgrade.push(rest);
            socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
          }
          return;
        }
        afterUpgrade.push(Buffer.from(chunk));
      });
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamPort = upstream.address().port;

    // cookie 交换端点
    cookieServer = (await import('node:http')).createServer((req, res) => {
      res.writeHead(303, { 'set-cookie': ['dsh-auth-test=ok; Path=/'], location: './' });
      res.end();
    });
    await new Promise((resolve) => cookieServer.listen(0, '127.0.0.1', resolve));
    const cookiePort = cookieServer.address().port;

    const { DshProxy } = await import('../lib/proxy.js');
    const proxy = new DshProxy({
      getUpstream: () => ({ protocol: 'http:', host: '127.0.0.1', port: upstreamPort }),
      authenticatedUrl: () => `http://127.0.0.1:${cookiePort}/?token=x`,
      denyPrefixes: [],
      getMaxRequestBytes: () => 1024,
      audit: { append() {} },
    });

    // 假 clientSocket：write 永远返回 false，模拟「下行拥塞 → 代理暂停读上游」
    class FakeSocket extends EventEmitter {
      constructor() {
        super();
        this.destroyed = false;
        this.writableLength = 256 * 1024;
        this.written = 0;
      }
      write(chunk) { this.written += chunk.length; return false; }
      end() { this.destroyed = true; }
      destroy() { this.destroyed = true; this.emit('close'); }
      pipe() { return this; }
    }
    const clientSocket = new FakeSocket();
    const req = {
      url: '/api/remote.mux',
      method: 'GET',
      headers: {
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-version': '13',
      },
    };
    await proxy.handleUpgrade(req, clientSocket, Buffer.alloc(0), { id: 'd_test01' });

    // 等 101 头被转发（FakeSocket 记录写过），且代理暂停了上游
    const started = Date.now();
    while (clientSocket.written === 0 && Date.now() - started < 3000) await new Promise((r) => setTimeout(r, 10));
    assert.ok(clientSocket.written > 0, '应已转发 101 响应');

    // 主动 Pong 应在上游侧出现（masked，opcode 0xA）
    const deadline = Date.now() + 4000;
    let foundPong = null;
    while (Date.now() < deadline && foundPong === null) {
      const all = Buffer.concat(afterUpgrade);
      for (let i = 0; i + 6 <= all.length; i += 1) {
        if ((all[i] & 0x0f) === 0x0a && (all[i + 1] & 0x80) !== 0) { foundPong = all.subarray(i); break; }
      }
      if (foundPong === null) await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(foundPong !== null, '拥塞期间代理应主动发 masked Pong 给上游');
    assert.equal(foundPong[1] & 0x80, 0x80, 'Pong 必须是 masked（client→server）');
    clientSocket.destroy();
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    if (upstream) await new Promise((resolve) => upstream.close(resolve));
    if (cookieServer) await new Promise((resolve) => cookieServer.close(resolve));
    home.cleanup();
  }
});
