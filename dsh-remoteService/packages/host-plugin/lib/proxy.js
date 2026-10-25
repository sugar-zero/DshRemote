import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { createHash } from 'node:crypto';
import { createWsFrameScanner, buildMaskedPongFrame, WS_OPCODE_PING } from './ws-keepalive.js';

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

/** 请求头剥离清单：身份/来源头一律不向上游透传。 */
const STRIP_REQUEST_HEADERS = new Set([
  ...HOP_BY_HOP,
  'host', 'cookie', 'authorization', 'origin', 'referer',
  'forwarded', 'x-real-ip', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port',
  'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user',
]);

const STRIP_RESPONSE_HEADERS = new Set([...HOP_BY_HOP, 'set-cookie']);

function hashOf(value) {
  return createHash('sha256').update(String(value ?? '')).digest('base64url');
}

/** 上游 WS 升级响应头的最大允许字节数（超过视为非 HTTP 响应，退化为纯透传）。 */
const MAX_UPGRADE_RESPONSE_HEAD_BYTES = 64 * 1024;

/**
 * 从反向代理收到的上游字节流里切出 HTTP 响应头。
 *
 * @param {Buffer} buffer 累积的字节
 * @param {number} [maxBytes] 头部上限，超过则视为非 HTTP 响应
 * @returns {{ status: number | null, overflow: boolean, header: Buffer, rest: Buffer } | null}
 *          返回 null 表示头还不完整；overflow=true 时 header 为全部已收字节。
 */
export function splitUpgradeResponseHead(buffer, maxBytes = MAX_UPGRADE_RESPONSE_HEAD_BYTES) {
  const end = buffer.indexOf('\r\n\r\n');
  if (end === -1) {
    if (buffer.length <= maxBytes) return null;
    return { status: null, overflow: true, header: buffer, rest: Buffer.alloc(0) };
  }
  const header = buffer.subarray(0, end + 4);
  const rest = buffer.subarray(end + 4);
  const match = /^HTTP\/1\.[01] (\d{3})/.exec(header.toString('latin1', 0, Math.min(header.length, 32)));
  return { status: match === null ? null : Number(match[1]), overflow: false, header, rest };
}

/**
 * DSH 本机 Web 服务的反向代理：
 * - 远程设备只面对主机插件的 TLS 监听；本类只负责把已认证请求转给 127.0.0.1。
 * - 不信任任何客户端 Host/Origin/Forwarded 头；统一重写 Host 并注入本机浏览器 cookie。
 * - deny 前缀（/connect、/oauth、/api/remote-access、/__dsh_remote 等）绝不外发。
 */
const DEFAULT_MAX_REQUEST_BYTES = 256 * 1024 * 1024;

/** DSH Web 的 Remote stream mux 路径：需要心跳中间盒。 */
const REMOTE_STREAM_MUX_PATH = '/api/remote.mux';
/** 下行积压超过该字节数就认为链路拥塞（开始主动代答心跳）。 */
const KEEPALIVE_CONGESTION_BYTES = 64 * 1024;
/** 拥塞期间主动代答 Pong 的间隔（DSH 心跳 2s / 忍 2 个周期）。 */
const KEEPALIVE_INTERVAL_MS = 1000;

/** 远程响应安全头（DSH 本身未设置；由主机插件统一补）。 */
const SECURITY_RESPONSE_HEADERS = Object.freeze({
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
});

export class DshProxy {
  constructor({ getUpstream, authenticatedUrl, denyPrefixes = [], getMaxRequestBytes, audit, log = () => {} }) {
    this.getUpstream = getUpstream;
    this.authenticatedUrl = authenticatedUrl;
    this.denyPrefixes = denyPrefixes.map(String);
    this.getMaxRequestBytes = getMaxRequestBytes;
    this.audit = audit;
    this.log = log;
    this.cookieHeader = '';
    this.cookieRefreshedAt = 0;
    this.cookiePromise = undefined;
  }

  isDenied(rawUrl) {
    let pathname;
    try {
      pathname = new URL(rawUrl ?? '/', 'http://localhost').pathname;
    } catch {
      return true;
    }
    return this.denyPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`) || pathname.startsWith(prefix));
  }

  upstreamTarget() {
    const up = this.getUpstream() || {};
    return {
      protocol: up.protocol === 'https:' || up.protocol === 'https' ? 'https' : 'http',
      host: up.host || '127.0.0.1',
      port: Number(up.port),
    };
  }

  async ensureCookie(force = false) {
    const fresh = this.cookieHeader && !force && Date.now() - this.cookieRefreshedAt < 6 * 60 * 60 * 1000;
    if (fresh) return this.cookieHeader;
    if (this.cookiePromise) return this.cookiePromise;
    this.cookiePromise = this.#refreshCookie(force).finally(() => { this.cookiePromise = undefined; });
    return this.cookiePromise;
  }

  async #refreshCookie(force) {
    const target = this.upstreamTarget();
    const url = new URL(this.authenticatedUrl());
    const client = url.protocol === 'https:' ? https : http;
    const cookie = await new Promise((resolve, reject) => {
      const req = client.request({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: { host: `${target.host}:${target.port}`, connection: 'close' },
        rejectUnauthorized: false,
        timeout: 5000,
      }, (res) => {
        const raw = res.headers['set-cookie'];
        res.resume();
        if (!Array.isArray(raw) || raw.length === 0) {
          reject(new Error(`本机 DSH auth 交换没有返回 cookie（HTTP ${res.statusCode}）`));
          return;
        }
        resolve(raw.map((entry) => String(entry).split(';')[0]).join('; '));
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end();
    });
    if (!cookie) throw new Error('无法获取本机 DSH 浏览器 cookie');
    this.cookieHeader = cookie;
    this.cookieRefreshedAt = Date.now();
    this.log(`cookie refreshed${force ? ' (forced)' : ''}`);
    return cookie;
  }

  #upstreamHeaders(req) {
    const target = this.upstreamTarget();
    const headers = {};
    for (const [name, value] of Object.entries(req.headers ?? {})) {
      const lower = name.toLowerCase();
      if (STRIP_REQUEST_HEADERS.has(lower)) continue;
      if (value === undefined) continue;
      headers[lower] = value;
    }
    headers.host = `${target.host}:${target.port}`;
    headers.connection = 'close';
    headers.cookie = this.cookieHeader;
    return headers;
  }

  async handle(req, res, device) {
    const target = this.upstreamTarget();
    const maxBytes = Number(this.getMaxRequestBytes?.() ?? DEFAULT_MAX_REQUEST_BYTES) || DEFAULT_MAX_REQUEST_BYTES;
    const declaredBytes = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      this.audit?.append({ deviceId: device?.id, action: 'proxy-reject', resource: 'body-too-large', result: 'denied' });
      res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('payload too large');
      return;
    }
    if (this.isDenied(req.url)) {
      this.audit?.append({ deviceId: device?.id, action: 'proxy-deny', resource: req.url, result: 'denied' });
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('forbidden');
      return;
    }
    let attempt = 0;
    const run = async () => {
      attempt += 1;
      try {
        await this.ensureCookie(attempt > 1);
      } catch (error) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`remote upstream auth unavailable: ${error.message}`);
        return;
      }
      const client = target.protocol === 'https' ? https : http;
      const upstream = client.request({
        hostname: target.host,
        port: target.port,
        method: req.method,
        path: req.url,
        headers: this.#upstreamHeaders(req),
        rejectUnauthorized: false,
        timeout: 60_000,
      }, (upRes) => {
        if (upRes.statusCode === 401 && attempt === 1) {
          upRes.resume();
          this.cookieHeader = '';
          run().catch(() => {});
          return;
        }
        const headers = {};
        for (const [name, value] of Object.entries(upRes.headers ?? {})) {
          if (STRIP_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
          if (value === undefined) continue;
          headers[name] = value;
        }
        Object.assign(headers, SECURITY_RESPONSE_HEADERS);
        const contentType = String(upRes.headers['content-type'] ?? '');
        let pathname = '/';
        try { pathname = new URL(req.url ?? '/', 'https://localhost').pathname; } catch { /* ignore */ }
        if (contentType.includes('text/html') || pathname.startsWith('/api/')) headers['cache-control'] = 'no-store';
        headers['x-dsh-remote-device'] = device?.id ?? 'unknown';
        res.writeHead(upRes.statusCode ?? 502, headers);
        upRes.pipe(res);
      });
      upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
      upstream.on('error', (error) => {
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(`remote upstream error: ${error.message}`);
        } else {
          res.destroy();
        }
      });
      req.pipe(upstream);
    };
    await run();
  }

  /** WebSocket 升级代理：手工写 upstream Upgrade 请求，再把两条 socket 对接。 */
  async handleUpgrade(req, clientSocket, head, device) {
    const target = this.upstreamTarget();
    if (this.isDenied(req.url)) {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    try {
      await this.ensureCookie();
    } catch {
      clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      return;
    }
    const upstream = target.protocol === 'https'
      ? tls.connect({ host: target.host, port: target.port, rejectUnauthorized: false, servername: target.host })
      : net.connect({ host: target.host, port: target.port });

    const key = req.headers['sec-websocket-key'];
    const version = req.headers['sec-websocket-version'] ?? '13';
    const protocol = req.headers['sec-websocket-protocol'];
    const extensions = req.headers['sec-websocket-extensions'];
    const lines = [
      `GET ${req.url} HTTP/1.1`,
      `Host: ${target.host}:${target.port}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      `Sec-WebSocket-Key: ${key}`,
      `Sec-WebSocket-Version: ${version}`,
      `Cookie: ${this.cookieHeader}`,
    ];
    if (protocol) lines.push(`Sec-WebSocket-Protocol: ${protocol}`);
    if (extensions) lines.push(`Sec-WebSocket-Extensions: ${extensions}`);
    const requestText = `${lines.join('\r\n')}\r\n\r\n`;
    /** 只有 DSH 的 Remote stream mux 需要心跳代答。 */
    let isMuxUpgrade = false;
    try {
      isMuxUpgrade = new URL(req.url ?? '/', 'http://localhost').pathname === REMOTE_STREAM_MUX_PATH;
    } catch {
      isMuxUpgrade = false;
    }

    let settled = false;
    const fail = (message) => {
      if (settled) return;
      settled = true;
      this.audit?.append({ deviceId: device?.id, action: 'ws-upgrade', resource: req.url, result: 'failed' });
      if (!clientSocket.destroyed) clientSocket.end(`HTTP/1.1 502 Bad Gateway\r\n\r\n${message ?? ''}`);
      upstream.destroy();
    };
    upstream.setTimeout(10_000, () => fail('upstream timeout'));
    upstream.once('error', (error) => fail(error.message));
    upstream.once('connect', () => {
      settled = true;
      upstream.setTimeout(0);
      upstream.write(requestText);
      if (head && head.length > 0) upstream.write(head);
      this.audit?.append({ deviceId: device?.id, action: 'ws-upgrade', resource: req.url, result: 'ok', hash: hashOf(device?.id) });

      // —— WS 心跳中间盒 ——
      // DSH 的 /api/remote.mux 每 2s Ping 一次、连续 2 个周期收不到 Pong 就
      // terminate。打开大会话时 `session/follow` 的首帧是数 MB 的历史快照，
      // 经慢速 relay 下行时 Ping/Pong 被排在这帧后面 → DSH 误判客户端失联，
      // 客户端重连再重试（手机端表现为「载入历史很慢/失败 + 画面反复跳」）。
      // 这里在 DSH→客户端 的明文字节流上做增量帧扫描，收到 Ping 就立刻代替
      // 隧道链路回一个 masked Pong，把心跳与慢速下行解耦；原始字节仍原样转发。
      // 真正的客户端失联仍由 socket close 检测（upstream 随之 destroy）。
      let scanFrame = createSafeScanner(this.log, (frame) => {
        if (frame.opcode !== WS_OPCODE_PING) return;
        try {
          if (!upstream.destroyed && upstream.writable) {
            upstream.write(buildMaskedPongFrame(frame.payload));
          }
        } catch (error) {
          this.log(`ws keepalive pong failed: ${error?.message ?? error}`);
        }
      });
      let scanEnabled = true;
      /** 把字节原样转发给客户端（带背压）。 */
      const forwardToClient = (chunk) => {
        if (clientSocket.destroyed || chunk.length === 0) return;
        if (clientSocket.write(chunk) === false) {
          upstream.pause();
          clientSocket.once('drain', () => {
            if (!upstream.destroyed) upstream.resume();
          });
        }
      };
      // 注意：扫描器只能吃 WebSocket 帧，不能吃 HTTP 101 响应头。
      // 先按 \r\n\r\n 切出上游响应头原样转发（同一 chunk 可能「头尾 + 首帧」），
      // 之后再启用帧扫描；若上游没返回 101（被 DSH 拒绝），则退化为纯字节透传。
      let responseHeadBuffer = Buffer.alloc(0);
      let responseHeadDone = false;
      upstream.on('data', (chunk) => {
        if (responseHeadDone) {
          if (scanEnabled && scanFrame !== null) scanFrame(chunk);
          forwardToClient(chunk);
          return;
        }
        responseHeadBuffer = responseHeadBuffer.length === 0 ? chunk : Buffer.concat([responseHeadBuffer, chunk]);
        const parsed = splitUpgradeResponseHead(responseHeadBuffer);
        if (parsed === null) return; // 头还没收全
        responseHeadDone = true;
        responseHeadBuffer = Buffer.alloc(0);
        if (parsed.status !== 101) {
          scanEnabled = false;
          const result = parsed.overflow ? 'non-http-response' : `upstream-${parsed.status ?? 'unknown'}`;
          this.audit?.append({ deviceId: device?.id, action: 'ws-upgrade-failed', resource: req.url, result });
          this.log(`ws upgrade rejected upstream (${result})`);
        }
        forwardToClient(parsed.header);
        if (scanEnabled && scanFrame !== null && parsed.rest.length > 0) scanFrame(parsed.rest);
        if (parsed.rest.length > 0) forwardToClient(parsed.rest);
        if (parsed.status === 101 && isMuxUpgrade) startKeepAlive();
      });

      // —— 拥塞时的主动心跳代答 ——
      // ⚠️ 只做上面的 reactive（扫到 Ping 再回 Pong）**不够**：DSH 写数 MB 帧后，
      // 后续 2s Ping 帧排在同一发送队列的字节流后面；一旦代理因下行拥塞暂停读
      // 上游，Ping 要等 payload 排空才会被读到，等读到再回 Pong 时 DSH 已经
      // 触发 MAX_MISSED_HEARTBEATS(2) 而 terminate（限速链路 A/B 实测：reactive
      // only 在 300KB/s 下 12.0s 被杀，被动 Pong 方案 15.2s 完整传完仍存活）。
      // 因此拥塞期间（代理对上游暂停读 / 客户端 TLS 缓冲积压）改为定时主动发
      // masked Pong，把 DSH 心跳与下行进度彻底解耦；链路通畅时不发，尽量保留
      // 原心跳语义（半开 TCP 仍由 socket close 清理）。
      let keepAliveTimer = null;
      const stopKeepAlive = () => {
        if (keepAliveTimer !== null) {
          clearInterval(keepAliveTimer);
          keepAliveTimer = null;
        }
      };
      const startKeepAlive = () => {
        if (keepAliveTimer !== null || !isMuxUpgrade) return;
        keepAliveTimer = setInterval(() => {
          if (upstream.destroyed || !upstream.writable || clientSocket.destroyed) {
            stopKeepAlive();
            return;
          }
          const congested = upstream.isPaused() || clientSocket.writableLength > KEEPALIVE_CONGESTION_BYTES;
          if (!congested) return;
          try {
            upstream.write(buildMaskedPongFrame(Buffer.alloc(0)));
          } catch (error) {
            this.log(`ws keepalive proactive pong failed: ${error?.message ?? error}`);
            stopKeepAlive();
          }
        }, KEEPALIVE_INTERVAL_MS);
        keepAliveTimer.unref?.();
      };
      upstream.on('end', () => {
        if (!clientSocket.destroyed) clientSocket.end();
      });
      clientSocket.pipe(upstream);
      clientSocket.on('error', () => { stopKeepAlive(); upstream.destroy(); });
      upstream.on('error', () => { stopKeepAlive(); clientSocket.destroy(); });
      upstream.on('close', () => { stopKeepAlive(); clientSocket.destroy(); });
      clientSocket.on('close', () => { stopKeepAlive(); upstream.destroy(); });
    });
  }
}

/**
 * 创建「安全」的 WebSocket 帧扫描函数：扫描器遇到非法帧时只记日志并永久
 * 停用，绝不影响原始字节转发（最坏退化为纯 TCP 透传）。
 * @param {(message: string) => void} log
 * @param {(frame: { opcode: number, payload: Buffer }) => void} onControlFrame
 * @returns {((chunk: Buffer) => void) | null}
 */
function createSafeScanner(log, onControlFrame) {
  let scanner;
  try {
    scanner = createWsFrameScanner(onControlFrame);
  } catch (error) {
    log(`ws frame scanner disabled: ${error?.message ?? error}`);
    return null;
  }
  let broken = false;
  return (chunk) => {
    if (broken) return;
    try {
      scanner(chunk);
    } catch (error) {
      broken = true;
      log(`ws frame scanner disabled: ${error?.message ?? error}`);
    }
  };
}
