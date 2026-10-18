import { paths, readJson, writeJson } from './paths.js';

/** 默认配置；所有字段都可在管理 API 里覆盖。 */
export const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  enabled: false,
  hostName: '',
  relayUrl: '',            // 例如 wss://relay.example.com:8443
  relayDomain: '',         // 例如 relay.example.com；主机 FQDN = <hostId>.<relayDomain>
  hostId: '',              // 例如 h_ab12cd34（relay 分配/约定）
  hostToken: '',           // relay host token（0600 文件保存）
  relayTlsInsecure: false, // 仅本地 POC：relay 控制面自签证书时使用
  tlsCertFile: '',         // B2：主机侧 DNS-01 得到的 fullchain.pem；留空则生成 dev 自签
  tlsKeyFile: '',          // 对应私钥
  requireApproval: true,   // 桌面确认后设备才拿到证书
  listenPort: 0,           // 0 = 随机 loopback 端口
  denyPrefixes: ['/connect', '/oauth', '/api/remote-access', '/__dsh_remote'],
  upstream: { protocol: 'http', host: '127.0.0.1' },
});

const ALLOWED_KEYS = new Set([
  'enabled', 'hostName', 'relayUrl', 'relayDomain', 'hostId', 'hostToken',
  'relayTlsInsecure', 'tlsCertFile', 'tlsKeyFile', 'requireApproval', 'listenPort', 'denyPrefixes',
]);

/** 加载配置（不存在时返回默认值）。 */
export function loadConfig() {
  const stored = readJson(paths.config(), {});
  const merged = { ...DEFAULT_CONFIG, ...(stored && typeof stored === 'object' ? stored : {}) };
  merged.upstream = { ...DEFAULT_CONFIG.upstream, ...(stored?.upstream ?? {}) };
  if (!Array.isArray(merged.denyPrefixes)) merged.denyPrefixes = [...DEFAULT_CONFIG.denyPrefixes];
  return merged;
}

/** 合并并持久化配置（只接受已知字段）。 */
export function saveConfig(patch) {
  const current = loadConfig();
  const next = { ...current };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!ALLOWED_KEYS.has(key)) continue;
    if (value === undefined) continue;
    next[key] = value;
  }
  if (Array.isArray(next.denyPrefixes)) {
    next.denyPrefixes = next.denyPrefixes.map(String).filter((p) => p.startsWith('/'));
  }
  writeJson(paths.config(), next);
  return next;
}

/** 校验进程序列化前的关键字段，返回可读错误列表。 */
export function validateConfig(config) {
  const errors = [];
  if (config.enabled) {
    if (!config.relayUrl) errors.push('relayUrl 未配置');
    else {
      try {
        const u = new URL(config.relayUrl);
        if (!['ws:', 'wss:', 'http:', 'https:'].includes(u.protocol)) errors.push('relayUrl 协议必须是 ws(s):// 或 http(s)://');
      } catch { errors.push('relayUrl 不是合法 URL'); }
    }
    if (!config.relayDomain) errors.push('relayDomain 未配置');
    if (!config.hostId) errors.push('hostId 未配置');
    else if (!/^[a-z0-9][a-z0-9_-]{1,40}$/.test(config.hostId)) errors.push('hostId 只能是小写字母/数字/-/_，2-41 位');
    if (!config.hostToken) errors.push('hostToken 未配置');
    if ((config.tlsCertFile && !config.tlsKeyFile) || (!config.tlsCertFile && config.tlsKeyFile)) errors.push('tlsCertFile 与 tlsKeyFile 必须成对提供');
  }
  return errors;
}

/** 主机 FQDN：<hostId>.<relayDomain>。 */
export function hostFqdn(config) {
  if (!config.relayDomain) return '';
  return `${config.hostId}.${config.relayDomain}`;
}
