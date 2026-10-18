/**
 * dsh-remote-service —— Host 插件入口。
 *
 * 功能：设备配对、mTLS 反向代理、自托管盲中继连接、管理 API（本机）。
 * Client 半在 client.js（账号行上方入口 + 配对/设备管理界面）。
 */
import { ADMIN_BASE } from 'dsh-remote-protocol';
import { RemoteService } from './lib/service.js';
import { createAdminHandler } from './lib/admin.js';

export const name = 'remote-service';
export const inject = ['webServer', 'connection'];

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const service = new RemoteService(ctx);
  const handler = createAdminHandler({ ctx, service });
  ctx.effect(() => {
    const disposeRoute = ctx.webServer.register({
      path: ADMIN_BASE,
      handler,
    });
    return () => {
      try { disposeRoute?.(); } catch { /* ignore */ }
      void service.dispose();
    };
  }, 'dsh-remote-service: /api/remote-access 路由');
}
