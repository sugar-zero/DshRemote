#!/usr/bin/env node
/**
 * dsh-remote-relay CLI（群体服务版，A 模式）。
 *
 *   node bin/relay.js --config /etc/dsh-relay/relay.json
 *   node bin/relay.js --dev --domain relay.test --group-file ./group.json
 *   node bin/relay.js invite create --config ./relay.json
 *   node bin/relay.js host list / revoke ...
 *   node bin/relay.js admin-token ...
 *
 * 0.3.0 起只服务群体版：classic 单机中继相关命令（token create/list/revoke、
 * --mode、--data-port、--tokens-file、RELAY_PUSH_*）已全部删除。
 *
 * 配置优先级：内置默认值 < config 文件 < 环境变量 < 命令行参数。
 * group.json 默认与 config 同目录（无 --config 时用当前目录）。
 */

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';
import { GROUP_REGISTER_PATH } from 'dsh-remote-protocol';
import {
  createConsoleLogger,
  createInvite,
  ensureAdminToken,
  defaultGroupFile,
  listHosts,
  listInvites,
  revokeHost,
  revokeInvite,
  startRelay,
} from '../index.js';

const FLAGS_WITH_VALUE = new Set([
  'config',
  'domain',
  'control-port',
  'http-port',
  'listen-host',
  'data-host', // 旧名（0.3.0 起统一叫 listen-host，保留别名）
  'cert-file',
  'key-file',
  'log-level',
  'group-file',
  'note',
  'max-uses',
  'expires-in',
  'admin-token',
  'admin-token-file',
  'group-api-port',
  'group-api-bind',
  'group-admin-port',
  'group-admin-bind',
  'group-public-control-port',
]);

const HELP = `dsh-remote-relay —— 群体服务版（A 模式）relay (DSH remote access)

用法:
  node bin/relay.js [options]                    启动 relay（边缘 TLS + 控制面 WSS + 注册 API + 后台）
  node bin/relay.js invite create [options]     生成自助注册邀请码（只打印一次）
  node bin/relay.js invite list                 列出邀请（含邀请码明文，方便复制）
  node bin/relay.js invite revoke <id|code>     撤销邀请
  node bin/relay.js host list                   列出已注册主机
  node bin/relay.js host revoke <hostId>        撤销主机（吊销其 token）
  node bin/relay.js admin-token                 打印部署方后台 admin token（--json 可机器读）
  node bin/relay.js --help                      显示本帮助
  node bin/relay.js --version                   显示版本

群体版部署方后台:
  启动后在浏览器打开 https://<domain>:<adminPort>/__admin （默认绑 127.0.0.1），
  粘贴 admin token 即可管理邀请码/主机。token 未配置时首次启动自动生成到
  <group.json 目录>/admin-token（0600），也可用 --admin-token / RELAY_ADMIN_TOKEN 显式指定。

启动参数:
  --config <path>        JSON 配置文件（group.file / 证书等相对路径基于该文件目录解析）
  --dev                  开发/测试模式：无 TLS 时允许 ws:// 控制面（绝不能用于公网）
  --domain <domain>      根域名，如 relay.example.com（必填；<hostId>.<domain> 走 DNS 泛解析）
  --control-port <port>  控制面 WSS 端口（默认 8443）
  --http-port <port>     health 端口（默认 80；只服务 GET/HEAD /healthz）
  --listen-host <addr>   监听地址（默认 0.0.0.0；旧名 --data-host 仍可用）
  --group-file <path>    群体版注册状态文件（默认 <config 目录>/group.json）
  --no-group-edge        显式关闭默认开启的边缘 TLS（仅本地/特殊场景；关闭后没有手机数据面）
  --cert-file <path>     控制面 TLS 证书链（生产必填，除非 --dev）
  --key-file <path>      控制面 TLS 私钥（生产必填，除非 --dev）
  --log-level <level>    debug | info | warn | error | silent（默认 info）
  --json                 invite/host/admin-token 命令输出 JSON（便于脚本解析）
  -h, --help             显示帮助

邀请码参数（invite create）:
  --note <text>          备注（最长 120 字符）
  --max-uses <n>         可用次数（默认 1，最大 1000）
  --expires-in <dur>     有效期，如 30m / 24h / 7d / 0（0 = 永不过期；默认 7d）

环境变量（覆盖 config 文件，被命令行参数覆盖）:
  RELAY_DOMAIN RELAY_DEV RELAY_CONTROL_PORT RELAY_HTTP_PORT RELAY_LISTEN_HOST
  RELAY_GROUP_FILE RELAY_GROUP_MOBILE_PORT
  RELAY_GROUP_API_PORT RELAY_GROUP_API_BIND RELAY_GROUP_ADMIN_PORT RELAY_GROUP_ADMIN_BIND
  RELAY_GROUP_PUBLIC_CONTROL_PORT RELAY_ADMIN_TOKEN RELAY_ADMIN_TOKEN_FILE
  RELAY_GROUP_EDGE_ENABLED RELAY_GROUP_EDGE_PORT RELAY_GROUP_EDGE_CERT_FILE RELAY_GROUP_EDGE_KEY_FILE
  RELAY_GROUP_SIGNING_KEY_FILE RELAY_TLS_CERT_FILE RELAY_TLS_KEY_FILE RELAY_LOG_LEVEL

服务端集中推送（self；可选，不配置 = 关闭）:
  RELAY_GROUP_PUSH_ENABLED=true|false      总开关（默认 false）
  RELAY_GROUP_PUSH_MODE=self               唯一通道（R2 起 official 已删除：官方 App 推送直连官方 hub）
  RELAY_GROUP_PUSH_CONTENT=generic|summary 内容策略（默认 generic）
  RELAY_GROUP_PUSH_COOLDOWN_SECONDS=30     同 host 推送最小间隔（0..3600 秒）
  RELAY_GROUP_PUSH_APNS_KEY_FILE / _KEY_ID / _TEAM_ID / _TOPIC / _ENVIRONMENT
  （APNs .p8 只放 /data 下 0600 文件；不要写进仓库/命令行）

示例:
  # 生产（控制面证书 = relay.example.com；边缘通配证书 = *.relay.example.com，写在 config 里）
  node bin/relay.js --config /etc/dsh-relay/relay.json

  # 本地开发（ws:// 控制面 + 临时端口；--no-group-edge 显式关闭默认开启的边缘 TLS，仅调注册/后台）
  node bin/relay.js --dev --domain relay.test --control-port 0 --http-port 0 --group-file ./group.json --no-group-edge

  # 发邀请码（只打印一次；只给要加入的群成员）
  node bin/relay.js invite create --note "朋友A" --expires-in 7d --config /etc/dsh-relay/relay.json

安全说明:
  - A 模式下 relay 终止手机 TLS（部署方可见明文，风险与责任由部署方承担）；
    relay 用通配证书 + SNI 把流量路由到主机，主机只做出站 WSS 隧道。
  - 主机必须凭邀请码注册；注册接口只接受有效邀请码；group.json 只存 invite 明文与
    host token 的 SHA-256（0600）。
  - 设备身份来自「配对注册的设备密钥 + relay 签发的短时 token」，不信任来源 IP/自定义头。
  - invite create 只在 stdout 打印一次明文，请立即交给群成员。
`;

/**
 * @param {string[]} argv
 * @returns {{flags: Record<string, string|boolean>, positionals: string[]}}
 */
function parseArgs(argv) {
  /** @type {Record<string, string|boolean>} */
  const flags = {};
  /** @type {string[]} */
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h') {
      flags.help = true;
      continue;
    }
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    let name;
    let value;
    if (eq >= 0) {
      name = arg.slice(2, eq);
      value = arg.slice(eq + 1);
    } else {
      name = arg.slice(2);
      if (FLAGS_WITH_VALUE.has(name)) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) throw new Error(`missing value for --${name}`);
        value = next;
        i += 1;
      } else {
        value = true;
      }
    }
    flags[name] = value;
  }
  return { flags, positionals };
}

/**
 * @param {string} value
 * @param {string} name
 * @returns {boolean}
 */
function parseBoolean(value, name) {
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`invalid boolean for ${name}: ${JSON.stringify(value)}`);
}

/**
 * 读 JSON 配置文件；相对路径按 config 文件所在目录解析。
 * @param {string} path
 * @returns {{config: Record<string, any>, path: string}}
 */
function readConfigFile(path) {
  const abs = resolve(path);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(abs, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read config file "${abs}": ${err && err.message ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`config file must contain a JSON object: ${abs}`);
  }
  const baseDir = dirname(abs);
  const resolveFromConfigDir = (value) => (typeof value === 'string' && value !== '' && !isAbsolute(value) ? resolve(baseDir, value) : value);
  /** @type {Record<string, any>} */
  const config = { ...parsed };
  if (config.group && typeof config.group === 'object') {
    config.group = { ...config.group };
    if (typeof config.group.file === 'string' && config.group.file !== '') {
      config.group.file = resolveFromConfigDir(config.group.file);
    }
    if (typeof config.group.adminTokenFile === 'string' && config.group.adminTokenFile !== '') {
      config.group.adminTokenFile = resolveFromConfigDir(config.group.adminTokenFile);
    }
    if (config.group.auth && typeof config.group.auth === 'object' && typeof config.group.auth.signingKeyFile === 'string'
      && config.group.auth.signingKeyFile !== '') {
      config.group = {
        ...config.group,
        auth: { ...config.group.auth, signingKeyFile: resolveFromConfigDir(config.group.auth.signingKeyFile) },
      };
    }
    if (config.group.edge && typeof config.group.edge === 'object') {
      config.group = { ...config.group, edge: { ...config.group.edge } };
      if (config.group.edge.tls && typeof config.group.edge.tls === 'object') {
        config.group.edge.tls = { ...config.group.edge.tls };
        if (config.group.edge.tls.certFile) config.group.edge.tls.certFile = resolveFromConfigDir(config.group.edge.tls.certFile);
        if (config.group.edge.tls.keyFile) config.group.edge.tls.keyFile = resolveFromConfigDir(config.group.edge.tls.keyFile);
      }
    }
    if (config.group.push && typeof config.group.push === 'object') {
      config.group = { ...config.group, push: { ...config.group.push } };
      const push = config.group.push;
      if (push.self && typeof push.self === 'object') {
        push.self = { ...push.self };
        if (typeof push.self.keyFile === 'string' && push.self.keyFile !== '') {
          push.self.keyFile = resolveFromConfigDir(push.self.keyFile);
        }
      }
    }
  }
  if (config.tls && typeof config.tls === 'object') {
    config.tls = { ...config.tls };
    if (config.tls.certFile) config.tls.certFile = resolveFromConfigDir(config.tls.certFile);
    if (config.tls.keyFile) config.tls.keyFile = resolveFromConfigDir(config.tls.keyFile);
  }
  return { config, path: abs };
}

/** 环境变量覆盖（仅在显式设置时生效）。 */
function applyEnv(config) {
  const env = process.env;
  if (env.RELAY_DOMAIN) config.domain = env.RELAY_DOMAIN;
  if (env.RELAY_DEV !== undefined) config.dev = parseBoolean(env.RELAY_DEV, 'RELAY_DEV');
  if (env.RELAY_CONTROL_PORT) config.controlPort = env.RELAY_CONTROL_PORT;
  if (env.RELAY_HTTP_PORT) config.httpPort = env.RELAY_HTTP_PORT;
  if (env.RELAY_LISTEN_HOST || env.RELAY_DATA_HOST) config.listenHost = env.RELAY_LISTEN_HOST || env.RELAY_DATA_HOST;
  const ensureGroup = () => {
    config.group = { ...(config.group && typeof config.group === 'object' ? config.group : {}) };
    return config.group;
  };
  if (env.RELAY_GROUP_FILE) ensureGroup().file = env.RELAY_GROUP_FILE;
  if (env.RELAY_GROUP_MOBILE_PORT) ensureGroup().mobilePort = env.RELAY_GROUP_MOBILE_PORT;
  if (env.RELAY_GROUP_API_PORT || env.RELAY_GROUP_API_BIND
    || env.RELAY_GROUP_ADMIN_PORT || env.RELAY_GROUP_ADMIN_BIND) {
    const group = ensureGroup();
    if (env.RELAY_GROUP_API_PORT) group.apiPort = env.RELAY_GROUP_API_PORT;
    if (env.RELAY_GROUP_API_BIND) group.apiBind = env.RELAY_GROUP_API_BIND;
    if (env.RELAY_GROUP_ADMIN_PORT) group.adminPort = env.RELAY_GROUP_ADMIN_PORT;
    if (env.RELAY_GROUP_ADMIN_BIND) group.adminBind = env.RELAY_GROUP_ADMIN_BIND;
  }
  if (env.RELAY_GROUP_PUBLIC_CONTROL_PORT) ensureGroup().publicControlPort = env.RELAY_GROUP_PUBLIC_CONTROL_PORT;
  if (env.RELAY_GROUP_EDGE_ENABLED !== undefined || env.RELAY_GROUP_EDGE_PORT
    || env.RELAY_GROUP_EDGE_CERT_FILE || env.RELAY_GROUP_EDGE_KEY_FILE) {
    const group = ensureGroup();
    group.edge = { ...(group.edge && typeof group.edge === 'object' ? group.edge : {}) };
    if (env.RELAY_GROUP_EDGE_ENABLED !== undefined) {
      group.edge.enabled = parseBoolean(env.RELAY_GROUP_EDGE_ENABLED, 'RELAY_GROUP_EDGE_ENABLED');
    } else if (env.RELAY_GROUP_EDGE_CERT_FILE || env.RELAY_GROUP_EDGE_KEY_FILE) {
      group.edge.enabled = true;
    }
    if (env.RELAY_GROUP_EDGE_PORT) group.edge.port = env.RELAY_GROUP_EDGE_PORT;
    if (env.RELAY_GROUP_EDGE_CERT_FILE || env.RELAY_GROUP_EDGE_KEY_FILE) {
      group.edge.tls = { ...(group.edge.tls && typeof group.edge.tls === 'object' ? group.edge.tls : {}) };
      if (env.RELAY_GROUP_EDGE_CERT_FILE) group.edge.tls.certFile = env.RELAY_GROUP_EDGE_CERT_FILE;
      if (env.RELAY_GROUP_EDGE_KEY_FILE) group.edge.tls.keyFile = env.RELAY_GROUP_EDGE_KEY_FILE;
    }
  }
  if (env.RELAY_GROUP_SIGNING_KEY_FILE) {
    const group = ensureGroup();
    group.auth = { ...(group.auth && typeof group.auth === 'object' ? group.auth : {}) };
    group.auth.signingKeyFile = env.RELAY_GROUP_SIGNING_KEY_FILE;
  }
  // 服务端集中推送（group.push）：R2 起只有 self；不设置 = 保持配置文件/默认值。
  if (env.RELAY_GROUP_PUSH_ENABLED !== undefined || env.RELAY_GROUP_PUSH_MODE || env.RELAY_GROUP_PUSH_CONTENT
    || env.RELAY_GROUP_PUSH_COOLDOWN_SECONDS
    || env.RELAY_GROUP_PUSH_APNS_KEY_FILE || env.RELAY_GROUP_PUSH_APNS_KEY_ID
    || env.RELAY_GROUP_PUSH_APNS_TEAM_ID || env.RELAY_GROUP_PUSH_APNS_TOPIC
    || env.RELAY_GROUP_PUSH_APNS_ENVIRONMENT) {
    const group = ensureGroup();
    group.push = { ...(group.push && typeof group.push === 'object' ? group.push : {}) };
    const push = group.push;
    if (env.RELAY_GROUP_PUSH_ENABLED !== undefined) {
      push.enabled = parseBoolean(env.RELAY_GROUP_PUSH_ENABLED, 'RELAY_GROUP_PUSH_ENABLED');
    }
    if (env.RELAY_GROUP_PUSH_MODE) {
      const mode = env.RELAY_GROUP_PUSH_MODE.trim().toLowerCase();
      if (mode !== 'self') {
        if (mode === 'official') {
          throw new Error(
            'RELAY_GROUP_PUSH_MODE="official" 已删除：R2 起官方 App 推送直连官方 hub（App 向 hub 登记、主机直连），relay 只做 self 推送',
          );
        }
        throw new Error(`RELAY_GROUP_PUSH_MODE=${JSON.stringify(env.RELAY_GROUP_PUSH_MODE)} 无效：relay 只支持 self（部署方自己的 APNs key）`);
      }
      push.mode = 'self';
    }
    if (env.RELAY_GROUP_PUSH_CONTENT) push.content = env.RELAY_GROUP_PUSH_CONTENT;
    if (env.RELAY_GROUP_PUSH_COOLDOWN_SECONDS) push.cooldownSeconds = env.RELAY_GROUP_PUSH_COOLDOWN_SECONDS;
    if (env.RELAY_GROUP_PUSH_APNS_KEY_FILE || env.RELAY_GROUP_PUSH_APNS_KEY_ID
      || env.RELAY_GROUP_PUSH_APNS_TEAM_ID || env.RELAY_GROUP_PUSH_APNS_TOPIC
      || env.RELAY_GROUP_PUSH_APNS_ENVIRONMENT) {
      push.self = { ...(push.self && typeof push.self === 'object' ? push.self : {}) };
      if (env.RELAY_GROUP_PUSH_APNS_KEY_FILE) push.self.keyFile = env.RELAY_GROUP_PUSH_APNS_KEY_FILE;
      if (env.RELAY_GROUP_PUSH_APNS_KEY_ID) push.self.keyId = env.RELAY_GROUP_PUSH_APNS_KEY_ID;
      if (env.RELAY_GROUP_PUSH_APNS_TEAM_ID) push.self.teamId = env.RELAY_GROUP_PUSH_APNS_TEAM_ID;
      if (env.RELAY_GROUP_PUSH_APNS_TOPIC) push.self.topic = env.RELAY_GROUP_PUSH_APNS_TOPIC;
      if (env.RELAY_GROUP_PUSH_APNS_ENVIRONMENT) push.self.environment = env.RELAY_GROUP_PUSH_APNS_ENVIRONMENT;
    }
  }
  if (env.RELAY_ADMIN_TOKEN || env.RELAY_ADMIN_TOKEN_FILE) {
    const group = ensureGroup();
    if (env.RELAY_ADMIN_TOKEN) group.adminToken = env.RELAY_ADMIN_TOKEN;
    if (env.RELAY_ADMIN_TOKEN_FILE) group.adminTokenFile = env.RELAY_ADMIN_TOKEN_FILE;
  }
  if (env.RELAY_LOG_LEVEL) config.logLevel = env.RELAY_LOG_LEVEL;
  if (env.RELAY_TLS_CERT_FILE || env.RELAY_TLS_KEY_FILE) {
    config.tls = { ...(config.tls ?? {}) };
    if (env.RELAY_TLS_CERT_FILE) config.tls.certFile = env.RELAY_TLS_CERT_FILE;
    if (env.RELAY_TLS_KEY_FILE) config.tls.keyFile = env.RELAY_TLS_KEY_FILE;
  }
}

/** 命令行参数覆盖（最高优先级）。 */
function applyFlags(config, flags) {
  if (flags.domain !== undefined) config.domain = flags.domain;
  if (flags.dev !== undefined) config.dev = true;
  if (flags['control-port'] !== undefined) config.controlPort = flags['control-port'];
  if (flags['http-port'] !== undefined) config.httpPort = flags['http-port'];
  if (flags['listen-host'] !== undefined) config.listenHost = flags['listen-host'];
  else if (flags['data-host'] !== undefined) config.listenHost = flags['data-host'];
  const ensureGroup = () => {
    config.group = { ...(config.group && typeof config.group === 'object' ? config.group : {}) };
    return config.group;
  };
  if (flags['group-file'] !== undefined) ensureGroup().file = flags['group-file'];
  if (flags['admin-token'] !== undefined || flags['admin-token-file'] !== undefined) {
    const group = ensureGroup();
    if (flags['admin-token'] !== undefined) group.adminToken = flags['admin-token'];
    if (flags['admin-token-file'] !== undefined) group.adminTokenFile = flags['admin-token-file'];
  }
  if (flags['group-api-port'] !== undefined || flags['group-api-bind'] !== undefined
    || flags['group-admin-port'] !== undefined || flags['group-admin-bind'] !== undefined) {
    const group = ensureGroup();
    if (flags['group-api-port'] !== undefined) group.apiPort = flags['group-api-port'];
    if (flags['group-api-bind'] !== undefined) group.apiBind = flags['group-api-bind'];
    if (flags['group-admin-port'] !== undefined) group.adminPort = flags['group-admin-port'];
    if (flags['group-admin-bind'] !== undefined) group.adminBind = flags['group-admin-bind'];
  }
  if (flags['no-group-edge'] !== undefined) {
    const group = ensureGroup();
    group.edge = { ...(group.edge && typeof group.edge === 'object' ? group.edge : {}), enabled: false };
  }
  if (flags['group-public-control-port'] !== undefined) ensureGroup().publicControlPort = flags['group-public-control-port'];
  if (flags['log-level'] !== undefined) config.logLevel = flags['log-level'];
  if (flags['cert-file'] !== undefined || flags['key-file'] !== undefined) {
    config.tls = { ...(config.tls ?? {}) };
    if (flags['cert-file'] !== undefined) config.tls.certFile = flags['cert-file'];
    if (flags['key-file'] !== undefined) config.tls.keyFile = flags['key-file'];
  }
}

/**
 * 合并 config 文件 / 环境变量 / 命令行参数，补齐默认 group.json 路径。
 * @param {Record<string, any>} flags
 * @returns {{config: Record<string, any>, configPath: string | undefined}}
 */
function buildConfig(flags) {
  let config = {};
  let configPath;
  if (flags.config !== undefined) {
    if (typeof flags.config !== 'string') throw new Error('--config requires a path');
    const loaded = readConfigFile(flags.config);
    config = loaded.config;
    configPath = loaded.path;
  }
  applyEnv(config);
  applyFlags(config, flags);

  if (!config.group || typeof config.group !== 'object' || Array.isArray(config.group)) config.group = {};
  if (!config.group.file) config.group.file = defaultGroupFile(configPath);
  config.group.file = resolve(process.cwd(), config.group.file);
  if (config.group.adminTokenFile) config.group.adminTokenFile = resolve(process.cwd(), config.group.adminTokenFile);
  if (config.group.auth && typeof config.group.auth === 'object' && config.group.auth.signingKeyFile) {
    config.group.auth = { ...config.group.auth, signingKeyFile: resolve(process.cwd(), config.group.auth.signingKeyFile) };
  }
  if (config.group.push && typeof config.group.push === 'object') {
    config.group = { ...config.group, push: { ...config.group.push } };
    const push = config.group.push;
    if (push.self && typeof push.self === 'object' && push.self.keyFile) {
      push.self = { ...push.self, keyFile: resolve(process.cwd(), push.self.keyFile) };
    }
  }
  if (config.group.edge && typeof config.group.edge === 'object' && config.group.edge.tls
    && typeof config.group.edge.tls === 'object' && config.group.edge.tls.cert === undefined) {
    config.group.edge = { ...config.group.edge, tls: { ...config.group.edge.tls } };
    if (config.group.edge.tls.certFile) config.group.edge.tls.certFile = resolve(process.cwd(), config.group.edge.tls.certFile);
    if (config.group.edge.tls.keyFile) config.group.edge.tls.keyFile = resolve(process.cwd(), config.group.edge.tls.keyFile);
  }
  if (config.tls && typeof config.tls === 'object' && config.tls.cert === undefined) {
    if (config.tls.certFile) config.tls.certFile = resolve(process.cwd(), config.tls.certFile);
    if (config.tls.keyFile) config.tls.keyFile = resolve(process.cwd(), config.tls.keyFile);
  }
  if (!config.logger) config.logger = createConsoleLogger(config.logLevel ?? 'info');
  return { config, configPath };
}

/**
 * 解析时长（30m / 24h / 7d / 0）；返回毫秒，0 = 永不过期。
 * @param {unknown} raw
 */
function parseDurationMs(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value === '') throw new Error('--expires-in 需要时长，如 7d / 24h / 0');
  if (value === '0') return 0;
  const match = /^(\d+)([mhd])$/.exec(value);
  if (!match) throw new Error(`无法解析时长 ${JSON.stringify(String(raw))}（示例：30m / 24h / 7d / 0）`);
  const amount = Number(match[1]);
  const unit = match[2];
  const factor = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return amount * factor;
}

/** @param {Record<string, any>} flags */
function resolveGroupFileFromFlags(flags) {
  const { config } = buildConfig(flags);
  return config.group.file;
}

/** @param {Record<string, any>} flags @param {string[]} positionals */
async function runInviteCommand(flags, positionals) {
  const action = positionals[1];
  const json = flags.json === true;
  const file = resolveGroupFileFromFlags(flags);

  if (!['create', 'list', 'revoke'].includes(action)) {
    throw new Error(`unknown invite command ${JSON.stringify(action ?? '')}; expected "invite create|list|revoke"`);
  }

  if (action === 'create') {
    const note = typeof flags.note === 'string' ? flags.note : '';
    const maxUses = flags['max-uses'] === undefined ? undefined : Number(flags['max-uses']);
    const expiresInMs = flags['expires-in'] === undefined ? undefined : parseDurationMs(flags['expires-in']);
    const invite = createInvite(file, { note, maxUses, expiresInMs });
    if (json) {
      console.log(JSON.stringify({ ...invite, groupFile: file }));
      return;
    }
    console.log(`Invite ID  : ${invite.inviteId}`);
    console.log(`Invite code: ${invite.code}`);
    if (invite.note) console.log(`Note       : ${invite.note}`);
    console.log(`Max uses   : ${invite.maxUses}`);
    console.log(`Expires    : ${invite.expiresAt ? new Date(invite.expiresAt).toISOString() : 'never'}`);
    console.log('');
    console.log('把这个邀请码交给要加入的群成员（也可在后台/`invite list` 再查看；不要发到公开渠道）。');
    console.log(`Group file : ${file} (0600)`);
    return;
  }

  if (action === 'list') {
    const invites = listInvites(file);
    if (json) {
      console.log(JSON.stringify({ groupFile: file, invites }, null, 2));
      return;
    }
    if (invites.length === 0) {
      console.log(`No invites in ${file}`);
      return;
    }
    console.log('inviteId              code                                         used max expires                note');
    for (const invite of invites) {
      const expires = invite.expiresAt ? new Date(invite.expiresAt).toISOString() : 'never';
      const status = invite.revoked ? 'REVOKED' : invite.expired ? 'EXPIRED' : '';
      const code = invite.code ?? '（旧邀请码，不可显示）';
      console.log(
        `${invite.inviteId.padEnd(21)} ${code.padEnd(43)} ${String(invite.used).padEnd(4)} ${String(invite.maxUses).padEnd(3)} ${expires.padEnd(22)} ${invite.note}${status ? ` [${status}]` : ''}`,
      );
    }
    return;
  }

  const key = positionals[2];
  if (key === undefined || key === '') throw new Error('invite revoke requires <inviteId|code>');
  const revoked = revokeInvite(file, key);
  if (json) {
    console.log(JSON.stringify({ revoked, inviteIdOrCode: key, groupFile: file }));
    if (!revoked) process.exitCode = 1;
  } else if (revoked) {
    console.log(`Revoked invite ${key}.`);
  } else {
    console.error(`No invite found for ${JSON.stringify(key)} in ${file}`);
    process.exitCode = 1;
  }
}

/** @param {Record<string, any>} flags @param {string[]} positionals */
async function runHostCommand(flags, positionals) {
  const action = positionals[1];
  const json = flags.json === true;
  const file = resolveGroupFileFromFlags(flags);

  if (!['list', 'revoke'].includes(action)) {
    throw new Error(`unknown host command ${JSON.stringify(action ?? '')}; expected "host list|revoke <hostId>"`);
  }

  if (action === 'list') {
    const hosts = listHosts(file);
    if (json) {
      console.log(JSON.stringify({ groupFile: file, hosts }, null, 2));
      return;
    }
    if (hosts.length === 0) {
      console.log(`No hosts in ${file}`);
      return;
    }
    console.log('hostId                  name                     port    created              status');
    for (const host of hosts) {
      const created = host.createdAt ? new Date(host.createdAt).toISOString() : '-';
      const status = host.revoked ? 'REVOKED' : 'active';
      console.log(`${host.hostId.padEnd(24)} ${String(host.hostName || '-').padEnd(24)} ${String(host.mobilePort).padEnd(7)} ${created.padEnd(20)} ${status}`);
    }
    return;
  }

  const hostId = positionals[2];
  if (hostId === undefined || hostId === '') throw new Error('host revoke requires <hostId>');
  const revoked = revokeHost(file, hostId);
  if (json) {
    console.log(JSON.stringify({ hostId: String(hostId).trim().toLowerCase(), revoked, groupFile: file }));
    if (!revoked) process.exitCode = 1;
  } else if (revoked) {
    console.log(`Revoked host "${String(hostId).trim().toLowerCase()}".`);
    console.log('撤销后该主机的 host token 失效：已建立的控制连接在下一次心跳/重连时被拒绝。');
  } else {
    console.error(`No host found for ${JSON.stringify(hostId)} in ${file}`);
    process.exitCode = 1;
  }
}

/** @param {Record<string, any>} flags */
function runAdminTokenCommand(flags) {
  const { config } = buildConfig(flags);
  const group = config.group && typeof config.group === 'object' ? config.group : {};
  const tokenFile = group.adminTokenFile ?? (typeof group.file === 'string' && group.file !== '' ? join(dirname(group.file), 'admin-token') : undefined);
  const info = ensureAdminToken({ token: group.adminToken, tokenFile });
  if (flags.json === true) {
    console.log(JSON.stringify({ token: info.token, source: info.generated ? 'generated' : (info.file ? 'file' : 'config'), tokenFile: info.file ?? null }));
    return;
  }
  console.log(`Admin token: ${info.token}`);
  if (info.file) console.log(`Token file : ${info.file} (0600)`);
  console.log('打开后台：https://<relayDomain>:<adminPort>/__admin/ 并粘贴上面的 token');
}

/** @param {Record<string, any>} flags @param {string[]} positionals */
async function runRelay(flags) {
  const { config, configPath } = buildConfig(flags);
  const relay = await startRelay(config);
  const logger = config.logger;

  if (config.dev && !config.tls) {
    logger.warn('DEV MODE: control plane is ws:// (plaintext, host tokens not protected). Never expose this to the internet.');
  }
  if (configPath) logger.info(`config file: ${configPath}`);
  logger.info(`health check: http://127.0.0.1:${relay.httpPort}/healthz`);
  logger.info(`group file: ${config.group.file}`);
  if (relay.edgePort) logger.info(`edge TLS: :${relay.edgePort} (wildcard cert, phone traffic)`);
  logger.info(`registration API: POST ${GROUP_REGISTER_PATH} on ${config.group.apiPort !== undefined ? `api plane :${relay.groupApiPort}` : `control plane :${relay.controlPort}`}`);
  if (config.group.mobilePort) logger.info(`mobile port (下发到主机二维码) = ${config.group.mobilePort}`);

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`received ${signal}, shutting down`);
    try {
      await relay.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

async function main(argv) {
  const { flags, positionals } = parseArgs(argv);

  if (flags.help === true) {
    console.log(HELP);
    return;
  }
  if (flags.version === true) {
    console.log('dsh-remote-relay 0.4.0');
    return;
  }
  if (positionals[0] === 'invite') {
    await runInviteCommand(flags, positionals);
    return;
  }
  if (positionals[0] === 'host') {
    await runHostCommand(flags, positionals);
    return;
  }
  if (positionals[0] === 'admin-token') {
    runAdminTokenCommand(flags);
    return;
  }
  if (positionals[0] === 'token') {
    throw new Error('token 命令属于 classic 单机模式，已在 0.3.0 删除；群体版主机请用 invite create / host list|revoke');
  }
  if (positionals.length > 0) {
    throw new Error(`unknown command: ${positionals.join(' ')} (try --help)`);
  }
  await runRelay(flags);
}

main(process.argv.slice(2)).catch((err) => {
  console.error(`relay: ${err && err.message ? err.message : String(err)}`);
  process.exitCode = 1;
});
