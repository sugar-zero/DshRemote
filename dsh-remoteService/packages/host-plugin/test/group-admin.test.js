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
    assert.equal(status.config.groupEnabled, false);
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
    assert.equal(result.json.data.config.groupEnabled, false);
    assert.equal(result.json.data.group.registered, false);
  } finally {
    await service.dispose();
    home.cleanup();
  }
});
