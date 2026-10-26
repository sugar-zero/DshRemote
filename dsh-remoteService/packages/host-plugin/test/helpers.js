import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import forge from 'node-forge';

/** 每个测试独立 $DSH_HOME。 */
export function withTempHome() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-remote-test-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  return {
    dir,
    cleanup() {
      if (previous === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previous;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 生成设备 RSA 密钥 + CSR。 */
export function makeCsr(commonName = 'test-device') {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([{ name: 'commonName', value: commonName }]);
  csr.sign(keys.privateKey, forge.md.sha256.create());
  return {
    csrPem: forge.pki.certificationRequestToPem(csr),
    privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
    publicKey: keys.publicKey,
  };
}

/** 用 openssl 生成 EC(P-256) 设备密钥 + CSR（模拟 Secure Enclave/Keystore 设备）。 */
export function makeEcCsr(commonName = 'ec-device') {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-remote-ec-csr-'));
  const keyPath = join(dir, 'device.key');
  const csrPath = join(dir, 'device.csr');
  execFileSync('openssl', [
    'req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256',
    '-nodes', '-subj', `/CN=${commonName}`, '-keyout', keyPath, '-out', csrPath,
  ], { stdio: 'pipe', timeout: 15_000 });
  const csrPem = readFileSync(csrPath, 'utf8');
  const privateKeyPem = readFileSync(keyPath, 'utf8');
  return {
    csrPem,
    privateKeyPem,
    cleanup() { rmSync(dir, { recursive: true, force: true }); },
  };
}

/** 生成一张「不受信任 CA」签发的客户端证书（用于断言 mTLS 拒绝）。 */
export function makeRogueClientCert(commonName = 'rogue-device') {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = `01${forge.util.bytesToHex(forge.random.getBytesSync(15))}`;
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 24 * 3600 * 1000);
  const attrs = [{ name: 'commonName', value: commonName }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', clientAuth: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey) };
}

/** 用 node:tls 发一个原始 HTTPS 请求（可带客户端证书）。 */
export function tlsRequest({ port, servername, caPem, certPem, keyPem, method = 'GET', path = '/', headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: '127.0.0.1',
      port,
      servername,
      ca: caPem,
      cert: certPem,
      key: keyPem,
      rejectUnauthorized: true,
    }, () => {
      const lines = [`${method} ${path} HTTP/1.1`, `Host: ${headers.Host ?? servername}`, 'Connection: close'];
      const payload = body ? Buffer.from(body) : undefined;
      if (payload) lines.push(`Content-Length: ${payload.length}`);
      for (const [name, value] of Object.entries(headers)) {
        if (name.toLowerCase() === 'host') continue;
        lines.push(`${name}: ${value}`);
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (payload) socket.write(payload);
    });
    const chunks = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const split = raw.indexOf('\r\n\r\n');
      const head = split >= 0 ? raw.slice(0, split) : raw;
      const body = split >= 0 ? raw.slice(split + 4) : '';
      const statusLine = head.split('\r\n')[0] ?? '';
      const status = Number(statusLine.split(' ')[1] ?? 0);
      const responseHeaders = {};
      for (const line of head.split('\r\n').slice(1)) {
        const idx = line.indexOf(':');
        if (idx > 0) responseHeaders[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
      }
      resolve({ status, headers: responseHeaders, body });
    });
  });
}

/** 建立一条无客户端证书的 TLS 连接并发请求（用于测试 pairing 路径/拒绝逻辑）。 */
export function tlsRequestNoClientCert({ port, servername, caPem, method = 'GET', path = '/', body = '' }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: '127.0.0.1', port, servername, ca: caPem, rejectUnauthorized: true }, () => {
      const payload = body ? Buffer.from(body) : undefined;
      const lengthLine = payload ? `Content-Length: ${payload.length}\r\n` : '';
      socket.write(`${method} ${path} HTTP/1.1\r\nHost: ${servername}\r\n${lengthLine}Connection: close\r\n\r\n`);
      if (payload) socket.write(payload);
    });
    const chunks = [];
    socket.on('data', (c) => chunks.push(c));
    socket.on('error', reject);
    socket.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const status = Number((raw.split('\r\n')[0] ?? '').split(' ')[1] ?? 0);
      resolve({ status, body: raw });
    });
  });
}

export function once(emitter, event, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting ${String(event)}`)), timeoutMs);
    emitter.once(event, (...args) => {
      clearTimeout(timer);
      resolve(args);
    });
  });
}

/** 系统里是否有可用的 openssl（非 RSA CSR 的优先路径；没有时会回退纯 JS）。 */
export function hasOpenssl() {
  const result = spawnSync('openssl', ['version'], { stdio: 'ignore', timeout: 10_000 });
  return result.status === 0;
}

/** 在「找不到 openssl」的环境下执行同步回调（验证纯 JS 回退路径）。 */
export function withoutOpenssl(fn) {
  const previous = process.env.PATH;
  process.env.PATH = '';
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
}

/** PEM 编码（测试用，不依赖 lib 内部实现）。 */
export function pemEncode(der, label) {
  const body = Buffer.from(der).toString('base64');
  return `-----BEGIN ${label}-----\n${body.match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
}

/**
 * 纯 JS（node:crypto + forge.asn1）生成 EC P-256 CSR，不依赖 openssl。
 * mismatchSignature=true 时 SPKI 用 A 的公钥、签名却用 B 的私钥（用于断言签名校验不会被绕过）。
 */
export function makeEcCsrJs(commonName = 'ec-device', { mismatchSignature = false, keys: providedKeys } = {}) {
  const keys = providedKeys ?? generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const signingKey = mismatchSignature
    ? generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
    : keys.privateKey;
  const asn1 = forge.asn1;
  const U = asn1.Class.UNIVERSAL;
  const seq = (items) => asn1.create(U, asn1.Type.SEQUENCE, true, items);
  const oid = (value) => asn1.create(U, asn1.Type.OID, false, asn1.oidToDer(value).getBytes());
  const spkiDer = keys.publicKey.export({ type: 'spki', format: 'der' });
  const spki = asn1.fromDer(forge.util.createBuffer(Buffer.from(spkiDer).toString('binary')), {
    strict: true,
    decodeBitStrings: false,
  });
  const cri = seq([
    asn1.create(U, asn1.Type.INTEGER, false, asn1.integerToDer(0).getBytes()),
    seq([
      asn1.create(U, asn1.Type.SET, true, [
        seq([
          oid('2.5.4.3'),
          asn1.create(U, asn1.Type.UTF8, false, forge.util.encodeUtf8(commonName)),
        ]),
      ]),
    ]),
    spki,
    asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, []),
  ]);
  const tbs = Buffer.from(asn1.toDer(cri).getBytes(), 'binary');
  const signature = cryptoSign('sha256', tbs, signingKey);
  const csr = seq([
    cri,
    seq([oid('1.2.840.10045.4.3.2')]),
    asn1.create(U, asn1.Type.BITSTRING, false, `\x00${signature.toString('binary')}`),
  ]);
  const der = Buffer.from(asn1.toDer(csr).getBytes(), 'binary');
  return {
    csrPem: pemEncode(der, 'CERTIFICATE REQUEST'),
    privateKeyPem: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }),
    der,
  };
}

/** 把 PEM 解成 DER（测试用）。 */
export function pemToDer(pem, label) {
  const match = new RegExp(`-----BEGIN ${label}-----([\\s\\S]*?)-----END ${label}-----`).exec(pem);
  if (!match) throw new Error(`no ${label} PEM`);
  return Buffer.from(match[1].replace(/\s+/g, ''), 'base64');
}
