import {
  AUDIT_PATH,
  DEVICE_REVOKE_PATH_PREFIX,
  DEVICES_PATH,
  PAIR_PATH,
  PAIR_STATUS_PATH,
  PUSH_TOKEN_PATH,
  RESTART_PATH,
  STATUS_PATH,
  TUNNEL_BASE,
} from 'dsh-remote-protocol';
import { readJsonBody, pathnameOf, sendError, sendJson } from './http-utils.js';
import { createPeerVerifier, createRemoteTlsServer } from './mtls.js';

const MAX_PUSH_TOKENS = 20;
const PUSH_PROVIDERS = new Set(['apns', 'expo', 'fcm']);
const PUSH_ENVIRONMENTS = new Set(['development', 'production']);

/**
 * 规范化 `POST /__dsh_remote/push-token` 请求体。
 * 本轮自托管推送只使用 provider='apns'（APNs device token + aps-environment）；
 * 'expo' 为旧版经 relay 的通道，保留兼容。
 *
 * @param {Record<string, any>} [body]
 * @returns {{provider: string, token: string, environment?: 'development'|'production'}}
 */
export function normalizePushTokenBody(body = {}) {
  const provider = String(body?.provider ?? 'expo').trim().toLowerCase();
  if (!PUSH_PROVIDERS.has(provider)) {
    throw Object.assign(new Error(`不支持的推送 provider: ${provider}`), { status: 400, code: 'unsupported-provider' });
  }
  const token = String(body?.token ?? '').trim();
  if (token === '' || token.length > 4096) {
    throw Object.assign(new Error('推送 token 非法'), { status: 400, code: 'invalid-token' });
  }
  if (provider === 'apns' && !/^[0-9a-f]{64}$/i.test(token)) {
    throw Object.assign(new Error('APNs device token 必须是 64 位十六进制'), { status: 400, code: 'invalid-token' });
  }
  let environment;
  if (provider === 'apns') {
    const raw = body?.environment;
    if (raw !== undefined && raw !== null && String(raw) !== '') {
      const value = String(raw).trim().toLowerCase();
      if (!PUSH_ENVIRONMENTS.has(value)) {
        throw Object.assign(new Error('APNs environment 只能是 development 或 production'), { status: 400, code: 'invalid-environment' });
      }
      environment = value;
    }
  }
  return { provider, token, ...(environment ? { environment } : {}) };
}

/**
 * 主机插件远程 TLS 监听：配对入口 + 设备 mTLS + 反向代理。
 * 该监听只 bind 127.0.0.1，经 relay 的 TLS 透传对外；不直接暴露公网。
 */
export function createRemoteServer({
  certPem,
  keyPem,
  caCertPem,
  devices,
  pairing,
  proxy,
  audit,
  getConfig,
  savePushToken,
  getStatus,
  restartHost,
  log = () => {},
}) {
  const verifyPeer = createPeerVerifier({ devices, caCertPem });
  /** @type {Map<string, Set<import('node:net').Socket>>} 设备证书 serial → 活跃 TLS socket */
  const deviceSockets = new Map();
  /** @type {WeakSet<import('node:net').Socket>} */
  const trackedSockets = new WeakSet();
  const server = createRemoteTlsServer({ certPem, keyPem });

  async function handleRequest(req, res) {
    const pathname = pathnameOf(req.url);
    if (!pathname) { sendError(res, 400, 'bad-url', '非法 URL'); return; }

    // —— 配对路径：允许无客户端证书（一次性密钥 + 限速保护）——
    if (pathname === PAIR_PATH || pathname === `${PAIR_PATH}/`) {
      if (req.method !== 'POST') { sendError(res, 405, 'method-not-allowed', '仅支持 POST'); return; }
      try {
        const body = await readJsonBody(req, 128 * 1024);
        const result = pairing.handlePairRequest({
          secret: body.secret,
          csrPem: body.csrPem,
          deviceName: body.deviceName,
          platform: body.platform,
          remoteAddress: req.socket.remoteAddress,
        });
        audit.append({ action: 'pair-request', result: result.status, hash: result.deviceId ? null : undefined });
        sendJson(res, 200, { ok: true, data: result });
      } catch (error) {
        sendError(res, error.status ?? 400, error.code ?? 'pairing-failed', error.message);
      }
      return;
    }
    if (pathname === PAIR_STATUS_PATH) {
      const ticket = new URL(req.url, 'https://localhost').searchParams.get('ticket');
      try {
        sendJson(res, 200, { ok: true, data: pairing.statusFor(ticket) });
      } catch (error) {
        sendError(res, error.status ?? 404, error.code ?? 'no-such-pairing', error.message);
      }
      return;
    }
    // —— 其余全部要求设备 mTLS ——
    const peer = verifyPeer(req.socket);
    if (!peer.ok) {
      audit.append({ action: 'device-auth', result: 'rejected', hash: peer.code });
      sendError(res, 403, peer.code, '设备证书无效或已撤销');
      return;
    }
    devices.touch(peer.serial);
    trackDeviceSocket(req.socket, peer.serial);

    if (pathname === AUDIT_PATH) {
      if (req.method !== 'GET') { sendError(res, 405, 'method-not-allowed', '仅支持 GET'); return; }
      const requested = Number(new URL(req.url, 'https://localhost').searchParams.get('limit') ?? 50);
      const limit = Number.isFinite(requested) ? Math.max(1, Math.min(200, Math.trunc(requested))) : 50;
      sendJson(res, 200, { ok: true, data: { entries: audit.tail(limit) } });
      return;
    }
    if (pathname === STATUS_PATH) {
      if (req.method !== 'GET') { sendError(res, 405, 'method-not-allowed', '仅支持 GET'); return; }
      const config = getConfig();
      const status = typeof getStatus === 'function' ? getStatus() : {};
      const allDevices = devices.list();
      sendJson(res, 200, {
        ok: true,
        data: {
          hostId: config.hostId,
          hostName: config.hostName || '',
          domain: `${config.hostId}.${config.relayDomain}`,
          tls: status.tls ?? null,
          relayConnected: status.relayConnected ?? null,
          version: status.version ?? null,
          devices: {
            total: allDevices.length,
            active: allDevices.filter((device) => !device.revokedAt).length,
          },
        },
      });
      return;
    }
    if (pathname === DEVICES_PATH) {
      if (req.method !== 'GET') { sendError(res, 405, 'method-not-allowed', '仅支持 GET'); return; }
      sendJson(res, 200, {
        ok: true,
        data: {
          devices: devices.list().map((device) => ({
            ...device,
            current: String(device.serial).toUpperCase() === String(peer.serial).toUpperCase(),
          })),
        },
      });
      return;
    }
    if (pathname.startsWith(DEVICE_REVOKE_PATH_PREFIX) && pathname.endsWith('/revoke')) {
      if (req.method !== 'POST') { sendError(res, 405, 'method-not-allowed', '仅支持 POST'); return; }
      const encodedId = pathname.slice(DEVICE_REVOKE_PATH_PREFIX.length, -'/revoke'.length);
      const deviceId = decodeURIComponent(encodedId);
      const revoked = devices.revoke(deviceId);
      if (!revoked) { sendError(res, 404, 'device-not-found', '设备不存在'); return; }
      audit.append({ deviceId, action: 'device-revoke', result: 'ok', hash: deviceId === peer.device.id ? 'self' : 'remote' });
      // 等响应发完再断链（自撤销时当前连接也在这里被清理）。
      res.once('finish', () => disconnectSerial(revoked.serial));
      sendJson(res, 200, { ok: true, data: { device: revoked } });
      return;
    }

    if (pathname === PUSH_TOKEN_PATH) {
      if (req.method !== 'POST') { sendError(res, 405, 'method-not-allowed', '仅支持 POST'); return; }
      try {
        const body = await readJsonBody(req, 16 * 1024);
        const tokenInfo = normalizePushTokenBody(body);
        savePushToken?.({ ...tokenInfo, deviceId: peer.device.id, ts: Date.now() });
        sendJson(res, 200, {
          ok: true,
          data: {
            registered: true,
            provider: tokenInfo.provider,
            environment: tokenInfo.environment ?? null,
          },
        });
      } catch (error) {
        sendError(res, error.status ?? 400, error.code ?? 'invalid-push-token', error.message);
      }
      return;
    }

    if (pathname === RESTART_PATH) {
      if (req.method !== 'POST') { sendError(res, 405, 'method-not-allowed', '仅支持 POST'); return; }
      if (typeof restartHost !== 'function') {
        audit.append({ deviceId: peer.device.id, action: 'host-restart', result: 'failed', hash: 'not-enabled' });
        sendError(res, 501, 'host-restart-unavailable', '当前主机未启用远程重启（插件版本或运行环境不支持）');
        return;
      }
      try {
        const result = await restartHost({ device: peer.device });
        const mode = String(result?.mode ?? 'unknown');
        audit.append({
          deviceId: peer.device.id,
          action: 'host-restart',
          result: 'accepted',
          hash: result?.deduped ? 'deduped' : mode,
        });
        sendJson(res, 202, { ok: true, data: { restarting: true, mode } });
      } catch (error) {
        audit.append({ deviceId: peer.device.id, action: 'host-restart', result: 'failed', hash: error?.code ?? 'restart-failed' });
        sendError(res, error.status ?? 500, error.code ?? 'host-restart-failed', error.message ?? '安排主机重启失败');
      }
      return;
    }

    // 未知的远程内部路径（已知的 pair/devices/push-token/restart 已在上方处理）
    if (pathname.startsWith(`${TUNNEL_BASE}/`)) {
      sendError(res, 404, 'not-found', '未知远程路径');
      return;
    }

    await proxy.handle(req, res, peer.device);
  }

  /**
   * 记录设备证书对应的活跃 socket，便于撤销时立即断链。
   * @param {import('node:net').Socket} socket
   * @param {string} serial
   */
  function trackDeviceSocket(socket, serial) {
    if (trackedSockets.has(socket)) return;
    trackedSockets.add(socket);
    const key = String(serial).toUpperCase();
    let set = deviceSockets.get(key);
    if (!set) { set = new Set(); deviceSockets.set(key, set); }
    set.add(socket);
    socket.once('close', () => {
      set.delete(socket);
      if (set.size === 0) deviceSockets.delete(key);
    });
  }

  /**
   * 立即断开某设备的所有活跃 TLS/WS 连接（撤销设备时调用）。
   * @param {string} serial
   * @returns {number}
   */
  function disconnectSerial(serial) {
    const key = String(serial).toUpperCase();
    const set = deviceSockets.get(key);
    if (!set) return 0;
    let count = 0;
    for (const socket of set) {
      count += 1;
      socket.destroy();
    }
    deviceSockets.delete(key);
    return count;
  }

  server.on('request', (req, res) => {
    handleRequest(req, res).catch((error) => {
      log(`request failed: ${error.message}`);
      if (!res.headersSent) sendError(res, 500, 'internal', '远程代理内部错误');
      else res.destroy();
    });
  });

  server.on('upgrade', (req, socket, head) => {
    const pathname = pathnameOf(req.url);
    if (!pathname || pathname.startsWith(TUNNEL_BASE)) { socket.destroy(); return; }
    const peer = verifyPeer(socket);
    if (!peer.ok) {
      audit.append({ action: 'ws-auth', result: 'rejected', hash: peer.code });
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    devices.touch(peer.serial);
    trackDeviceSocket(socket, peer.serial);
    proxy.handleUpgrade(req, socket, head, peer.device).catch((error) => {
      log(`ws proxy failed: ${error.message}`);
      socket.destroy();
    });
  });

  server.on('tlsClientError', (error) => {
    log(`tls client error: ${error.message}`);
  });

  return {
    server,
    /** 撤销设备时立即断链（service/admin 调用）。 */
    disconnectDevice: disconnectSerial,
    listen(port = 0, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve({ port: server.address().port, host });
        });
      });
    },
    async close() {
      await new Promise((resolve) => {
        server.close(() => resolve());
        try { server.closeAllConnections?.(); } catch { /* ignore */ }
      });
    },
  };
}
