import { execFileSync } from 'node:child_process';
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
