import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { withTempHome } from './helpers.js';

test('主机身份：首次创建、再次加载指纹稳定，落盘 0600', async () => {
  const home = withTempHome();
  try {
    const identityModule = await import('../lib/identity.js');
    const { paths } = await import('../lib/paths.js');
    const a = identityModule.loadOrCreateHostIdentity();
    const b = identityModule.loadOrCreateHostIdentity();
    assert.equal(a.status, 'created');
    assert.equal(b.status, 'loaded');
    assert.equal(a.fingerprint, b.fingerprint, '重新加载后主机指纹必须稳定');
    assert.equal(a.publicKeyDerB64, b.publicKeyDerB64);
    assert.ok(a.fingerprint.length > 0);
    const raw = JSON.parse(readFileSync(paths.hostIdentity(), 'utf8'));
    assert.equal(raw.version, 1);
    assert.equal(raw.publicKeyDerB64, a.publicKeyDerB64);
    if (process.platform !== 'win32') {
      assert.equal(statSync(paths.hostIdentity()).mode & 0o777, 0o600, '主机身份文件必须是 0600');
    }
    // 群体版不再生成设备 CA / 开发 TLS 证书（classic 功能已删除）
    assert.equal(identityModule.loadOrCreateDeviceCa, undefined);
    assert.equal(identityModule.loadOrCreateDevServerCert, undefined);
    assert.equal(identityModule.signDeviceCertificate, undefined);
  } finally {
    home.cleanup();
  }
});
