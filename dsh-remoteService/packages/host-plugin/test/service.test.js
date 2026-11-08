import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { withTempHome } from './helpers.js';

async function setup() {
  const home = withTempHome();
  const { saveConfig } = await import('../lib/config.js');
  const { RemoteService } = await import('../lib/service.js');
  saveConfig({ enabled: false });
  const service = new RemoteService({
    webServer: { protocol: 'http:', port: 1, getOrigin: () => 'http://127.0.0.1:1/' },
    connection: { authenticatedUrl: (origin) => `${origin}?token=test` },
  });
  await service.ready;
  return { home, service };
}

test('RemoteService：版本与管理 API 展示的版本一致（0.2.8）', async () => {
  const { home, service } = await setup();
  try {
    const pkgVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
    assert.equal(service.status().version, pkgVersion);
    assert.equal(pkgVersion, '0.2.8');
  } finally {
    await service.dispose();
    home.cleanup();
  }
});

test('RemoteService：配置 schema 只保留群体字段，classic 字段不会写回磁盘', async () => {
  const { home, service } = await setup();
  try {
    const { loadConfig, saveConfig, DEFAULT_CONFIG } = await import('../lib/config.js');
    const { paths } = await import('../lib/paths.js');
    // 旧版遗留字段：保存时被忽略，读取时被丢弃
    saveConfig({
      relayUrl: 'wss://relay.example.com:8443',
      relayDomain: 'relay.example.com',
      hostId: 'h_classic',
      hostToken: 'legacy-token',
      tlsCertFile: '/path/fullchain.pem',
      pushEnabled: true,
      apnsKeyFile: '/path/AuthKey.p8',
      groupEnabled: true,
      groupServiceUrl: 'https://relay.example.com:19443',
    });
    const raw = JSON.parse(readFileSync(paths.config(), 'utf8'));
    for (const key of ['relayUrl', 'relayDomain', 'hostId', 'hostToken', 'tlsCertFile', 'apnsKeyFile', 'groupEnabled']) {
      assert.equal(key in raw, false, `classic 字段 ${key} 不应写回配置`);
    }
    const config = loadConfig();
    assert.equal(config.groupServiceUrl, 'https://relay.example.com:19443');
    assert.equal(config.pushEnabled, true, '群体版「推送提醒」开关默认开启（保存时允许写回）');
    for (const key of ['relayUrl', 'relayDomain', 'hostId', 'hostToken', 'publicPort', 'tlsCertFile', 'tlsKeyFile', 'pushProvider', 'apnsKeyFile', 'groupEnabled', 'listenPort', 'relayTlsInsecure']) {
      assert.equal(key in DEFAULT_CONFIG, false, `${key} 不应出现在 DEFAULT_CONFIG`);
      assert.equal(key in config, false, `${key} 不应出现在加载后的配置`);
    }
    assert.deepEqual(config.denyPrefixes, DEFAULT_CONFIG.denyPrefixes);

    // 「重启主机」组件是群体版正式配置字段（默认关闭），保存后能读回。
    assert.equal(DEFAULT_CONFIG.restartHostEnabled, false, '重启组件默认关闭');
    assert.equal(config.restartHostEnabled, false);
    const enabled = saveConfig({ restartHostEnabled: true });
    assert.equal(enabled.restartHostEnabled, true);
    assert.equal(loadConfig().restartHostEnabled, true);
    saveConfig({ restartHostEnabled: false });
    assert.equal(loadConfig().restartHostEnabled, false);

    // 「推送提醒」开关同样是群体版正式字段（默认开启），保存后能读回。
    assert.equal(DEFAULT_CONFIG.pushEnabled, true, '推送开关默认开启');
    assert.equal(saveConfig({ pushEnabled: false }).pushEnabled, false);
    assert.equal(loadConfig().pushEnabled, false);
    saveConfig({ pushEnabled: true });
    assert.equal(loadConfig().pushEnabled, true);
  } finally {
    await service.dispose();
    home.cleanup();
  }
});

test('RemoteService：updateConfig 落到群体字段并重启运行时（未启用时不连接）', async () => {
  const { home, service } = await setup();
  try {
    const result = await service.updateConfig({
      enabled: false,
      hostName: 'My Group Host',
      requireApproval: false,
      groupServiceUrl: 'https://relay.example.com:19443',
      groupPlainPort: 34567,
    });
    assert.deepEqual(result.errors, []);
    assert.equal(result.config.hostName, 'My Group Host');
    assert.equal(result.config.requireApproval, false);
    assert.equal(result.config.groupServiceUrl, 'https://relay.example.com:19443');
    assert.equal(result.config.groupPlainPort, 34567);
    const status = service.status();
    assert.equal(status.enabled, false);
    assert.equal(status.group.connected, false);
    assert.equal(status.config.hostName, 'My Group Host');
    assert.equal(status.config.groupPlainPort, 34567);
    assert.equal(status.group.registered, false);
    // 推送状态（R2 契约 §6.3）：默认开启、两通道无设备，不含 token/credential
    assert.equal(status.config.pushEnabled, true);
    assert.deepEqual(status.push, {
      enabled: true,
      detail: false,
      self: { devices: 0, lastError: null },
      official: { devices: 0, lastError: null, hub: null },
      mode: '',
    });
    assert.equal(JSON.stringify(status.push).includes('credential'), false, 'push 状态不能有 credential 字段');
  } finally {
    await service.dispose();
    home.cleanup();
  }
});

test('RemoteService：deleteDevice 只允许删除已撤销设备，并写审计', async () => {
  const { home, service } = await setup();
  try {
    service.devices.add({ id: 'd_del', name: 'Old iPhone', platform: 'ios', groupPublicKey: 'pk-del' });
    assert.throws(
      () => service.deleteDevice('d_del'),
      (error) => error.status === 409 && error.code === 'device-active',
    );
    service.devices.revoke('d_del');
    const { device } = service.deleteDevice('d_del');
    assert.equal(device.id, 'd_del');
    assert.equal(service.devices.list().length, 0);
    assert.ok(service.audit.tail(10).some((entry) => entry.action === 'device-delete' && entry.deviceId === 'd_del'));
    assert.throws(() => service.deleteDevice('d_del'), (error) => error.status === 404 && error.code === 'device-not-found');
  } finally {
    await service.dispose();
    home.cleanup();
  }
});

test('RemoteService：未注册群体服务时重试连接返回 409（无需网络）', async () => {
  const { home, service } = await setup();
  try {
    await assert.rejects(
      service.retryGroup(),
      (error) => error.status === 409 && error.code === 'group-not-registered',
    );
  } finally {
    await service.dispose();
    home.cleanup();
  }
});
