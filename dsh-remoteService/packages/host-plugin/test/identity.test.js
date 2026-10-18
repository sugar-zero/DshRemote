import test from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { withTempHome, makeCsr } from './helpers.js';

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
  } finally {
    home.cleanup();
  }
});
