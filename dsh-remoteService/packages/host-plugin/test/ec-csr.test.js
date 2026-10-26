import test from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate, createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import tls from 'node:tls';
import forge from 'node-forge';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hasOpenssl,
  makeCsr,
  makeEcCsr,
  makeEcCsrJs,
  pemEncode,
  withTempHome,
  withoutOpenssl,
} from './helpers.js';

async function loadIdentity() {
  return import('../lib/identity.js');
}

/** 用一个假的 openssl（POSIX 脚本）跑同步回调，模拟「openssl 存在但行为异常」。 */
function withFakeOpenssl(script, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fake-openssl-'));
  const file = join(dir, 'openssl');
  writeFileSync(file, script, { mode: 0o755 });
  chmodSync(file, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${dir}:${previous}`;
  try {
    return fn();
  } finally {
    process.env.PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-remote-doctest-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('非 RSA CSR：openssl 不可用（Windows 默认）时回退纯 JS 校验', async () => {
  const home = withTempHome();
  try {
    const identity = await loadIdentity();
    const csr = makeEcCsrJs('iPhone-NoOpenSSL');
    const parsed = withoutOpenssl(() => identity.parseDeviceCsr(csr.csrPem));
    assert.equal(parsed.keyType, 'ec');
    assert.equal(parsed.engine, 'js');
    assert.match(parsed.publicKeyPem, /BEGIN PUBLIC KEY/);
    // 旧行为：非 RSA 场景的指纹 = CSR 原始内容哈希（设备注册表/审计沿用）
    assert.match(parsed.publicKeyFingerprint, /^[A-Za-z0-9_-]+$/);
  } finally {
    home.cleanup();
  }
});

test('纯 JS 校验拒绝被篡改的 CSR 签名', async () => {
  const home = withTempHome();
  try {
    const identity = await loadIdentity();
    const csr = makeEcCsrJs('tampered');
    const der = Buffer.from(csr.der);
    der[der.length - 1] ^= 0xff; // 改掉签名最后一个字节
    const pem = pemEncode(der, 'CERTIFICATE REQUEST');
    assert.throws(() => withoutOpenssl(() => identity.parseDeviceCsr(pem)), /CSR 解析失败.*纯 JS 校验/s);
  } finally {
    home.cleanup();
  }
});

test('纯 JS 校验拒绝「公钥与签名私钥不是一对」的 CSR', async () => {
  const home = withTempHome();
  try {
    const identity = await loadIdentity();
    const csr = makeEcCsrJs('mismatch', { mismatchSignature: true });
    assert.throws(() => withoutOpenssl(() => identity.parseDeviceCsr(csr.csrPem)), /CSR 解析失败.*纯 JS 校验/s);
  } finally {
    home.cleanup();
  }
});

test('纯 JS 签发 EC 设备证书：链、serial、公钥绑定与设备私钥都对得上', async () => {
  const home = withTempHome();
  try {
    const identity = await loadIdentity();
    const ca = identity.loadOrCreateDeviceCa();
    const csr = makeEcCsrJs('iPhone EC');
    const signed = withoutOpenssl(() =>
      identity.signDeviceCertificate({ ca, csrPem: csr.csrPem, deviceId: 'd_ec01', commonName: 'iPhone EC', days: 3 }),
    );
    assert.equal(signed.engine, 'js');
    assert.match(signed.certPem, /BEGIN CERTIFICATE/);

    const leaf = new X509Certificate(signed.certPem);
    const caCert = new X509Certificate(ca.certPem);
    assert.equal(leaf.checkIssued(caCert), true);
    assert.equal(leaf.verify(caCert.publicKey), true);
    assert.equal(leaf.serialNumber.toUpperCase(), signed.serial);
    assert.ok(Math.abs(Date.parse(leaf.validTo) - signed.notAfter) < 1000);
    assert.match(leaf.subject, /iPhone EC/);
    // 设备端后续 mTLS 用的是 CSR 里那把 EC 私钥，必须与证书公钥成对
    assert.equal(leaf.checkPrivateKey(createPrivateKey(csr.privateKeyPem)), true);
  } finally {
    home.cleanup();
  }
});

test('openssl 生成的真实 EC CSR 也能被纯 JS 回退接受并签发', { skip: !hasOpenssl() && '本机没有 openssl' }, async () => {
  const home = withTempHome();
  try {
    const identity = await loadIdentity();
    const ca = identity.loadOrCreateDeviceCa();
    const ec = makeEcCsr('iPhone-FromOpenSSL');
    try {
      const parsed = withoutOpenssl(() => identity.parseDeviceCsr(ec.csrPem));
      assert.equal(parsed.engine, 'js');
      const signed = withoutOpenssl(() =>
        identity.signDeviceCertificate({ ca, csrPem: ec.csrPem, deviceId: 'd_ec02', commonName: 'iPhone-FromOpenSSL' }),
      );
      assert.equal(signed.engine, 'js');
      const leaf = new X509Certificate(signed.certPem);
      const caCert = new X509Certificate(ca.certPem);
      assert.equal(leaf.checkIssued(caCert), true);
      assert.equal(leaf.verify(caCert.publicKey), true);
      assert.equal(leaf.checkPrivateKey(createPrivateKey(ec.privateKeyPem)), true);
    } finally {
      ec.cleanup();
    }
  } finally {
    home.cleanup();
  }
});

test('纯 JS 签发的 EC 证书可通过 openssl 验链（独立交叉验证）', { skip: !hasOpenssl() && '本机没有 openssl' }, async () => {
  const home = withTempHome();
  try {
    const identity = await loadIdentity();
    const ca = identity.loadOrCreateDeviceCa();
    const csr = makeEcCsrJs('iPhone-OpenSSL-Check');
    const signed = withoutOpenssl(() =>
      identity.signDeviceCertificate({ ca, csrPem: csr.csrPem, deviceId: 'd_ec03', commonName: 'iPhone-OpenSSL-Check' }),
    );
    withTempDir((dir) => {
      const caPath = join(dir, 'ca.pem');
      const leafPath = join(dir, 'leaf.pem');
      writeFileSync(caPath, ca.certPem);
      writeFileSync(leafPath, signed.certPem);
      const verify = execFileSync('openssl', ['verify', '-CAfile', caPath, leafPath], { encoding: 'utf8' });
      assert.match(verify, /OK/);
      const text = execFileSync('openssl', ['x509', '-in', leafPath, '-noout', '-text'], { encoding: 'utf8' });
      assert.match(text, /id-ecPublicKey/);
      assert.match(text, /TLS Web Client Authentication/);
      assert.match(text, /CA:FALSE/);
      assert.ok(text.replace(/[:\s]/g, '').toLowerCase().includes(signed.serial.toLowerCase()));
    });
  } finally {
    home.cleanup();
  }
});

test('openssl 可用时优先走 openssl（不改变 macOS/Linux 现有行为）', { skip: !hasOpenssl() && '本机没有 openssl' }, async () => {
  const home = withTempHome();
  try {
    const identity = await loadIdentity();
    const ca = identity.loadOrCreateDeviceCa();
    const csr = makeEcCsrJs('iPhone-OpenSSL');
    const parsed = identity.parseDeviceCsr(csr.csrPem);
    assert.equal(parsed.engine, 'openssl');
    const signed = identity.signDeviceCertificate({ ca, csrPem: csr.csrPem, deviceId: 'd_ec04', commonName: 'iPhone-OpenSSL' });
    assert.equal(signed.engine, 'openssl');
    const leaf = new X509Certificate(signed.certPem);
    assert.equal(leaf.checkPrivateKey(createPrivateKey(csr.privateKeyPem)), true);
  } finally {
    home.cleanup();
  }
});

test('openssl 明确拒绝的坏 CSR 不会被静默放行', { skip: !hasOpenssl() && '本机没有 openssl' }, async () => {
  const home = withTempHome();
  try {
    const identity = await loadIdentity();
    const csr = makeEcCsrJs('bad-signature');
    const der = Buffer.from(csr.der);
    der[der.length - 1] ^= 0xff;
    const pem = pemEncode(der, 'CERTIFICATE REQUEST');
    assert.throws(() => identity.parseDeviceCsr(pem), /CSR 解析失败.*openssl/s);
  } finally {
    home.cleanup();
  }
});

test('RSA CSR 仍走 forge 路径（engine=forge）', async () => {
  const home = withTempHome();
  try {
    const identity = await loadIdentity();
    const parsed = identity.parseDeviceCsr(makeCsr('rsa-device').csrPem);
    assert.equal(parsed.keyType, 'rsa');
    assert.equal(parsed.engine, 'forge');
  } finally {
    home.cleanup();
  }
});

test('纯 JS 签发的 EC 设备证书能通过主机真实 mTLS 握手校验', async () => {
  const home = withTempHome();
  try {
    const identity = await import('../lib/identity.js');
    const { DeviceStore } = await import('../lib/devices.js');
    const { createPeerVerifier, createRemoteTlsServer } = await import('../lib/mtls.js');
    const ca = identity.loadOrCreateDeviceCa();
    const hostCert = identity.loadOrCreateDevServerCert('h_ec.relay.test');
    const csr = makeEcCsrJs('iPhone mTLS');
    const signed = withoutOpenssl(() =>
      identity.signDeviceCertificate({ ca, csrPem: csr.csrPem, deviceId: 'd_mtls01', commonName: 'iPhone mTLS' }),
    );
    const devices = new DeviceStore();
    devices.add({
      id: 'd_mtls01',
      name: 'iPhone mTLS',
      platform: 'ios',
      serial: signed.serial,
      publicKeyFingerprint: signed.devicePublicKeyFingerprint,
      notAfter: signed.notAfter,
    });
    const verifyPeer = createPeerVerifier({ devices, caCertPem: ca.certPem });
    const server = createRemoteTlsServer({ certPem: hostCert.certPem, keyPem: hostCert.keyPem });
    server.on('secureConnection', (socket) => {
      const result = verifyPeer(socket);
      socket.end(JSON.stringify(result.ok ? { ok: true, deviceId: result.device.id, serial: result.serial } : result));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = server.address().port;
      const body = await new Promise((resolve, reject) => {
        const socket = tls.connect(
          {
            host: '127.0.0.1',
            port,
            servername: 'h_ec.relay.test',
            ca: hostCert.certPem,
            cert: signed.certPem,
            key: csr.privateKeyPem,
            rejectUnauthorized: true,
          },
          () => {},
        );
        let chunks = '';
        socket.on('data', (chunk) => { chunks += chunk.toString(); });
        socket.on('end', () => resolve(chunks));
        socket.on('error', reject);
      });
      const result = JSON.parse(body);
      assert.equal(result.ok, true);
      assert.equal(result.deviceId, 'd_mtls01');
      assert.equal(result.serial, signed.serial);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    home.cleanup();
  }
});

test('openssl 存在但校验失败（exit 1）时拒绝配对，不回退放行', { skip: process.platform === 'win32' && 'POSIX shell 脚本模拟' }, async () => {
  const home = withTempHome();
  try {
    const identity = await loadIdentity();
    const csr = makeEcCsrJs('valid-but-openssl-fails');
    assert.throws(
      () => withFakeOpenssl('#!/bin/sh\nexit 1\n', () => identity.parseDeviceCsr(csr.csrPem)),
      /CSR 解析失败.*openssl/s,
    );
  } finally {
    home.cleanup();
  }
});

test('openssl 退出 0 但没有真正校验时，篡改 CSR 仍被纯 JS 复核拒绝', { skip: process.platform === 'win32' && 'POSIX shell 脚本模拟' }, async () => {
  const home = withTempHome();
  try {
    const identity = await loadIdentity();
    const csr = makeEcCsrJs('fake-openssl-noop');
    const der = Buffer.from(csr.der);
    der[der.length - 1] ^= 0xff;
    const pem = pemEncode(der, 'CERTIFICATE REQUEST');
    assert.throws(
      () => withFakeOpenssl('#!/bin/sh\nexit 0\n', () => identity.parseDeviceCsr(pem)),
      /纯 JS 复核未通过/,
    );
  } finally {
    home.cleanup();
  }
});

test('纯 JS 校验拒绝结构不合规的 CSR（多余元素 / 缺少 attributes）', async () => {
  const home = withTempHome();
  try {
    const identity = await loadIdentity();
    const csr = makeEcCsrJs('bad-structure');
    const root = forge.asn1.fromDer(forge.util.createBuffer(Buffer.from(csr.der).toString('binary')), {
      strict: true,
      parseAllBytes: true,
      decodeBitStrings: false,
    });
    root.value[0].value.pop(); // 去掉 attributes [0]
    const badDer = Buffer.from(forge.asn1.toDer(root).getBytes(), 'binary');
    assert.throws(
      () => withoutOpenssl(() => identity.parseDeviceCsr(pemEncode(badDer, 'CERTIFICATE REQUEST'))),
      /CertificationRequestInfo|结构/,
    );
  } finally {
    home.cleanup();
  }
});

test('非 RSA 设备公钥指纹按 SPKI 计算：同一把钥匙不同 CSR 指纹相同', async () => {
  const home = withTempHome();
  try {
    const identity = await loadIdentity();
    const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const first = makeEcCsrJs('device-a', { keys });
    const second = makeEcCsrJs('device-b', { keys });
    assert.notEqual(first.csrPem, second.csrPem);
    const a = withoutOpenssl(() => identity.parseDeviceCsr(first.csrPem));
    const b = withoutOpenssl(() => identity.parseDeviceCsr(second.csrPem));
    assert.equal(a.publicKeyFingerprint, b.publicKeyFingerprint);
    assert.match(a.publicKeyFingerprint, /^[A-Za-z0-9_-]{43}/);
  } finally {
    home.cleanup();
  }
});
