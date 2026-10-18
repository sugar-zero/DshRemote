#!/usr/bin/env node
/**
 * 本地吞吐/延迟基准：client ──TLS(SNI)──▶ relay:443 ──帧──▶ fake host ──▶ 本地 HTTPS origin
 *
 * 不是带宽测试，而是验证 B2 数据面（SNI 路由 + 多路复用二进制帧 + TLS 透传）在
 * 并发 keep-alive 请求下的正确性与基本性能，作为上线前基线。
 *
 *   node poc/bench-relay.js [requests=2000] [concurrency=32]
 */
import https from 'node:https';
import net from 'node:net';
import forge from 'node-forge';
import WebSocket from 'ws';
import {
  CONTROL_PATH,
  FRAME_TYPE,
  PROTOCOL_VERSION,
  RELAY_MSG,
  decodeFrame,
  encodeFrame,
} from '../packages/protocol/index.js';
import { createRelay } from '../packages/relay/index.js';

const REQUESTS = Number.parseInt(process.argv[2] ?? '2000', 10);
const CONCURRENCY = Number.parseInt(process.argv[3] ?? '32', 10);
const DOMAIN = 'relay.test';
const HOST_ID = 'bench';
const FQDN = `${HOST_ID}.${DOMAIN}`;
const TOKEN = 'bench-token';

function serial() { return `01${forge.util.bytesToHex(forge.random.getBytesSync(15))}`; }
function generateCerts() {
  const caKeys = forge.pki.rsa.generateKeyPair(2048);
  const ca = forge.pki.createCertificate();
  ca.publicKey = caKeys.publicKey; ca.serialNumber = serial();
  ca.validity.notBefore = new Date(Date.now() - 60_000);
  ca.validity.notAfter = new Date(Date.now() + 3600_000);
  const caAttrs = [{ name: 'commonName', value: 'DSH bench CA' }];
  ca.setSubject(caAttrs); ca.setIssuer(caAttrs);
  ca.setExtensions([{ name: 'basicConstraints', cA: true }, { name: 'keyUsage', keyCertSign: true }]);
  ca.sign(caKeys.privateKey, forge.md.sha256.create());

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey; cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 3600_000);
  cert.setSubject([{ name: 'commonName', value: FQDN }]);
  cert.setIssuer(ca.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [{ type: 2, value: FQDN }] },
  ]);
  cert.sign(caKeys.privateKey, forge.md.sha256.create());
  return {
    caPem: forge.pki.certificateToPem(ca),
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

async function main() {
  const certs = generateCerts();
  const body = 'x'.repeat(1024);
  const origin = https.createServer({ key: certs.keyPem, cert: certs.certPem }, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  });
  await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve));
  const originPort = origin.address().port;

  const relay = await createRelay({
    domain: DOMAIN,
    dataPort: 0,
    controlPort: 0,
    httpPort: 0,
    dev: true,
    dataHost: '127.0.0.1',
    hostTokens: { [HOST_ID]: TOKEN },
    logLevel: 'silent',
  });

  // fake host connector：响应 host.open/opened + 二进制帧透传
  const ws = new WebSocket(`ws://127.0.0.1:${relay.controlPort}${CONTROL_PATH}`);
  const streams = new Map();
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('host connector not ready')), 5000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: RELAY_MSG.HOST_HELLO, protocolVersion: PROTOCOL_VERSION, hostId: HOST_ID, token: TOKEN, hostName: 'bench' }));
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const frame = decodeFrame(Buffer.from(data));
        const socket = streams.get(frame.streamId);
        if (!socket) return;
        if (frame.type === FRAME_TYPE.DATA) socket.write(frame.payload);
        else { socket.end(); streams.delete(frame.streamId); }
        return;
      }
      const msg = JSON.parse(data.toString());
      if (msg.t === RELAY_MSG.HOST_READY) { clearTimeout(timer); resolve(); return; }
      if (msg.t === RELAY_MSG.HOST_OPEN) {
        const socket = net.connect({ host: '127.0.0.1', port: originPort });
        streams.set(msg.streamId, socket);
        socket.once('connect', () => ws.send(JSON.stringify({ t: RELAY_MSG.HOST_OPENED, streamId: msg.streamId })));
        socket.on('data', (chunk) => ws.send(new Uint8Array(encodeFrame(FRAME_TYPE.DATA, msg.streamId, chunk))));
        socket.on('close', () => {
          if (streams.delete(msg.streamId)) ws.send(new Uint8Array(encodeFrame(FRAME_TYPE.CLOSE, msg.streamId)));
        });
        socket.on('error', () => socket.destroy());
        return;
      }
      if (msg.t === RELAY_MSG.HOST_CLOSE) {
        const socket = streams.get(msg.streamId);
        if (socket) { socket.destroy(); streams.delete(msg.streamId); }
      }
    });
    ws.on('error', reject);
  });
  await ready;

  const agent = new https.Agent({ keepAlive: true, maxSockets: CONCURRENCY, ca: certs.caPem });
  const latencies = [];
  let errors = 0;
  const startAt = process.hrtime.bigint();
  let issued = 0;
  async function one() {
    const t0 = process.hrtime.bigint();
    await new Promise((resolve) => {
      const request = https.request({
        host: '127.0.0.1',
        port: relay.dataPort,
        method: 'GET',
        path: '/',
        servername: FQDN,
        ca: certs.caPem,
        agent,
        headers: { host: FQDN },
      }, (res) => {
        let bytes = 0;
        res.on('data', (chunk) => { bytes += chunk.length; });
        res.on('end', () => {
          if (res.statusCode !== 200 || bytes !== body.length) errors += 1;
          resolve();
        });
      });
      request.on('error', () => { errors += 1; resolve(); });
      request.end();
    });
    latencies.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  async function worker() {
    while (issued < REQUESTS) {
      issued += 1;
      await one();
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, REQUESTS) }, () => worker()));
  const elapsedMs = Number(process.hrtime.bigint() - startAt) / 1e6;
  latencies.sort((a, b) => a - b);
  const pick = (p) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))];
  const result = {
    requests: REQUESTS,
    concurrency: CONCURRENCY,
    errors,
    elapsedMs: Math.round(elapsedMs),
    throughputRps: Math.round((REQUESTS / elapsedMs) * 1000),
    p50Ms: Number(pick(0.5).toFixed(2)),
    p95Ms: Number(pick(0.95).toFixed(2)),
    p99Ms: Number(pick(0.99).toFixed(2)),
  };
  console.log(JSON.stringify(result, null, 2));

  agent.destroy();
  ws.close();
  await relay.close();
  await new Promise((resolve) => origin.close(resolve));
  if (errors > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('[bench] FAILED:', error);
  process.exit(1);
});
