/**
 * 本机管理 API：设备记录删除（POST /api/remote-access/devices/:id/delete）。
 *
 * 规则：只允许删除**已撤销**设备；有效设备必须先在设备列表撤销。
 * 用真实 RemoteService（enabled=false，不启动监听）+ 假 req/res 驱动 adminHandler。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
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

test('设备删除：已撤销设备可删除，记录消失并写审计', async () => {
  const { home, service, handler } = await setup();
  try {
    service.devices.add({ id: 'd_revoked', serial: 'AB01', name: 'Old iPhone', platform: 'ios' });
    service.devices.revoke('d_revoked');

    const result = await request(handler, { method: 'POST', path: '/api/remote-access/devices/d_revoked/delete' });
    assert.equal(result.status, 200);
    assert.equal(result.json.ok, true);
    assert.equal(result.json.data.device.id, 'd_revoked');
    assert.equal(service.devices.list().length, 0, '设备记录应被删除');
    assert.ok(service.audit.tail(10).some((entry) => entry.action === 'device-delete' && entry.deviceId === 'd_revoked'));
  } finally {
    await service.dispose();
    home.cleanup();
  }
});

test('设备删除：有效设备必须拒绝（409），未知设备 404', async () => {
  const { home, service, handler } = await setup();
  try {
    service.devices.add({ id: 'd_active', serial: 'AB02', name: 'Active iPhone', platform: 'ios' });

    const active = await request(handler, { method: 'POST', path: '/api/remote-access/devices/d_active/delete' });
    assert.equal(active.status, 409);
    assert.equal(active.json.error.code, 'device-active');
    assert.equal(service.devices.list().length, 1, '有效设备不能被删除');

    const missing = await request(handler, { method: 'POST', path: '/api/remote-access/devices/d_missing/delete' });
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error.code, 'device-not-found');
  } finally {
    await service.dispose();
    home.cleanup();
  }
});

test('设备删除：同时清理该设备的推送 token', async () => {
  const { home, service, handler } = await setup();
  try {
    service.devices.add({ id: 'd_push', serial: 'AB03', name: 'Push iPhone', platform: 'ios' });
    service.pushTokens.set('d_push', { deviceId: 'd_push', provider: 'apns', token: 'tok', updatedAt: Date.now() });
    service.devices.revoke('d_push');

    const result = await request(handler, { method: 'POST', path: '/api/remote-access/devices/d_push/delete' });
    assert.equal(result.status, 200);
    assert.equal(service.pushTokens.has('d_push'), false, '删除设备应清理推送 token');
  } finally {
    await service.dispose();
    home.cleanup();
  }
});
