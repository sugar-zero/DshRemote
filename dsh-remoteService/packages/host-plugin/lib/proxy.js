import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { createHash } from 'node:crypto';

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

/**
 * DSH 本机 Web 服务的反向代理：
 * - 远程设备只面对主机插件的 TLS 监听；本类只负责把已认证请求转给 127.0.0.1。
 * - 不信任任何客户端 Host/Origin/Forwarded 头；统一重写 Host 并注入本机浏览器 cookie。
 * - deny 前缀（/connect、/oauth、/api/remote-access、/__dsh_remote 等）绝不外发。
 */
export class DshProxy {
  constructor({ getUpstream, authenticatedUrl, denyPrefixes = [], audit, log = () => {} }) {
    this.getUpstream = getUpstream;
    this.authenticatedUrl = authenticatedUrl;
    this.denyPrefixes = denyPrefixes.map(String);
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
        const contentType = String(upRes.headers['content-type'] ?? '');
        if (contentType.includes('text/html')) headers['cache-control'] = 'no-store';
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
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
      clientSocket.on('error', () => upstream.destroy());
      upstream.on('error', () => clientSocket.destroy());
      upstream.on('close', () => clientSocket.destroy());
      clientSocket.on('close', () => upstream.destroy());
    });
  }
}
