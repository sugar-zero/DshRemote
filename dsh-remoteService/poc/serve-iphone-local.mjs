#!/usr/bin/env node
/**
 * 本地 iPhone E2E：Docker relay（443/8444）+ 本机 DSH host + 本地 CA 证书。
 * 生成配对二维码（PNG）与配对 URI，保持运行，供 iPhone App 扫码/粘贴。
 */
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, networkInterfaces } from 'node:os';
import http from 'node:http';
import zlib from 'node:zlib';
import forge from 'node-forge';
import qrcode from 'qrcode-generator';
import { parsePairingUri } from './dsh-remoteService/packages/protocol/index.js';

const ROOT = './dsh-remoteService';
const HOST_PLUGIN = join(ROOT, 'packages/host-plugin');
const DSH = process.env.DSH_BIN || 'dsh';
const HOST_ID = 'h_ab12cd34';
const RELAY_DOMAIN = 'local';
const FQDN = `${HOST_ID}.${RELAY_DOMAIN}`;
const TOKEN_FILE = `${process.env.HOME}/.dsh-relay-iphone/config/tokens.json`;
const CERT_DIR = `${process.env.HOME}/.dsh-relay-iphone/certs`;
const CA_HTTP_PORT = 18081;
const DOCKER_CONTAINER = 'dsh-relay-iphone';
const logs = [];
function log(m) { const line = `[local-e2e] ${m}`; logs.push(line); console.log(line); }

function makeCerts() {
  mkdirSync(CERT_DIR, { recursive: true });
  const caKeys = forge.pki.rsa.generateKeyPair(2048);
  const ca = forge.pki.createCertificate();
  ca.publicKey = caKeys.publicKey;
  ca.serialNumber = `01${forge.util.bytesToHex(forge.random.getBytesSync(15))}`;
  ca.validity.notBefore = new Date(Date.now() - 60_000);
  ca.validity.notAfter = new Date(Date.now() + 7 * 86_400_000);
  const caAttrs = [{ name: 'commonName', value: 'DSH Local iPhone Dev CA' }];
  ca.setSubject(caAttrs); ca.setIssuer(caAttrs);
  ca.setExtensions([{ name: 'basicConstraints', cA: true }, { name: 'keyUsage', keyCertSign: true, cRLSign: true }]);
  ca.sign(caKeys.privateKey, forge.md.sha256.create());
  const serverKeys = forge.pki.rsa.generateKeyPair(2048);
  const server = forge.pki.createCertificate();
  server.publicKey = serverKeys.publicKey;
  server.serialNumber = `01${forge.util.bytesToHex(forge.random.getBytesSync(15))}`;
  server.validity.notBefore = new Date(Date.now() - 60_000);
  server.validity.notAfter = new Date(Date.now() + 7 * 86_400_000);
  server.setSubject([{ name: 'commonName', value: FQDN }]);
  server.setIssuer(ca.subject.attributes);
  server.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [{ type: 2, value: FQDN }] },
  ]);
  server.sign(caKeys.privateKey, forge.md.sha256.create());
  const caPem = forge.pki.certificateToPem(ca);
  const serverPem = forge.pki.certificateToPem(server);
  const keyPem = forge.pki.privateKeyToPem(serverKeys.privateKey);
  const caDer = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(ca)).getBytes(), 'binary');
  writeFileSync(join(CERT_DIR, 'dsh-local-ca.pem'), caPem, { mode: 0o644 });
  writeFileSync(join(CERT_DIR, 'dsh-local-ca.cer'), caDer, { mode: 0o644 });
  writeFileSync(join(CERT_DIR, 'server.pem'), serverPem, { mode: 0o600 });
  writeFileSync(join(CERT_DIR, 'server-key.pem'), keyPem, { mode: 0o600 });
  return { caPem, serverPem, keyPem };
}

function startDshWeb(env) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(DSH, ['--profile', 'web', '--no-open', '--port', '0'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    const timer = setTimeout(() => rejectPromise(new Error(`dsh web 启动超时\n${stdout}`)), 120_000);
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString(); stdout += text;
      for (const line of text.split('\n')) if (line.trim()) log(`[dsh] ${line.trim()}`);
      const match = /dsh web: (http:\/\/\S+)/.exec(stdout);
      if (match) { clearTimeout(timer); resolvePromise({ child, url: match[1] }); }
    });
    child.stderr.on('data', (chunk) => { for (const line of chunk.toString().split('\n')) if (line.trim()) log(`[dsh:err] ${line.trim()}`); });
    child.on('exit', (code) => { clearTimeout(timer); rejectPromise(new Error(`dsh web exited ${code}`)); });
  });
}
function exchangeToken(url) {
  return new Promise((resolvePromise, rejectPromise) => {
    http.get(url, (res) => {
      const cookies = res.headers['set-cookie'] ?? []; res.resume();
      if (!cookies.length) rejectPromise(new Error(`token exchange HTTP ${res.statusCode}`));
      else resolvePromise(cookies.map((c) => String(c).split(';')[0]).join('; '));
    }).on('error', rejectPromise);
  });
}
function admin(port, cookie, method, path, body) {
  return new Promise((resolvePromise, rejectPromise) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { cookie, ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) rejectPromise(new Error(`${method} ${path} -> ${res.statusCode} ${text}`));
        else resolvePromise(text);
      });
    }); req.on('error', rejectPromise); if (payload) req.write(payload); req.end();
  });
}
function adminJson(port, cookie, method, path, body) {
  return admin(port, cookie, method, path, body).then((text) => { const json = JSON.parse(text); return json?.data ?? json; });
}
async function waitFor(fn, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 200)); }
  throw new Error(`timeout ${label}`);
}
function crc32(buf) {
  let c; const table = [];
  for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function writeQrPng(uri, path) {
  const qr = qrcode(0, 'M'); qr.addData(uri); qr.make();
  const count = qr.getModuleCount(); const scale = 10; const margin = 4;
  const size = (count + margin * 2) * scale;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const mx = Math.floor(x / scale) - margin; const my = Math.floor(y / scale) - margin;
      const dark = mx >= 0 && my >= 0 && mx < count && my < count && qr.isDark(my, mx);
      const value = dark ? 0 : 255; const off = y * (size * 3 + 1) + 1 + x * 3;
      raw[off] = value; raw[off + 1] = value; raw[off + 2] = value;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
  writeFileSync(path, png);
}

async function main() {
  const certs = makeCerts();
  // CA download server (iPhone Safari 安装)
  const caServer = http.createServer((req, res) => {
    if (req.url === '/dsh-local-ca.cer') { res.writeHead(200, { 'content-type': 'application/x-x509-ca-cert', 'content-disposition': 'attachment; filename="dsh-local-ca.cer"' }); res.end(readFileSync(join(CERT_DIR, 'dsh-local-ca.cer'))); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<h1>DSH Local CA</h1><a href="/dsh-local-ca.cer">下载 CA 证书</a>');
  });
  await new Promise((r) => caServer.listen(CA_HTTP_PORT, '0.0.0.0', r));
  log(`CA 下载: http://192.168.1.100:${CA_HTTP_PORT}/dsh-local-ca.cer`);

  // 临时 DSH_HOME + 安装插件
  const home = mkdtempSync(join(tmpdir(), 'dsh-iphone-home-'));
  const env = { ...process.env, DSH_HOME: home };
  execFileSync(DSH, ['plugin', '--profile', 'web', 'add', HOST_PLUGIN], { env, stdio: 'ignore' });
  const started = await startDshWeb(env);
  const webUrl = new URL(started.url); const webPort = Number(webUrl.port);
  const cookie = await exchangeToken(started.url);
  log(`dsh web ${started.url}`);

  const tokens = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'));
  const token = tokens.tokens[HOST_ID].token;
  await adminJson(webPort, cookie, 'POST', '/api/remote-access/config', {
    enabled: true,
    relayUrl: 'ws://127.0.0.1:18444',
    relayDomain: RELAY_DOMAIN,
    hostId: HOST_ID,
    hostToken: token,
    hostName: 'Local iPhone Test Host',
    tlsCertFile: join(CERT_DIR, 'server.pem'),
    tlsKeyFile: join(CERT_DIR, 'server-key.pem'),
    requireApproval: false,
    relayTlsInsecure: true,
  });
  const status = await waitFor(async () => {
    const s = await adminJson(webPort, cookie, 'GET', '/api/remote-access/status');
    return s.relay?.connected && s.listenPort ? s : null;
  }, 20_000, 'relay connected');
  log(`host connected: ${status.host.domain}, listenPort=${status.listenPort}`);

  const pairing = await adminJson(webPort, cookie, 'POST', '/api/remote-access/pairing/start', {});
  const parsed = parsePairingUri(pairing.uri);
  log(`pairing URI host=${parsed.host}`);
  const qrPath = './mockups/local-pairing-qr.png';
  writeQrPng(pairing.uri, qrPath);
  writeFileSync(join(CERT_DIR, 'pairing-uri.txt'), pairing.uri + '\n', { mode: 0o600 });
  log(`配对二维码: ${qrPath}`);
  log(`配对 URI: ${pairing.uri}`);
  log('等待 iPhone 配对。Ctrl+C 结束。');
  const shutdown = async () => {
    try { started.child.kill('SIGTERM'); } catch {}
    caServer.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
main().catch((e) => { console.error(e); process.exit(1); });
