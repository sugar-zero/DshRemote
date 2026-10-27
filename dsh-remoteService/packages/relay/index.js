/**
 * dsh-remote-relay —— 自托管盲中继（方案 B2）。
 *
 * 对外只暴露两个工厂：
 *   - createRelay(options) → { dataPort, controlPort, httpPort, domain, dev, close(), health(), onlineHostIds() }
 *   - startRelay(config)   → 同上（CLI / 配置文件入口语义）
 *
 * 端口可以传 0 让系统分配临时端口（测试用）；实际端口从返回值 / health() 读取。
 *
 * 典型用法：
 *   import { createRelay } from 'dsh-remote-relay';
 *   const relay = await createRelay({
 *     domain: 'relay.example.com',
 *     hostTokens: { h_ab12cd34: process.env.HOST_TOKEN },
 *     tls: { certFile: '/etc/dsh-relay/fullchain.pem', keyFile: '/etc/dsh-relay/privkey.pem' },
 *   });
 *   // relay.dataPort / relay.controlPort / relay.httpPort
 *   await relay.close();
 */

import { createRelay, startRelay } from './lib/server.js';

export { createRelay, startRelay };
export { parseClientHello, extractSni, SNI_STATUS, MAX_CLIENT_HELLO_BYTES } from './lib/sni.js';
export {
  createHostToken,
  defaultTokensFile,
  generateHostToken,
  isValidHostId,
  listHostTokens,
  loadHostTokens,
  maskToken,
  normalizeHostId,
  readTokenStore,
  resolveTokensFile,
  revokeHostToken,
  writeTokenStore,
} from './lib/tokens.js';
export {
  RELAY_DEFAULTS,
  RELAY_GROUP_DEFAULTS,
  RELAY_MODES,
  RELAY_TIMINGS,
  createConsoleLogger,
  normalizeConfig,
  normalizeDomain,
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
  registerHost,
  resolveGroupFile,
  revokeHost,
  revokeInvite,
  verifyHostToken,
  writeGroupStore,
} from './lib/group.js';
export { GroupAuthError, GroupAuthService } from './lib/group-auth.js';
export {
  GROUP_ADMIN_API_BASE,
  GROUP_ADMIN_BASE,
  createGroupAdminHandler,
  ensureAdminToken,
  renderAdminPage,
} from './lib/group-admin.js';

export default { createRelay, startRelay };
