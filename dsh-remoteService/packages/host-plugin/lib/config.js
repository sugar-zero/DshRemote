import { existsSync } from 'node:fs';
import { paths, readJson, writeJson } from './paths.js';

/** 默认配置；所有字段都可在管理 API 里覆盖。 */
export const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  enabled: false,
  hostName: '',
  relayUrl: '',            // 例如 wss://relay.example.com:8443
  relayDomain: '',         // 例如 relay.example.com；主机 FQDN = <hostId>.<relayDomain>
  hostId: '',              // 例如 h_ab12cd34（relay 分配/约定）
  publicPort: 0,           // 手机访问的数据面端口；0/443 表示默认 443；直连模式可填 1443
  hostToken: '',           // relay host token（0600 文件保存）
  relayTlsInsecure: false, // 仅本地 POC：relay 控制面自签证书时使用
  tlsCertFile: '',         // B2：主机侧 DNS-01 得到的 fullchain.pem；留空则生成 dev 自签
  tlsKeyFile: '',          // 对应私钥
  requireApproval: true,   // 桌面确认后设备才拿到证书
  restartHostEnabled: false, // 「重启主机」组件：默认关闭；开启后 App 顶栏才显示 ⏻、重启接口才可用
  listenPort: 0,           // 0 = 随机 loopback 端口
  maxRequestBytes: 256 * 1024 * 1024, // 远程代理请求体上限（默认 256 MiB）
  denyPrefixes: ['/connect', '/oauth', '/open-in-app', '/api/remote-access', '/__dsh_remote'],
  pushEnabled: true,
  pushCooldownSeconds: 30,
  pushProvider: 'apns',    // 'apns' = 自托管直连 Apple（推荐）；'expo' = 旧版经 relay 的 Expo 推送
  apnsKeyFile: '',         // APNs Auth Key (.p8) 的本地路径；建议放在仓库外，0600
  apnsKeyId: '',           // AuthKey_<KEY_ID>.p8 里的 KEY_ID
  apnsTeamId: '',          // Apple Developer Team ID
  apnsTopic: '',           // App bundle ID，例如 com.example.app
  apnsEnvironment: 'auto', // auto = 按设备注册时上报的 aps-environment；也可固定 development/production
  upstream: { protocol: 'http', host: '127.0.0.1' },
  // 群体服务版（A 模式）：注册到部署方的 relay，主机不持有 TLS/APNs 配置。
  groupEnabled: false,
  groupServiceUrl: '',     // 例如 https://relay.example.com:8443（部署方 relay 控制面）
  groupInviteCode: '',     // 一次性邀请码；注册成功后应清空
  groupPlainPort: 0,       // loopback 明文代理端口（0 = 随机；仅隧道可达）
  groupInsecure: false,    // 仅 POC：允许 http/ws 与自签证书（生产必须 https/wss）
});

const ALLOWED_KEYS = new Set([
  'enabled', 'hostName', 'relayUrl', 'relayDomain', 'hostId', 'publicPort', 'hostToken',
  'relayTlsInsecure', 'tlsCertFile', 'tlsKeyFile', 'requireApproval', 'restartHostEnabled', 'listenPort', 'denyPrefixes',
  'pushEnabled', 'pushCooldownSeconds', 'maxRequestBytes',
  'pushProvider',
  'apnsKeyFile', 'apnsKeyId', 'apnsTeamId', 'apnsTopic', 'apnsEnvironment',
  'groupEnabled', 'groupServiceUrl', 'groupInviteCode', 'groupPlainPort', 'groupInsecure',
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
  if (next.pushProvider !== 'apns' && next.pushProvider !== 'expo') next.pushProvider = 'apns';
  if (!['auto', 'development', 'production'].includes(next.apnsEnvironment)) next.apnsEnvironment = 'auto';
  writeJson(paths.config(), next);
  return next;
}

/** 校验进程序列化前的关键字段，返回可读错误列表。 */
export function validateConfig(config) {
  const errors = [];
  if (config.enabled && config.groupEnabled) {
    // 群体服务版：只需要「服务地址」；hostId/token/证书由注册自动获得。
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
    const publicPort = Number(config.publicPort ?? 0);
    if (!Number.isInteger(publicPort) || publicPort < 0 || publicPort > 65535) {
      errors.push('publicPort 必须是 0-65535 的整数（0/443 表示默认 443）');
    }
    if ((config.tlsCertFile && !config.tlsKeyFile) || (!config.tlsCertFile && config.tlsKeyFile)) errors.push('tlsCertFile 与 tlsKeyFile 必须成对提供');
  }
  return errors;
}

/**
 * 推送通道：'apns' = 主机直连 Apple（不经过 relay）；'expo' = 旧版经 relay 的 Expo 推送。
 * 未配置/非法值一律退回 apns（自托管默认）。
 * @param {Record<string, any>} [config]
 * @returns {'apns'|'expo'}
 */
export function pushProviderOf(config = {}) {
  return config.pushProvider === 'expo' ? 'expo' : 'apns';
}

/**
 * 推送配置自检：不阻止远程访问启动，只用于设置页提示与状态展示。
 * 仅在 pushEnabled 且 provider=apns 时检查 APNs 字段。
 * @param {Record<string, any>} [config]
 * @returns {string[]}
 */
export function validatePushConfig(config = {}) {
  const errors = [];
  if (config.pushEnabled === false) return errors;
  if (pushProviderOf(config) === 'expo') return errors; // 旧通道由 relay 配置，无需本机字段
  const keyFile = String(config.apnsKeyFile ?? '').trim();
  if (keyFile === '') errors.push('APNs 私钥路径（apnsKeyFile）未配置');
  else if (!existsSync(keyFile)) errors.push('APNs 私钥文件不存在');
  if (String(config.apnsKeyId ?? '').trim() === '') errors.push('APNs Key ID 未配置');
  if (String(config.apnsTeamId ?? '').trim() === '') errors.push('Apple Team ID 未配置');
  if (String(config.apnsTopic ?? '').trim() === '') errors.push('APNs Topic（App bundle ID）未配置');
  return errors;
}

/** 主机 FQDN：<hostId>.<relayDomain>。 */
export function hostFqdn(config) {
  if (!config.relayDomain) return '';
  return `${config.hostId}.${config.relayDomain}`;
}

/**
 * 手机实际访问的 host（配对 URI / WebView URL）。
 * publicPort=0/443 时不带端口；直连模式（例如 1443）时带上 :1443。
 */
export function hostAddress(config) {
  const fqdn = hostFqdn(config);
  if (!fqdn) return '';
  const port = Number(config.publicPort ?? 0);
  return Number.isInteger(port) && port > 0 && port !== 443 ? `${fqdn}:${port}` : fqdn;
}
