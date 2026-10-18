import test from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { withTempHome, makeCsr, makeEcCsr } from './helpers.js';

test('host identity is stable across reloads; device CA signs CSR', async () => {
  const home = withTempHome();
  try {
    const identityMod = await import('../lib/identity.js');
    const a = identityMod.loadOrCreateHostIdentity();
    const b = identityMod.loadOrCreateHostIdentity();
    assert.equal(a.fingerprint, b.fingerprint);
    assert.equal(a.status, 'created');
    assert.equal(b.status, 'loaded');

    const ca = identityMod.loadOrCreateDeviceCa();
    const csr = makeCsr('iPhone-15-Pro');
    const signed = identityMod.signDeviceCertificate({ ca, csrPem: csr.csrPem, deviceId: 'd_test01', commonName: 'iPhone', days: 1 });
    assert.match(signed.certPem, /BEGIN CERTIFICATE/);
    const leaf = new X509Certificate(signed.certPem);
    const caCert = new X509Certificate(ca.certPem);
    assert.equal(leaf.checkIssued(caCert), true);
    assert.equal(leaf.verify(caCert.publicKey), true);
    assert.equal(leaf.serialNumber.toUpperCase(), signed.serial);

    // EC(P-256) CSR：forge 不支持，改走 openssl；供 Secure Enclave/Keystore 设备使用
    const ec = makeEcCsr('iPhone-EC');
    try {
      const parsedEc = identityMod.parseDeviceCsr(ec.csrPem);
      assert.equal(parsedEc.keyType, 'ec');
      const signedEc = identityMod.signDeviceCertificate({ ca, csrPem: ec.csrPem, deviceId: 'd_ec01', commonName: 'iPhone-EC', days: 1 });
      const ecLeaf = new X509Certificate(signedEc.certPem);
      assert.equal(ecLeaf.checkIssued(caCert), true);
      assert.equal(ecLeaf.verify(caCert.publicKey), true);
      assert.equal(ecLeaf.serialNumber.toUpperCase(), signedEc.serial);
    } finally {
      ec.cleanup();
    }
  } finally {
    home.cleanup();
  }
});
