#!/usr/bin/env node
/**
 * 方案 B2 · 本地端到端 POC
 *
 * 步骤：
 *  1. 建独立临时 $DSH_HOME，把 host-plugin 安装进 web profile
 *  2. 起盲中继（dev 模式，临时端口）；80/443/8443 无需真实域名
 *  3. 起 dsh web（随机端口），拿到 token URL
 *  4. 通过管理 API 配置并启用插件，等待中继连接
 *  5. 创建配对会话 → 生成设备 CSR → 经 relay 的 TLS 做配对 → 拿到设备证书
 *  6. 用设备证书经 relay 访问 DSH UI / 验证头伪造无效 / deny list / 无证书拒绝
 *  7. 用设备证书开 `/api/remote.mux` WebSocket，验证 101 升级
 *
 * 用法：node poc/run-poc.js
 * 依赖：dsh CLI 在 PATH；node >= 22；openssl 不需要（证书由 node-forge 生成）。
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import http from 'node:http';
import WebSocket from 'ws';
import { createRelay } from '../packages/relay/index.js';
import { parsePairingUri } from '../packages/protocol/index.js';
import { makeDeviceCsr, httpsRequest, httpsJson } from './certs.js';

const ROOT = resolve(import.meta.dirname, '..');
const HOST_PLUGIN = join(ROOT, 'packages/host-plugin');
const DSH = process.env.DSH_BIN || 'dsh';
const KEEP_HOME = process.env.POC_KEEP_HOME === '1';
const TRANSPORT = process.env.POC_TRANSPORT === 'direct' ? 'direct' : 'relay';
const HOST_ID = 'poc';
const HOST_TOKEN = 'poc-token-123456';
const RELAY_DOMAIN = 'relay.test';
const FQDN = `${HOST_ID}.${RELAY_DOMAIN}`;

const logs = [];
function log(message) {
  const line = `[poc] ${message}`;
  logs.push(line);
  console.log(line);
}

function execDsh(args, env) {
  log(`$ dsh ${args.join(' ')}`);
  execFileSync(DSH, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
}

function startDshWeb(env) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(DSH, ['--profile', 'web', '--no-open', '--port', '0'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => rejectPromise(new Error(`dsh web 启动超时\n${stdout}\n${stderr}`)), 120_000);
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      for (const line of text.split('\n')) {
        if (line.trim()) logs.push(`[dsh] ${line.trim()}`);
      }
      const match = /dsh web: (http:\/\/\S+)/.exec(stdout);
      if (match) {
        clearTimeout(timer);
        resolvePromise({ child, url: match[1] });
      }
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      for (const line of text.split('\n')) {
        if (line.trim()) logs.push(`[dsh:err] ${line.trim()}`);
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      rejectPromise(new Error(`dsh web 提前退出 code=${code}\n${stdout}\n${stderr}`));
    });
  });
}

function exchangeToken(url) {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = http.get(url, (res) => {
      const cookies = res.headers['set-cookie'] ?? [];
      res.resume();
      if (cookies.length === 0) rejectPromise(new Error(`token exchange 没有 cookie（HTTP ${res.statusCode}）`));
      else resolvePromise(cookies.map((c) => String(c).split(';')[0]).join('; '));
    });
    req.on('error', rejectPromise);
  });
}

function admin(port, cookie, method, path, body) {
  return new Promise((resolvePromise, rejectPromise) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path,
      headers: {
        cookie,
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        if (res.statusCode >= 400) rejectPromise(new Error(`${method} ${path} -> ${res.statusCode} ${text}`));
        else resolvePromise(json?.data ?? json);
      });
    });
    req.on('error', rejectPromise);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitFor(fn, timeoutMs = 20_000, label = 'condition') {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`等待超时: ${label}`);
}

async function main() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-poc-home-'));
  const env = { ...process.env, DSH_HOME: home };
  let child;
  let relay;
  try {
    log(`临时 DSH_HOME=${home}`);
    log('[1/8] 安装 host-plugin 到临时 web profile');
    execDsh(['plugin', '--profile', 'web', 'add', HOST_PLUGIN], env);

    log('[2/8] 启动盲中继（dev，临时端口）');
    relay = await createRelay({
      domain: RELAY_DOMAIN,
      dataPort: 0,
      controlPort: 0,
      httpPort: 0,
      dev: true,
      dataHost: '127.0.0.1',
      hostTokens: { [HOST_ID]: HOST_TOKEN },
      logLevel: 'warn',
    });
    log(`relay data=${relay.dataPort} control=${relay.controlPort} http=${relay.httpPort}`);

    log('[3/8] 启动 dsh web');
    const started = await startDshWeb(env);
    child = started.child;
    const webUrl = new URL(started.url);
    const webPort = Number(webUrl.port);
    log(`dsh web 就绪 ${webUrl.origin}`);
    const cookie = await exchangeToken(started.url);

    log('[4/8] 配置并启用远程访问');
    await admin(webPort, cookie, 'POST', '/api/remote-access/config', {
      enabled: true,
      relayUrl: `ws://127.0.0.1:${relay.controlPort}`,
      relayDomain: RELAY_DOMAIN,
      hostId: HOST_ID,
      hostToken: HOST_TOKEN,
      hostName: 'POC Mac',
      requireApproval: true,
      relayTlsInsecure: true,
    });
    const status = await waitFor(async () => {
      const data = await admin(webPort, cookie, 'GET', '/api/remote-access/status');
      return data.relay?.connected && data.listenPort ? data : undefined;
    }, 20_000, '插件中继连接');
    log(`插件已启用：relay connected, host domain=${status.host.domain}, listenPort=${status.listenPort}`);
    const targetPort = TRANSPORT === 'direct' ? status.listenPort : relay.dataPort;
    log(`POC transport = ${TRANSPORT} (target 127.0.0.1:${targetPort})`);

    const devCertPath = join(home, 'remote-access', 'dev-tls', 'cert.pem');
    if (!existsSync(devCertPath)) throw new Error(`开发 TLS 证书不存在: ${devCertPath}`);
    const serverCa = readFileSync(devCertPath, 'utf8');
    log(`使用 POC 自签主机证书（生产应替换为 B2 DNS-01 证书）: ${devCertPath}`);

    log('[5/8] 创建配对会话并模拟 App 扫码配对');
    const pairing = await admin(webPort, cookie, 'POST', '/api/remote-access/pairing/start', {});
    const parsed = parsePairingUri(pairing.uri);
    if (parsed.host !== FQDN) throw new Error(`配对 host 不符: ${parsed.host}`);
    log(`配对 URI host=${parsed.host} code=${pairing.code}`);
    const device = makeDeviceCsr('POC iPhone');
    const pairRes = await httpsJson({
      port: targetPort,
      servername: FQDN,
      ca: serverCa,
      method: 'POST',
      path: '/__dsh_remote/pair',
      body: { secret: parsed.secret, csrPem: device.csrPem, deviceName: 'POC iPhone', platform: 'ios' },
    });
    if (pairRes.status !== 200) throw new Error(`配对请求失败: ${pairRes.status} ${pairRes.body}`);
    let paired = pairRes.data;
    if (paired.status === 'pending') {
      log(`App 收到 pending（SAS=${paired.sas}），模拟桌面确认`);
      const approved = await admin(webPort, cookie, 'POST', '/api/remote-access/pairing/approve', {
        pairingId: pairing.pairingId,
        ticket: paired.ticket,
        approve: true,
      });
      if (approved.status !== 'paired') throw new Error(`桌面确认失败: ${JSON.stringify(approved)}`);
      paired = approved;
      log('桌面确认通过');
    }
    if (paired.status !== 'paired') throw new Error(`配对失败: ${JSON.stringify(paired)}`);
    log(`配对成功 deviceId=${paired.deviceId}`);

    log('[6/8] 用设备证书经 relay 访问 DSH UI');
    const page = await httpsRequest({
      port: targetPort,
      servername: FQDN,
      ca: serverCa,
      cert: paired.certPem,
      key: device.privateKeyPem,
      path: '/',
    });
    if (page.status !== 200) throw new Error(`GET / -> ${page.status}\n${page.head}\nBODY: ${page.body}`);
    if (!/<div id="root">|DeepSeek Harness/.test(page.body)) throw new Error('返回页面不像 DSH UI');
    log(`DSH UI 200，${page.body.length} bytes`);

    log('[7/8] 安全断言：无证书 403 / 头伪造不生效 / deny list 403');
    const noCert = await httpsRequest({ port: targetPort, servername: FQDN, ca: serverCa, path: '/' })
      .catch((error) => ({ status: -1, error: error.message }));
    if (noCert.status !== 403) throw new Error(`无客户端证书应 403，实际 ${noCert.status ?? noCert.error}`);
    const spoof = await httpsRequest({
      port: targetPort,
      servername: FQDN,
      ca: serverCa,
      cert: paired.certPem,
      key: device.privateKeyPem,
      path: '/',
      headers: { Host: 'evil.example', 'X-Forwarded-For': '127.0.0.1', 'X-Real-IP': '127.0.0.1', Origin: 'https://evil.example' },
    });
    if (spoof.status !== 200) throw new Error(`伪造 Host/XFF 的请求不应失败（应被重写后正常返回），实际 ${spoof.status}`);
    const denied = await httpsRequest({
      port: targetPort,
      servername: FQDN,
      ca: serverCa,
      cert: paired.certPem,
      key: device.privateKeyPem,
      path: '/connect',
    });
    if (denied.status !== 403) throw new Error(`/connect 应被 deny list 拒绝，实际 ${denied.status}`);
    log('安全断言通过（身份来自 mTLS 设备证书，与 Host/XFF/Origin 无关）');

    log('[8/8] WebSocket /api/remote.mux 经 relay + mTLS 升级');
    const wsOpen = await new Promise((resolvePromise, rejectPromise) => {
      const ws = new WebSocket(`wss://127.0.0.1:${targetPort}/api/remote.mux`, [], {
        servername: FQDN,
        ca: serverCa,
        cert: paired.certPem,
        key: device.privateKeyPem,
        rejectUnauthorized: true,
      });
      const timer = setTimeout(() => rejectPromise(new Error('WebSocket 101 超时')), 10_000);
      ws.on('open', () => { clearTimeout(timer); ws.close(); resolvePromise(true); });
      ws.on('unexpected-response', (_req, res) => { clearTimeout(timer); rejectPromise(new Error(`WS upgrade -> ${res.statusCode}`)); });
      ws.on('error', (error) => { clearTimeout(timer); rejectPromise(error); });
    });
    if (!wsOpen) throw new Error('WebSocket 未建立');
    log('WebSocket 升级成功');

    log('POC PASS：配对 → 设备 mTLS → relay 透传 → DSH UI/WS 全部打通');
    if (KEEP_HOME) log(`保留临时目录: ${home}`);
    return { home, webPort, relay };
  } finally {
    try { child?.kill('SIGTERM'); } catch { /* ignore */ }
    try { await relay?.close(); } catch { /* ignore */ }
    if (!KEEP_HOME) {
      try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(`\n[poc] FAILED: ${error.stack ?? error.message}`);
  console.error('\n--- 最近日志 ---');
  for (const line of logs.slice(-40)) console.error(line);
  process.exit(1);
});
