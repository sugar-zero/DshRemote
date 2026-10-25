#!/usr/bin/env node
/**
 * heartbeat-verify — 慢速链路下 DSH `/api/remote.mux` 心跳误杀的独立复现/验证工具。
 *
 * 为什么需要它：
 *   DSH 的 api-gateway 对 `/api/remote.mux` 每 2s 发一次 WebSocket Ping，连续
 *   2 个周期（MAX_MISSED_HEARTBEATS=2，约 6s）收不到 Pong/任何帧就 terminate。
 *   打开大会话时 `session/follow` 的首帧是一个数 MB 的历史快照（单条 WS text
 *   message）；经慢速 relay（实测约 5Mbps）下行时这帧要 6s+，DSH 发出的 Ping
 *   被排在这帧后面，客户端的 Pong 自然来不及 → DSH 在 ~6s 误杀 mux，客户端
 *   重连重试，手机端表现为「载入历史很久/失败 + 画面反复跳」。
 *
 * 本工具做三件事：
 *   1. 在客户端与主机插件 TLS 监听之间插入一个限速 TCP 转发器（默认下行
 *      ~600 KB/s），模拟慢速 relay 链路；
 *   2. 以真实设备 mTLS 证书连接 `wss://.../api/remote.mux`，打开 `$events`
 *      和大会话的 `session/follow`，测量：大帧大小/到达时刻、Ping 到达时刻、
 *      mux 关闭码与时刻、吞吐采样；
 *   3. `--pong-spoof` 让客户端每 500ms 主动发一个 unsolicited Pong（等价于
 *      「主机插件代理替隧道回 Pong」的修复效果），用来对照证明根因是心跳
 *      误判而不是别的。
 *
 * 用法（在 dsh-remoteService 目录下）：
 *   node poc/heartbeat-verify.js                          # 限速 600KB/s，无 Pong 代发 → 预期 ~6s 被杀
 *   node poc/heartbeat-verify.js --pong-spoof             # 同样限速 + Pong 代发 → 预期存活且大帧完整
 *   node poc/heartbeat-verify.js --rate 0                 # 不限速（本地直连对照）
 *   node poc/heartbeat-verify.js --port 64100             # 指向 standalone runner（修复后的代码）
 *   node poc/heartbeat-verify.js --json                   # 末尾输出一行机器可读 JSON
 *
 * 只依赖 repo 已有的 `ws`。需要**自备调试设备证书**（--cert/--key/--ca 或
 * DSH_PROBE_CERT/KEY/CA 环境变量；默认路径 /tmp/probe/* 仅为示例，不要用生产手机证书）。
 * 会话 id 与 TLS SNI 无默认值，用 --session/--servername 或
 * DSH_PROBE_SESSION/DSH_PROBE_SERVERNAME 提供。
 *
 * 该脚本只做只读操作：打开 $events 与 session/follow，不发送任何会话写操作。
 */

import net from 'node:net';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

// —— 默认参数 ——
const DEFAULTS = Object.freeze({
  host: '127.0.0.1',
  port: 63135, // 运行中的主机插件远程 TLS 监听（只读用，不重启）
  rate: 600_000, // 下行限速 B/s，约等于 4.8Mbps，贴近真实 relay
  upRate: 0, // 上行限速（0 = 不限速；真实手机上行慢，但控制帧很小）
  duration: 20_000, // 最长观察时间 ms
  spoofMs: 500, // --pong-spoof 时的 Pong 间隔
  bigThreshold: 100_000, // 多大算「大帧」快照
  // 以下两项没有内置默认值：用参数或环境变量提供（见 --help）
  session: process.env.DSH_PROBE_SESSION ?? '',
  servername: process.env.DSH_PROBE_SERVERNAME ?? '',
  cert: process.env.DSH_PROBE_CERT ?? '/tmp/probe/device.crt',
  key: process.env.DSH_PROBE_KEY ?? '/tmp/probe/device.key',
  ca: process.env.DSH_PROBE_CA ?? '/tmp/probe/ca.pem',
  runnerPath: join(import.meta.dirname, 'heartbeat-runner.js'),
  tickMs: 10, // 限速器 tick 粒度
  highWater: 512 * 1024, // 限速器内部排队上限，超过就 pause 源 socket（传播背压）
});

function parseArgs(argv) {
  const options = {
    ...DEFAULTS,
    pongSpoof: false,
    json: false,
    quiet: false,
    help: false,
    runner: false,
    noFollow: false,
    proxyModule: null,
  };
  const takesValue = new Set([
    'host', 'port', 'rate', 'up-rate', 'duration', 'spoof-ms', 'big-threshold',
    'session', 'servername', 'cert', 'key', 'ca', 'runner-path', 'proxy-module',
  ]);
  const map = {
    host: 'host', port: 'port', rate: 'rate', 'up-rate': 'upRate', duration: 'duration',
    'spoof-ms': 'spoofMs', 'big-threshold': 'bigThreshold', session: 'session',
    servername: 'servername', cert: 'cert', key: 'key', ca: 'ca',
    'runner-path': 'runnerPath', 'proxy-module': 'proxyModule',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--pong-spoof') { options.pongSpoof = true; continue; }
    if (arg === '--json') { options.json = true; continue; }
    if (arg === '--quiet') { options.quiet = true; continue; }
    if (arg === '--runner') { options.runner = true; continue; }
    if (arg === '--no-follow') { options.noFollow = true; continue; }
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (!arg.startsWith('--')) throw new Error(`无法识别的参数: ${arg}`);
    const name = arg.slice(2);
    if (!takesValue.has(name)) throw new Error(`无法识别的参数: ${arg}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`参数 ${arg} 缺少值`);
    i += 1;
    const key = map[name];
    options[key] = ['port', 'rate', 'upRate', 'duration', 'spoofMs', 'bigThreshold', 'tickMs', 'highWater'].includes(key)
      ? Number(value)
      : value;
  }
  return options;
}

function printHelp() {
  console.log(`heartbeat-verify — 慢速链路下 DSH mux 心跳误杀验证

用法: node poc/heartbeat-verify.js [options]

  --host <addr>          目标 TLS 监听地址（默认 127.0.0.1）
  --port <n>             目标 TLS 监听端口（默认 63135 = 运行中的主机插件）
  --rate <B/s>           下行限速，字节/秒（默认 600000；0 = 不限速直连）
  --up-rate <B/s>        上行限速（默认 0 = 不限制）
  --runner               起 poc/heartbeat-runner.js（repo 当前代码）做目标，不连运行中的插件
  --proxy-module <path>  配合 --runner：指定 DshProxy 模块（默认 repo 版本；可指向旧版做 A/B）
  --no-follow            只开 $events、不 follow 大会话（心跳基线对照）
  --pong-spoof           每 --spoof-ms 主动发一个 unsolicited Pong（模拟修复效果）
  --spoof-ms <n>         Pong 间隔（默认 500）
  --duration <ms>        最长观察时间（默认 20000）
  --big-threshold <n>    判定「大帧」的字节阈值（默认 100000）
  --session <id>         要 follow 的会话 id（必填；或环境变量 DSH_PROBE_SESSION）
  --servername <s>       TLS SNI = 主机子域 <hostId>.<relayDomain>（必填；或 DSH_PROBE_SERVERNAME）
  --cert <path>          客户端证书（默认 $DSH_PROBE_CERT 或 /tmp/probe/device.crt）
  --key <path>           客户端私钥（默认 $DSH_PROBE_KEY 或 /tmp/probe/device.key）
  --json                 末尾输出一行 JSON 摘要
  --quiet                只输出最终结论
  -h, --help             显示本帮助
`);
}

// ————————————————————————————————————————————————————————————
// 限速 TCP 转发器：source→dest 方向按 bytesPerSecond 匀速放行，
// 用 pause/resume 把背压一路传回源 socket（从而让 DSH 的发送缓冲堆积）。
// ————————————————————————————————————————————————————————————
function createThrottledPump({ source, dest, bytesPerSecond, tickMs, highWaterBytes, onProgress }) {
  const budgetPerTick = Math.max(1, Math.floor((bytesPerSecond * tickMs) / 1000));
  /** @type {Buffer[]} */
  let chunks = [];
  let queuedBytes = 0;
  let sourcePaused = false;
  let ended = false;
  let finished = false;
  let waitingDrain = false;
  let timer = null;

  function stopTimer() {
    if (timer !== null) { clearInterval(timer); timer = null; }
  }
  function maybeFinish() {
    if (!ended || finished || queuedBytes > 0) return;
    finished = true;
    stopTimer();
    try { dest.end(); } catch { /* ignore */ }
  }
  function refill() {
    if (waitingDrain || finished) return;
    let budget = budgetPerTick;
    while (budget > 0 && chunks.length > 0) {
      const head = chunks[0];
      const take = Math.min(head.length, budget);
      const out = take === head.length ? head : head.subarray(0, take);
      if (take === head.length) chunks.shift(); else chunks[0] = head.subarray(take);
      queuedBytes -= take;
      budget -= take;
      onProgress?.(take);
      const ok = dest.write(out);
      if (!ok) {
        waitingDrain = true;
        dest.once('drain', () => { waitingDrain = false; });
        break;
      }
    }
    if (sourcePaused && queuedBytes <= highWaterBytes / 2) {
      sourcePaused = false;
      try { source.resume(); } catch { /* ignore */ }
    }
    maybeFinish();
  }
  function ensureTimer() {
    if (timer === null && !finished) timer = setInterval(refill, tickMs);
  }
  return {
    push(chunk) {
      if (finished || ended) return;
      chunks.push(chunk);
      queuedBytes += chunk.length;
      if (!sourcePaused && queuedBytes >= highWaterBytes) {
        sourcePaused = true;
        try { source.pause(); } catch { /* ignore */ }
      }
      ensureTimer();
    },
    end() {
      ended = true;
      ensureTimer();
      maybeFinish();
    },
    destroy() {
      finished = true;
      chunks = [];
      stopTimer();
    },
  };
}

function startLimiter({ targetHost, targetPort, downRate, upRate, tickMs, highWater }) {
  const stats = { connections: 0, downBytes: 0, upBytes: 0 };
  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set();
  const server = net.createServer((client) => {
    stats.connections += 1;
    client.setNoDelay(true);
    const upstream = net.connect({ host: targetHost, port: targetPort });
    upstream.setNoDelay(true);
    sockets.add(client);
    sockets.add(upstream);

    // 下行：主机插件 → 客户端（限速）
    const downstream = createThrottledPump({
      source: upstream,
      dest: client,
      bytesPerSecond: downRate,
      tickMs,
      highWaterBytes: highWater,
      onProgress: (n) => { stats.downBytes += n; },
    });
    upstream.on('data', (chunk) => { downstream.push(chunk); });
    upstream.on('end', () => { downstream.end(); });
    upstream.on('close', () => { downstream.destroy(); client.destroy(); });
    upstream.on('error', () => { downstream.destroy(); client.destroy(); });

    // 上行：客户端 → 主机插件（默认不限速，只统计；可选限速）
    if (upRate > 0) {
      const uplink = createThrottledPump({
        source: client,
        dest: upstream,
        bytesPerSecond: upRate,
        tickMs,
        highWaterBytes: highWater,
        onProgress: (n) => { stats.upBytes += n; },
      });
      client.on('data', (chunk) => { uplink.push(chunk); });
      client.on('end', () => { uplink.end(); });
      client.on('close', () => { uplink.destroy(); });
    } else {
      client.on('data', (chunk) => { stats.upBytes += chunk.length; });
      client.pipe(upstream);
      client.on('end', () => { if (!upstream.destroyed) upstream.end(); });
    }
    client.on('error', () => upstream.destroy());
    client.on('close', () => { downstream.destroy(); if (!upstream.destroyed) upstream.destroy(); });
  });
  return {
    stats,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject);
          resolve(server.address().port);
        });
      });
    },
    close() {
      for (const socket of sockets) { try { socket.destroy(); } catch { /* ignore */ } }
      return new Promise((resolve) => { server.close(() => resolve()); });
    },
  };
}

// ————————————————————————————————————————————————————————————
// standalone runner：把 repo 当前 host-plugin 代码起在一个临时端口上
// ————————————————————————————————————————————————————————————
function startRunner({ runnerPath, proxyModule, log }) {
  const args = [runnerPath];
  if (proxyModule) args.push('--proxy-module', proxyModule);
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const ready = new Promise((resolvePromise, rejectPromise) => {
    let buffer = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; rejectPromise(new Error('runner ready timeout (15s)')); }
    }, 15_000);
    const settle = (info) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(info);
    };
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.event === 'ready') { settle(parsed); continue; }
        } catch { /* not JSON: fall through to log */ }
        log(`[runner] ${line}`);
      }
    });
    child.stderr.on('data', (chunk) => log(`[runner:stderr] ${String(chunk).trim()}`));
    child.on('error', (error) => {
      clearTimeout(timer);
      if (!settled) { settled = true; rejectPromise(error); }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (!settled) { settled = true; rejectPromise(new Error(`runner 提前退出 code=${code}`)); }
    });
  });
  return { child, ready };
}

// ————————————————————————————————————————————————————————————
// 主流程
// ————————————————————————————————————————————————————————————
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { printHelp(); return; }
  if (!options.session || !options.servername) {
    const missing = [];
    if (!options.session) missing.push('--session（或 DSH_PROBE_SESSION）');
    if (!options.servername) missing.push('--servername（或 DSH_PROBE_SERVERNAME）');
    console.error(`缺少必填参数: ${missing.join('、')}`);
    console.error('  --session    : 要 follow 的会话 id');
    console.error('  --servername : 主机子域 <hostId>.<relayDomain>（TLS SNI）');
    process.exit(2);
  }
  const log = options.quiet
    ? () => {}
    : (...args) => console.log(...args);

  const cert = readFileSync(options.cert);
  const key = readFileSync(options.key);
  const ca = options.ca ? readFileSync(options.ca) : undefined;

  const t0 = Date.now();
  const at = () => Date.now() - t0;

  const summary = {
    startedAt: new Date().toISOString(),
    target: { host: options.host, port: options.port },
    throttled: options.rate > 0,
    rateBytesPerSecond: options.rate,
    upRateBytesPerSecond: options.upRate,
    pongSpoof: options.pongSpoof,
    spoofMs: options.pongSpoof ? options.spoofMs : null,
    sessionId: options.noFollow ? null : options.session,
    followedSession: !options.noFollow,
    wsOpenAtMs: null,
    limiterPort: null,
    pings: { count: 0, atMs: [] },
    messages: { count: 0, bytes: 0, sizes: [] },
    big: null,
    close: null,
    error: null,
    aliveAtEnd: false,
    verdict: null,
    forwarder: null,
    runner: null,
    durationMs: null,
  };

  let limiter = null;
  let runner = null;
  let targetPort = options.port;
  let targetHost = options.host;
  if (options.runner) {
    runner = startRunner({ runnerPath: options.runnerPath, proxyModule: options.proxyModule, log });
    const info = await runner.ready;
    summary.runner = info;
    targetHost = info.host ?? '127.0.0.1';
    targetPort = info.port;
    log(`[harness] standalone runner ready on 127.0.0.1:${info.port} proxyModule=${info.proxyModule}`);
  }
  if (options.rate > 0) {
    limiter = startLimiter({
      targetHost,
      targetPort,
      downRate: options.rate,
      upRate: options.upRate,
      tickMs: options.tickMs,
      highWater: options.highWater,
    });
    const limiterPort = await limiter.listen();
    summary.limiterPort = limiterPort;
    targetPort = limiterPort;
    targetHost = '127.0.0.1';
  }

  const url = `wss://${targetHost}:${targetPort}/api/remote.mux`;
  log(`[harness] target=${url} throttled=${options.rate > 0 ? `down ${options.rate} B/s` : 'no'} pongSpoof=${options.pongSpoof} follow=${options.noFollow ? 'no' : options.session}`);

  const eventsStreamId = randomUUID();
  const followStreamId = randomUUID();
  const ws = new WebSocket(url, {
    servername: options.servername,
    cert,
    key,
    ca,
    rejectUnauthorized: false,
    handshakeTimeout: 15_000,
    perMessageDeflate: false,
  });

  /** @type {NodeJS.Timeout|null} */
  let spoofTimer = null;
  let pongsSent = 0;
  let finished = false;
  /** @type {NodeJS.Timeout|null} */
  let finishTimer = null;

  const bytesTimeline = [];
  let lastSampleAt = 0;

  function finish(reason) {
    if (finished) return;
    finished = true;
    if (spoofTimer !== null) { clearInterval(spoofTimer); spoofTimer = null; }
    if (finishTimer !== null) { clearTimeout(finishTimer); finishTimer = null; }
    summary.durationMs = at();
    summary.aliveAtEnd = ws.readyState === WebSocket.OPEN;
    summary.endState = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][ws.readyState] ?? String(ws.readyState);
    summary.pongsSent = pongsSent;
    summary.bytesTimeline = bytesTimeline;
    summary.endReason = reason;
    if (limiter) {
      summary.forwarder = { ...limiter.stats };
    }
    if (runner) {
      try { runner.child.kill('SIGTERM'); } catch { /* ignore */ }
    }

    // —— 判定 ——
    const bigComplete = Boolean(summary.big && summary.big.complete);
    if (summary.close && bigComplete) {
      summary.verdict = `mux-killed-after-big-payload(close=${summary.close.code}, closeAt=${summary.close.atMs}ms, bigAt=${summary.big.atMs}ms)`;
    } else if (summary.close) {
      summary.verdict = `mux-killed-with-big-payload-in-flight(close=${summary.close.code}, closeAt=${summary.close.atMs}ms, bigAt=${summary.big?.atMs ?? null})`;
    } else if (bigComplete) {
      summary.verdict = 'survived-big-payload-complete';
    } else {
      summary.verdict = 'survived-without-big-payload';
    }
    // 输出
    const line = (name, value) => log(`[harness] ${name}: ${value}`);
    log('[harness] ———— 结果摘要 ————');
    line('target', `${targetHost}:${targetPort}${limiter ? ` (via limiter :${summary.limiterPort})` : ''}${summary.runner ? ` [runner :${summary.runner.port}, proxy=${summary.runner.proxyModule}]` : ''}`);
    line('mode', `downRate=${options.rate > 0 ? `${options.rate}B/s` : 'unlimited'} pongSpoof=${options.pongSpoof}`);
    line('ws open at', summary.wsOpenAtMs === null ? 'n/a' : `+${summary.wsOpenAtMs}ms`);
    line('pings received', `${summary.pings.count}  at=${JSON.stringify(summary.pings.atMs)}`);
    line('messages', `${summary.messages.count} total, ${summary.messages.bytes}B`);
    line('big payload', summary.big
      ? `${summary.big.size}B at +${summary.big.atMs}ms (complete=${summary.big.complete}${summary.big.parsed?.records !== undefined ? `, records=${summary.big.parsed.records}` : ''})`
      : 'none');
    line('close', summary.close ? `code=${summary.close.code} at +${summary.close.atMs}ms reason="${summary.close.reason}"` : 'no (socket still open at end)');
    line('error', summary.error ?? 'none');
    line('forwarder', limiter ? JSON.stringify(summary.forwarder) : 'no limiter');
    line('duration', `${summary.durationMs}ms (endReason=${reason})`);
    line('VERDICT', summary.verdict);

    if (options.json) {
      console.log(JSON.stringify(summary));
    }
    cleanup().catch(() => {});
  }

  async function cleanup() {
    if (spoofTimer !== null) clearInterval(spoofTimer);
    try { ws.terminate(); } catch { /* ignore */ }
    if (runner) { try { runner.child.kill('SIGTERM'); } catch { /* ignore */ } }
    if (limiter) {
      await Promise.race([
        limiter.close().catch(() => {}),
        new Promise((resolvePromise) => setTimeout(resolvePromise, 2000)),
      ]);
    }
    setTimeout(() => process.exit(0), 50);
  }

  // 收到 close 后稍等再收尾，让 ws/限速器把剩余统计跑完
  function scheduleFinish(reason, delayMs = 500) {
    if (finished || finishTimer !== null) return;
    finishTimer = setTimeout(() => finish(reason), delayMs);
  }

  ws.on('open', () => {
    summary.wsOpenAtMs = at();
    log(`[harness] mux open at +${summary.wsOpenAtMs}ms`);
    // 与 DSH Web 客户端一致：先订阅 $events，再 follow 大会话
    ws.send(JSON.stringify({ type: 'open', streamId: eventsStreamId, endpoint: '$events', payload: { args: {} } }));
    if (!options.noFollow) {
      ws.send(JSON.stringify({
        type: 'open',
        streamId: followStreamId,
        endpoint: 'session/follow',
        payload: { args: { request: { address: { kind: 'session', sessionId: options.session }, assistantStream: true } } },
      }));
    }
  });

  if (options.pongSpoof) {
    spoofTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.pong();
      pongsSent += 1;
    }, options.spoofMs);
  }

  ws.on('ping', (payload) => {
    summary.pings.count += 1;
    summary.pings.atMs.push(at());
    log(`[harness] ping #${summary.pings.count} at +${at()}ms len=${payload?.length ?? 0}`);
  });

  ws.on('message', (data, isBinary) => {
    const size = data.length;
    summary.messages.count += 1;
    summary.messages.bytes += size;
    if (summary.messages.sizes.length < 50) summary.messages.sizes.push({ atMs: at(), size });
    const now = at();
    if (now - lastSampleAt >= 200) {
      bytesTimeline.push({ atMs: now, bytes: summary.messages.bytes });
      lastSampleAt = now;
    }
    if (!isBinary && size >= options.bigThreshold && !summary.big) {
      const big = { size, atMs: now, complete: true, parsed: { ok: false } };
      try {
        const parsed = JSON.parse(String(data));
        const value = parsed?.value ?? parsed;
        const records = value?.records?.length ?? value?.value?.records?.length;
        big.parsed = {
          ok: true,
          type: parsed?.type ?? null,
          keys: Object.keys(value ?? {}).slice(0, 12),
          records: Number.isInteger(records) ? records : undefined,
          streamId: parsed?.streamId ?? null,
        };
      } catch (error) {
        big.parsed = { ok: false, error: error.message };
      }
      summary.big = big;
      log(`[harness] BIG message ${size}B at +${now}ms complete=true parsed=${JSON.stringify(big.parsed)}`);
      // 大帧已完整到达：若在跑「存活」场景，继续观察到 duration；若已被杀则马上收尾
      if (summary.close) scheduleFinish('big-payload-and-close', 100);
    }
  });

  ws.on('unexpected-response', (req, res) => {
    summary.error = `unexpected HTTP ${res.statusCode}`;
    log(`[harness] unexpected-response HTTP ${res.statusCode}`);
    res.resume();
    scheduleFinish('unexpected-response', 100);
  });

  ws.on('close', (code, reason) => {
    if (finished) return;
    summary.close = { code, reason: String(reason ?? ''), atMs: at() };
    log(`[harness] CLOSE code=${code} reason="${String(reason ?? '')}" at +${summary.close.atMs}ms`);
    scheduleFinish('close', 300);
  });

  ws.on('error', (error) => {
    if (finished) return;
    summary.error = error.message;
    log(`[harness] ERROR at +${at()}ms: ${error.message}`);
    scheduleFinish('error', 300);
  });

  // 最长观察窗口
  setTimeout(() => finish('duration-reached'), options.duration);

  // 看门狗：无论收尾路径发生什么，最长 duration+30s 后强制退出，避免测试挂死。
  setTimeout(() => {
    console.error(`[harness] watchdog: hard exit after ${options.duration + 30_000}ms`);
    process.exit(2);
  }, options.duration + 30_000);

}

main().catch((error) => {
  console.error(`[harness] fatal: ${error.stack ?? error.message}`);
  process.exit(1);
});
