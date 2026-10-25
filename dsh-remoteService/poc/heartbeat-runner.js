#!/usr/bin/env node
/**
 * heartbeat-runner — 用 repo 当前 host-plugin 代码启动一个**独立**的远程 TLS 监听，
 * 供 poc/heartbeat-verify.js 做慢速链路心跳验证（不连 relay、不动正在运行的 DSH/插件）。
 *
 * 它做什么：
 *   - 读本机 DSH 远程访问的 TLS 证书/私钥与设备 CA（~/.dsh/remote-access/）；
 *   - 把 devices.json 拷贝到 /tmp 再用 DeviceStore 加载（touch 只写临时副本，
 *     绝不修改正在运行的插件状态）；
 *   - DshProxy 上游指向本机 DSH web（默认 127.0.0.1:63134）；
 *   - authenticatedUrl 指向一个本地一次性 HTTP 服务，返回带 DSH 浏览器 cookie 的
 *     Set-Cookie（cookie 由 ~/.dsh/.credentials.yaml 的 browser-session secret 现场
 *     HMAC 生成，authority=127.0.0.1:63134，不落盘）；
 *   - createRemoteServer() 起一个临时端口的 mTLS 监听，并通过 stdout 打印一行
 *     `{"event":"ready","port":...}`（给 harness --runner 用）。
 *
 * 重要：proxy 模块可以通过 --proxy-module 指向任意文件，这样可以对「修复前」的
 * 旧 proxy.js 做同环境 A/B 对照（把 git HEAD 版本导出到 /tmp 再喂进来即可）。
 *
 * 用法：
 *   node poc/heartbeat-runner.js                 # 监听临时端口，打印 ready JSON 后常驻
 *   node poc/heartbeat-runner.js --port 0        # 同上（默认）
 *   node poc/heartbeat-runner.js --proxy-module /tmp/pre-fix-proxy.mjs
 *   node poc/heartbeat-runner.js --upstream-port 63134 --verbose
 *
 * 仅只读访问 ~/.dsh 下文件；只监听 127.0.0.1 临时端口；退出时关闭监听。
 */

import http from 'node:http';
import { readFileSync, copyFileSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, createHmac } from 'node:crypto';

import { DeviceStore } from '../packages/host-plugin/lib/devices.js';
import { createRemoteServer } from '../packages/host-plugin/lib/server.js';

const HOME = process.env.HOME || homedir();
const DSH_REMOTE_DIR = join(HOME, '.dsh', 'remote-access');

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function parseArgs(argv) {
  const options = {
    port: 0,
    host: '127.0.0.1',
    upstreamHost: '127.0.0.1',
    upstreamPort: 63134,
    proxyModule: resolve(import.meta.dirname, '../packages/host-plugin/lib/proxy.js'),
    verbose: false,
    help: false,
  };
  const takesValue = new Set(['port', 'host', 'upstream-host', 'upstream-port', 'proxy-module']);
  const map = { port: 'port', host: 'host', 'upstream-host': 'upstreamHost', 'upstream-port': 'upstreamPort', 'proxy-module': 'proxyModule' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--verbose') { options.verbose = true; continue; }
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (!arg.startsWith('--')) throw new Error(`无法识别的参数: ${arg}`);
    const name = arg.slice(2);
    if (!takesValue.has(name)) throw new Error(`无法识别的参数: ${arg}`);
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`参数 ${arg} 缺少值`);
    i += 1;
    options[map[name]] = ['port', 'upstreamPort'].includes(map[name]) ? Number(value) : value;
  }
  return options;
}

function printHelp() {
  console.log(`heartbeat-runner — 独立起一个 host-plugin 远程 TLS 监听（供慢速链路验证）

用法: node poc/heartbeat-runner.js [options]

  --port <n>             监听端口（默认 0 = 临时端口）
  --host <addr>          监听地址（默认 127.0.0.1）
  --upstream-host <h>    DSH web 主机（默认 127.0.0.1）
  --upstream-port <n>    DSH web 端口（默认 63134）
  --proxy-module <path>  用哪个 DshProxy 模块（默认 repo 当前 packages/host-plugin/lib/proxy.js；
                         可指向导出的旧版本做 A/B）
  --verbose             把 proxy 日志打到 stderr
  -h, --help             显示本帮助
`);
}

/** 用 ~/.dsh/.credentials.yaml 的 browser-session secret 现场生成 DSH cookie。 */
function mintCookie(authority) {
  const yaml = readFileSync(join(HOME, '.dsh', '.credentials.yaml'), 'utf8');
  const match = /client-connection\/browser-session:[\s\S]*?secret: ([A-Za-z0-9_-]+)/.exec(yaml);
  if (!match) throw new Error('找不到 client-connection browser-session secret');
  const secret = Buffer.from(match[1].replaceAll('-', '+').replaceAll('_', '/') + '=', 'base64');
  const b64u = (buffer) => Buffer.from(buffer).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
  const now = Date.now();
  const payload = { version: 1, authority, issuedAt: now, expiresAt: now + 30 * 86400 * 1000 - 1000 };
  const body = b64u(JSON.stringify(payload));
  const sig = b64u(createHmac('sha256', secret).update(body).digest());
  return `dsh-auth-${b64u(createHash('sha256').update(authority).digest())}=v1.${body}.${sig}`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { printHelp(); return; }

  const log = options.verbose ? (message) => console.error(`[runner] ${message}`) : () => {};

  // —— 读 DSH 远程访问配置（只读）——
  const config = readJson(join(DSH_REMOTE_DIR, 'config.json'), {});
  const tlsCertFile = config.tlsCertFile ?? join(DSH_REMOTE_DIR, 'certs', 'fullchain.pem');
  const tlsKeyFile = config.tlsKeyFile ?? join(DSH_REMOTE_DIR, 'certs', 'privkey.pem');
  const caCertPath = join(DSH_REMOTE_DIR, 'device-ca', 'cert.pem');
  const certPem = readFileSync(tlsCertFile, 'utf8');
  const keyPem = readFileSync(tlsKeyFile, 'utf8');
  const caCertPem = readFileSync(caCertPath, 'utf8');

  // —— devices.json 只读拷贝到临时目录（DeviceStore.touch 会写盘，绝不能写活的） ——
  const tempDir = mkdtempSync(join(tmpdir(), 'dsh-heartbeat-runner-'));
  const devicesCopyPath = join(tempDir, 'devices.json');
  copyFileSync(join(DSH_REMOTE_DIR, 'devices.json'), devicesCopyPath);
  const devices = new DeviceStore(devicesCopyPath);

  // —— 行为日志只留在内存（不写 ~/.dsh/remote-access/audit.jsonl） ——
  const entries = [];
  const audit = {
    append(entry) { entries.push(entry); },
    tail(limit = 50) { return entries.slice(-limit); },
  };

  // —— DSH 浏览器 cookie：本地 authenticatedUrl 服务现场签发 ——
  const authority = `${options.upstreamHost}:${options.upstreamPort}`;
  const cookie = mintCookie(authority);
  const authServer = http.createServer((req, res) => {
    log(`auth-server ${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store', 'set-cookie': cookie });
    res.end('harness-authenticated\n');
  });
  const authPort = await new Promise((resolvePromise, rejectPromise) => {
    authServer.once('error', rejectPromise);
    authServer.listen(0, '127.0.0.1', () => {
      authServer.off('error', rejectPromise);
      resolvePromise(authServer.address().port);
    });
  });
  const denials = [];
  const authenticatedUrl = () => `http://127.0.0.1:${authPort}/__harness_auth`;
  // 注：DshProxy 会用 host=<upstream> 头请求该 URL，DSH 只校验 Set-Cookie，所以无需模拟完整 DSH。

  // —— 加载选定版本的 DshProxy（可指向 /tmp 里导出的旧版本做 A/B） ——
  const proxyModuleUrl = pathToFileURL(resolve(options.proxyModule)).href;
  let DshProxy;
  try {
    ({ DshProxy } = await import(proxyModuleUrl));
  } catch (error) {
    throw new Error(`无法加载 DshProxy（${options.proxyModule}）: ${error.message}`);
  }
  if (typeof DshProxy !== 'function') throw new Error(`模块 ${options.proxyModule} 没有导出 DshProxy`);
  const proxy = new DshProxy({
    getUpstream: () => ({ protocol: 'http:', host: options.upstreamHost, port: options.upstreamPort }),
    authenticatedUrl,
    denyPrefixes: Array.isArray(config.denyPrefixes) ? config.denyPrefixes : [],
    getMaxRequestBytes: () => config.maxRequestBytes ?? 256 * 1024 * 1024,
    audit,
    log,
  });

  const pairing = {
    handlePairRequest() {
      const error = new Error('heartbeat-runner 不开放配对');
      error.status = 404;
      error.code = 'pairing-disabled';
      throw error;
    },
    statusFor() {
      const error = new Error('heartbeat-runner 不开放配对');
      error.status = 404;
      error.code = 'no-such-pairing';
      throw error;
    },
  };

  const runtime = createRemoteServer({
    certPem,
    keyPem,
    caCertPem,
    devices,
    pairing,
    proxy,
    audit,
    getConfig: () => ({
      hostId: config.hostId ?? 'harness',
      hostName: config.hostName ?? 'heartbeat-harness',
      relayDomain: config.relayDomain ?? 'harness.invalid',
    }),
    savePushToken: () => {},
    getStatus: () => ({ tls: { subject: 'harness', valid: true, dev: false }, relayConnected: false, version: 'harness' }),
    log,
  });

  const address = await runtime.listen(options.port, options.host);
  const ready = {
    event: 'ready',
    port: address.port,
    host: address.host,
    proxyModule: options.proxyModule,
    upstream: `${options.upstreamHost}:${options.upstreamPort}`,
    certFile: tlsCertFile,
    devices: devices.list().map((device) => ({ id: device.id, name: device.name, platform: device.platform })),
    authenticatedUrl: authenticatedUrl(),
  };
  // 机器可读的一行（harness --runner 依赖它）
  console.log(JSON.stringify(ready));
  const logReady = (message) => (options.verbose ? console.error(`[runner] ${message}`) : null);
  logReady(`listening on ${address.host}:${address.port}`);
  void denials;

  const shutdown = async () => {
    try { await runtime.close(); } catch { /* ignore */ }
    try { await new Promise((resolvePromise) => authServer.close(() => resolvePromise())); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(`[runner] fatal: ${error.stack ?? error.message}`);
  process.exit(1);
});
