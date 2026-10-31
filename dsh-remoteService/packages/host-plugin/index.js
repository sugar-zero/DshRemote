/**
 * dsh-remote-service —— Host 插件入口（群体服务版 / A 模式）。
 *
 * 功能：群体服务注册与隧道、loopback 明文反向代理（HTTP/WS）、token 验签、
 * 群体版设备配对、本机管理 API。
 * Client 半在 client.js（侧栏入口 + 设置页 + 手机 WebView 优化）。
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
