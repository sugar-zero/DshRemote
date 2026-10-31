import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGroupPairingUri, PAIR_AUTH_TOKEN } from 'dsh-remote-protocol';
import { makeGroupDevice, withTempHome } from './helpers.js';

const GROUP_INFO = { hostId: 'h_test1234', relayDomain: 'relay.test', mobilePort: 11443 };

async function setup({ requireApproval = true } = {}) {
  const home = withTempHome();
  const { loadOrCreateHostIdentity } = await import('../lib/identity.js');
  const { DeviceStore } = await import('../lib/devices.js');
  const { AuditLog } = await import('../lib/audit.js');
  const { PairingManager } = await import('../lib/pairing.js');
  const devices = new DeviceStore();
  const audit = new AuditLog();
  const pairing = new PairingManager({
    identity: loadOrCreateHostIdentity(),
    devices,
    audit,
    getConfig: () => ({ hostName: 'Test Mac', requireApproval }),
    getGroupInfo: () => GROUP_INFO,
  });
  return { home, devices, audit, pairing };
}

test('群体配对：QR v2 → 提交 P-256 公钥 → 桌面确认 → 写入设备表', async () => {
  const { home, devices, pairing } = await setup();
  try {
    const device = makeGroupDevice('iPhone 15 Pro');
    const session = pairing.createSession();
    assert.equal(session.active, true);
    const parsed = parseGroupPairingUri(session.uri);
    assert.equal(parsed.host, 'h_test1234.relay.test');
    assert.equal(parsed.port, 11443);
    assert.equal(parsed.auth, PAIR_AUTH_TOKEN);
    assert.equal(parsed.relayDomain, 'relay.test');
    assert.equal(parsed.hostId, 'h_test1234');
    assert.match(session.code, /^[A-Z0-9]{4}-?[A-Z0-9]{4}$|^[A-Z0-9]{12}$/);

    const pending = pairing.handlePairRequest({
      secret: parsed.secret,
      publicKey: device.publicKeyRaw,
      deviceName: 'iPhone 15 Pro',
      platform: 'ios',
      remoteAddress: '127.0.0.1',
    });
    assert.equal(pending.status, 'pending');
    assert.match(pending.sas, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    assert.equal(devices.list().length, 0, '桌面确认前不得写入设备表');
    assert.equal(pairing.statusFor(pending.ticket).status, 'pending');

    const paired = pairing.approve({ pairingId: session.pairingId, ticket: pending.ticket, approve: true });
    assert.equal(paired.status, 'paired');
    assert.equal(paired.auth, 'token');
    assert.equal(paired.devicePublicKey, device.publicKeyRaw);
    assert.equal(paired.hostId, 'h_test1234');
    assert.equal(paired.relayDomain, 'relay.test');
    assert.equal(paired.mobilePort, 11443);
    assert.equal(devices.list().length, 1);
    const stored = devices.list()[0];
    assert.equal(stored.name, 'iPhone 15 Pro');
    assert.equal(stored.groupPublicKey, device.publicKeyRaw);
    assert.ok(stored.publicKeyFingerprint.length > 0);

    const final = pairing.statusFor(pending.ticket);
    assert.equal(final.status, 'paired');
    assert.equal(final.deviceId, stored.id);

    // 一次性 secret：配对完成后旧 secret 不能再次发起请求
    assert.throws(
      () => pairing.handlePairRequest({
        secret: parsed.secret,
        publicKey: makeGroupDevice().publicKeyRaw,
        deviceName: 'x',
        platform: 'ios',
        remoteAddress: '127.0.0.1',
      }),
      /没有有效的配对会话|没有有效/,
    );
  } finally {
    home.cleanup();
  }
});

test('群体配对：requireApproval=false 时直接登记设备公钥', async () => {
  const { home, devices, pairing } = await setup({ requireApproval: false });
  try {
    const device = makeGroupDevice('Pixel 9');
    const session = pairing.createSession();
    const parsed = parseGroupPairingUri(session.uri);
    const paired = pairing.handlePairRequest({
      secret: parsed.secret,
      publicKey: device.publicKeyRaw,
      deviceName: 'Pixel 9',
      platform: 'android',
      remoteAddress: '127.0.0.1',
    });
    assert.equal(paired.status, 'paired');
    assert.equal(paired.auth, 'token');
    assert.equal(devices.list().length, 1);
    assert.equal(devices.list()[0].platform, 'android');
  } finally {
    home.cleanup();
  }
});

test('群体配对：未注册群体服务时不能创建配对会话', async () => {
  const home = withTempHome();
  try {
    const { loadOrCreateHostIdentity } = await import('../lib/identity.js');
    const { DeviceStore } = await import('../lib/devices.js');
    const { PairingManager } = await import('../lib/pairing.js');
    const pairing = new PairingManager({
      identity: loadOrCreateHostIdentity(),
      devices: new DeviceStore(),
      audit: { append() {} },
      getConfig: () => ({ hostName: 'Test Mac', requireApproval: true }),
      getGroupInfo: () => undefined,
    });
    assert.throws(() => pairing.createSession(), (error) => error.code === 'not-registered' && error.status === 409);
  } finally {
    home.cleanup();
  }
});

test('群体配对：非法公钥被拒绝（必须 P-256 未压缩点）', async () => {
  const { home, pairing } = await setup();
  try {
    const session = pairing.createSession();
    const parsed = parseGroupPairingUri(session.uri);
    for (const publicKey of ['', 'not-a-key', Buffer.alloc(64).toString('base64url')]) {
      assert.throws(
        () => pairing.handlePairRequest({
          secret: parsed.secret,
          publicKey,
          deviceName: 'x',
          platform: 'ios',
          remoteAddress: '127.0.0.1',
        }),
        (error) => error.code === 'invalid-public-key',
      );
    }
  } finally {
    home.cleanup();
  }
});

test('群体配对：错误 secret 被拒绝并计数，超限后 rate-limited', async () => {
  const { home, pairing } = await setup({ requireApproval: false });
  try {
    const device = makeGroupDevice();
    pairing.createSession();
    assert.throws(
      () => pairing.handlePairRequest({
        secret: 'wrong',
        publicKey: device.publicKeyRaw,
        deviceName: 'x',
        platform: 'ios',
        remoteAddress: '127.0.0.1',
      }),
      /配对密钥不正确/,
    );
    for (let i = 0; i < 10; i += 1) {
      try {
        pairing.handlePairRequest({
          secret: `bad-${i}`,
          publicKey: device.publicKeyRaw,
          deviceName: 'x',
          platform: 'ios',
          remoteAddress: '203.0.113.1',
        });
      } catch {
        /* 预期失败 */
      }
    }
    assert.throws(
      () => pairing.handlePairRequest({
        secret: 'bad-final',
        publicKey: device.publicKeyRaw,
        deviceName: 'x',
        platform: 'ios',
        remoteAddress: '203.0.113.1',
      }),
      (error) => error.code === 'rate-limited' && error.status === 429,
    );
  } finally {
    home.cleanup();
  }
});

test('群体配对：同一把设备公钥重新配对复用原设备记录并重新激活', async () => {
  const { home, devices, pairing } = await setup({ requireApproval: false });
  try {
    const device = makeGroupDevice('Old iPhone');
    const first = pairing.createSession();
    const firstPaired = pairing.handlePairRequest({
      secret: parseGroupPairingUri(first.uri).secret,
      publicKey: device.publicKeyRaw,
      deviceName: 'Old iPhone',
      platform: 'ios',
      remoteAddress: '127.0.0.1',
    });
    assert.equal(firstPaired.status, 'paired');
    const deviceId = firstPaired.deviceId;
    devices.revoke(deviceId);

    const second = pairing.createSession();
    const secondPaired = pairing.handlePairRequest({
      secret: parseGroupPairingUri(second.uri).secret,
      publicKey: device.publicKeyRaw,
      deviceName: 'Renamed iPhone',
      platform: 'ios',
      remoteAddress: '127.0.0.1',
    });
    assert.equal(secondPaired.status, 'paired');
    assert.equal(secondPaired.deviceId, deviceId, '重新配对应复用原设备 ID');
    assert.equal(devices.list().length, 1);
    assert.equal(devices.get(deviceId).revokedAt, null, '重新配对后设备恢复有效');
    assert.equal(devices.get(deviceId).name, 'Renamed iPhone');
  } finally {
    home.cleanup();
  }
});
