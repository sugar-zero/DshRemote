import net from 'node:net';
import {
  CONTROL_PATH,
  FRAME_TYPE,
  PROTOCOL_VERSION,
  RELAY_MSG,
  decodeFrame,
  encodeFrame,
} from 'dsh-remote-protocol';

/**
 * 主机 → relay 主动外联连接器（无入站端口）。
 * - JSON text frame 走控制面（hello/heartbeat/host.open/host.opened/host.close）
 * - 二进制 frame 走数据面（encodeFrame/decodeFrame）
 */
export class RelayConnector {
  constructor({ relayUrl, hostId, hostToken, hostName, getLocalPort, relayTlsInsecure = false, audit, log = () => {} }) {
    this.relayUrl = relayUrl;
    this.hostId = hostId;
    this.hostToken = hostToken;
    this.hostName = hostName;
    this.getLocalPort = getLocalPort;
    this.relayTlsInsecure = relayTlsInsecure;
    this.audit = audit;
    this.log = log;
    this.ws = undefined;
    this.connected = false;
    this.lastError = null;
    this.streams = new Map();
    /** @type {Map<string, {deviceId:string, provider:string, token:string}>} */
    this.pushTokens = new Map();
    this.onPushResult = undefined;
    this.closed = false;
    this.retryMs = 1000;
    this.heartbeatTimer = undefined;
    this.retryTimer = undefined;
  }

  controlUrl() {
    const url = new URL(this.relayUrl);
    if (url.protocol === 'https:') url.protocol = 'wss:';
    if (url.protocol === 'http:') url.protocol = 'ws:';
    url.pathname = CONTROL_PATH;
    url.search = '';
    return url.href;
  }

  start() {
    this.closed = false;
    this.#connect();
  }

  stop() {
    this.closed = true;
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.retryTimer);
    this.#closeAllStreams('connector-stopped');
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = undefined;
    this.connected = false;
  }

  isConnected() {
    return this.connected;
  }

  /** 注册/更新设备推送 token；已连接时立即上报 relay，未连接时等 ready 后补发。 */
  registerPushToken(entry) {
    if (!entry?.deviceId || !entry?.token) return false;
    this.pushTokens.set(String(entry.deviceId), {
      deviceId: String(entry.deviceId),
      provider: String(entry.provider ?? 'expo'),
      token: String(entry.token),
    });
    if (this.connected) this.#send({ t: RELAY_MSG.PUSH_REGISTER, ...this.pushTokens.get(String(entry.deviceId)) });
    return true;
  }

  /** 请求 relay 发一条"需要关注"提醒（内容无关）。 */
  sendPush({ kind = 'attention' } = {}) {
    if (!this.connected) return false;
    this.#send({ t: RELAY_MSG.PUSH_SEND, kind: String(kind).slice(0, 32) });
    return true;
  }

  #scheduleReconnect() {
    if (this.closed) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.#connect(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, 30_000);
  }

  #connect() {
    if (this.closed) return;
    const url = this.controlUrl();
    this.log(`connecting to relay ${url}`);
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (error) {
      this.lastError = error.message;
      this.#scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('open', () => {
      this.log('relay control socket open');
      ws.send(JSON.stringify({
        t: RELAY_MSG.HOST_HELLO,
        protocolVersion: PROTOCOL_VERSION,
        hostId: this.hostId,
        token: this.hostToken,
        hostName: this.hostName,
      }));
    });
    ws.addEventListener('message', (event) => {
      const data = event.data;
      if (typeof data === 'string') {
        this.#onControlMessage(data);
      } else if (data instanceof ArrayBuffer) {
        this.#onBinary(Buffer.from(data));
      } else if (ArrayBuffer.isView(data)) {
        this.#onBinary(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
      }
    });
    ws.addEventListener('error', () => {
      this.lastError = 'relay control socket error';
    });
    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.connected = false;
      clearInterval(this.heartbeatTimer);
      this.#closeAllStreams('relay-disconnected');
      if (!this.closed) this.#scheduleReconnect();
    });
  }

  #onControlMessage(text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.t === RELAY_MSG.HOST_READY) {
      this.connected = true;
      this.lastError = null;
      this.retryMs = 1000;
      this.log(`relay ready: ${msg.hostname ?? this.hostId}`);
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => this.#send({ t: RELAY_MSG.HOST_HEARTBEAT }), 10_000);
      for (const entry of this.pushTokens.values()) {
        this.#send({ t: RELAY_MSG.PUSH_REGISTER, ...entry });
      }
      return;
    }
    if (msg.t === RELAY_MSG.ERROR) {
      this.lastError = `${msg.code}: ${msg.message}`;
      this.log(`relay error: ${this.lastError}`);
      return;
    }
    if (msg.t === RELAY_MSG.HOST_OPEN) {
      this.#openStream(msg.streamId, msg.sni);
      return;
    }
    if (msg.t === RELAY_MSG.PUSH_RESULT) {
      this.onPushResult?.(msg);
      this.audit?.append({ action: 'push-result', result: msg.ok ? 'ok' : 'failed' });
      return;
    }
    if (msg.t === RELAY_MSG.HOST_CLOSE) {
      const stream = this.streams.get(msg.streamId);
      if (stream) {
        stream.socket.destroy();
        this.streams.delete(msg.streamId);
      }
    }
  }

  #openStream(streamId, sni) {
    if (this.streams.has(streamId)) return;
    let socket;
    try {
      socket = net.connect({ host: '127.0.0.1', port: this.getLocalPort() });
    } catch (error) {
      this.#send({ t: RELAY_MSG.ERROR, code: 'local-connect', message: error.message, streamId });
      return;
    }
    const stream = { socket, sni };
    this.streams.set(streamId, stream);
    socket.setNoDelay(true);
    socket.once('connect', () => {
      this.#send({ t: RELAY_MSG.HOST_OPENED, streamId });
    });
    socket.on('data', (chunk) => {
      this.#sendBinary(encodeFrame(FRAME_TYPE.DATA, streamId, chunk));
    });
    socket.on('error', () => {
      this.#sendBinary(encodeFrame(FRAME_TYPE.CLOSE, streamId));
      socket.destroy();
      this.streams.delete(streamId);
    });
    socket.on('close', () => {
      this.#sendBinary(encodeFrame(FRAME_TYPE.CLOSE, streamId));
      this.streams.delete(streamId);
    });
  }

  #onBinary(buffer) {
    const frame = decodeFrame(buffer);
    if (!frame) return;
    const stream = this.streams.get(frame.streamId);
    if (!stream) return;
    if (frame.type === FRAME_TYPE.DATA) {
      const ok = stream.socket.write(frame.payload);
      if (!ok) {
        stream.socket.pause();
        stream.socket.once('drain', () => stream.socket.resume());
      }
    } else if (frame.type === FRAME_TYPE.CLOSE) {
      stream.socket.end();
      this.streams.delete(frame.streamId);
    }
  }

  #closeAllStreams(reason) {
    for (const [, stream] of this.streams) {
      stream.socket.destroy();
    }
    this.streams.clear();
    if (reason === 'relay-disconnected') this.audit?.append({ action: 'relay-disconnect', result: reason });
  }

  #send(message) {
    if (this.ws?.readyState === 1) {
      this.ws.send(JSON.stringify(message));
    }
  }

  #sendBinary(buffer) {
    if (this.ws?.readyState !== 1) return;
    if (this.ws.bufferedAmount > 2 * 1024 * 1024) {
      setTimeout(() => this.#sendBinary(buffer), 50);
      return;
    }
    this.ws.send(new Uint8Array(buffer));
  }
}
