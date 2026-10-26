import test from 'node:test';
import assert from 'node:assert/strict';
import forge from 'node-forge';
import { checkTlsKeyPair } from '../lib/tls-check.js';
import { makeEcCsrJs, withTempHome, withoutOpenssl } from './helpers.js';

/** 用 forge 生成一张自签的“主机证书”（只用于测试 SAN/证书-私钥匹配逻辑）。 */
function makeServerCert(names) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = `01${forge.util.bytesToHex(forge.random.getBytesSync(15))}`;
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 24 * 3600 * 1000);
  const attrs = [{ name: 'commonName', value: names[0].replace('*.', '') }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([{ name: 'subjectAltName', altNames: names.map((value) => ({ type: 2, value })) }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), keyPem: forge.pki.privateKeyToPem(keys.privateKey) };
}

test('TLS 自检：证书与私钥成对、SAN 覆盖主机名时通过', () => {
  const { certPem, keyPem } = makeServerCert(['h_ab12cd34.relay.example.com']);
  const result = checkTlsKeyPair({ certPem, keyPem, fqdn: 'h_ab12cd34.relay.example.com' });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.hostname, 'h_ab12cd34.relay.example.com');
  assert.equal(result.certFingerprint, result.keyFingerprint);
});

test('TLS 自检：通配符 SAN 覆盖任意 hostId（含 Node checkHost 不认的下划线 hostId）', () => {
  const { certPem, keyPem } = makeServerCert(['*.relay.example.com', 'relay.example.com']);
  // h_ab12cd34 是项目允许的 hostId 形式（[a-z0-9_-]），但 Node checkHost 会因下划线返回 undefined
  const result = checkTlsKeyPair({ certPem, keyPem, fqdn: 'h_ab12cd34.relay.example.com' });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.hostname, '*.relay.example.com');
  // 单层通配符不应匹配多级子域
  const deep = checkTlsKeyPair({ certPem, keyPem, fqdn: 'a.b.relay.example.com' });
  assert.equal(deep.warnings.length, 1);
});

test('TLS 自检：SAN 不覆盖主机名会给出告警（而不是静默握手失败）', () => {
  const { certPem, keyPem } = makeServerCert(['other.example.com']);
  const result = checkTlsKeyPair({ certPem, keyPem, fqdn: 'h_ab12cd34.relay.example.com' });
  assert.equal(result.error, undefined);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /SAN 未覆盖主机名/);
});

test('TLS 自检：证书与私钥不匹配时报错并给出双方公钥指纹', () => {
  const first = makeServerCert(['h_ab12cd34.relay.example.com']);
  const second = makeServerCert(['h_ab12cd34.relay.example.com']);
  const result = checkTlsKeyPair({ certPem: first.certPem, keyPem: second.keyPem });
  assert.match(result.error, /证书与私钥不匹配/);
  assert.match(result.error, /modulus/);
  assert.notEqual(result.certFingerprint, result.keyFingerprint);
});

test('TLS 自检：EC 证书用 checkPrivateKey 判断（不依赖 RSA modulus）', async () => {
  const home = withTempHome();
  try {
    const identity = await import('../lib/identity.js');
    const ca = identity.loadOrCreateDeviceCa();
    const csr = makeEcCsrJs('iPhone EC TLS');
    const signed = withoutOpenssl(() =>
      identity.signDeviceCertificate({ ca, csrPem: csr.csrPem, deviceId: 'd_tls01', commonName: 'iPhone EC TLS' }),
    );
    const match = checkTlsKeyPair({ certPem: signed.certPem, keyPem: csr.privateKeyPem });
    assert.equal(match.error, undefined);
    assert.equal(match.certFingerprint, match.keyFingerprint);

    const otherCsr = makeEcCsrJs('another EC');
    const mismatch = checkTlsKeyPair({ certPem: signed.certPem, keyPem: otherCsr.privateKeyPem });
    assert.match(mismatch.error, /证书与私钥不匹配/);
  } finally {
    home.cleanup();
  }
});

test('TLS 自检：fullchain 里有多张证书时只看叶子证书', () => {
  const leaf = makeServerCert(['h_ab12cd34.relay.example.com']);
  const ca = makeServerCert(['DSH Remote Test CA']);
  const fullchain = `${leaf.certPem}${ca.certPem}`;
  const result = checkTlsKeyPair({ certPem: fullchain, keyPem: leaf.keyPem, fqdn: 'h_ab12cd34.relay.example.com' });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.warnings, []);
});

test('TLS 自检：证书/私钥不是 PEM 时给出可读错误', () => {
  assert.match(checkTlsKeyPair({ certPem: 'nope', keyPem: 'nope' }).error, /TLS 证书解析失败/);
  const { certPem } = makeServerCert(['h_ab12cd34.relay.example.com']);
  assert.match(checkTlsKeyPair({ certPem, keyPem: 'nope' }).error, /TLS 私钥解析失败/);
});
