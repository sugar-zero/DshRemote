import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import { withTempHome } from './helpers.js';

/** 发一个 plain HTTP 请求，收集响应头/体。 */
function request({ port, method = 'GET', path = '/', headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(body) : undefined;
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path,
      headers: {
        connection: 'close',
        ...(payload ? { 'content-length': payload.length } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * DshProxy 的独立测试（群体版 loopback 明文代理也复用它）：
 * cookie 注入 / 来源头剥离 / deny list / 请求体上限 / 安全响应头 / WebSocket 反代。
 */
test('DshProxy：cookie 注入、头剥离、deny list、请求体上限、WS 反代', async () => {
  const home = withTempHome();
  const seen = [];
  let upstream;
  let wsServer;
  let proxyServer;
  try {
    const { DshProxy } = await import('../lib/proxy.js');

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

    const audit = { append() {} };
    const proxy = new DshProxy({
      getUpstream: () => ({ protocol: 'http:', host: '127.0.0.1', port: upstreamPort }),
      authenticatedUrl: () => `http://127.0.0.1:${upstreamPort}/?token=test-token`,
      denyPrefixes: ['/connect', '/oauth', '/open-in-app', '/api/remote-access', '/__dsh_remote'],
      getMaxRequestBytes: () => 4 * 1024 * 1024,
      audit,
    });
    proxyServer = http.createServer((req, res) => {
      proxy.handle(req, res, { id: 'd_test01' }).catch(() => {
        if (!res.headersSent) { res.writeHead(500); res.end(); }
      });
    });
    proxyServer.on('upgrade', (req, socket, head) => {
      proxy.handleUpgrade(req, socket, head, { id: 'd_test01' }).catch(() => socket.destroy());
    });
    await new Promise((resolve) => proxyServer.listen(0, '127.0.0.1', resolve));
    const port = proxyServer.address().port;

    // 1) 反代 + cookie 注入 + 来源头剥离 + 安全响应头
    const ok = await request({
      port,
      path: '/',
      headers: {
        Host: 'evil.example',
        'X-Forwarded-For': '203.0.113.9',
        'X-Real-IP': '203.0.113.9',
        Origin: 'https://evil.example',
        Cookie: 'attacker=1',
      },
    });
    assert.equal(ok.status, 200);
    assert.match(ok.body, /DSH-REMOTE-TEST/);
    const last = seen.at(-1);
    assert.equal(last.headers.host, `127.0.0.1:${upstreamPort}`);
    assert.equal(last.headers.cookie, 'dsh-auth-test=ok', '必须注入本机 DSH cookie，而不是透传客户端 cookie');
    assert.equal(last.headers['x-forwarded-for'], undefined);
    assert.equal(last.headers['x-real-ip'], undefined);
    assert.equal(last.headers.origin, undefined);
    assert.equal(last.headers.referer, undefined);
    assert.equal(ok.headers['x-content-type-options'], 'nosniff');
    assert.equal(ok.headers['x-frame-options'], 'DENY');
    assert.equal(ok.headers['referrer-policy'], 'no-referrer');
    assert.match(ok.headers['strict-transport-security'] ?? '', /max-age=31536000/);
    assert.equal(ok.headers['cache-control'], 'no-store');

    // 2) deny list 不命中上游
    const before = seen.length;
    const denied = await request({ port, path: '/connect' });
    assert.equal(denied.status, 403);
    assert.equal(seen.length, before, 'denied path must not reach upstream');
    const deniedLocal = await request({ port, path: '/open-in-app/open' });
    assert.equal(deniedLocal.status, 403);

    // 3) 请求体上限（Content-Length 超限直接 413）
    const tooLarge = await request({ port, path: '/', headers: { 'Content-Length': String(8 * 1024 * 1024) } });
    assert.equal(tooLarge.status, 413);

    // 4) API 响应 no-store
    const apiRes = await request({ port, path: '/api/test' });
    assert.equal(apiRes.status, 200);
    assert.equal(apiRes.headers['cache-control'], 'no-store');

    // 5) WebSocket 反代（cookie 注入 + 双向流）
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/remote.mux`);
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
  } finally {
    try { wsServer?.close(); } catch { /* ignore */ }
    if (wsServer) await new Promise((resolve) => wsServer.close(() => resolve()));
    if (proxyServer) await new Promise((resolve) => proxyServer.close(resolve));
    if (upstream) await new Promise((resolve) => upstream.close(resolve));
    home.cleanup();
  }
});
