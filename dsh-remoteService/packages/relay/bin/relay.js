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
import { dirname, isAbsolute, resolve } from 'node:path';
import process from 'node:process';
import {
  createConsoleLogger,
  createHostToken,
  defaultTokensFile,
  listHostTokens,
  revokeHostToken,
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
]);

const HELP = `dsh-remote-relay — 自托管盲中继 (DSH remote access, 方案 B2)

用法:
  node bin/relay.js [options]                   启动 relay（443 透传 / 80 跳转 / 8443 控制面）
  node bin/relay.js token create <hostId>       为 hostId 签发 token（轮换同一 hostId 会覆盖旧 token）
  node bin/relay.js token list                  列出已签发 host（token 掩码显示）
  node bin/relay.js token revoke <hostId>       吊销 token
  node bin/relay.js --help                      显示本帮助

启动参数:
  --config <path>        JSON 配置文件（tokensFile/certFile 等相对路径基于该文件目录解析）
  --dev                  开发/测试模式：无 TLS 时允许 ws:// 控制面（绝不能用于公网）
  --domain <domain>      根域名，如 relay.example.com（必填；<hostId>.<domain> 走 DNS 泛解析）
  --data-port <port>     TLS 透传端口（默认 443）
  --control-port <port>  控制面端口（默认 8443）
  --http-port <port>     HTTP 301 端口（默认 80）
  --data-host <addr>     监听地址（默认 0.0.0.0）
  --tokens-file <path>   host token 文件（默认 <config 目录>/tokens.json）
  --cert-file <path>     控制面 TLS 证书链（生产必填，除非 --dev）
  --key-file <path>      控制面 TLS 私钥（生产必填，除非 --dev）
  --log-level <level>    debug | info | warn | error | silent（默认 info）
  --json                 token create/list 输出 JSON（便于脚本解析）
  -h, --help             显示帮助

环境变量（覆盖 config 文件，被命令行参数覆盖）:
  RELAY_DOMAIN RELAY_DEV RELAY_DATA_PORT RELAY_CONTROL_PORT RELAY_HTTP_PORT
  RELAY_DATA_HOST RELAY_TOKENS_FILE RELAY_TLS_CERT_FILE RELAY_TLS_KEY_FILE RELAY_LOG_LEVEL

示例:
  # 生产（控制面用 relay.example.com 的 Let's Encrypt 证书，端口 80 留给 301）
  node bin/relay.js --config /etc/dsh-relay/relay.json

  # 本地开发（ws:// 控制面 + 临时端口 0）
  node bin/relay.js --dev --domain relay.test --data-port 0 --control-port 0 --http-port 0

  # 签发主机 token（只打印一次；请写入主机插件配置，勿进日志/仓库）
  HOST_ID=h_ab12cd34
  node bin/relay.js token create "$HOST_ID" --config /etc/dsh-relay/relay.json

安全说明:
  - 中继不终止 TLS、不持有主机子域证书私钥，看不到明文；日志不记录内容/凭据。
  - token create 只在 stdout 打印一次明文 token；tokens.json 权限 0600。
  - 已连接的主机不会因 CLI revoke 立即断开；吊销在其下次重连时生效。
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
  if (flags['data-port'] !== undefined) config.dataPort = flags['data-port'];
  if (flags['control-port'] !== undefined) config.controlPort = flags['control-port'];
  if (flags['http-port'] !== undefined) config.httpPort = flags['http-port'];
  if (flags['data-host'] !== undefined) config.dataHost = flags['data-host'];
  if (flags['tokens-file'] !== undefined) config.tokensFile = flags['tokens-file'];
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
    console.log('dsh-remote-relay 0.1.0');
    return;
  }
  if (positionals[0] === 'token') {
    await runTokenCommand(flags, positionals);
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
