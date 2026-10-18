import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import forge from 'node-forge';
import { paths, ensureDir, fileExists, readJson, writeJson, writeText } from './paths.js';
import { sha256Base64Url } from 'dsh-remote-protocol';

function readText(file) {
  return readFileSync(file, 'utf8');
}

function randomSerial() {
  // X.509 serial 必须是正数：首字节固定为 0x01，避免 DER INTEGER 最高位被解释为负数
  // （Node X509Certificate.serialNumber 会输出带 '-' 的负值，导致设备注册表匹配失败）。
  return `01${randomBytes(15).toString('hex')}`;
}

/** ED25519 主机身份：用于配对指纹与后续签名。 */
export function loadOrCreateHostIdentity() {
  const file = paths.hostIdentity();
  const stored = readJson(file, undefined);
  if (stored?.privateKeyJwk) {
    const privateKey = createPrivateKey({ key: stored.privateKeyJwk, format: 'jwk' });
    const publicKey = createPublicKey(privateKey);
    return {
      status: 'loaded',
      privateKey,
      publicKey,
      publicKeyDerB64: stored.publicKeyDerB64,
      fingerprint: sha256Base64Url(Buffer.from(stored.publicKeyDerB64, 'base64url')),
    };
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const publicKeyDerB64 = Buffer.from(der).toString('base64url');
  const privateKeyJwk = privateKey.export({ format: 'jwk' });
  ensureDir(paths.dir());
  writeJson(file, { version: 1, publicKeyDerB64, privateKeyJwk });
  return {
    status: 'created',
    privateKey,
    publicKey,
    publicKeyDerB64,
    fingerprint: sha256Base64Url(Buffer.from(publicKeyDerB64, 'base64url')),
  };
}

/** 用主机身份签名（应用层挑战/诊断用）。 */
export function hostSign(identity, data) {
  return sign(null, Buffer.from(data), identity.privateKey).toString('base64url');
}

export function hostVerify(identity, data, signatureB64) {
  return verify(null, Buffer.from(data), identity.publicKey, Buffer.from(signatureB64, 'base64url'));
}

/** 生成/加载设备 CA（RSA 2048，自签，10 年）。设备证书由它签发。 */
export function loadOrCreateDeviceCa() {
  const keyFile = paths.deviceCaKey();
  const certFile = paths.deviceCaCert();
  if (fileExists(keyFile) && fileExists(certFile)) {
    const keyPem = readText(keyFile);
    const certPem = readText(certFile);
    return { status: 'loaded', keyPem, certPem, key: forge.pki.privateKeyFromPem(keyPem), cert: forge.pki.certificateFromPem(certPem) };
  }
  ensureDir(paths.dir());
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomSerial();
  cert.validity.notBefore = new Date(Date.now() - 5 * 60 * 1000);
  cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000);
  const attrs = [
    { name: 'commonName', value: 'DSH Remote Device CA' },
    { name: 'organizationName', value: 'DSH Remote' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, pathLenConstraint: 0 },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
  const certPem = forge.pki.certificateToPem(cert);
  writeText(keyFile, keyPem);
  writeText(certFile, certPem);
  return { status: 'created', keyPem, certPem, key: keys.privateKey, cert };
}

/** 解析并校验 CSR；返回 forge CSR 与设备公钥指纹。 */
export function parseDeviceCsr(csrPem) {
  if (typeof csrPem !== 'string' || !csrPem.includes('BEGIN CERTIFICATE REQUEST')) throw new Error('csrPem 不是合法 CSR');
  try {
    const csr = forge.pki.certificationRequestFromPem(csrPem);
    if (!csr.verify()) throw new Error('CSR 签名校验失败');
    const publicKeyPem = forge.pki.publicKeyToPem(csr.publicKey);
    return { csr, publicKeyPem, publicKeyFingerprint: sha256Base64Url(publicKeyPem), keyType: 'rsa' };
  } catch (forgeError) {
    // forge 不支持 EC(P-256) CSR；用 openssl 校验，供 Secure Enclave/Keystore 设备使用。
    try {
      verifyCsrWithOpenssl(csrPem);
    } catch (opensslError) {
      const error = new Error(`CSR 解析失败（forge: ${forgeError.message}; openssl: ${opensslError.message}）`);
      error.cause = opensslError;
      throw error;
    }
    return {
      csr: undefined,
      publicKeyPem: undefined,
      // EC 场景以 CSR 原始内容哈希作为稳定设备公钥标识（CSR 内含公钥，等价绑定）
      publicKeyFingerprint: sha256Base64Url(csrPem),
      keyType: 'ec',
    };
  }
}

/** 用 openssl 校验 PKCS#10 CSR 签名（EC/RSA 均可；EC 为主）。 */
export function verifyCsrWithOpenssl(csrPem) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-remote-csr-'));
  try {
    const csrPath = join(dir, 'device.csr');
    writeFileSync(csrPath, csrPem, { mode: 0o600 });
    try {
      execFileSync('openssl', ['req', '-in', csrPath, '-verify', '-noout'], { stdio: 'pipe', timeout: 10_000 });
    } catch (error) {
      const detail = error?.stderr ? String(error.stderr).trim().split('\n').slice(-3).join(' | ') : error.message;
      throw new Error(`openssl 校验 CSR 失败: ${detail}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 用 openssl 以设备 CA 签发 EC（或 forge 不支持的）CSR。
 * 必需：主机上安装 openssl（macOS/Linux 默认有）。
 */
export function signDeviceCertificateWithOpenssl({ ca, csrPem, deviceId, commonName, days = 30 }) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-remote-sign-'));
  try {
    const csrPath = join(dir, 'device.csr');
    const caCertPath = join(dir, 'ca.crt');
    const caKeyPath = join(dir, 'ca.key');
    const extPath = join(dir, 'ext.cnf');
    const certPath = join(dir, 'device.crt');
    writeFileSync(csrPath, csrPem, { mode: 0o600 });
    writeFileSync(caCertPath, ca.certPem, { mode: 0o600 });
    writeFileSync(caKeyPath, ca.keyPem, { mode: 0o600 });
    writeFileSync(extPath, [
      'basicConstraints=CA:FALSE',
      'keyUsage=digitalSignature,keyEncipherment',
      'extendedKeyUsage=clientAuth',
      'subjectKeyIdentifier=hash',
      '',
    ].join('\n'), { mode: 0o600 });
    try {
      execFileSync('openssl', [
        'x509', '-req', '-in', csrPath,
        '-CA', caCertPath, '-CAkey', caKeyPath, '-CAcreateserial',
        '-days', String(Math.max(1, days)), '-sha256',
        '-extfile', extPath, '-out', certPath,
      ], { stdio: 'pipe', timeout: 15_000 });
    } catch (error) {
      const detail = error?.stderr ? String(error.stderr).trim().split('\n').slice(-3).join(' | ') : error.message;
      throw new Error(`openssl 签发设备证书失败: ${detail}`);
    }
    const certPem = readFileSync(certPath, 'utf8');
    const caX509 = new X509Certificate(ca.certPem);
    const leaf = new X509Certificate(certPem);
    if (!leaf.checkIssued(caX509) || !leaf.verify(caX509.publicKey)) {
      throw new Error('openssl 签发的设备证书未通过 CA 校验');
    }
    return {
      certPem,
      serial: leaf.serialNumber.toUpperCase(),
      notAfter: Date.parse(leaf.validTo),
      devicePublicKeyFingerprint: sha256Base64Url(csrPem),
      keyType: 'ec',
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 用设备 CA 签发客户端证书。
 * @returns {{certPem: string, serial: string, notAfter: number, devicePublicKeyFingerprint: string}}
 */
export function signDeviceCertificate({ ca, csrPem, deviceId, commonName, days = 30 }) {
  let parsed;
  try {
    parsed = parseDeviceCsr(csrPem);
  } catch (error) {
    throw error;
  }
  if (parsed.keyType === 'ec') {
    return signDeviceCertificateWithOpenssl({ ca, csrPem, deviceId, commonName, days });
  }
  const serial = randomSerial();
  const cert = forge.pki.createCertificate();
  cert.publicKey = parsed.csr.publicKey;
  cert.serialNumber = serial;
  cert.validity.notBefore = new Date(Date.now() - 5 * 60 * 1000);
  cert.validity.notAfter = new Date(Date.now() + Math.max(1, days) * 24 * 3600 * 1000);
  cert.setSubject([
    { name: 'commonName', value: commonName || deviceId },
    { name: 'organizationName', value: 'DSH Remote Device' },
    { name: 'organizationalUnitName', value: deviceId },
  ]);
  cert.setIssuer(ca.cert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', clientAuth: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(ca.key, forge.md.sha256.create());
  return {
    certPem: forge.pki.certificateToPem(cert),
    serial: serial.toUpperCase(),
    notAfter: cert.validity.notAfter.getTime(),
    devicePublicKeyFingerprint: parsed.publicKeyFingerprint,
  };
}

/** 本地 POC：生成自签的开发用 TLS 证书（生产必须换成 B2 的 LE 证书）。 */
export function loadOrCreateDevServerCert(fqdn) {
  const certFile = paths.devTlsCert();
  const keyFile = paths.devTlsKey();
  const metaFile = `${paths.devTlsKey()}.json`;
  const meta = readJson(metaFile, undefined);
  if (fileExists(certFile) && fileExists(keyFile) && meta?.fqdn === fqdn) {
    return { status: 'loaded', certPem: readText(certFile), keyPem: readText(keyFile), dev: true };
  }
  ensureDir(paths.dir());
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomSerial();
  cert.validity.notBefore = new Date(Date.now() - 5 * 60 * 1000);
  cert.validity.notAfter = new Date(Date.now() + 90 * 24 * 3600 * 1000);
  const attrs = [
    { name: 'commonName', value: fqdn },
    { name: 'organizationName', value: 'DSH Remote (DEV)' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, keyCertSign: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [{ type: 2, value: fqdn }, { type: 7, ip: '127.0.0.1' }] },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const certPem = forge.pki.certificateToPem(cert);
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
  writeText(certFile, certPem);
  writeText(keyFile, keyPem);
  writeJson(metaFile, { fqdn, createdAt: Date.now() });
  return { status: 'created', certPem, keyPem, dev: true };
}
