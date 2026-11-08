#!/usr/bin/env node
/**
 * dsh-remote-push-hub CLI —— 官方推送 hub 的服务入口（0.3.0 起只有 serve）。
 *
 *   node packages/push-hub/bin/push-hub.js serve --config /data/config/hub.json
 *   node packages/push-hub/bin/push-hub.js --help
 *
 * 配置优先级：内置默认值 < hub.json < `HUB_*` 环境变量 < 命令行参数（--port/--listen-host/--log-level）。
 * `--config` 缺省时读 HUB_CONFIG；两者都没有但当前目录有 hub.json 就用它；否则纯环境变量模式。
 *
 * hub 只服务 R2（官方 App 设备登记 /v1/enroll* + 主机拿 device credential 直连 /v1/push）：
 * 没有 relay 凭据、没有 relay 转发通道、没有 hub 侧可写 store，因此也不再需要任何管理子命令。
 *
 * 安全：设备 credential 由 hub 的 Ed25519 签名 key 签发（私钥只在部署方 /data，0600，自动生成）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  HUB_DEFAULT_CONFIG_FILE,
  createConsoleLogger,
  createHubServer,
  loadHubConfig,
} from '../index.js';

/** 需要取值的命令行参数。 */
const FLAGS_WITH_VALUE = new Set(['config', 'port', 'listen-host', 'log-level']);

const HELP = `dsh-remote-push-hub —— DSH 群体服务版官方推送 hub (DSH remote access)

用法:
  node bin/push-hub.js serve [options]                  启动 hub（默认命令）
  node bin/push-hub.js --help                           显示本帮助
  node bin/push-hub.js --version                        显示版本

serve 参数:
  --config <path>        hub.json 路径（缺省：HUB_CONFIG，或当前目录的 hub.json；都不存在则只用环境变量）
  --port <port>          覆盖监听端口（默认 9445；0 = 临时端口，仅测试）
  --listen-host <addr>   覆盖监听地址（默认 127.0.0.1；容器内通常 0.0.0.0）
  --log-level <level>    debug | info | warn | error | silent（默认 info）

环境变量（覆盖 hub.json；命令行参数覆盖环境变量）:
  基础:   HUB_LISTEN_HOST HUB_PORT HUB_LOG_LEVEL
          HUB_TLS_CERT_FILE HUB_TLS_KEY_FILE
  APNs:   HUB_APNS_KEY_FILE HUB_APNS_KEY_ID HUB_APNS_TEAM_ID HUB_APNS_TOPIC
  R2:     HUB_PUBLIC_URL（必填才启用设备直连；credential 的 aud）
          HUB_SIGNING_KEY_FILE（Ed25519 PKCS#8；不存在则首次启动 0600 自动生成）
          HUB_CREDENTIAL_TTL_DAYS HUB_ENROLL_ENABLED HUB_ENROLL_CHALLENGE_TTL_SECONDS
  配额:   HUB_MAX_TOKENS_PER_REQUEST
          HUB_ENROLL_PER_HOUR_PER_IP HUB_ENROLL_PER_HOUR_PER_DEVICE HUB_CHALLENGE_PER_HOUR_PER_IP
          HUB_PUSH_PER_MINUTE_PER_TOKEN HUB_PUSH_PER_DAY_PER_TOKEN HUB_PUSH_PER_MINUTE_PER_CREDENTIAL
          HUB_PUSH_PER_MINUTE_PER_HOST HUB_PUSH_PER_MINUTE_PER_IP HUB_PUSH_PER_MINUTE_GLOBAL

示例:
  # 生产（由前置 nginx 终止 TLS；hub 只发布到宿主回环）
  node bin/push-hub.js serve --config /data/config/hub.json

API:
  GET  /healthz               能力/配额摘要（不含 token/密钥/credential）
  POST /v1/enroll/challenge   官方 App 申请一次性 challenge {devicePublicKey?}
  POST /v1/enroll             P-256 PoP 验签 → 签发 device credential（默认 7 天）
  POST /v1/push               Authorization: Bearer <deviceCredential>
                              body {kind, host?, token, environment?}

安全边界:
  - 只发固定通用文案（turn-end → 「任务已完成」；waiting-answer → 「正在等待你的回答」），
    不接收 title/body/sessionId 等会话内容（schema 直接 400）；
  - /v1/push 只接受 device credential（Bearer 不是合法 credential → 401 invalid_credential），
    hub 不识别 relay，也没有任何 relay 凭据/转发通道；
  - credential 由 hub 的 Ed25519 key 签发并校验（aud/tokenHash/env/bundleId 绑定），
    靠短 TTL（默认 7 天）自然失效；
  - 逐层限流（enroll IP/设备、push token/credential/host/IP/全局），429 带 Retry-After；
  - 设备 token / credential 不落盘、不写日志；日志只记模式 / 计数 / 结果；
  - APNs 私钥只从只读挂载的 .p8 读取（或内联配置），不打印、不进 /healthz、不进推送 payload；
    签名 key 只存部署方 /data（0600），不打印私钥。
`;

/**
 * @param {string[]} argv
 * @returns {{flags: Record<string, string | boolean>, positionals: string[]}}
 */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
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

/** 包版本（不引 JSON import attribute，避免不同 Node 小版本差异）。 */
function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return String(pkg.version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
}

/**
 * 解析配置文件路径：--config > HUB_CONFIG > ./hub.json（存在才用）> 纯环境变量模式。
 * @param {Record<string, string | boolean>} flags
 * @returns {string | undefined}
 */
function resolveConfigPath(flags) {
  if (flags.config !== undefined) {
    if (typeof flags.config !== 'string' || flags.config.trim() === '') {
      throw new Error('--config requires a path');
    }
    return flags.config.trim();
  }
  const fromEnv = process.env.HUB_CONFIG;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
  const fallback = resolve(process.cwd(), HUB_DEFAULT_CONFIG_FILE);
  return existsSync(fallback) ? fallback : undefined;
}

/**
 * 读配置并把命令行覆盖项并入（命令行通过覆盖环境变量实现最高优先级）。
 * @param {Record<string, string | boolean>} flags
 * @returns {{config: object, configPath: string | undefined}}
 */
function loadConfigWithFlags(flags) {
  /** @type {Record<string, string | undefined>} */
  const env = { ...process.env };
  if (flags.port !== undefined) env.HUB_PORT = String(flags.port);
  if (flags['listen-host'] !== undefined) env.HUB_LISTEN_HOST = String(flags['listen-host']);
  if (flags['log-level'] !== undefined) env.HUB_LOG_LEVEL = String(flags['log-level']);
  return loadHubConfig({ configPath: resolveConfigPath(flags), env });
}

/**
 * serve：启动 hub（HTTPS/HTTP + /healthz + /v1/enroll* + /v1/push），SIGINT/SIGTERM 优雅退出。
 * @param {Record<string, string | boolean>} flags
 */
async function runServe(flags) {
  const { config, configPath } = loadConfigWithFlags(flags);
  const logger = createConsoleLogger(config.logLevel, 'push-hub');
  const hub = createHubServer({ config, logger });
  await hub.listen();
  if (configPath) logger.info(`config file: ${configPath}`);
  logger.info(`health check: ${hub.address()?.url ?? ''}/healthz`);

  let shuttingDown = false;
  /** @param {string} signal */
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`received ${signal}, shutting down`);
    try {
      await hub.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

/**
 * @param {string[]} argv
 */
async function main(argv) {
  const { flags, positionals } = parseArgs(argv);

  if (flags.help === true || positionals[0] === 'help') {
    console.log(HELP);
    return;
  }
  if (flags.version === true) {
    console.log(`dsh-remote-push-hub ${readVersion()}`);
    return;
  }

  if (positionals.length > 0 && positionals[0] !== 'serve') {
    throw new Error(`unknown command ${JSON.stringify(positionals[0])}；可用：serve（--help 查看用法）`);
  }
  if (positionals.length > 1) {
    throw new Error(`serve 不接受位置参数：${positionals.slice(1).join(' ')}`);
  }
  await runServe(flags);
}

const isMain = (() => {
  try {
    return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return true;
  }
})();

if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`push-hub: ${error && error.message ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
