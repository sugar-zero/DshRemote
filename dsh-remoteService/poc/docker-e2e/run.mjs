#!/usr/bin/env node
/**
 * Docker relay 端到端验收（需 daemon）：
 *   dsh-remote-relay 容器（dev 模式，高位端口）
 *     ⇄ 真实 RemoteService host 插件（ws 控制面 + TLS listener）
 *     ⇄ mTLS 客户端（设备证书）请求 /__dsh_remote/status
 *
 * 断言：relay healthz 看到 host 上线；容器内非 root；mTLS 请求 200 且 hostId 正确；
 *       relay 看到的 host 子域 SNI 路由生效。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { connect as tlsConnect } from 'node:tls';
import forge from 'node-forge';

const CONTAINER = 'dsh-relay-e2e';
const IMAGE = 'dsh-remote-relay:poc';
const HTTP_PORT = 18080;
const DATA_PORT = 18443;
const CONTROL_PORT = 18444;
const FQDN = 'h_docker.relay.test';
const results = [];
function pass(msg) { console.log(`  ✅ ${msg}`); results.push(msg); }
function fail(msg) { console.error(`  ❌ ${msg}`); throw new Error(msg); }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await sleep(100);
  }
  throw new Error(`timeout waiting ${label}: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

function makeCsr(commonName) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([{ name: 'commonName', value: commonName }]);
  csr.sign(keys.privateKey, forge.md.sha256.create());
  return { csrPem: forge.pki.certificationRequestToPem(csr), privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey) };
}

function tlsRequest({ port, servername, caPem, certPem, keyPem, path }) {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host: '127.0.0.1', port, servername, ca: caPem, cert: certPem, key: keyPem, rejectUnauthorized: true }, () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${servername}\r\nConnection: close\r\n\r\n`);
    });
    const chunks = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const split = raw.indexOf('\r\n\r\n');
      resolve({ status: Number((raw.split('\r\n')[0] ?? '').split(' ')[1] ?? 0), body: split >= 0 ? raw.slice(split + 4) : '' });
    });
  });
}

async function main() {
  console.log('== Docker relay 端到端验收 ==');
  const mountDir = mkdtempSync(join(homedir(), '.dsh-relay-e2e-'));
  const configDir = join(mountDir, 'config');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'relay.json'), JSON.stringify({
    domain: 'relay.test',
    dataPort: 8443,
    controlPort: 8444,
    httpPort: 8080,
    dataHost: '0.0.0.0',
    dev: true,
    logLevel: 'info',
  }, null, 2));
  const dshHome = mkdtempSync('/tmp/dsh-docker-e2e-');
  process.env.DSH_HOME = dshHome;

  let service;
  let containerStarted = false;
  try {
    execFileSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' });
    execFileSync('docker', [
      'run', '-d', '--name', CONTAINER,
      '-p', `${HTTP_PORT}:8080`, '-p', `${DATA_PORT}:8443`, '-p', `${CONTROL_PORT}:8444`,
      '-v', `${configDir}:/data/config`,
      IMAGE,
    ], { stdio: 'ignore' });
    containerStarted = true;
    pass('relay 容器已启动');

    const uid = execFileSync('docker', ['exec', CONTAINER, 'id', '-u'], { encoding: 'utf8' }).trim();
    if (uid === '0') fail('容器内不应以 root 运行');
    pass(`容器内非 root 运行（uid=${uid}）`);

    await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${HTTP_PORT}/healthz`);
      return response.ok;
    }, 15000, 'relay healthz');
    pass(`容器 /healthz 可用（:${HTTP_PORT}）`);

    execFileSync('docker', ['exec', CONTAINER, 'node', 'packages/relay/bin/relay.js', 'token', 'create', 'h_docker', '--config', '/data/config/relay.json'], { stdio: 'ignore' });
    const tokens = JSON.parse(readFileSync(join(configDir, 'tokens.json'), 'utf8'));
    const token = tokens.tokens.h_docker.token;
    pass('容器内 token CLI 可生成 host token');

    const { saveConfig } = await import('../../packages/host-plugin/lib/config.js');
    const { RemoteService } = await import('../../packages/host-plugin/lib/service.js');
    const { signDeviceCertificate } = await import('../../packages/host-plugin/lib/identity.js');
    saveConfig({
      enabled: true,
      relayUrl: `ws://127.0.0.1:${CONTROL_PORT}`,
      relayDomain: 'relay.test',
      hostId: 'h_docker',
      hostToken: token,
      hostName: 'Docker E2E Host',
      listenPort: 0,
      relayTlsInsecure: true,
      requireApproval: false,
    });
    const fakeCtx = {
      webServer: { protocol: 'http:', port: 1, getOrigin: () => 'http://127.0.0.1:1/' },
      connection: { authenticatedUrl: (origin) => `${origin}?token=test` },
      effect: (fn) => fn(),
      on: () => () => {},
    };
    service = new RemoteService(fakeCtx);
    await service.ready;
    await waitFor(() => service.connector?.isConnected() === true, 10000, 'host connector');
    pass('真实 host 插件已连接容器 relay');

    const health = await waitFor(async () => {
      const json = await fetch(`http://127.0.0.1:${HTTP_PORT}/healthz`).then((r) => r.json());
      return json.hosts.includes('h_docker') ? json : null;
    }, 10000, 'host online in relay healthz');
    pass(`relay healthz 看到 host 上线（hosts=${health.hosts.join(',')}）`);

    const deviceCsr = makeCsr('Docker E2E iPhone');
    const signed = signDeviceCertificate({ ca: service.ca, csrPem: deviceCsr.csrPem, deviceId: 'd_docker', commonName: 'Docker E2E iPhone' });
    service.devices.add({ id: 'd_docker', name: 'Docker E2E iPhone', platform: 'ios', serial: signed.serial, notAfter: signed.notAfter });
    pass('设备证书已由 host CA 签发');

    const serverCertPem = readFileSync(service.tlsInfo.certFile, 'utf8');
    const response = await tlsRequest({
      port: DATA_PORT,
      servername: FQDN,
      caPem: serverCertPem,
      certPem: signed.certPem,
      keyPem: deviceCsr.privateKeyPem,
      path: '/__dsh_remote/status',
    });
    if (response.status !== 200) fail(`mTLS 请求失败：HTTP ${response.status}`);
    const payload = JSON.parse(response.body);
    if (payload.data?.hostId !== 'h_docker') fail('mTLS 响应 hostId 不正确');
    if (!payload.data?.version) fail('mTLS 响应缺少 version');
    pass(`mTLS 请求经容器 relay 到达 host：/__dsh_remote/status 200（hostId=${payload.data.hostId}）`);

    console.log('');
    console.log('✅ Docker relay 端到端验收 PASS');
  } finally {
    await service?.dispose?.().catch(() => {});
    if (containerStarted) {
      try { execFileSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' }); } catch { /* ignore */ }
    }
    rmSync(mountDir, { recursive: true, force: true });
    rmSync(dshHome, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('[docker-e2e] FAILED:', error.message);
  process.exit(1);
});
