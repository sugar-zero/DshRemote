#!/usr/bin/env node
/**
 * check-deploy.sh 成功路径本地演练（不需要 DNS / VPS / Docker）：
 *   进程内真 relay（控制面 WSS + 数据面 TLS 透传）
 *     + 真 RemoteService host 插件（dev 自签 TLS listener、wss 连接 relay）
 *     + 执行 scripts/check-deploy.sh（跳过 DNS，高位端口）
 *
 * 断言：脚本退出码 0、host 上线、证书检查通过。
 * 这是上线前验证 check-deploy.sh 全绿分支的最小闭环。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import forge from 'node-forge';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) { last = error; }
    await sleep(100);
  }
  throw new Error(`timeout waiting ${label}: ${last instanceof Error ? last.message : String(last)}`);
}

function makeSelfSigned() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = `01${forge.util.bytesToHex(forge.random.getBytesSync(15))}`;
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 86_400_000);
  cert.setSubject([{ name: 'commonName', value: '127.0.0.1' }]);
  cert.setIssuer([{ name: 'commonName', value: '127.0.0.1' }]);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }, { type: 2, value: '127.0.0.1' }] },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), keyPem: forge.pki.privateKeyToPem(keys.privateKey) };
}

async function main() {
  console.log('== check-deploy.sh 本地成功路径演练 ==');
  const certs = makeSelfSigned();
  const { createRelay } = await import('../packages/relay/index.js');
  const relay = await createRelay({
    domain: '127.0.0.1',
    dataPort: 0,
    controlPort: 0,
    httpPort: 0,
    dataHost: '127.0.0.1',
    tls: { cert: certs.certPem, key: certs.keyPem },
    hostTokens: { h_local: 'local-token' },
    logLevel: 'silent',
  });
  const dshHome = mkdtempSync('/tmp/dsh-check-deploy-');
  process.env.DSH_HOME = dshHome;
  // 本地演练用自签控制面证书；Node 内置 WebSocket 不暴露 per-connection CA 选项，
  // 生产使用公开 CA 证书，这里仅在本地子进程内放宽证书校验。
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  let service;
  try {
    const { saveConfig } = await import('../packages/host-plugin/lib/config.js');
    const { RemoteService } = await import('../packages/host-plugin/lib/service.js');
    saveConfig({
      enabled: true,
      relayUrl: `wss://127.0.0.1:${relay.controlPort}`,
      relayDomain: '127.0.0.1',
      hostId: 'h_local',
      hostToken: 'local-token',
      hostName: 'Local Drill Host',
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
    await waitFor(() => relay.health().hosts.includes('h_local'), 10000, 'relay 看到 host');
    console.log(`    relay: http=${relay.httpPort} data=${relay.dataPort} control=${relay.controlPort}`);

    // 注意：必须用异步 spawn。execFileSync 会阻塞本进程事件循环，而 relay 就跑在本进程里。
    const scriptOutput = await new Promise((resolve, reject) => {
      const child = spawn('bash', ['scripts/check-deploy.sh', '127.0.0.1', 'h_local', String(relay.controlPort)], {
        env: {
          ...process.env,
          CHECK_DEPLOY_SKIP_DNS: '1',
          RELAY_HTTP_PORT: String(relay.httpPort),
          RELAY_DATA_PORT: String(relay.dataPort),
        },
      });
      let out = '';
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.stderr.on('data', (chunk) => { out += chunk; });
      child.on('close', (code) => {
        if (code === 0) resolve(out);
        else reject(Object.assign(new Error(`check-deploy.sh 退出码 ${code}`), { output: out }));
      });
      child.on('error', reject);
    });
    console.log(scriptOutput.trim().split('\n').map((line) => `    ${line}`).join('\n'));
    if (!scriptOutput.includes('✅ 自检通过')) throw new Error('check-deploy.sh 未报告通过');
    console.log('');
    console.log('✅ check-deploy.sh 成功路径本地演练 PASS');
  } finally {
    await service?.dispose?.().catch(() => {});
    await relay.close();
    rmSync(dshHome, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('[check-deploy-local] FAILED:', error.message);
  process.exit(1);
});
