import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import forge from 'node-forge';
import { buildUnsupportedDeviceCertificate, parseUnsupportedCsr, verifyCsrSignatureWithNode } from './ec-csr.js';
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

/**
 * 解析并校验 CSR；返回 forge CSR 与设备公钥指纹。
 *
 * 引擎选择：
 *   1. RSA CSR → node-forge（完整解析 + 签名校验）；
 *   2. 非 RSA（iOS Secure Enclave 的 EC P-256 为主，forge 不支持）→ 优先系统 `openssl`；
 *   3. openssl 不存在/不可执行（典型：Windows 默认没有）→ 回退纯 JS（node:crypto + forge.asn1）。
 *
 * `engine` 字段会写进审计/日志，便于排查某台主机走的是哪条路径。
 */
export function parseDeviceCsr(csrPem) {
  if (typeof csrPem !== 'string' || !csrPem.includes('BEGIN CERTIFICATE REQUEST')) throw new Error('csrPem 不是合法 CSR');
  let forgeError;
  try {
    const csr = forge.pki.certificationRequestFromPem(csrPem);
    if (!csr.verify()) throw new Error('CSR 签名校验失败');
    const publicKeyPem = forge.pki.publicKeyToPem(csr.publicKey);
    return { csr, publicKeyPem, publicKeyFingerprint: sha256Base64Url(publicKeyPem), keyType: 'rsa', engine: 'forge' };
  } catch (error) {
    forgeError = error;
  }

  // forge 不支持 EC/Ed25519：先走 openssl
  let opensslError;
  let opensslVerified = false;
  try {
    verifyCsrWithOpenssl(csrPem);
    opensslVerified = true;
  } catch (error) {
    opensslError = error;
  }
  if (opensslVerified) {
    // 纵深防御：能解析就再用 node:crypto 独立复核一次自签名，避免只凭 openssl 退出码下结论。
    // 纯 JS 解析不了（未知密钥/算法）时保留 openssl 的结论（能力不足 ≠ 放行已知坏签名）。
    let jsParsed;
    let jsError;
    try {
      jsParsed = parseUnsupportedCsr(csrPem);
      verifyCsrSignatureWithNode(jsParsed);
    } catch (error) {
      jsError = error;
    }
    if (jsParsed && jsError && jsError.code !== 'UNSUPPORTED_CSR_ALGORITHM') {
      const error = new Error(`CSR 签名校验失败（openssl 通过，但纯 JS 复核未通过: ${jsError.message}）`);
      error.cause = jsError;
      throw error;
    }
    return {
      csr: undefined,
      publicKeyPem: jsParsed?.spkiPem,
      publicKeyFingerprint: devicePublicKeyFingerprint(jsParsed, csrPem),
      keyType: 'ec',
      engine: 'openssl',
    };
  }
  if (!isMissingExecutable(opensslError)) {
    // openssl 明确拒绝（签名不对/CSR 非法）→ 不能保底放行
    const error = new Error(`CSR 解析失败（forge: ${forgeError.message}; ${opensslError.message}）`);
    error.cause = opensslError;
    throw error;
  }
  // openssl 不可用：纯 JS 回退
  let parsed;
  let jsError;
  try {
    parsed = parseUnsupportedCsr(csrPem);
    verifyCsrSignatureWithNode(parsed);
  } catch (error) {
    jsError = error;
  }
  if (jsError) {
    const error = new Error(
      `CSR 解析失败（forge: ${forgeError.message}; openssl 不可用（${opensslError.message}）; 纯 JS 校验: ${jsError.message}）`,
    );
    error.cause = jsError;
    throw error;
  }
  return {
    csr: undefined,
    publicKeyPem: parsed.spkiPem,
    publicKeyFingerprint: sha256Base64Url(parsed.spkiPem),
    keyType: 'ec',
    engine: 'js',
  };
}

/**
 * 非 RSA 设备公钥指纹：优先用 SPKI 公钥的哈希（语义与 RSA 路径一致：同一把钥匙恒定）；
 * 万一纯 JS 解析不了（未知密钥类型），退回 CSR 原始内容哈希以保持兼容。
 */
function devicePublicKeyFingerprint(parsed, csrPem) {
  return parsed?.spkiPem ? sha256Base64Url(parsed.spkiPem) : sha256Base64Url(csrPem);
}

/** 子进程调用失败是否属于「可执行文件本身找不到/不可执行」（用于决定回退纯 JS）。 */
function isMissingExecutable(error) {
  const code = error?.code;
  // EPERM：Windows 上被策略/杀软阻止执行；ENOENT：没装；EACCES/ENOTDIR：不可执行/路径不对。
  // 这些都属于「本机无法用 openssl」，回退纯 JS 是安全的（JS 会独立验 CSR 自签名）。
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM';
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
      // 找不到 openssl（ENOENT）时保留原始错误，让调用方回退纯 JS；其余失败视为校验不通过
      if (isMissingExecutable(error)) throw error;
      const detail = error?.stderr ? String(error.stderr).trim().split('\n').slice(-3).join(' | ') : error.message;
      const wrapped = new Error(`openssl 校验 CSR 失败: ${detail}`);
      wrapped.code = 'OPENSSL_CSR_VERIFY_FAILED';
      throw wrapped;
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
    return signNonRsaDeviceCertificate({
      ca,
      csrPem,
      deviceId,
      commonName,
      days,
      publicKeyFingerprint: parsed.publicKeyFingerprint,
    });
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
    engine: 'forge',
  };
}

/**
 * 非 RSA 设备证书签发：优先 openssl（历史行为），不可用/失败时回退纯 JS。
 * 两条路径都拿设备 CA 的 RSA 私钥以 SHA-256 签名，且纯 JS 路径会**重新解析并校验 CSR 自签名**，
 * 因此「openssl 存在但签发失败」时回退到 JS 也不会放过坏 CSR（失败是 fail-closed 的）。
 */
function signNonRsaDeviceCertificate({ ca, csrPem, deviceId, commonName, days, publicKeyFingerprint }) {
  let opensslError;
  try {
    const signed = signDeviceCertificateWithOpenssl({ ca, csrPem, deviceId, commonName, days });
    return { ...signed, devicePublicKeyFingerprint: publicKeyFingerprint, engine: 'openssl' };
  } catch (error) {
    opensslError = error;
  }
  try {
    const serial = randomSerial();
    const signed = buildUnsupportedDeviceCertificate({
      caCertPem: ca.certPem,
      caKeyPem: ca.keyPem,
      csrPem,
      serial,
      commonName,
      deviceId,
      days,
    });
    return {
      certPem: signed.certPem,
      serial: signed.serial,
      notAfter: signed.notAfter,
      devicePublicKeyFingerprint: publicKeyFingerprint,
      engine: 'js',
    };
  } catch (jsError) {
    const error = new Error(`签发非 RSA 设备证书失败（openssl: ${opensslError.message}; 纯 JS: ${jsError.message}）`);
    error.cause = jsError;
    throw error;
  }
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
