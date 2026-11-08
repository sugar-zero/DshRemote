/**
 * 本机管理 API（群体版）：设备撤销 / 已撤销设备记录删除。
 *
 * 规则：只能删除**已撤销**设备；有效设备必须先撤销。
 * 用真实 RemoteService（enabled=false，不启动隧道）+ 假 req/res 驱动 adminHandler。
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

test('管理 API：设备列表 / 撤销 / 删除（已撤销设备）', async () => {
  const { home, service, handler } = await setup();
  try {
    service.devices.add({ id: 'd_test01', name: 'Old iPhone', platform: 'ios', groupPublicKey: 'pk-1' });
    const list = await request(handler, { method: 'GET', path: '/api/remote-access/devices' });
    assert.equal(list.status, 200);
    assert.equal(list.json.data.devices.length, 1);
    assert.equal(list.json.data.devices[0].groupPublicKey, 'pk-1');

    const revoke = await request(handler, { method: 'POST', path: '/api/remote-access/devices/d_test01/revoke' });
    assert.equal(revoke.status, 200);
    assert.ok(revoke.json.data.device.revokedAt > 0);
    assert.ok(service.audit.tail(10).some((entry) => entry.action === 'device-revoke' && entry.deviceId === 'd_test01'));

    const remove = await request(handler, { method: 'POST', path: '/api/remote-access/devices/d_test01/delete' });
    assert.equal(remove.status, 200);
    assert.equal(remove.json.data.device.id, 'd_test01');
    assert.equal(service.devices.list().length, 0);
    assert.ok(service.audit.tail(10).some((entry) => entry.action === 'device-delete' && entry.deviceId === 'd_test01'));
  } finally {
    await service.dispose();
    home.cleanup();
  }
});

test('管理 API：有效设备不能删除（409），未知设备 404', async () => {
  const { home, service, handler } = await setup();
  try {
    service.devices.add({ id: 'd_active', name: 'Active iPhone', platform: 'ios', groupPublicKey: 'pk-2' });
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

test('管理 API：群体版状态只暴露群字段（推送只剩开关/状态，无 TLS/中继/Apple 凭据）', async () => {
  const { home, service, handler } = await setup();
  try {
    const result = await request(handler, { method: 'GET', path: '/api/remote-access/status' });
    assert.equal(result.status, 200);
    const data = result.json.data;
    assert.equal(typeof data.version, 'string');
    assert.equal(data.enabled, false);
    assert.equal(typeof data.group, 'object');
    assert.equal(data.group.registered, false);
    assert.equal(typeof data.host.fingerprint, 'string');
    // 群体版推送（R2）：只有主机开关 + self/official 分流状态，不含 token/credential/Apple 凭据
    assert.deepEqual(data.push, {
      enabled: true,
      detail: false,
      self: { devices: 0, lastError: null },
      official: { devices: 0, lastError: null, hub: null },
      mode: '',
    });
    assert.deepEqual(data.restart, { enabled: false }, '「重启主机」组件默认关闭');
    assert.equal(data.config.pushEnabled, true);
    assert.equal(data.config.apnsKeyFile, undefined);
    assert.equal(data.config.relayUrl, undefined);
    assert.equal(data.config.tlsCertFile, undefined);
    assert.equal(data.config.groupServiceUrl, '');
    assert.equal(data.config.requireApproval, true);
    assert.equal(data.config.restartHostEnabled, false);
  } finally {
    await service.dispose();
    home.cleanup();
  }
});
