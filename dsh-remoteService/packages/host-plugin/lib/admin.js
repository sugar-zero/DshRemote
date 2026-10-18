import qrcode from 'qrcode-generator';
import { ADMIN_BASE } from 'dsh-remote-protocol';
import { pathnameOf, readJsonBody, sendError, sendJson, sendOk } from './http-utils.js';

/**
 * 本机管理 API：/api/remote-access/*
 * 只允许本机已认证的 DSH 浏览器访问（ctx.connection.requestRejection）。
 * 远程代理必须 deny 该前缀。
 */
export function createAdminHandler({ ctx, service, authDisabled = false }) {
  return async function adminHandler(req, res) {
    try {
      if (!authDisabled) {
        const rejection = ctx?.connection?.requestRejection?.(req);
        if (rejection) {
          res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(rejection === 401 ? 'unauthorized' : 'forbidden');
          return;
        }
      }
      await service.ready;
      const pathname = pathnameOf(req.url);
      if (!pathname || !pathname.startsWith(ADMIN_BASE)) { sendError(res, 404, 'not-found', 'not found'); return; }
      const sub = pathname.slice(ADMIN_BASE.length) || '/';
      const method = req.method ?? 'GET';

      if (sub === '/status' && method === 'GET') { sendOk(res, service.status()); return; }
      if (sub === '/config' && method === 'POST') {
        const body = await readJsonBody(req);
        const result = await service.updateConfig(body);
        if (result.errors?.length) { sendError(res, 400, 'invalid-config', result.errors.join('; ')); return; }
        sendOk(res, service.status());
        return;
      }
      if (sub === '/pairing/start' && method === 'POST') {
        try {
          sendOk(res, service.pairing.createSession());
        } catch (error) {
          sendError(res, error.status ?? 409, error.code ?? 'pairing-failed', error.message);
        }
        return;
      }
      if (sub === '/pairing/cancel' && method === 'POST') { sendOk(res, service.pairing.cancel()); return; }
      if (sub === '/pairing/approve' && method === 'POST') {
        const body = await readJsonBody(req);
        try {
          sendOk(res, service.pairing.approve(body));
        } catch (error) {
          sendError(res, error.status ?? 400, error.code ?? 'approve-failed', error.message);
        }
        return;
      }
      if (sub === '/pairing/qr.svg' && method === 'GET') {
        const active = service.pairing.publicSession();
        if (!active?.active || !active.uri) { sendError(res, 409, 'no-active-pairing', '没有活跃的配对会话'); return; }
        const svg = renderQrSvg(active.uri);
        res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-store' });
        res.end(svg);
        return;
      }
      if (sub === '/devices' && method === 'GET') { sendOk(res, { devices: service.devices.list() }); return; }
      const revokeMatch = /^\/devices\/([^/]+)\/revoke$/.exec(sub);
      if (revokeMatch && method === 'POST') {
        const device = service.devices.revoke(decodeURIComponent(revokeMatch[1]));
        if (!device) { sendError(res, 404, 'device-not-found', '设备不存在'); return; }
        service.audit.append({ deviceId: device.id, action: 'device-revoke', result: 'ok' });
        service.disconnectDevice?.(device.id);
        sendOk(res, { device });
        return;
      }
      if (sub === '/audit' && method === 'GET') {
        const limit = Number(new URL(req.url, 'https://localhost').searchParams.get('limit') ?? 100);
        sendOk(res, { entries: service.audit.tail(Number.isFinite(limit) ? limit : 100) });
        return;
      }
      sendError(res, 404, 'not-found', '未知管理接口');
    } catch (error) {
      if (!res.headersSent) sendError(res, error.status ?? 500, error.code ?? 'internal', error.message);
      else res.destroy();
    }
  };
}

/** 生成二维码 SVG（qrcode-generator）。 */
export function renderQrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(String(text));
  qr.make();
  return qr.createSvgTag({ cellSize: 5, margin: 4, scalable: true });
}
