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
  RELAY_TIMINGS,
  createConsoleLogger,
  normalizeConfig,
  normalizeDomain,
  readTlsMaterial,
} from './lib/config.js';

export default { createRelay, startRelay };
