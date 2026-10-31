/**
 * 自托管盲中继（方案 B2）核心实现。
 *
 *   :443/tcp   TLS 透传 —— 只读 ClientHello 的 SNI，按 <hostId>.<domain> 路由；
 *              relay 不终止 TLS、不持有主机证书私钥，看不到明文内容。
 *   :80/tcp    除 /healthz 外一律 301 到 https://<host><path>。
 *   :8443/tcp  控制面 WSS（host 插件专用）：host.hello 鉴权 → host.ready →
 *              JSON 控制消息 + 二进制流帧（dsh-remote-protocol）。
 *
 * 数据面多路复用：
 *   公网连接 → u32 streamId → host.open(JSON) → host.opened(JSON) →
 *   [二进制 DATA 帧双向] → CLOSE 帧。
 */

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { WebSocket, WebSocketServer } from 'ws';
import {
  CONTROL_PATH,
  FRAME_TYPE,
  GROUP_AUTH_CHALLENGE_PATH,
  GROUP_AUTH_TOKEN_PATH,
  GROUP_EDGE_STREAM_KIND,
  GROUP_REGISTER_PATH,
  GROUP_REFRESH_PATH,
  PAIR_PATH,
  PAIR_STATUS_PATH,
  PROTOCOL_VERSION,
  RELAY_MSG,
  decodeFrame,
  encodeFrame,
  hostFqdn,
  safeEqualStrings,
} from 'dsh-remote-protocol';
import { MAX_CLIENT_HELLO_BYTES, parseClientHello } from './sni.js';
import { isValidHostId, loadHostTokens, normalizeHostId } from './tokens.js';
import { normalizeConfig, readTlsMaterial } from './config.js';
import { createPushService } from './push.js';
import { GroupRegistrationService, verifyHostToken } from './group.js';
import { GROUP_ADMIN_BASE, createGroupAdminHandler, ensureAdminToken } from './group-admin.js';
import { dirname, join } from 'node:path';
import { GroupAuthError, GroupAuthService } from './group-auth.js';
import { parseHttpHead, readHttpHead, readHttpJsonBody, writeHttpResponse } from './edge-http.js';

/** 控制面单帧上限（流帧由主机侧切成合理大小；给 32 MiB 余量）。 */
const MAX_CONTROL_PAYLOAD = 32 * 1024 * 1024;
/** app → host 方向的 ws 背压水位。 */
const SEND_HIGH_WATER_BYTES = 2 * 1024 * 1024;
const SEND_LOW_WATER_BYTES = 1024 * 1024;
/** 控制连接关闭码（应用层自定义段 4000-4999）。 */
const CLOSE_CODE_REPLACED = 4001;
const CLOSE_CODE_HEARTBEAT_TIMEOUT = 4002;
const CLOSE_CODE_RELAY_SHUTDOWN = 4003;

/** @param {import('ws').WebSocket | undefined | null} ws */
function isWsOpen(ws) {
  return Boolean(ws) && ws.readyState === WebSocket.OPEN;
}

/** @param {net.Server | http.Server | undefined | null} server */
function closeServer(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

/**
 * 带 mtime 无关的 tokens 文件按需读取：每次握手都重读，CLI 改动即时生效。
 */
class HostTokenStore {
  /**
   * @param {{hostTokens: Record<string, string>, tokensFile?: string, logger: any}} options
   */
  constructor({ hostTokens, tokensFile, logger }) {
    this.explicit = hostTokens ?? {};
    this.tokensFile = tokensFile;
    this.logger = logger;
  }

  /** @param {string} hostId @returns {string | undefined} */
  get(hostId) {
    if (Object.hasOwn(this.explicit, hostId)) return this.explicit[hostId];
    if (!this.tokensFile) return undefined;
    try {
      const tokens = loadHostTokens(this.tokensFile);
      return Object.hasOwn(tokens, hostId) ? tokens[hostId] : undefined;
    } catch (err) {
      this.logger.warn(`cannot read tokens file "${this.tokensFile}": ${err && err.message ? err.message : String(err)}`);
      return undefined;
    }
  }
}

/** @param {net.Socket} socket */
function formatPeer(socket) {
  return `${socket.remoteAddress ?? '?'}:${socket.remotePort ?? '?'}`;
}

class Relay {
  /** @param {ReturnType<typeof normalizeConfig>} config */
  constructor(config) {
    this.config = config;
    this.logger = config.logger;
    this.tokenStore = new HostTokenStore({
      hostTokens: config.hostTokens,
      tokensFile: config.tokensFile,
      logger: config.logger,
    });
    this.pushService = createPushService({ ...config.push, logger: config.logger });
    /**
     * 群体服务版（A 模式）注册/开通服务；classic 模式下为 null（main 行为不变）。
     * @type {GroupRegistrationService | null}
     */
    /**
     * 群体版设备会话鉴权（仅 group + edge 时启用）：短时 token、challenge、设备注册表。
     * @type {GroupAuthService | null}
     */
    this.groupAuth = config.mode === 'group' && config.group.edge.enabled
      ? new GroupAuthService({
        groupFile: config.group.file,
        ...config.group.auth,
        logger: config.logger,
      })
      : null;
    this.groupService = config.mode === 'group'
      ? new GroupRegistrationService({
        ...config.group,
        relayDomain: config.domain,
        logger: config.logger,
        tokenPublicKey: this.groupAuth?.publicKey,
        getControlPort: () => this.controlPort,
        publicControlPort: config.group.publicControlPort,
      })
      : null;
    /** 群体版部署方后台（/__admin）：默认自动生成 admin-token 文件（0600）。 */
    this.groupAdmin = null;
    this.groupAdminTokenInfo = null;
    if (config.mode === 'group') {
      const adminTokenFile = config.group.adminTokenFile ?? join(dirname(config.group.file), 'admin-token');
      const admin = ensureAdminToken({ token: config.group.adminToken, tokenFile: adminTokenFile });
      this.groupAdminTokenInfo = admin;
      this.groupAdmin = createGroupAdminHandler({
        groupFile: config.group.file,
        domain: config.domain,
        mobilePort: config.group.mobilePort,
        adminToken: admin.token,
        onlineHostIds: () => [...this.hosts.keys()],
        logger: config.logger,
      });
    }

    /** @type {Map<string, any>} hostId → host */
    this.hosts = new Map();
    /** @type {Set<net.Socket>} 数据面未关闭 socket（close() 时强制断） */
    this.dataSockets = new Set();
    /** @type {Map<string, number>} IP → 当前数据面连接数（DoS 兜底） */
    this.ipConnections = new Map();

    this.dataPort = config.dataPort;
    this.controlPort = config.controlPort;
    this.httpPort = config.httpPort;
    this.edgePort = 0;
    this.closed = false;

    /** @type {net.Server | null} */
    this.dataServer = null;
    /** @type {tls.Server | null} 群体版边缘 TLS（A 模式） */
    this.edgeServer = null;
    /** @type {Set<import('node:tls').TLSSocket>} 边缘连接（close() 时强制断） */
    this.edgeSockets = new Set();
    /** @type {Map<string, number>} IP → 边缘连接数（DoS 兜底） */
    this.edgeIpConnections = new Map();
    /** @type {http.Server | https.Server | null} */
    this.controlServer = null;
    /** @type {http.Server | https.Server | null} group 注册 API 独立监听（apiPort） */
    this.groupApiServer = null;
    /** @type {http.Server | https.Server | null} group 部署方后台独立监听（adminPort） */
    this.groupAdminServer = null;
    this.groupApiPort = 0;
    this.groupAdminPort = 0;
    /** @type {http.Server | null} */
    this.httpServer = null;
    /** @type {WebSocketServer | null} */
    this.wss = null;
    /** @type {NodeJS.Timeout | null} */
    this.heartbeatTimer = null;
  }

  async start() {
    const tlsMaterial = readTlsMaterial(this.config.tls);

    const controlRequestHandler = (req, res) => this.handleControlHttpRequest(req, res);
    this.controlServer = tlsMaterial
      ? https.createServer({ cert: tlsMaterial.cert, key: tlsMaterial.key }, controlRequestHandler)
      : http.createServer(controlRequestHandler);
    this.controlServer.on('error', (err) => this.logger.error(`control plane server error: ${err.code ?? ''} ${err.message}`));
    this.controlServer.on('upgrade', (req, socket, head) => this.handleControlUpgrade(req, socket, head));

    // 职责分离：控制面只做 WSS 隧道；注册 API / 部署方后台各自独立监听（apiPort / adminPort）。
    if (this.config.mode === 'group') {
      const makeHttpServer = (handler, name) => {
        const server = tlsMaterial
          ? https.createServer({ cert: tlsMaterial.cert, key: tlsMaterial.key }, handler)
          : http.createServer(handler);
        server.on('error', (err) => this.logger.error(`${name} server error: ${err.code ?? ''} ${err.message}`));
        return server;
      };
      if (this.config.group.apiPort !== undefined) {
        this.groupApiServer = makeHttpServer((req, res) => this.handleGroupApiHttpRequest(req, res), 'group api');
      }
      if (this.config.group.adminPort !== undefined) {
        this.groupAdminServer = makeHttpServer((req, res) => { void this.groupAdmin(req, res); }, 'group admin');
      }
    }

    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_CONTROL_PAYLOAD,
      perMessageDeflate: false,
      clientTracking: true,
    });
    this.wss.on('connection', (ws, req) => this.handleControlConnection(ws, req));
    this.wss.on('error', (err) => this.logger.error(`control websocket server error: ${err.message}`));

    this.httpServer = http.createServer((req, res) => this.handleHttpRequest(req, res));
    this.httpServer.on('error', (err) => this.logger.error(`http plane server error: ${err.code ?? ''} ${err.message}`));

    // group 模式由边缘 TLS 终结手机流量，不再启动 classic 的 L4 透传端口（避免占用 443）。
    if (this.config.mode !== 'group') {
      this.dataServer = net.createServer((socket) => this.handleDataConnection(socket));
      this.dataServer.on('error', (err) => this.logger.error(`data plane server error: ${err.code ?? ''} ${err.message}`));
    }

    if (this.config.mode === 'group' && this.config.group.edge.enabled) {
      const edgeTls = readTlsMaterial(this.config.group.edge.tls);
      this.edgeServer = tls.createServer(
        { cert: edgeTls.cert, key: edgeTls.key, requestCert: false, rejectUnauthorized: false },
        (socket) => this.handleEdgeConnection(socket),
      );
      this.edgeServer.on('tlsClientError', (err, socket) => {
        this.logger.debug(`edge: TLS handshake failed from ${formatPeer(socket)}: ${err.code ?? err.message}`);
      });
      this.edgeServer.on('error', (err) => this.logger.error(`edge server error: ${err.code ?? ''} ${err.message}`));
    }

    try {
      await Promise.all([
        this.dataServer ? this.listen(this.dataServer, this.config.dataPort, 'data') : Promise.resolve(),
        this.listen(this.controlServer, this.config.controlPort, 'control'),
        this.listen(this.httpServer, this.config.httpPort, 'http'),
        this.edgeServer ? this.listen(this.edgeServer, this.config.group.edge.port, 'edge') : Promise.resolve(),
        this.groupApiServer
          ? this.listen(
            this.groupApiServer,
            this.config.group.apiPort,
            'group api',
            this.config.group.apiBind ?? this.config.dataHost,
          )
          : Promise.resolve(),
        this.groupAdminServer
          ? this.listen(
            this.groupAdminServer,
            this.config.group.adminPort,
            'group admin',
            this.config.group.adminBind ?? '127.0.0.1',
          )
          : Promise.resolve(),
      ]);
    } catch (err) {
      this.closed = true;
      await this.closeTransport();
      throw err;
    }

    const controlAddr = /** @type {net.AddressInfo} */ (this.controlServer.address());
    const httpAddr = /** @type {net.AddressInfo} */ (this.httpServer.address());
    if (this.dataServer) this.dataPort = /** @type {net.AddressInfo} */ (this.dataServer.address()).port;
    this.controlPort = controlAddr.port;
    this.httpPort = httpAddr.port;
    if (this.groupApiServer) this.groupApiPort = /** @type {net.AddressInfo} */ (this.groupApiServer.address()).port;
    if (this.groupAdminServer) this.groupAdminPort = /** @type {net.AddressInfo} */ (this.groupAdminServer.address()).port;
    if (this.edgeServer) {
      this.edgePort = /** @type {net.AddressInfo} */ (this.edgeServer.address()).port;
      if (this.config.group.edge.allowUnauthenticated) {
        this.logger.warn(
          `group edge listening on :${this.edgePort} WITHOUT device authentication (dev-only); `
          + 'do not expose this to the internet',
        );
      } else {
        this.logger.info(`group edge listening on :${this.edgePort} (device session token auth enabled)`);
      }
    }

    const tick = Math.max(10, Math.min(this.config.timings.heartbeatIntervalMs, 5000));
    this.heartbeatTimer = setInterval(() => this.sweepHosts(), tick);
    this.heartbeatTimer.unref?.();

    this.logger.info(
      `relay listening on ${this.config.dataHost} — `
      + (this.dataServer ? `data :${this.dataPort} (tls passthrough), ` : '')
      + `control :${this.controlPort} (${tlsMaterial ? 'wss' : 'ws/dev'}), http :${this.httpPort}; domain ${this.config.domain}`,
    );
    if (this.groupApiServer) {
      const scheme = tlsMaterial ? 'https' : 'http';
      this.logger.info(
        `group api: ${scheme}://${this.config.domain}:${this.groupApiPort}${GROUP_REGISTER_PATH} `
        + `(self-registration + ${GROUP_REFRESH_PATH}; control plane :${this.controlPort} now WSS-only)`,
      );
    }
    if (this.groupAdmin) {
      const scheme = tlsMaterial ? 'https' : 'http';
      const info = this.groupAdminTokenInfo;
      const tokenHint = info?.file ? `${info.file}${info.generated ? ' (generated)' : ''}` : 'configured via group.adminToken';
      if (this.groupAdminServer) {
        this.logger.info(
          `group admin: ${scheme}://${this.config.group.adminBind ?? '127.0.0.1'}:${this.groupAdminPort}${GROUP_ADMIN_BASE}/ `
          + `— token: ${tokenHint}`,
        );
      } else {
        this.logger.info(`admin UI: ${scheme}://${this.config.domain}:${this.controlPort}${GROUP_ADMIN_BASE}/ — token: ${tokenHint}`);
      }
    }
    return this.api();
  }

  /**
   * @param {net.Server | http.Server} server
   * @param {number} port
   * @param {string} name
   */
  listen(server, port, name, host = this.config.dataHost) {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        server.removeListener('listening', onListening);
        const code = err && err.code ? ` (${err.code})` : '';
        reject(new Error(`failed to bind ${name} plane on ${host}:${port}${code}: ${err && err.message ? err.message : String(err)}`));
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen({ port, host });
    });
  }

  /** 暴露给调用方的 API（createRelay/startRelay 返回值）。 */
  api() {
    return {
      dataPort: this.dataPort,
      controlPort: this.controlPort,
      httpPort: this.httpPort,
      groupApiPort: this.groupApiPort,
      groupAdminPort: this.groupAdminPort,
      domain: this.config.domain,
      mode: this.config.mode,
      edgePort: this.edgePort,
      dev: this.config.dev,
      close: () => this.close(),
      health: () => this.health(),
      onlineHostIds: () => [...this.hosts.keys()].sort(),
    };
  }

  health() {
    return {
      ok: true,
      domain: this.config.domain,
      hosts: [...this.hosts.keys()].sort(),
      pushTokens: this.pushService.totalCount(),
    };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const host of [...this.hosts.values()]) this.removeHost(host, 'relay_shutdown');
    this.hosts.clear();
    for (const ws of this.wss?.clients ?? []) {
      try {
        ws.close(CLOSE_CODE_RELAY_SHUTDOWN, 'relay shutdown');
      } catch {
        /* ignore */
      }
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
    }
    for (const socket of this.dataSockets) socket.destroy();
    this.dataSockets.clear();
    for (const socket of this.edgeSockets) socket.destroy();
    this.edgeSockets.clear();
    this.controlServer?.closeAllConnections?.();
    this.httpServer?.closeAllConnections?.();
    this.groupApiServer?.closeAllConnections?.();
    this.groupAdminServer?.closeAllConnections?.();
    await this.closeTransport();
    this.logger.info('relay stopped');
  }

  async closeTransport() {
    const wss = this.wss;
    this.wss = null;
    try {
      wss?.close();
    } catch {
      /* ignore */
    }
    await Promise.all([
      closeServer(this.dataServer),
      closeServer(this.httpServer),
      closeServer(this.controlServer),
      closeServer(this.edgeServer),
      closeServer(this.groupApiServer),
      closeServer(this.groupAdminServer),
    ]);
  }

  // ---------------------------------------------------------------------------
  // 控制面（:8443 WSS，host 插件专用）
  // ---------------------------------------------------------------------------

  /** @param {http.IncomingMessage} req @param {net.Socket} socket @param {Buffer} head */
  handleControlUpgrade(req, socket, head) {
    if (this.closed) {
      socket.destroy();
      return;
    }
    let pathname = '/';
    try {
      pathname = new URL(req.url ?? '/', 'http://relay.invalid').pathname;
    } catch {
      pathname = req.url ?? '/';
    }
    if (pathname !== CONTROL_PATH) {
      this.logger.debug(`control: rejecting websocket upgrade for path ${JSON.stringify(pathname)}`);
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
  }

  /**
   * 控制端口上的普通 HTTP 请求：
   *   - POST /__group/register → 群体版自助注册（仅 group 模式）；
   *   - 其它 → 404（控制面只接受 WS upgrade）。
   */
  handleControlHttpRequest(req, res) {
    let pathname = '/';
    try {
      pathname = new URL(req.url ?? '/', 'http://relay.invalid').pathname;
    } catch {
      pathname = req.url ?? '/';
    }
    const separatedAdmin = this.config.mode === 'group' && this.config.group.adminPort !== undefined;
    const separatedApi = this.config.mode === 'group' && this.config.group.apiPort !== undefined;
    if (!separatedAdmin && this.groupAdmin && (pathname === GROUP_ADMIN_BASE || pathname.startsWith(`${GROUP_ADMIN_BASE}/`))) {
      void this.groupAdmin(req, res);
      return;
    }
    if (!separatedApi && this.groupService && pathname === GROUP_REGISTER_PATH) {
      void this.groupService.handleHttp(req, res);
      return;
    }
    if (!separatedApi && this.groupService && pathname === GROUP_REFRESH_PATH) {
      void this.groupService.handleRefreshHttp(req, res);
      return;
    }
    const body = JSON.stringify({ ok: false, error: { code: 'not_found', message: 'control plane only accepts WebSocket upgrades on /control' } });
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }

  /**
   * 独立注册 API 面（group.apiPort）：只服务 POST /__group/register；其它 404。
   * 控制面配置了 apiPort 后不再提供注册接口。
   * @param {http.IncomingMessage} req @param {http.ServerResponse} res
   */
  handleGroupApiHttpRequest(req, res) {
    let pathname = '/';
    try {
      pathname = new URL(req.url ?? '/', 'http://relay.invalid').pathname;
    } catch {
      pathname = req.url ?? '/';
    }
    if (this.groupService && pathname === GROUP_REGISTER_PATH) {
      void this.groupService.handleHttp(req, res);
      return;
    }
    if (this.groupService && pathname === GROUP_REFRESH_PATH) {
      void this.groupService.handleRefreshHttp(req, res);
      return;
    }
    const body = JSON.stringify({
      ok: false,
      error: { code: 'not_found', message: 'group api plane serves POST /__group/register only' },
    });
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }

  /**
   * @param {WebSocket} ws
   * @param {http.IncomingMessage} req
   */
  handleControlConnection(ws, req) {
    const conn = {
      ws,
      remote: formatPeer(req.socket),
      ready: false,
      /** @type {any} */
      host: null,
      lastSeenAt: Date.now(),
      /** @type {NodeJS.Timeout | null} */
      helloTimer: null,
    };
    conn.helloTimer = setTimeout(() => {
      if (!conn.ready) this.failConn(conn, 'handshake_timeout', 'host.hello was not received in time');
    }, this.config.timings.handshakeTimeoutMs);
    conn.helloTimer.unref?.();

    ws.on('message', (data, isBinary) => this.handleControlMessage(conn, data, isBinary));
    ws.on('close', () => this.handleControlClose(conn));
    ws.on('error', (err) => this.logger.debug(`control: socket error from ${conn.remote}: ${err.code ?? err.message}`));
    this.logger.debug(`control: connection from ${conn.remote}`);
  }

  /**
   * @param {any} conn
   * @param {Buffer} data
   * @param {boolean} isBinary
   */
  handleControlMessage(conn, data, isBinary) {
    conn.lastSeenAt = Date.now();
    if (conn.host) conn.host.lastSeenAt = conn.lastSeenAt;

    if (!conn.ready) {
      this.handlePreHelloMessage(conn, data, isBinary);
      return;
    }
    if (isBinary) {
      this.handleHostFrame(conn.host, data);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      this.logger.debug('control: ignoring malformed JSON text message');
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case RELAY_MSG.HOST_HEARTBEAT:
        return; // lastSeenAt 已刷新
      case RELAY_MSG.DEVICE_SYNC:
        this.handleDeviceSync(conn.host, msg);
        return;
      case RELAY_MSG.DEVICE_REVOKE:
        this.handleDeviceRevoke(conn.host, msg);
        return;
      case RELAY_MSG.HOST_OPENED:
        this.handleHostOpened(conn.host, msg);
        return;
      case RELAY_MSG.HOST_CLOSE:
        this.handleHostCloseMessage(conn.host, msg);
        return;
      case RELAY_MSG.PUSH_REGISTER: {
        try {
          const result = this.pushService.register(conn.host.hostId, {
            deviceId: msg.deviceId,
            provider: msg.provider,
            token: msg.token,
          });
          this.sendJson(conn.host.ws, { t: RELAY_MSG.PUSH_RESULT, action: 'register', ok: true, ...result });
        } catch (error) {
          this.sendJson(conn.host.ws, { t: RELAY_MSG.PUSH_RESULT, action: 'register', ok: false, code: error.code ?? 'push-register-failed', message: error.message });
        }
        return;
      }
      case RELAY_MSG.PUSH_SEND: {
        this.pushService.send(conn.host.hostId, { kind: msg.kind })
          .then((result) => this.sendJson(conn.host.ws, { t: RELAY_MSG.PUSH_RESULT, action: 'send', ok: true, ...result }))
          .catch((error) => this.sendJson(conn.host.ws, { t: RELAY_MSG.PUSH_RESULT, action: 'send', ok: false, message: error.message }));
        return;
      }
      default:
        this.logger.debug(`control: ignoring unsupported message type ${JSON.stringify(String(msg.t))}`);
    }
  }

  /**
   * @param {any} conn
   * @param {Buffer} data
   * @param {boolean} isBinary
   */
  handlePreHelloMessage(conn, data, isBinary) {
    if (isBinary) {
      this.failConn(conn, 'expected_hello', 'first control message must be a host.hello text frame');
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      this.failConn(conn, 'invalid_json', 'first control message must be valid JSON');
      return;
    }
    if (!msg || typeof msg !== 'object' || msg.t !== RELAY_MSG.HOST_HELLO) {
      this.failConn(conn, 'expected_hello', 'first control message must be host.hello');
      return;
    }
    this.handleHello(conn, msg);
  }

  /**
   * @param {any} conn
   * @param {Record<string, any>} msg
   */
  handleHello(conn, msg) {
    const version = Number(msg.protocolVersion);
    if (version !== PROTOCOL_VERSION) {
      this.failConn(conn, 'unsupported_protocol_version', `relay speaks protocol version ${PROTOCOL_VERSION}`);
      return;
    }
    if (!isValidHostId(msg.hostId)) {
      this.failConn(conn, 'invalid_host_id', 'hostId must be a DNS label (1-63 chars, a-z0-9_-)');
      return;
    }
    const hostId = normalizeHostId(msg.hostId);
    if (typeof msg.token !== 'string' || msg.token.length === 0) {
      this.failConn(conn, 'unauthorized', 'invalid host credentials');
      return;
    }
    if (!this.verifyHostCredential(hostId, msg.token)) {
      this.logger.warn(`control: rejected host "${hostId}" from ${conn.remote}: invalid token`);
      this.failConn(conn, 'unauthorized', 'invalid host credentials');
      return;
    }

    if (conn.helloTimer) {
      clearTimeout(conn.helloTimer);
      conn.helloTimer = null;
    }

    const hostName = typeof msg.hostName === 'string' && msg.hostName.trim() !== ''
      ? msg.hostName.trim().slice(0, 120)
      : hostId;

    // 同一 hostId 只保留最新连接：旧连接直接替换（先回收其 streams）。
    const existing = this.hosts.get(hostId);
    if (existing) {
      this.logger.info(`control: replacing existing control connection for host "${hostId}"`);
      this.removeHost(existing, 'replaced');
      this.sendJson(existing.ws, { t: RELAY_MSG.ERROR, code: 'replaced', message: 'replaced by a new control connection' });
      try {
        existing.ws.close(CLOSE_CODE_REPLACED, 'replaced');
      } catch {
        try {
          existing.ws.terminate();
        } catch {
          /* ignore */
        }
      }
    }

    const now = Date.now();
    const host = {
      hostId,
      hostName,
      ws: conn.ws,
      conn,
      connectedAt: now,
      lastSeenAt: now,
      lastHeartbeatAt: now,
      streams: new Map(),
      streamSeq: 0,
    };
    conn.ready = true;
    conn.host = host;
    this.hosts.set(hostId, host);
    this.logger.info(`host online: "${hostId}" (${hostName}) from ${conn.remote}`);

    this.sendJson(conn.ws, {
      t: RELAY_MSG.HOST_READY,
      protocolVersion: PROTOCOL_VERSION,
      hostId,
      domain: this.config.domain,
      hostname: hostFqdn(hostId, this.config.domain),
      dataPort: this.dataPort,
    });
  }

  /** @param {any} conn */
  handleControlClose(conn) {
    if (conn.helloTimer) {
      clearTimeout(conn.helloTimer);
      conn.helloTimer = null;
    }
    const host = conn.host;
    conn.host = null;
    conn.ready = false;
    if (host && this.hosts.get(host.hostId) === host) {
      this.removeHost(host, 'control_connection_closed');
    }
  }

  /**
   * @param {any} conn
   * @param {string} code
   * @param {string} message
   */
  failConn(conn, code, message) {
    this.logger.debug(`control: closing connection (${code}): ${message}`);
    if (conn.helloTimer) {
      clearTimeout(conn.helloTimer);
      conn.helloTimer = null;
    }
    if (isWsOpen(conn.ws)) {
      this.sendJson(conn.ws, { t: RELAY_MSG.ERROR, code, message });
      try {
        conn.ws.close(1008, code.slice(0, 120));
      } catch {
        try {
          conn.ws.terminate();
        } catch {
          /* ignore */
        }
      }
    } else {
      try {
        conn.ws.terminate();
      } catch {
        /* ignore */
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 数据面（:443 raw TCP，TLS 透传 + SNI 路由）
  // ---------------------------------------------------------------------------

  /** @param {net.Socket} socket */
  handleDataConnection(socket) {
    if (this.closed) {
      socket.destroy();
      return;
    }
    const ip = socket.remoteAddress ?? 'unknown';
    const ipCount = this.ipConnections.get(ip) ?? 0;
    if (ipCount >= this.config.limits.maxConnectionsPerIp
      || this.dataSockets.size >= this.config.limits.maxDataConnections) {
      this.logger.warn(`data: dropping connection from ${formatPeer(socket)}: connection limit reached`);
      socket.destroy();
      return;
    }
    this.ipConnections.set(ip, ipCount + 1);
    this.dataSockets.add(socket);
    socket.on('close', () => {
      this.dataSockets.delete(socket);
      const remaining = (this.ipConnections.get(ip) ?? 1) - 1;
      if (remaining <= 0) this.ipConnections.delete(ip);
      else this.ipConnections.set(ip, remaining);
    });
    socket.on('error', (err) => this.logger.debug(`data: socket error from ${formatPeer(socket)}: ${err.code ?? err.message}`));

    const remote = formatPeer(socket);
    let buffered = Buffer.alloc(0);
    let routed = false;

    /** @param {Buffer} chunk */
    const onData = (chunk) => {
      if (routed) return;
      buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
      if (buffered.length > MAX_CLIENT_HELLO_BYTES) {
        this.logger.debug(`data: dropping ${remote}: ClientHello exceeds ${MAX_CLIENT_HELLO_BYTES} bytes`);
        socket.destroy();
        return;
      }
      const result = parseClientHello(buffered);
      if (result.status === 'incomplete') return;
      routed = true;
      socket.removeListener('data', onData);
      if (result.status === 'invalid') {
        this.logger.debug(`data: dropping ${remote}: ${result.reason}`);
        socket.destroy();
        return;
      }
      this.routeDataConnection(socket, result.sni, buffered, remote);
    };
    socket.on('data', onData);
  }

  /**
   * 从 SNI 解析 hostId：必须严格是 <hostId>.<domain>，hostId 为单个 DNS 首标签。
   * @param {string | null | undefined} sni
   * @returns {string | null}
   */
  resolveHostIdFromSni(sni) {
    if (typeof sni !== 'string' || sni.length === 0 || sni.length > 253) return null;
    const name = sni.toLowerCase();
    const suffix = `.${this.config.domain}`;
    if (!name.endsWith(suffix)) return null;
    const hostId = name.slice(0, name.length - suffix.length);
    if (hostId === '' || hostId.includes('.') || !isValidHostId(hostId)) return null;
    return hostId;
  }

  /**
   * @param {net.Socket} socket
   * @param {string | null} sni
   * @param {Buffer} helloBytes 已读到的客户端字节（至少包含完整 ClientHello）
   * @param {string} remote
   */
  routeDataConnection(socket, sni, helloBytes, remote) {
    if (socket.destroyed) return;
    // 先暂停：host.opened 之前到达的字节留在 socket 读缓冲里，不会丢。
    socket.pause();

    const hostId = this.resolveHostIdFromSni(sni);
    if (!hostId) {
      this.logger.debug(`data: dropping ${remote}: no route for SNI ${sni === null ? '(absent)' : JSON.stringify(sni)}`);
      socket.destroy();
      return;
    }
    const host = this.hosts.get(hostId);
    if (!host || !isWsOpen(host.ws)) {
      this.logger.debug(`data: dropping ${remote}: host "${hostId}" is offline (SNI ${JSON.stringify(sni)})`);
      socket.destroy();
      return;
    }
    const streamId = this.allocateStreamId(host);
    if (streamId === null) {
      this.logger.warn(`data: dropping ${remote}: stream table for host "${hostId}" is full`);
      socket.destroy();
      return;
    }

    const stream = {
      id: streamId,
      host,
      socket,
      /** @type {Buffer[]} */
      pending: [helloBytes],
      opened: false,
      finished: false,
      hostClosed: false,
      /** @type {NodeJS.Timeout | null} */
      openTimer: null,
    };
    host.streams.set(streamId, stream);
    socket.on('close', () => this.finishStream(stream, 'app_closed'));
    socket.on('error', (err) => this.logger.debug(`data: stream ${streamId} app error: ${err.code ?? err.message}`));

    stream.openTimer = setTimeout(() => {
      if (stream.opened || stream.finished) return;
      this.logger.warn(`data: stream ${streamId} → host "${hostId}" open timeout`);
      this.sendJson(host.ws, { t: RELAY_MSG.HOST_CLOSE, streamId, reason: 'open_timeout' });
      this.finishStream(stream, 'open_timeout');
    }, this.config.timings.openTimeoutMs);
    stream.openTimer.unref?.();

    this.logger.debug(`data: stream ${streamId} → host "${hostId}" (SNI ${JSON.stringify(sni)}, ${helloBytes.length}B hello buffered) from ${remote}`);
    this.sendJson(host.ws, { t: RELAY_MSG.HOST_OPEN, streamId, sni });
  }

  /**
   * @param {any} host
   * @returns {number | null}
   */
  allocateStreamId(host) {
    for (let attempt = 0; attempt < 1_000_000; attempt += 1) {
      host.streamSeq = host.streamSeq >= 0xffffffff ? 1 : host.streamSeq + 1;
      if (!host.streams.has(host.streamSeq)) return host.streamSeq;
    }
    return null;
  }

  /**
   * host 回了 host.opened：先把缓冲的 ClientHello **转发给 host**（client→host 方向），
   * 然后恢复 app socket 读流；后续 app 数据走 forwardAppData。
   *
   * 注意方向：stream.pending 是客户端发来的 ClientHello（client→host），
   * 绝不能写回 app socket（那会让 TLS 客户端收到自己发出的握手字节）。
   *
   * @param {any} stream
   */
  openStream(stream) {
    if (stream.opened || stream.finished) return;
    stream.opened = true;
    if (stream.openTimer) {
      clearTimeout(stream.openTimer);
      stream.openTimer = null;
    }
    const host = stream.host;
    if (!isWsOpen(host.ws)) {
      this.finishStream(stream, 'host_disconnected');
      return;
    }
    const socket = stream.socket;
    if (socket.destroyed || !socket.writable) {
      this.finishStream(stream, 'app_closed_before_open');
      return;
    }

    const pending = stream.pending.length === 1 ? stream.pending[0] : Buffer.concat(stream.pending);
    stream.pending = [];
    if (pending.length === 0) {
      this.resumeAppStream(stream);
      return;
    }
    try {
      host.ws.send(encodeFrame(FRAME_TYPE.DATA, stream.id, pending), { binary: true }, (err) => {
        if (err) {
          this.finishStream(stream, 'send_error');
          return;
        }
        this.resumeAppStream(stream);
      });
    } catch {
      this.finishStream(stream, 'send_error');
    }
  }

  /** 开始把 app socket 的后续字节转成 DATA 帧（先发 Host 的 ClientHello 之后才调用）。 */
  resumeAppStream(stream) {
    if (stream.finished || stream.socket.destroyed) return;
    stream.socket.on('data', (chunk) => this.forwardAppData(stream, chunk));
    stream.socket.resume();
  }

  /**
   * app → host：DATA 帧；ws 缓冲过高时暂停 app socket，send 回调后恢复。
   * @param {any} stream
   * @param {Buffer} chunk
   */
  forwardAppData(stream, chunk) {
    if (stream.finished) return;
    const host = stream.host;
    if (!isWsOpen(host.ws)) {
      this.finishStream(stream, 'host_disconnected');
      return;
    }
    const frame = encodeFrame(FRAME_TYPE.DATA, stream.id, chunk);
    try {
      host.ws.send(frame, { binary: true }, (err) => {
        if (err) {
          this.finishStream(stream, 'send_error');
          return;
        }
        const socket = stream.socket;
        if (!socket.destroyed && socket.isPaused() && host.ws.bufferedAmount < SEND_LOW_WATER_BYTES) socket.resume();
      });
    } catch {
      this.finishStream(stream, 'send_error');
      return;
    }
    if (host.ws.bufferedAmount > SEND_HIGH_WATER_BYTES && !stream.socket.isPaused()) stream.socket.pause();
  }

  /**
   * host → relay 二进制帧：DATA → app socket.write；CLOSE → app socket.end()。
   * @param {any} host
   * @param {Buffer} data
   */
  handleHostFrame(host, data) {
    const frame = decodeFrame(data);
    if (!frame) {
      this.logger.debug(`control: host "${host.hostId}" sent a binary frame shorter than the ${5}-byte header`);
      return;
    }
    const stream = host.streams.get(frame.streamId);
    if (!stream || stream.finished) return;
    if (frame.type === FRAME_TYPE.DATA) {
      if (!stream.opened) {
        this.logger.debug(`control: host "${host.hostId}" sent DATA before host.opened for stream ${frame.streamId}; dropped`);
        return;
      }
      if (stream.socket.destroyed || !stream.socket.writable) {
        this.finishStream(stream, 'app_closed');
        return;
      }
      try {
        stream.socket.write(frame.payload);
      } catch {
        this.finishStream(stream, 'app_write_error');
      }
      return;
    }
    if (frame.type === FRAME_TYPE.CLOSE) {
      stream.hostClosed = true;
      if (!stream.socket.destroyed) stream.socket.end();
      return;
    }
    this.logger.debug(`control: ignoring unknown frame type ${frame.type} from host "${host.hostId}"`);
  }

  /** @param {any} host @param {Record<string, any>} msg */
  handleHostOpened(host, msg) {
    const streamId = Number(msg.streamId);
    if (!Number.isInteger(streamId) || streamId <= 0) return;
    const stream = host.streams.get(streamId);
    if (!stream) {
      this.logger.debug(`control: host "${host.hostId}" opened unknown/expired stream ${streamId}`);
      return;
    }
    this.openStream(stream);
  }

  /** 主机主动取消一个未就绪/进行中的 stream（JSON host.close）。 */
  handleHostCloseMessage(host, msg) {
    const streamId = Number(msg.streamId);
    if (!Number.isInteger(streamId) || streamId <= 0) return;
    const stream = host.streams.get(streamId);
    if (!stream || stream.finished) return;
    stream.hostClosed = true;
    this.finishStream(stream, typeof msg.reason === 'string' ? msg.reason : 'host_closed');
  }

  /**
   * 结束一条 stream：从 host 表移除、必要时通知 host、销毁 app socket。
   * @param {any} stream
   * @param {string} reason
   */
  finishStream(stream, reason) {
    if (stream.finished) return;
    stream.finished = true;
    if (stream.openTimer) {
      clearTimeout(stream.openTimer);
      stream.openTimer = null;
    }
    const host = stream.host;
    host.streams.delete(stream.id);
    if (!stream.hostClosed && stream.opened && isWsOpen(host.ws)) {
      try {
        host.ws.send(encodeFrame(FRAME_TYPE.CLOSE, stream.id), { binary: true });
      } catch {
        /* ignore */
      }
    }
    if (!stream.socket.destroyed) stream.socket.destroy();
    this.logger.debug(`data: stream ${stream.id} closed (${reason})`);
  }

  /** @param {any} host @param {string} reason */
  removeHost(host, reason) {
    if (this.hosts.get(host.hostId) === host) this.hosts.delete(host.hostId);
    // 注意：不要在这里清空 groupAuth 的设备注册表。
    // 控制连接会被「replace / 短暂断线重连」替换，清空会导致主机重连、device.sync 到达前的
    // 几百毫秒内所有边缘请求 401（表现为「首次进入白屏 401、返回再进就好」）。
    // 设备撤销以主机侧设备表为权威（主机代理逐请求检查 device 是否存在），relay 设备表只用于
    // 校验 token 里的 deviceId 是否仍在册；显式撤销走 device.revoke。
    for (const stream of [...host.streams.values()]) {
      stream.finished = true;
      if (stream.openTimer) clearTimeout(stream.openTimer);
      if (!stream.socket.destroyed) stream.socket.destroy();
    }
    host.streams.clear();
    if (host.conn) {
      host.conn.ready = false;
      host.conn.host = null;
    }
    this.logger.info(`host offline: "${host.hostId}" (${reason})`);
  }

  /** 心跳：每 tick 发 host.heartbeat；超过 heartbeatTimeoutMs 没有任何消息 → 断开。 */
  sweepHosts() {
    if (this.closed) return;
    const now = Date.now();
    for (const host of [...this.hosts.values()]) {
      const silence = now - host.lastSeenAt;
      if (silence > this.config.timings.heartbeatTimeoutMs) {
        this.logger.warn(`host "${host.hostId}": silent for ${Math.round(silence)}ms (limit ${this.config.timings.heartbeatTimeoutMs}ms), dropping`);
        this.removeHost(host, 'heartbeat_timeout');
        try {
          host.ws.close(CLOSE_CODE_HEARTBEAT_TIMEOUT, 'heartbeat timeout');
        } catch {
          /* ignore */
        }
        try {
          host.ws.terminate();
        } catch {
          /* ignore */
        }
        continue;
      }
      if (now - host.lastHeartbeatAt >= this.config.timings.heartbeatIntervalMs) {
        host.lastHeartbeatAt = now;
        this.sendJson(host.ws, { t: RELAY_MSG.HOST_HEARTBEAT, ts: now });
      }
    }
  }

  /**
   * 校验 host 控制面凭据：group 模式走注册 store 的 token hash；classic 走 tokens.json。
   * @param {string} hostId
   * @param {string} token
   */
  verifyHostCredential(hostId, token) {
    if (this.config.mode === 'group') {
      try {
        if (verifyHostToken(this.config.group.file, hostId, token)) return true;
      } catch (err) {
        this.logger.warn(`control: cannot verify group host "${hostId}": ${err && err.message ? err.message : String(err)}`);
      }
    }
    const expected = this.tokenStore.get(hostId);
    return typeof expected === 'string' && safeEqualStrings(String(token), expected);
  }

  // ---------------------------------------------------------------------------
  // 群体版边缘平面（A 模式）：relay 终止手机 TLS，明文经控制面隧道转发到主机
  // ---------------------------------------------------------------------------
  // 本切片（P1 切片 2）只做「边缘 TLS 终止 + 出站隧道」骨架与压测；设备鉴权
  //（短时 token + relay 签名断言）在下一片接入，因此未认证模式仅 dev 可用。

  /** @param {import('node:tls').TLSSocket} socket */
  handleEdgeConnection(socket) {
    if (this.closed) {
      socket.destroy();
      return;
    }
    const ip = socket.remoteAddress ?? 'unknown';
    const ipCount = this.edgeIpConnections.get(ip) ?? 0;
    if (ipCount >= this.config.limits.maxConnectionsPerIp
      || this.edgeSockets.size >= this.config.limits.maxDataConnections) {
      this.logger.warn(`edge: dropping ${formatPeer(socket)}: connection limit reached`);
      socket.destroy();
      return;
    }
    this.edgeIpConnections.set(ip, ipCount + 1);
    this.edgeSockets.add(socket);
    socket.on('close', () => {
      this.edgeSockets.delete(socket);
      const left = (this.edgeIpConnections.get(ip) ?? 1) - 1;
      if (left <= 0) this.edgeIpConnections.delete(ip);
      else this.edgeIpConnections.set(ip, left);
    });
    socket.on('error', (err) => this.logger.debug(`edge: socket error from ${formatPeer(socket)}: ${err.code ?? err.message}`));
    const sni = typeof socket.servername === 'string' && socket.servername !== '' ? socket.servername : null;
    void this.handleEdgeSession(socket, sni).catch((err) => {
      this.logger.debug(`edge: session error from ${formatPeer(socket)}: ${err && err.message ? err.message : String(err)}`);
      if (!socket.destroyed) socket.destroy();
    });
  }

  /**
   * 拒绝一条边缘连接（TLS 已建立，回最小 HTTP 响应后关闭）。
   * @param {import('node:tls').TLSSocket} socket
   * @param {number} status
   * @param {string} reason
   */
  rejectEdgeHttp(socket, status, reason) {
    if (socket.destroyed) return;
    const reasonText = status === 421 ? 'Misdirected Request' : status === 502 ? 'Bad Gateway' : 'Service Unavailable';
    const body = `${reason}\n`;
    const head = `HTTP/1.1 ${status} ${reasonText}\r\n`
      + 'content-type: text/plain; charset=utf-8\r\n'
      + `content-length: ${Buffer.byteLength(body)}\r\n`
      + 'connection: close\r\n\r\n';
    try {
      socket.end(head + body);
    } catch {
      socket.destroy();
    }
  }

  /**
   * 边缘会话：读 HTTP 头 → 鉴权接口 /（cookie 校验后）开隧道到主机。
   * @param {import('node:tls').TLSSocket} socket
   * @param {string | null} sni
   */
  async handleEdgeSession(socket, sni) {
    if (socket.destroyed) return;
    const remote = formatPeer(socket);
    const hostId = this.resolveHostIdFromSni(sni);
    if (!hostId) {
      this.logger.debug(`edge: dropping ${remote}: no route for SNI ${sni === null ? '(absent)' : JSON.stringify(sni)}`);
      this.rejectEdgeHttp(socket, 421, 'no_route');
      return;
    }
    const host = this.hosts.get(hostId);
    if (!host || !isWsOpen(host.ws)) {
      this.logger.debug(`edge: dropping ${remote}: host "${hostId}" is offline (SNI ${JSON.stringify(sni)})`);
      this.rejectEdgeHttp(socket, 502, 'host_offline');
      return;
    }

    let rawHead;
    let rest;
    let parsedHead;
    try {
      ({ head: rawHead, rest } = await readHttpHead(socket, { timeoutMs: this.config.timings.openTimeoutMs }));
      parsedHead = parseHttpHead(rawHead);
    } catch (err) {
      this.logger.debug(`edge: bad HTTP request from ${remote}: ${err && err.message ? err.message : String(err)}`);
      this.rejectEdgeHttp(socket, 400, 'bad_request');
      return;
    }
    if (this.closed || socket.destroyed) return;
    if (!this.hosts.has(hostId)) {
      this.rejectEdgeHttp(socket, 502, 'host_offline');
      return;
    }

    const pathname = parsedHead.path.split('?')[0];
    if (pathname === GROUP_AUTH_CHALLENGE_PATH || pathname === GROUP_AUTH_TOKEN_PATH) {
      let body;
      try {
        body = await readHttpJsonBody(socket, parsedHead.headers, rest);
      } catch (err) {
        writeHttpResponse(socket, {
          status: err && err.statusCode ? err.statusCode : 400,
          body: JSON.stringify({ ok: false, error: { code: 'invalid_request' } }),
        });
        return;
      }
      if (!this.groupAuth) {
        writeHttpResponse(socket, { status: 503, body: JSON.stringify({ ok: false, error: { code: 'group_auth_unavailable' } }) });
        return;
      }
      const result = this.groupAuth.handleAuthRequest({
        hostId,
        method: parsedHead.method,
        path: pathname,
        body,
        clientKey: socket.remoteAddress ?? 'unknown',
      });
      if (result.status >= 400) {
        const entry = result.body && result.body.error ? result.body.error : result.body;
        this.logger.warn(
          `edge: auth ${pathname} -> ${result.status} for host ${hostId} `
          + `device ${String(body && body.deviceId ? body.deviceId : '?')} from ${remote}: ${JSON.stringify(entry)}`,
        );
      }
      writeHttpResponse(socket, {
        status: result.status,
        headers: result.headers,
        body: JSON.stringify(result.body),
      });
      return;
    }

    // 配对路径：与 classic 一致，允许无会话（一次性 secret + 主机确认保护；主机侧还有限速）。
    const isPairPath = pathname === PAIR_PATH || pathname === `${PAIR_PATH}/` || pathname === PAIR_STATUS_PATH;

    // 普通业务流量：校验 __Host- 会话 cookie（dev 允许跳过；生产必须通过）。
    let session;
    if (!isPairPath && !this.config.group.edge.allowUnauthenticated) {
      session = this.groupAuth?.sessionFromHeaders(parsedHead.headers, hostId);
      if (!session) {
        this.logger.debug(`edge: rejecting unauthenticated ${parsedHead.method} ${pathname} from ${remote} for host "${hostId}"`);
        writeHttpResponse(socket, {
          status: 401,
          headers: { 'www-authenticate': 'Session' },
          body: JSON.stringify({ ok: false, error: { code: 'unauthorized', message: 'missing or invalid session' } }),
        });
        return;
      }
    }

    this.openEdgeTunnel({ socket, hostId, host, sni, rawHead, rest, deviceId: session?.deviceId, remote });
  }

  /**
   * 把（已鉴权的）边缘连接转成控制面隧道 stream；已读的 HTTP 头/剩余字节作为首包原样转发。
   * 主机侧仍是真正的 HTTP/WS 代理（逐请求鉴权也在主机侧用 relay 公钥复验 token）。
   * @param {{socket: import('node:tls').TLSSocket, hostId: string, host: any, sni: string | null,
   *          rawHead: Buffer, rest: Buffer, deviceId?: string, remote: string}} input
   */
  openEdgeTunnel({ socket, hostId, host, sni, rawHead, rest, deviceId, remote }) {
    if (socket.destroyed || !isWsOpen(host.ws)) {
      this.rejectEdgeHttp(socket, 502, 'host_offline');
      return;
    }
    const streamId = this.allocateStreamId(host);
    if (streamId === null) {
      this.logger.warn(`edge: dropping ${remote}: stream table for host "${hostId}" is full`);
      this.rejectEdgeHttp(socket, 503, 'stream_limit');
      return;
    }
    socket.pause();
    /** @type {Buffer[]} */
    const pending = [rawHead];
    if (rest && rest.length > 0) pending.push(rest);
    const stream = {
      id: streamId,
      host,
      socket,
      pending,
      opened: false,
      finished: false,
      hostClosed: false,
      /** @type {NodeJS.Timeout | null} */
      openTimer: null,
      kind: GROUP_EDGE_STREAM_KIND,
    };
    host.streams.set(streamId, stream);
    socket.on('close', () => this.finishStream(stream, 'app_closed'));
    stream.openTimer = setTimeout(() => {
      if (stream.opened || stream.finished) return;
      this.logger.warn(`edge: stream ${streamId} → host "${hostId}" open timeout`);
      this.sendJson(host.ws, { t: RELAY_MSG.HOST_CLOSE, streamId, reason: 'open_timeout' });
      this.finishStream(stream, 'open_timeout');
    }, this.config.timings.openTimeoutMs);
    stream.openTimer.unref?.();
    this.logger.debug(`edge: stream ${streamId} → host "${hostId}" (SNI ${JSON.stringify(sni)}${deviceId ? `, device ${deviceId}` : ''}) from ${remote}`);
    this.sendJson(host.ws, {
      t: RELAY_MSG.HOST_OPEN,
      streamId,
      sni,
      kind: GROUP_EDGE_STREAM_KIND,
      ...(deviceId ? { deviceId } : {}),
    });
  }

  // ---------------------------------------------------------------------------
  // 群体版设备注册同步（host 控制面 → relay）
  // ---------------------------------------------------------------------------

  /**
   * 主机全量同步设备列表（设备 ID + P-256 公钥）；覆写该主机的设备注册表。
   * @param {any} host
   * @param {Record<string, any>} msg
   */
  handleDeviceSync(host, msg) {
    if (!this.groupAuth) {
      this.sendJson(host.ws, { t: RELAY_MSG.DEVICE_SYNCED, ok: false, code: 'group_auth_unavailable' });
      return;
    }
    try {
      const count = this.groupAuth.syncDevices(host.hostId, msg.devices);
      this.logger.info(`group auth: host "${host.hostId}" synced ${count} device(s)`);
      this.sendJson(host.ws, { t: RELAY_MSG.DEVICE_SYNCED, ok: true, count });
    } catch (err) {
      const code = err instanceof GroupAuthError ? err.code : 'invalid_devices';
      this.logger.warn(`group auth: host "${host.hostId}" device.sync failed: ${err && err.message ? err.message : String(err)}`);
      this.sendJson(host.ws, { t: RELAY_MSG.DEVICE_SYNCED, ok: false, code, message: err && err.message ? err.message : String(err) });
    }
  }

  /**
   * 撤销单台设备（旧 token 立即失效：session 校验会再查注册表）。
   * @param {any} host
   * @param {Record<string, any>} msg
   */
  handleDeviceRevoke(host, msg) {
    const deviceId = String(msg.deviceId ?? '');
    const revoked = this.groupAuth ? this.groupAuth.revokeDevice(host.hostId, deviceId) : false;
    if (revoked) this.logger.info(`group auth: host "${host.hostId}" revoked device ${deviceId}`);
    this.sendJson(host.ws, { t: RELAY_MSG.DEVICE_REVOKED, ok: revoked, deviceId });
  }

  // ---------------------------------------------------------------------------
  // HTTP 平面（:80）
  // ---------------------------------------------------------------------------

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  handleHttpRequest(req, res) {
    const rawUrl = typeof req.url === 'string' && req.url.startsWith('/') ? req.url : '/';

    if (rawUrl.split('?')[0] === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
      const body = JSON.stringify(this.health());
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
      });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }

    const targetHost = this.pickRedirectHost(req.headers.host);
    res.writeHead(301, {
      location: `https://${targetHost}${rawUrl}`,
      'content-length': 0,
      connection: 'close',
    });
    res.end();
  }

  /**
   * 复用请求 Host（去掉端口），非法时回落到 relay domain。
   * @param {string | undefined} hostHeader
   * @returns {string}
   */
  pickRedirectHost(hostHeader) {
    if (typeof hostHeader === 'string') {
      let host = hostHeader.trim();
      if (host.startsWith('[')) {
        const end = host.indexOf(']');
        if (end > 0) host = host.slice(0, end + 1);
      } else {
        const colon = host.indexOf(':');
        if (colon > 0) host = host.slice(0, colon);
      }
      if (host !== '' && host.length <= 253 && /^[a-z0-9.:[\]_-]+$/i.test(host)) return host;
    }
    return this.config.domain;
  }

  /**
   * 向 host 发 JSON 控制消息。
   * @param {WebSocket} ws
   * @param {Record<string, any>} message
   */
  sendJson(ws, message) {
    if (!isWsOpen(ws)) return;
    try {
      ws.send(JSON.stringify(message));
    } catch (err) {
      this.logger.debug(`control: send failed: ${err && err.message ? err.message : String(err)}`);
    }
  }
}

/**
 * 创建并启动 relay。
 * @param {object} options
 * @param {string} options.domain 根域名，如 relay.example.com
 * @param {number} [options.dataPort=443] TLS 透传端口；0 = 临时端口
 * @param {number} [options.controlPort=8443] 控制面端口；0 = 临时端口
 * @param {number} [options.httpPort=80] HTTP 跳转端口；0 = 临时端口
 * @param {Record<string,string>} [options.hostTokens] hostId → token（也可用 tokensFile）
 * @param {{certFile?: string, keyFile?: string, cert?: Buffer|string, key?: Buffer|string}} [options.tls]
 * @param {boolean} [options.dev=false] 允许无 TLS 的 ws:// 控制面（仅测试/开发）
 * @param {string} [options.tokensFile] tokens.json 路径
 * @param {string} [options.dataHost='0.0.0.0'] 监听地址
 * @returns {Promise<{dataPort:number, controlPort:number, httpPort:number, domain:string, dev:boolean, close:Function, health:Function, onlineHostIds:Function}>}
 */
export async function createRelay(options = {}) {
  const config = normalizeConfig(options);
  const relay = new Relay(config);
  return relay.start();
}

/**
 * startRelay 与 createRelay 等价，语义更贴近 CLI/config 文件入口：
 * 先校验配置（生产必须 TLS），再绑定三个端口并返回实际端口。
 * @param {object} config
 */
export async function startRelay(config = {}) {
  return createRelay(config);
}
