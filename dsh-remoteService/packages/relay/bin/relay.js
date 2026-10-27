#!/usr/bin/env node
/**
 * dsh-remote-relay CLI。
 *
 *   node bin/relay.js --config /etc/dsh-relay/relay.json
 *   node bin/relay.js --dev --domain relay.test
 *   node bin/relay.js token create h_ab12cd34 --config ./relay.json
 *   node bin/relay.js token list / revoke ...
 *
 * 配置优先级：内置默认值 < config 文件 < 环境变量 < 命令行参数。
 * token 文件默认与 config 同目录（tokens.json，0600）；无 --config 时用当前目录。
 */

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';
import { GROUP_REGISTER_PATH } from 'dsh-remote-protocol';
import {
  createConsoleLogger,
  createHostToken,
  createInvite,
  ensureAdminToken,
  defaultGroupFile,
  defaultTokensFile,
  listHosts,
  listHostTokens,
  listInvites,
  revokeHost,
  revokeHostToken,
  revokeInvite,
  startRelay,
} from '../index.js';

const FLAGS_WITH_VALUE = new Set([
  'config',
  'domain',
  'data-port',
  'control-port',
  'http-port',
  'data-host',
  'tokens-file',
  'cert-file',
  'key-file',
  'log-level',
  // 群体服务版（A 模式）
  'mode',
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

const HELP = `dsh-remote-relay — 自托管中继 (DSH remote access)

用法:
  node bin/relay.js [options]                   启动 relay（classic：443 透传 / 80 跳转 / 8443 控制面）
  node bin/relay.js --mode group [options]      启动 relay（group 群体服务版：控制面 + 自助注册）
  node bin/relay.js token create <hostId>       classic：为 hostId 签发 token（轮换会覆盖旧 token）
  node bin/relay.js token list                   classic：列出已签发 host（token 掩码）
  node bin/relay.js token revoke <hostId>        classic：吊销 token
  node bin/relay.js invite create [options]     group：生成自助注册邀请码（只打印一次）
  node bin/relay.js invite list                 group：列出邀请（不含明文 code）
  node bin/relay.js invite revoke <id|code>     group：撤销邀请
  node bin/relay.js host list                   group：列出已注册主机
  node bin/relay.js host revoke <hostId>        group：撤销主机（吊销其 token）
  node bin/relay.js admin-token                 group：打印部署方后台 admin token（--json 可机器读）
  node bin/relay.js --help                      显示本帮助

群体版部署方后台:
  启动 group 模式后在浏览器打开 https://<domain>:<controlPort>/__admin ，
  粘贴 admin token 即可管理邀请码/主机。token 未配置时首次启动自动生成到
  <group.json 目录>/admin-token（0600），也可用 --admin-token / RELAY_ADMIN_TOKEN 显式指定。

启动参数:
  --config <path>        JSON 配置文件（tokensFile/group.file/certFile 等相对路径基于该文件目录解析）
  --dev                  开发/测试模式：无 TLS 时允许 ws:// 控制面（绝不能用于公网）
  --mode <mode>          classic（默认，B2 盲中继）| group（群体服务版 A 模式）
  --domain <domain>      根域名，如 relay.example.com（必填；<hostId>.<domain> 走 DNS 泛解析）
  --data-port <port>     TLS 透传端口（默认 443；group 模式后续由边缘 TLS 接管）
  --control-port <port>  控制面端口（默认 8443；group 注册接口也在此端口）
  --http-port <port>     HTTP 301 端口（默认 80）
  --data-host <addr>     监听地址（默认 0.0.0.0）
  --tokens-file <path>   classic：host token 文件（默认 <config 目录>/tokens.json）
  --group-file <path>    group：注册状态文件（默认 <config 目录>/group.json）
  --cert-file <path>     控制面 TLS 证书链（生产必填，除非 --dev）
  --key-file <path>      控制面 TLS 私钥（生产必填，除非 --dev）
  --log-level <level>    debug | info | warn | error | silent（默认 info）
  --json                 token/invite/host 命令输出 JSON（便于脚本解析）
  -h, --help             显示帮助

邀请码参数（invite create）:
  --note <text>          备注（最长 120 字符）
  --max-uses <n>         可用次数（默认 1，最大 1000）
  --expires-in <dur>     有效期，如 30m / 24h / 7d / 0（0 = 永不过期；默认 7d）

环境变量（覆盖 config 文件，被命令行参数覆盖）:
  RELAY_DOMAIN RELAY_MODE RELAY_DEV RELAY_DATA_PORT RELAY_CONTROL_PORT RELAY_HTTP_PORT
  RELAY_DATA_HOST RELAY_TOKENS_FILE RELAY_GROUP_FILE RELAY_GROUP_MOBILE_PORT
  RELAY_GROUP_API_PORT RELAY_GROUP_API_BIND RELAY_GROUP_ADMIN_PORT RELAY_GROUP_ADMIN_BIND
  RELAY_GROUP_PUBLIC_CONTROL_PORT
  RELAY_TLS_CERT_FILE RELAY_TLS_KEY_FILE RELAY_LOG_LEVEL
  RELAY_PUSH_ENDPOINT RELAY_PUSH_ACCESS_TOKEN RELAY_PUSH_TITLE RELAY_PUSH_BODY

示例:
  # classic 生产（控制面用 relay.example.com 的 Let's Encrypt 证书，端口 80 留给 301）
  node bin/relay.js --config /etc/dsh-relay/relay.json

  # group 本地开发（ws:// 控制面 + 临时端口 0）
  node bin/relay.js --mode group --dev --domain relay.test --control-port 0 --group-file ./group.json

  # group：发邀请码（只打印一次；只给要加入的群成员）
  node bin/relay.js invite create --note "朋友A" --expires-in 7d --config /etc/dsh-relay/relay.json

安全说明:
  - classic：中继不终止 TLS、不持有主机子域证书私钥，看不到明文；日志不记录内容/凭据。
  - group：A 模式下 relay 终止 TLS（部署方可见明文，风险与责任由部署方承担）；
    注册接口只接受有效邀请码，group.json 只存 invite/token 的 SHA-256（0600）。
  - token create / invite create 只在 stdout 打印一次明文，请立即交给主机/群成员。
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
  if (config.tokensFile) config.tokensFile = resolveFromConfigDir(config.tokensFile);
  if (config.group && typeof config.group === 'object' && typeof config.group.file === 'string' && config.group.file !== '') {
    config.group = { ...config.group, file: resolveFromConfigDir(config.group.file) };
  }
  if (config.group && typeof config.group === 'object' && typeof config.group.adminTokenFile === 'string' && config.group.adminTokenFile !== '') {
    config.group = { ...config.group, adminTokenFile: resolveFromConfigDir(config.group.adminTokenFile) };
  }
  if (config.group && typeof config.group === 'object' && config.group.auth && typeof config.group.auth === 'object'
    && typeof config.group.auth.signingKeyFile === 'string' && config.group.auth.signingKeyFile !== '') {
    config.group = {
      ...config.group,
      auth: { ...config.group.auth, signingKeyFile: resolveFromConfigDir(config.group.auth.signingKeyFile) },
    };
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
  if (env.RELAY_DATA_PORT) config.dataPort = env.RELAY_DATA_PORT;
  if (env.RELAY_CONTROL_PORT) config.controlPort = env.RELAY_CONTROL_PORT;
  if (env.RELAY_HTTP_PORT) config.httpPort = env.RELAY_HTTP_PORT;
  if (env.RELAY_DATA_HOST) config.dataHost = env.RELAY_DATA_HOST;
  if (env.RELAY_TOKENS_FILE) config.tokensFile = env.RELAY_TOKENS_FILE;
  if (env.RELAY_GROUP_FILE) {
    config.group = { ...(config.group && typeof config.group === 'object' ? config.group : {}) };
    config.group.file = env.RELAY_GROUP_FILE;
  }
  if (env.RELAY_GROUP_MOBILE_PORT) {
    config.group = { ...(config.group && typeof config.group === 'object' ? config.group : {}) };
    config.group.mobilePort = env.RELAY_GROUP_MOBILE_PORT;
  }
  if (env.RELAY_GROUP_API_PORT || env.RELAY_GROUP_API_BIND
    || env.RELAY_GROUP_ADMIN_PORT || env.RELAY_GROUP_ADMIN_BIND) {
    config.group = { ...(config.group && typeof config.group === 'object' ? config.group : {}) };
    if (env.RELAY_GROUP_API_PORT) config.group.apiPort = env.RELAY_GROUP_API_PORT;
    if (env.RELAY_GROUP_API_BIND) config.group.apiBind = env.RELAY_GROUP_API_BIND;
    if (env.RELAY_GROUP_ADMIN_PORT) config.group.adminPort = env.RELAY_GROUP_ADMIN_PORT;
    if (env.RELAY_GROUP_ADMIN_BIND) config.group.adminBind = env.RELAY_GROUP_ADMIN_BIND;
  }
  if (env.RELAY_GROUP_PUBLIC_CONTROL_PORT) {
    config.group = { ...(config.group && typeof config.group === 'object' ? config.group : {}) };
    config.group.publicControlPort = env.RELAY_GROUP_PUBLIC_CONTROL_PORT;
  }
  if (env.RELAY_MODE) config.mode = env.RELAY_MODE;
  if (env.RELAY_ADMIN_TOKEN || env.RELAY_ADMIN_TOKEN_FILE) {
    config.group = { ...(config.group && typeof config.group === 'object' ? config.group : {}) };
    if (env.RELAY_ADMIN_TOKEN) config.group.adminToken = env.RELAY_ADMIN_TOKEN;
    if (env.RELAY_ADMIN_TOKEN_FILE) config.group.adminTokenFile = env.RELAY_ADMIN_TOKEN_FILE;
  }
  if (env.RELAY_LOG_LEVEL) config.logLevel = env.RELAY_LOG_LEVEL;
  if (env.RELAY_PUSH_ENDPOINT || env.RELAY_PUSH_ACCESS_TOKEN || env.RELAY_PUSH_TITLE || env.RELAY_PUSH_BODY) {
    config.push = { ...(config.push && typeof config.push === 'object' ? config.push : {}) };
    if (env.RELAY_PUSH_ENDPOINT) config.push.endpoint = env.RELAY_PUSH_ENDPOINT;
    if (env.RELAY_PUSH_ACCESS_TOKEN) config.push.accessToken = env.RELAY_PUSH_ACCESS_TOKEN;
    if (env.RELAY_PUSH_TITLE) config.push.title = env.RELAY_PUSH_TITLE;
    if (env.RELAY_PUSH_BODY) config.push.body = env.RELAY_PUSH_BODY;
  }
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
  if (flags['data-port'] !== undefined) config.dataPort = flags['data-port'];
  if (flags['control-port'] !== undefined) config.controlPort = flags['control-port'];
  if (flags['http-port'] !== undefined) config.httpPort = flags['http-port'];
  if (flags['data-host'] !== undefined) config.dataHost = flags['data-host'];
  if (flags['tokens-file'] !== undefined) config.tokensFile = flags['tokens-file'];
  if (flags['group-file'] !== undefined) {
    config.group = { ...(config.group && typeof config.group === 'object' ? config.group : {}) };
    config.group.file = flags['group-file'];
  }
  if (flags.mode !== undefined) config.mode = flags.mode;
  if (flags['admin-token'] !== undefined || flags['admin-token-file'] !== undefined) {
    config.group = { ...(config.group && typeof config.group === 'object' ? config.group : {}) };
    if (flags['admin-token'] !== undefined) config.group.adminToken = flags['admin-token'];
    if (flags['admin-token-file'] !== undefined) config.group.adminTokenFile = flags['admin-token-file'];
  }
  if (flags['group-api-port'] !== undefined || flags['group-api-bind'] !== undefined
    || flags['group-admin-port'] !== undefined || flags['group-admin-bind'] !== undefined) {
    config.group = { ...(config.group && typeof config.group === 'object' ? config.group : {}) };
    if (flags['group-api-port'] !== undefined) config.group.apiPort = flags['group-api-port'];
    if (flags['group-api-bind'] !== undefined) config.group.apiBind = flags['group-api-bind'];
    if (flags['group-admin-port'] !== undefined) config.group.adminPort = flags['group-admin-port'];
    if (flags['group-admin-bind'] !== undefined) config.group.adminBind = flags['group-admin-bind'];
  }
  if (flags['group-public-control-port'] !== undefined) {
    config.group = { ...(config.group && typeof config.group === 'object' ? config.group : {}) };
    config.group.publicControlPort = flags['group-public-control-port'];
  }
  if (flags['log-level'] !== undefined) config.logLevel = flags['log-level'];
  if (flags['cert-file'] !== undefined || flags['key-file'] !== undefined) {
    config.tls = { ...(config.tls ?? {}) };
    if (flags['cert-file'] !== undefined) config.tls.certFile = flags['cert-file'];
    if (flags['key-file'] !== undefined) config.tls.keyFile = flags['key-file'];
  }
}

/**
 * 合并 config 文件 / 环境变量 / 命令行参数，补齐默认 tokens 文件。
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

  if (!config.tokensFile) config.tokensFile = defaultTokensFile(configPath);
  config.tokensFile = resolve(process.cwd(), config.tokensFile);
  if (!config.group || typeof config.group !== 'object' || Array.isArray(config.group)) config.group = {};
  if (!config.group.file) config.group.file = defaultGroupFile(configPath);
  config.group.file = resolve(process.cwd(), config.group.file);
  if (config.tls && typeof config.tls === 'object' && config.tls.cert === undefined) {
    if (config.tls.certFile) config.tls.certFile = resolve(process.cwd(), config.tls.certFile);
    if (config.tls.keyFile) config.tls.keyFile = resolve(process.cwd(), config.tls.keyFile);
  }
  if (!config.logger) config.logger = createConsoleLogger(config.logLevel ?? 'info');
  return { config, configPath };
}

/** @param {Record<string, any>} flags @param {string[]} positionals */
async function runTokenCommand(flags, positionals) {
  const action = positionals[1];
  const hostIdRaw = positionals[2];
  const { config } = buildConfig(flags);
  const tokensFile = config.tokensFile;
  const json = flags.json === true;

  if (!['create', 'list', 'revoke'].includes(action)) {
    throw new Error(`unknown token command ${JSON.stringify(action ?? '')}; expected "token create|list|revoke <hostId>"`);
  }
  if (action !== 'list' && (hostIdRaw === undefined || hostIdRaw === '')) {
    throw new Error(`token ${action} requires a hostId, e.g. "token ${action} h_ab12cd34"`);
  }

  if (action === 'create') {
    const result = createHostToken(tokensFile, hostIdRaw);
    if (json) {
      console.log(JSON.stringify({ ...result, tokensFile }));
      return;
    }
    console.log(`Host ID   : ${result.hostId}`);
    console.log(`Token     : ${result.token}`);
    console.log('');
    console.log(result.rotated
      ? 'NOTE: an existing token for this host was rotated; the old token is now invalid.'
      : 'Store this token in the host plugin now — it is shown only once.');
    console.log(`Tokens file: ${tokensFile} (0600)`);
    return;
  }

  if (action === 'list') {
    const hosts = listHostTokens(tokensFile);
    if (json) {
      console.log(JSON.stringify({ tokensFile, hosts }, null, 2));
      return;
    }
    if (hosts.length === 0) {
      console.log(`No host tokens in ${tokensFile}`);
      return;
    }
    console.log(`hostId                 token              createdAt            updatedAt`);
    for (const host of hosts) {
      const created = host.createdAt ? new Date(host.createdAt).toISOString() : '-';
      const updated = host.updatedAt ? new Date(host.updatedAt).toISOString() : '-';
      console.log(`${host.hostId.padEnd(22)} ${host.maskedToken.padEnd(18)} ${created.padEnd(20)} ${updated}`);
    }
    return;
  }

  // revoke
  const revoked = revokeHostToken(tokensFile, hostIdRaw);
  if (json) {
    console.log(JSON.stringify({ hostId: String(hostIdRaw).trim().toLowerCase(), revoked, tokensFile }));
    if (!revoked) process.exitCode = 1;
  } else if (revoked) {
    console.log(`Revoked token for host "${String(hostIdRaw).trim().toLowerCase()}".`);
    console.log('An already-connected host keeps its connection until it reconnects.');
  } else {
    console.error(`No token found for host "${hostIdRaw}" in ${tokensFile}`);
    process.exitCode = 1;
  }
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
    console.log('把这个邀请码交给要加入的群成员（只显示一次；不要发到公开渠道）。');
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
    console.log('inviteId              used  max  expires                note');
    for (const invite of invites) {
      const expires = invite.expiresAt ? new Date(invite.expiresAt).toISOString() : 'never';
      const status = invite.revoked ? 'REVOKED' : invite.expired ? 'EXPIRED' : '';
      console.log(
        `${invite.inviteId.padEnd(21)} ${String(invite.used).padEnd(5)} ${String(invite.maxUses).padEnd(4)} ${expires.padEnd(22)} ${invite.note}${status ? ` [${status}]` : ''}`,
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
    console.log('已建立/后续连接在该主机 token 失效后拒绝（隧道接入后即时断链；P1 切片暂无隧道）。');
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
  console.log('打开后台：https://<relayDomain>:<controlPort>/__admin/ 并粘贴上面的 token');
}

/** @param {Record<string, any>} flags @param {string[]} positionals */
async function runRelay(flags) {
  const { config } = buildConfig(flags);
  const relay = await startRelay(config);
  const logger = config.logger;

  if (config.dev && !config.tls) {
    logger.warn('DEV MODE: control plane is ws:// (plaintext, host tokens not protected). Never expose this to the internet.');
  }
  logger.info(`health check: http://127.0.0.1:${relay.httpPort}/healthz`);
  logger.info(`tokens file: ${config.tokensFile}`);
  if (config.mode === 'group') {
    logger.info(`group mode: POST ${GROUP_REGISTER_PATH} on control plane :${relay.controlPort}; group file: ${config.group.file}`);
    if (config.group.mobilePort) logger.info(`group mode: mobile port (下发到主机二维码) = ${config.group.mobilePort}`);
  }

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
    console.log('dsh-remote-relay 0.2.1');
    return;
  }
  if (positionals[0] === 'token') {
    await runTokenCommand(flags, positionals);
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
  if (positionals.length > 0) {
    throw new Error(`unknown command: ${positionals.join(' ')} (try --help)`);
  }
  await runRelay(flags);
}

main(process.argv.slice(2)).catch((err) => {
  console.error(`relay: ${err && err.message ? err.message : String(err)}`);
  process.exitCode = 1;
});
