import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import { withTempHome, makeCsr, makeRogueClientCert, tlsRequest, tlsRequestNoClientCert } from './helpers.js';

test('remote TLS server: mTLS gate, header stripping, cookie injection, deny list, WS proxy', async () => {
  const home = withTempHome();
  const seen = [];
  let upstream;
  let wsServer;
  let remote;
  try {
    const { loadOrCreateHostIdentity, loadOrCreateDeviceCa, loadOrCreateDevServerCert, signDeviceCertificate } = await import('../lib/identity.js');
    const { DeviceStore } = await import('../lib/devices.js');
    const { PairingManager } = await import('../lib/pairing.js');
    const { DshProxy } = await import('../lib/proxy.js');
    const { createRemoteServer } = await import('../lib/server.js');

    upstream = http.createServer((req, res) => {
      seen.push({ url: req.url, headers: { ...req.headers } });
      if (req.url.startsWith('/?token=')) {
        res.writeHead(303, { 'set-cookie': ['dsh-auth-test=ok; Path=/; HttpOnly'], location: './' });
        res.end();
        return;
      }
      if (req.url === '/connect') { res.writeHead(200); res.end('LEAK'); return; }
      if (req.url.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><body>DSH-REMOTE-TEST</body></html>');
    });
    wsServer = new WebSocketServer({ noServer: true });
    upstream.on('upgrade', (req, socket, head) => {
      wsServer.handleUpgrade(req, socket, head, (ws) => {
        ws.send(`ready:${req.headers.cookie ?? ''}`);
        ws.on('message', (data) => ws.send(`echo:${data.toString()}`));
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
    const pairing = new PairingManager({ identity, ca, devices, audit: { append() {} }, getConfig: () => config });
    const audit = { append() {} };
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
    });
    const { port } = await remote.listen(0, '127.0.0.1');

    const deviceCsr = makeCsr('Test iPhone');
    const signed = signDeviceCertificate({ ca, csrPem: deviceCsr.csrPem, deviceId: 'd_test01', commonName: 'Test iPhone' });
    devices.add({ id: 'd_test01', name: 'Test iPhone', platform: 'ios', serial: signed.serial, notAfter: signed.notAfter });

    // 1) 无客户端证书 -> 403
    const noCert = await tlsRequestNoClientCert({ port, servername: fqdn, caPem: devCert.certPem, path: '/' });
    assert.equal(noCert.status, 403);

    // 2) pairing 路径允许无证书（无活跃会话 -> 409，而不是 403）
    const pairRes = await tlsRequestNoClientCert({
      port, servername: fqdn, caPem: devCert.certPem, method: 'POST', path: '/__dsh_remote/pair',
      body: JSON.stringify({ secret: 'x', csrPem: 'x', deviceName: 'x', platform: 'ios' }),
      headers: { 'Content-Type': 'application/json' },
    });
    assert.equal(pairRes.status, 409);

    // 3) 有客户端证书：反代 + cookie 注入 + 头剥离
    const ok = await tlsRequest({
      port, servername: fqdn, caPem: devCert.certPem,
      certPem: signed.certPem, keyPem: deviceCsr.privateKeyPem,
      path: '/',
      headers: { Host: 'evil.example', 'X-Forwarded-For': '203.0.113.9', 'X-Real-IP': '203.0.113.9', Origin: 'https://evil.example' },
    });
    assert.equal(ok.status, 200);
    assert.match(ok.body, /DSH-REMOTE-TEST/);
    const last = seen.at(-1);
    assert.equal(last.headers.host, `127.0.0.1:${upstreamPort}`);
    assert.equal(last.headers.cookie, 'dsh-auth-test=ok');
    assert.equal(last.headers['x-forwarded-for'], undefined);
    assert.equal(last.headers['x-real-ip'], undefined);
    assert.equal(last.headers.origin, undefined);
    assert.equal(ok.headers['x-content-type-options'], 'nosniff');
    assert.equal(ok.headers['x-frame-options'], 'DENY');
    assert.equal(ok.headers['referrer-policy'], 'no-referrer');
    assert.match(ok.headers['strict-transport-security'] ?? '', /max-age=31536000/);
    assert.equal(ok.headers['cache-control'], 'no-store');

    // 4) deny list 不命中上游
    const before = seen.length;
    const denied = await tlsRequest({
      port, servername: fqdn, caPem: devCert.certPem,
      certPem: signed.certPem, keyPem: deviceCsr.privateKeyPem, path: '/connect',
    });
    assert.equal(denied.status, 403);
    assert.equal(seen.length, before, 'denied path must not reach upstream');

    const deniedLocal = await tlsRequest({
      port, servername: fqdn, caPem: devCert.certPem,
      certPem: signed.certPem, keyPem: deviceCsr.privateKeyPem, path: '/open-in-app/open',
    });
    assert.equal(deniedLocal.status, 403);

    // 请求体上限（Content-Length 超限直接 413）
    const tooLarge = await tlsRequest({
      port, servername: fqdn, caPem: devCert.certPem,
      certPem: signed.certPem, keyPem: deviceCsr.privateKeyPem, path: '/',
      headers: { 'Content-Length': String(8 * 1024 * 1024) },
    });
    assert.equal(tooLarge.status, 413);

    const apiRes = await tlsRequest({
      port, servername: fqdn, caPem: devCert.certPem,
      certPem: signed.certPem, keyPem: deviceCsr.privateKeyPem, path: '/api/test',
    });
    assert.equal(apiRes.status, 200);
    assert.equal(apiRes.headers['cache-control'], 'no-store');

    // 设备管理 tunnel API（App 侧 mTLS 调用）：列表/撤销
    const secondCsr = makeCsr('Second iPhone');
    const secondSigned = signDeviceCertificate({ ca, csrPem: secondCsr.csrPem, deviceId: 'd_test02', commonName: 'Second iPhone' });
    devices.add({ id: 'd_test02', name: 'Second iPhone', platform: 'ios', serial: secondSigned.serial, notAfter: secondSigned.notAfter });
    const listRes = await tlsRequest({
      port, servername: fqdn, caPem: devCert.certPem,
      certPem: signed.certPem, keyPem: deviceCsr.privateKeyPem, path: '/__dsh_remote/devices',
    });
    assert.equal(listRes.status, 200);
    const listJson = JSON.parse(listRes.body);
    assert.equal(listJson.data.devices.length, 2);
    assert.equal(listJson.data.devices.find((d) => d.id === 'd_test01').current, true);
    assert.equal(listJson.data.devices.find((d) => d.id === 'd_test02').current, false);
    const revokeRes = await tlsRequest({
      port, servername: fqdn, caPem: devCert.certPem,
      certPem: signed.certPem, keyPem: deviceCsr.privateKeyPem,
      method: 'POST', path: '/__dsh_remote/devices/d_test02/revoke',
    });
    assert.equal(revokeRes.status, 200);
    const listAfter = JSON.parse((await tlsRequest({
      port, servername: fqdn, caPem: devCert.certPem,
      certPem: signed.certPem, keyPem: deviceCsr.privateKeyPem, path: '/__dsh_remote/devices',
    })).body);
    assert.ok(listAfter.data.devices.find((d) => d.id === 'd_test02').revokedAt);
    const listNoCert = await tlsRequestNoClientCert({ port, servername: fqdn, caPem: devCert.certPem, path: '/__dsh_remote/devices' });
    assert.equal(listNoCert.status, 403);

    // 5) WebSocket 反代（mTLS + cookie + 流）
    const ws = new WebSocket(`wss://127.0.0.1:${port}/api/remote.mux`, [], {
      servername: fqdn,
      ca: devCert.certPem,
      cert: signed.certPem,
      key: deviceCsr.privateKeyPem,
      rejectUnauthorized: true,
    });
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws timeout')), 5000);
      ws.on('message', (data) => { clearTimeout(timer); resolve(data.toString()); });
      ws.on('error', reject);
    });
    assert.equal(ready, 'ready:dsh-auth-test=ok');
    ws.send('ping');
    const echo = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('echo timeout')), 5000);
      ws.on('message', (data) => { clearTimeout(timer); resolve(data.toString()); });
      ws.on('error', reject);
    });
    assert.equal(echo, 'echo:ping');
    ws.close();

    // 6) 撤销设备后立即 403（已有连接断开；新连接拒绝）
    devices.revoke('d_test01');
    const revoked = await tlsRequest({
      port, servername: fqdn, caPem: devCert.certPem,
      certPem: signed.certPem, keyPem: deviceCsr.privateKeyPem, path: '/',
    });
    assert.equal(revoked.status, 403);

    // 7) 不受信任 CA 签发的客户端证书 -> 403
    const rogue = makeRogueClientCert();
    const untrusted = await tlsRequest({
      port, servername: fqdn, caPem: devCert.certPem,
      certPem: rogue.certPem, keyPem: rogue.privateKeyPem, path: '/',
    });
    assert.equal(untrusted.status, 403);
  } finally {
    try { await remote?.close(); } catch { /* ignore */ }
    try { wsServer?.close(); } catch { /* ignore */ }
    try { await new Promise((resolve) => upstream?.close(resolve)); } catch { /* ignore */ }
    home.cleanup();
  }
});
