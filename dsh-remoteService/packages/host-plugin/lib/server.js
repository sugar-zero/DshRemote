import {
  DEVICE_REVOKE_PATH_PREFIX,
  DEVICES_PATH,
  PAIR_PATH,
  PAIR_STATUS_PATH,
  PUSH_TOKEN_PATH,
  TUNNEL_BASE,
} from 'dsh-remote-protocol';
import { readJsonBody, pathnameOf, sendError, sendJson } from './http-utils.js';
import { createPeerVerifier, createRemoteTlsServer } from './mtls.js';

const MAX_PUSH_TOKENS = 20;

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
  log = () => {},
}) {
  const verifyPeer = createPeerVerifier({ devices, caCertPem });
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
      sendJson(res, 200, { ok: true, data: { device: revoked } });
      return;
    }

    if (pathname === PUSH_TOKEN_PATH) {
      if (req.method !== 'POST') { sendError(res, 405, 'method-not-allowed', '仅支持 POST'); return; }
      try {
        const body = await readJsonBody(req, 16 * 1024);
        const provider = String(body.provider || 'expo');
        const token = String(body.token || '');
        if (!token || token.length > 4096) throw Object.assign(new Error('token 非法'), { status: 400, code: 'invalid-token' });
        savePushToken?.({ provider, token, deviceId: peer.device.id, ts: Date.now() });
        sendJson(res, 200, { ok: true, data: { registered: true, provider } });
      } catch (error) {
        sendError(res, error.status ?? 400, error.code ?? 'invalid-push-token', error.message);
      }
      return;
    }

    // 未知的远程内部路径（已知的 pair/devices/push-token 已在上方处理）
    if (pathname.startsWith(`${TUNNEL_BASE}/`)) {
      sendError(res, 404, 'not-found', '未知远程路径');
      return;
    }

    await proxy.handle(req, res, peer.device);
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
