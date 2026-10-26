import test from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { withTempHome, makeCsr, makeEcCsrJs, withoutOpenssl } from './helpers.js';
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

test('pairing: publicPort is included in the QR host (direct relay mode)', async () => {
  const home = withTempHome();
  try {
    const { loadOrCreateHostIdentity, loadOrCreateDeviceCa } = await import('../lib/identity.js');
    const { DeviceStore } = await import('../lib/devices.js');
    const { PairingManager } = await import('../lib/pairing.js');
    const pairing = new PairingManager({
      identity: loadOrCreateHostIdentity(),
      ca: loadOrCreateDeviceCa(),
      devices: new DeviceStore(),
      audit: { append() {} },
      getConfig: () => ({
        hostId: 'h_test',
        relayDomain: 'relay.test',
        publicPort: 1443,
        requireApproval: false,
      }),
    });
    const session = pairing.createSession();
    const parsed = parsePairingUri(session.uri);
    assert.equal(parsed.host, 'h_test.relay.test:1443');
    assert.equal(parsed.relayDomain, 'relay.test');
  } finally {
    home.cleanup();
  }
});

test('pairing: EC（Secure Enclave）CSR 在无 openssl 主机上也能完成配对', async () => {
  const home = withTempHome();
  try {
    const { loadOrCreateHostIdentity, loadOrCreateDeviceCa } = await import('../lib/identity.js');
    const { DeviceStore } = await import('../lib/devices.js');
    const { AuditLog } = await import('../lib/audit.js');
    const { PairingManager } = await import('../lib/pairing.js');
    const identity = loadOrCreateHostIdentity();
    const ca = loadOrCreateDeviceCa();
    const devices = new DeviceStore();
    const config = { hostId: 'h_ec', relayDomain: 'relay.test', hostName: 'Test Win', requireApproval: false };
    const pairing = new PairingManager({ identity, ca, devices, audit: new AuditLog(), getConfig: () => config });

    const session = pairing.createSession();
    const parsed = parsePairingUri(session.uri);
    const csr = makeEcCsrJs('iPhone SE');
    // 模拟 Windows 主机：PATH 置空 → 主机端找不到 openssl，走纯 JS 回退
    const paired = withoutOpenssl(() =>
      pairing.handlePairRequest({
        secret: parsed.secret,
        csrPem: csr.csrPem,
        deviceName: 'iPhone SE',
        platform: 'ios',
        remoteAddress: '127.0.0.1',
      }),
    );
    assert.equal(paired.status, 'paired');
    assert.match(paired.certPem, /BEGIN CERTIFICATE/);
    assert.equal(devices.list().length, 1);
    assert.equal(devices.list()[0].name, 'iPhone SE');

    const leaf = new X509Certificate(paired.certPem);
    const caCert = new X509Certificate(paired.caPem);
    assert.equal(leaf.checkIssued(caCert), true);
    assert.equal(leaf.verify(caCert.publicKey), true);
    // 手机端后续 mTLS 用的就是这把 EC 私钥
    assert.equal(leaf.checkPrivateKey(createPrivateKey(csr.privateKeyPem)), true);
    assert.equal(leaf.serialNumber.toUpperCase(), paired.serial);
  } finally {
    home.cleanup();
  }
});
