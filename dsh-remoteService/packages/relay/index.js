/**
 * dsh-remote-relay —— 群体服务版（A 模式）relay。
 *
 * 0.3.0 起只服务群体版产品线：classic 单机盲中继（443 TLS 透传 / 80 跳转 /
 * tokens.json / Expo 推送）已全部删除。relay 现在提供四个面：
 *   - 边缘 TLS（group.edge）：relay 用通配证书终止手机 TLS，鉴权后经控制面隧道到主机；
 *   - 控制面 WSS（/control）：主机插件出站隧道（host.hello / 心跳 / host.open / 流帧）；
 *   - 注册 API（/__group/register、/__group/refresh）：邀请码 → 主机自助注册；
 *   - 部署方后台（/__admin）：邀请码/主机管理；
 *   - health：httpPort 上只保留 GET/HEAD /healthz（容器 HEALTHCHECK 用）。
 *
 * 对外工厂：
 *   - createRelay(options) → { controlPort, httpPort, groupApiPort, groupAdminPort, edgePort,
 *                             domain, dev, close(), health(), onlineHostIds() }
 *   - startRelay(config)   → 同上（CLI / 配置文件入口语义）
 *
 * 端口可以传 0 让系统分配临时端口（测试用）；实际端口从返回值 / health() 读取。
 *
 * 典型用法（生产：控制面证书 + 边缘通配证书）：
 *   import { createRelay } from 'dsh-remote-relay';
 *   const relay = await createRelay({
 *     domain: 'relay.example.com',
 *     tls: { certFile: '/data/certs/relay.example.com/fullchain.pem',
 *            keyFile:  '/data/certs/relay.example.com/privkey.pem' },
 *     group: {
 *       file: '/data/group.json',
 *       mobilePort: 443,
 *       edge: {
 *         enabled: true,
 *         port: 443,
 *         tls: { certFile: '/data/certs/wildcard/fullchain.pem',
 *                keyFile:  '/data/certs/wildcard/privkey.pem' },
 *       },
 *     },
 *   });
 *   await relay.close();
 */

import { createRelay, startRelay } from './lib/server.js';

export { createRelay, startRelay };
export { HOST_TOKEN_BYTES, generateHostToken, isValidHostId, normalizeHostId } from './lib/tokens.js';
export {
  RELAY_DEFAULTS,
  RELAY_GROUP_DEFAULTS,
  RELAY_LIMIT_DEFAULTS,
  RELAY_TIMINGS,
  createConsoleLogger,
  normalizeConfig,
  normalizeDomain,
  normalizeLimits,
  readTlsMaterial,
} from './lib/config.js';
export {
  GROUP_INVITE_DEFAULT_MAX_USES,
  GROUP_INVITE_DEFAULT_TTL_MS,
  GROUP_STORE_DIR_MODE,
  GROUP_STORE_FILE_MODE,
  GROUP_STORE_FILE_NAME,
  GroupRegistrationError,
  GroupRegistrationService,
  createInvite,
  defaultGroupFile,
  getHostRecord,
  groupErrorStatus,
  listHosts,
  listInvites,
  readGroupStore,
  refreshHost,
  registerHost,
  resolveGroupFile,
  revokeHost,
  revokeInvite,
  verifyHostToken,
  writeGroupStore,
} from './lib/group.js';
export { GroupAuthError, GroupAuthService } from './lib/group-auth.js';
export { createGroupPushService } from './lib/push.js';
export {
  GROUP_ADMIN_API_BASE,
  GROUP_ADMIN_BASE,
  createGroupAdminHandler,
  ensureAdminToken,
  renderAdminPage,
} from './lib/group-admin.js';

export default { createRelay, startRelay };
