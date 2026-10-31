/**
 * 群体服务管理：服务方法参数校验 + 管理 API 路由 + 重置清除本机注册。
 * 用真实 RemoteService（enabled=false，不启动监听）+ 假 req/res。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { withTempHome } from './helpers.js';

function fakeResponse() {
  let status = 0;
  let body = '';
  return {
    writeHead(nextStatus) { status = nextStatus; },
    end(chunk) { body = chunk === undefined ? '' : String(chunk); },
    get status() { return status; },
    get body() { return body; },
  };
}

async function request(handler, { method = 'GET', path }) {
  const res = fakeResponse();
  await handler({ url: path, method, headers: {}, socket: {} }, res);
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch { /* plain text */ }
  return { status: res.status, body: res.body, json: parsed };
}

async function setup() {
  const home = withTempHome();
  const { saveConfig } = await import('../lib/config.js');
  const { RemoteService } = await import('../lib/service.js');
  const { createAdminHandler } = await import('../lib/admin.js');
  saveConfig({ enabled: false });
  const service = new RemoteService({ webServer: { protocol: 'http:', port: 1 } });
  await service.ready;
  const handler = createAdminHandler({ ctx: {}, service, authDisabled: true });
  return { home, service, handler };
}

test('群体服务：注册参数校验（服务地址/邀请码必填）', async () => {
  const { home, service } = await setup();
  try {
    await assert.rejects(
      service.registerGroup({}),
      (error) => error.status === 400 && error.code === 'invalid-service-url',
    );
    await assert.rejects(
      service.registerGroup({ serviceUrl: 'https://relay.example.com:8443' }),
      (error) => error.code === 'invalid-invite',
    );
  } finally {
    await service.dispose();
    home.cleanup();
  }
});

test('群体服务：重置注册会停掉运行时并删除本机 group.json', async () => {
  const { home, service } = await setup();
  try {
    const { saveGroupRegistration } = await import('../lib/group.js');
    const { paths } = await import('../lib/paths.js');
    saveGroupRegistration({
      serviceUrl: 'https://relay.example.com:8443',
      hostId: 'h_test1234',
      hostToken: 'test-token-value',
      relayDomain: 'relay.test',
      mobilePort: 11443,
      tokenPublicKey: '-----BEGIN PUBLIC KEY-----\nAA\n-----END PUBLIC KEY-----\n',
      hostName: 'Group Test',
    });
    assert.equal(existsSync(paths.groupRegistration()), true);

    const status = await service.resetGroup();
    assert.equal(existsSync(paths.groupRegistration()), false, '重置后本机注册文件应被删除');
    assert.equal(status.config.enabled, false, '重置后应关闭远程访问');
    assert.equal(status.group.registered, false);
    assert.ok(service.audit.tail(10).some((entry) => entry.action === 'group-reset'));
  } finally {
    await service.dispose();
    home.cleanup();
  }
});

test('群体服务管理 API：POST /group/reset 返回最新状态', async () => {
  const { home, service, handler } = await setup();
  try {
    const result = await request(handler, { method: 'POST', path: '/api/remote-access/group/reset' });
    assert.equal(result.status, 200);
    assert.equal(result.json.ok, true);
    assert.equal(result.json.data.config.enabled, false);
    assert.equal(result.json.data.group.registered, false);
  } finally {
    await service.dispose();
    home.cleanup();
  }
});

/**
 * 服务级集成：用假注册 API + 假控制面 WSS 验证 RemoteService 的注册/隧道/设备同步/停用重连/重置。
 * 不依赖 relay 包与 TLS 证书（群体版主机的在线/离线语义在这里直接可控）。
 */
test('群体服务：RemoteService 注册 → 隧道上线 → 设备同步 → 停用/重连 → 重置', async () => {
  const { createServer } = await import('node:http');
  const { WebSocketServer } = await import('ws');
  const { parseGroupPairingUri, PAIR_AUTH_TOKEN } = await import('dsh-remote-protocol');
  const { makeGroupDevice, waitFor } = await import('./helpers.js');

  const home = withTempHome();
  const deviceSyncs = [];
  let refreshes = 0;
  let httpServer;
  let wss;
  let service;
  try {
    const registrationPayload = () => ({
      ok: true,
      hostId: 'h_faketest1',
      hostToken: 'fake-host-token',
      relayDomain: 'relay.test',
      mobilePort: 11443,
      tokenPublicKey: '-----BEGIN PUBLIC KEY-----\nAA\n-----END PUBLIC KEY-----\n',
      controlUrl: `ws://127.0.0.1:${httpServer.address().port}`,
    });
    httpServer = createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        if (req.url === '/__group/register') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(registrationPayload()));
          return;
        }
        if (req.url === '/__group/refresh') {
          refreshes += 1;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(registrationPayload()));
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: { code: 'not_found' } }));
      });
    });
    wss = new WebSocketServer({ server: httpServer, path: '/control' });
    wss.on('connection', (ws) => {
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        let message;
        try { message = JSON.parse(data.toString()); } catch { return; }
        if (message.t === 'host.hello') {
          ws.send(JSON.stringify({
            t: 'host.ready',
            protocolVersion: 1,
            hostId: message.hostId,
            hostname: `${message.hostId}.relay.test`,
            domain: 'relay.test',
          }));
        }
        if (message.t === 'device.sync') deviceSyncs.push(message);
      });
    });
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));

    const { saveConfig, loadConfig } = await import('../lib/config.js');
    const { RemoteService } = await import('../lib/service.js');
    saveConfig({ enabled: false, groupInsecure: true });
    service = new RemoteService({
      webServer: { protocol: 'http:', port: 1, getOrigin: () => 'http://127.0.0.1:1/' },
      connection: { authenticatedUrl: (origin) => `${origin}?token=test` },
    });
    await service.ready;

    const serviceUrl = `http://127.0.0.1:${httpServer.address().port}`;
    const status = await service.registerGroup({ serviceUrl, inviteCode: 'fake-invite-code', hostName: 'Group Admin Test' });
    assert.equal(status.enabled, true);
    assert.equal(status.group.registered, true);
    assert.equal(status.group.hostId, 'h_faketest1');
    assert.equal(status.group.serviceUrl, serviceUrl);
    assert.equal(status.group.mobilePort, 11443);
    assert.ok(status.group.plainPort > 0, '应启动 loopback 明文代理');
    assert.equal(loadConfig().groupInviteCode, '', '邀请码注册成功后应清空');
    await waitFor(() => service.status().group.connected === true, 5000);

    // 已注册后才能生成配对二维码 v2（hostId/域名/端口来自注册响应）
    const session = service.pairing.createSession();
    const parsed = parseGroupPairingUri(session.uri);
    assert.equal(parsed.host, 'h_faketest1.relay.test');
    assert.equal(parsed.port, 11443);
    assert.equal(parsed.auth, PAIR_AUTH_TOKEN);

    // 设备表变化触发 device.sync（带上 P-256 公钥）
    const device = makeGroupDevice('iPhone 15 Pro');
    service.devices.add({ id: 'd_group01', name: 'iPhone 15 Pro', platform: 'ios', groupPublicKey: device.publicKeyRaw });
    await waitFor(() => deviceSyncs.some((entry) => entry.devices?.some((device) => device.deviceId === 'd_group01')), 3000);
    const synced = deviceSyncs.flatMap((entry) => entry.devices ?? []).find((entry) => entry.deviceId === 'd_group01');
    assert.ok(synced, 'device.sync 应包含新配对设备');
    assert.equal(synced.publicKey, device.publicKeyRaw);

    // 关闭远程访问：隧道断开但注册保留（再开启可恢复）
    const disabled = await service.updateConfig({ enabled: false });
    assert.deepEqual(disabled.errors, []);
    assert.equal(service.status().enabled, false);
    assert.equal(service.status().group.connected, false);
    assert.equal(service.status().group.registered, true, '关闭不应删除本机注册');

    // 重新启用：按已有注册重连（刷新注册信息，不消耗邀请码）
    const before = refreshes;
    await service.updateConfig({ enabled: true });
    await waitFor(() => service.status().group.connected === true, 5000);
    assert.equal(service.status().group.registered, true);
    assert.ok(refreshes > before, '重新启用应先刷新注册信息');

    // 重置注册：删除 group.json、关闭远程访问
    const reset = await service.resetGroup();
    assert.equal(reset.enabled, false);
    assert.equal(reset.group.registered, false);
    const { paths } = await import('../lib/paths.js');
    assert.equal(existsSync(paths.groupRegistration()), false);
  } finally {
    try { await service?.dispose(); } catch { /* ignore */ }
    if (wss) await new Promise((resolve) => wss.close(() => resolve()));
    if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
    home.cleanup();
  }
});
