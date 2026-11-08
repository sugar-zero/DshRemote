import { paths, readJson, writeJson } from './paths.js';

/**
 * 群体服务版（A 模式）主机配置。
 *
 * 主机**不持有** TLS 证书 / 主机令牌 / relay 域名 / 推送配置：所有与 relay 相关的信息
 * （hostId / hostToken / relayDomain / mobilePort / token 公钥 / controlUrl）都由
 * 「注册 API + 邀请码」自助注册获得，落盘在 `$DSH_HOME/remote-access/group.json`。
 */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: false,          // 开启远程访问（关闭 = 停止隧道与 loopback 代理）
  hostName: '',            // 手机上显示的友好名称（注册时同步给服务端）
  requireApproval: true,   // 新设备配对需要本机确认
  maxRequestBytes: 256 * 1024 * 1024, // 远程代理请求体上限（默认 256 MiB）
  denyPrefixes: ['/connect', '/oauth', '/open-in-app', '/api/remote-access', '/__dsh_remote'],
  groupServiceUrl: '',     // 部署方 relay 的注册 API 地址，例如 https://relay.example.com:19443
  groupInviteCode: '',     // 一次性邀请码；注册成功后清空
  groupPlainPort: 0,       // loopback 明文代理端口（0 = 随机；只被隧道客户端连接）
  groupInsecure: false,    // 仅 POC：允许 http/ws 与自签证书（生产必须 https/wss）
  restartHostEnabled: false, // 「组件」：允许手机重启主机 DSH（默认关闭；501 拒绝 + App 隐藏 ⏻）
  pushEnabled: true,       // 「推送提醒」：允许把推送意图（push.send）发给 relay（默认开启）
  pushDetail: false,       // 「详细推送内容」：通知里带会话标题/摘要（默认关闭 = 通用文案）
});

const ALLOWED_KEYS = new Set([
  'enabled', 'hostName', 'requireApproval', 'maxRequestBytes', 'denyPrefixes',
  'groupServiceUrl', 'groupInviteCode', 'groupPlainPort', 'groupInsecure',
  'restartHostEnabled', 'pushEnabled', 'pushDetail',
]);

/**
 * 加载配置（不存在时返回默认值）。
 * 旧版（classic/单体）遗留字段一律丢弃：不进入运行时，也不会在后续保存时写回磁盘。
 */
export function loadConfig() {
  const stored = readJson(paths.config(), {});
  const merged = { ...DEFAULT_CONFIG };
  for (const [key, value] of Object.entries(stored && typeof stored === 'object' ? stored : {})) {
    if (ALLOWED_KEYS.has(key) && value !== undefined) merged[key] = value;
  }
  if (!Array.isArray(merged.denyPrefixes)) merged.denyPrefixes = [...DEFAULT_CONFIG.denyPrefixes];
  return merged;
}

/** 合并并持久化配置（只接受已知字段）。 */
export function saveConfig(patch) {
  const next = loadConfig();
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!ALLOWED_KEYS.has(key)) continue;
    if (value === undefined) continue;
    next[key] = value;
  }
  if (Array.isArray(next.denyPrefixes)) {
    next.denyPrefixes = next.denyPrefixes.map(String).filter((p) => p.startsWith('/'));
  }
  const plainPort = Number(next.groupPlainPort);
  next.groupPlainPort = Number.isInteger(plainPort) && plainPort >= 0 && plainPort <= 65535 ? plainPort : 0;
  const maxBytes = Number(next.maxRequestBytes);
  next.maxRequestBytes = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_CONFIG.maxRequestBytes;
  writeJson(paths.config(), next);
  return next;
}

/** 校验进程序列化前的关键字段，返回可读错误列表。 */
export function validateConfig(config) {
  const errors = [];
  if (!config?.enabled) return errors;
  const raw = String(config.groupServiceUrl ?? '').trim();
  if (raw === '') {
    errors.push('groupServiceUrl（服务地址）未配置');
  } else {
    try {
      const url = new URL(raw);
      const allowed = config.groupInsecure ? ['https:', 'wss:', 'http:', 'ws:'] : ['https:', 'wss:'];
      if (!allowed.includes(url.protocol)) errors.push('groupServiceUrl 协议必须是 https:// 或 wss://');
    } catch {
      errors.push('groupServiceUrl 不是合法 URL');
    }
  }
  const plainPort = Number(config.groupPlainPort ?? 0);
  if (!Number.isInteger(plainPort) || plainPort < 0 || plainPort > 65535) {
    errors.push('groupPlainPort 必须是 0-65535 的整数（0 = 随机端口）');
  }
  return errors;
}
