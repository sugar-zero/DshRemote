import test from 'node:test';
import assert from 'node:assert/strict';
import { withTempHome, makeCsr } from './helpers.js';
import { buildPairingUri, parsePairingUri } from 'dsh-remote-protocol';

test('pairing: create session -> pending approval -> paired -> device registered; secret single use', async () => {
  const home = withTempHome();
  try {
    const { loadOrCreateHostIdentity, loadOrCreateDeviceCa } = await import('../lib/identity.js');
    const { DeviceStore } = await import('../lib/devices.js');
    const { AuditLog } = await import('../lib/audit.js');
    const { PairingManager } = await import('../lib/pairing.js');
    const identity = loadOrCreateHostIdentity();
    const ca = loadOrCreateDeviceCa();
    const devices = new DeviceStore();
    const audit = new AuditLog();
    const config = { hostId: 'h_test', relayDomain: 'relay.test', hostName: 'Test Mac', requireApproval: true };
    const pairing = new PairingManager({ identity, ca, devices, audit, getConfig: () => config });

    const session = pairing.createSession();
    assert.equal(session.active, true);
    const parsed = parsePairingUri(session.uri);
    assert.equal(parsed.host, 'h_test.relay.test');
    assert.equal(parsed.hostFingerprint, identity.fingerprint);

    const csr = makeCsr('iPhone');
    const pending = pairing.handlePairRequest({ secret: parsed.secret, csrPem: csr.csrPem, deviceName: 'iPhone', platform: 'ios', remoteAddress: '127.0.0.1' });
    assert.equal(pending.status, 'pending');
    assert.match(pending.sas, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    assert.equal(devices.list().length, 0);

    const status = pairing.statusFor(pending.ticket);
    assert.equal(status.status, 'pending');

    const paired = pairing.approve({ pairingId: session.pairingId, ticket: pending.ticket, approve: true });
    assert.equal(paired.status, 'paired');
    assert.match(paired.certPem, /BEGIN CERTIFICATE/);
    assert.equal(devices.list().length, 1);
    assert.equal(devices.list()[0].name, 'iPhone');

    assert.equal(pairing.statusFor(pending.ticket).status, 'paired');
    assert.throws(
      () => pairing.handlePairRequest({ secret: parsed.secret, csrPem: makeCsr().csrPem, deviceName: 'x', platform: 'ios', remoteAddress: '127.0.0.1' }),
      /没有有效的配对会话|没有有效/,
    );
    // 新会话覆盖旧会话
    const session2 = pairing.createSession();
    assert.notEqual(session2.pairingId, session.pairingId);
  } finally {
    home.cleanup();
  }
});

test('pairing: per-IP attempt limit returns rate-limited', async () => {
  const home = withTempHome();
  try {
    const { loadOrCreateHostIdentity, loadOrCreateDeviceCa } = await import('../lib/identity.js');
    const { DeviceStore } = await import('../lib/devices.js');
    const { PairingManager } = await import('../lib/pairing.js');
    const identity = loadOrCreateHostIdentity();
    const ca = loadOrCreateDeviceCa();
    const pairing = new PairingManager({
      identity, ca, devices: new DeviceStore(), audit: { append() {} },
      getConfig: () => ({ hostId: 'h', relayDomain: 'r.test', requireApproval: false }),
    });
    pairing.createSession();
    const csrPem = makeCsr().csrPem;
    for (let i = 0; i < 10; i += 1) {
      assert.throws(
        () => pairing.handlePairRequest({ secret: `bad-${i}`, csrPem, deviceName: 'x', platform: 'ios', remoteAddress: '203.0.113.1' }),
        (error) => error.code === 'invalid-secret',
      );
    }
    assert.throws(
      () => pairing.handlePairRequest({ secret: 'bad-final', csrPem, deviceName: 'x', platform: 'ios', remoteAddress: '203.0.113.1' }),
      (error) => error.code === 'rate-limited' && error.status === 429,
    );
  } finally {
    home.cleanup();
  }
});

test('pairing: bad secret rejected and attempts counted', async () => {
  const home = withTempHome();
  try {
    const { loadOrCreateHostIdentity, loadOrCreateDeviceCa } = await import('../lib/identity.js');
    const { DeviceStore } = await import('../lib/devices.js');
    const { PairingManager } = await import('../lib/pairing.js');
    const identity = loadOrCreateHostIdentity();
    const ca = loadOrCreateDeviceCa();
    const devices = new DeviceStore();
    const audit = { append() {} };
    const pairing = new PairingManager({ identity, ca, devices, audit, getConfig: () => ({ hostId: 'h', relayDomain: 'r.test', requireApproval: false }) });
    const session = pairing.createSession();
    assert.throws(
      () => pairing.handlePairRequest({ secret: 'wrong', csrPem: makeCsr().csrPem, deviceName: 'x', platform: 'ios', remoteAddress: '127.0.0.1' }),
      /配对密钥不正确/,
    );
    assert.equal(pairing.publicSession().status, 'waiting');
    assert.ok(session);
  } finally {
    home.cleanup();
  }
});
