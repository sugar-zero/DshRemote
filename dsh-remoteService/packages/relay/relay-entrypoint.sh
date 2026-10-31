#!/bin/sh
# Relay 容器入口：在启动 relay 前，根据 .env 自动确保 host token 存在。
#
#   RELAY_HOST_ID      必填，例如 h_ab12cd34
#   RELAY_HOST_TOKEN   可选；若设置，则直接用该 token（与主机插件保持一致）
#                      未设置时自动生成随机 token，并写入 /data/host-token.txt
#
# 已存在 token 时不会自动轮换，避免每次重启把主机踢下线。
set -eu

cd /app 2>/dev/null || true   # 本地测试直接跑脚本时可能没有 /app（镜像内一定存在）

# 解析显式 --config <path>（group 模式首次启动可据此自动生成配置文件）
CONFIG_PATH=""
if [ "$#" -gt 0 ]; then
  prev=""
  for arg in "$@"; do
    if [ "$prev" = "--config" ]; then
      CONFIG_PATH="$arg"
    fi
    prev="$arg"
  done
fi

# 群体服务版（A 模式）：主机通过邀请码自助注册，不再需要预置 RELAY_HOST_ID/token。
# 配置文件缺失时按 .env 自动生成（只需 RELAY_DOMAIN + 证书；已存在则绝不覆盖）。
if [ "${RELAY_MODE:-}" = "group" ] || [ -n "${RELAY_GROUP_FILE:-}" ]; then
  echo "relay-entrypoint: group 模式（主机自助注册，跳过 host token 预置）"

  if [ -n "$CONFIG_PATH" ] && [ ! -f "$CONFIG_PATH" ]; then
    if [ -z "${RELAY_DOMAIN:-}" ]; then
      echo "relay-entrypoint: 缺少 RELAY_DOMAIN，无法自动生成配置文件。" >&2
      echo "  请在 .env.group / .env 里设置 RELAY_DOMAIN=relay.example.com" >&2
      exit 1
    fi

    # 证书默认路径：控制面 <domain>，边缘通配 wildcard；前两者可用环境变量覆盖
    : "${RELAY_TLS_CERT_FILE:=/data/certs/${RELAY_DOMAIN}/fullchain.pem}"
    : "${RELAY_TLS_KEY_FILE:=/data/certs/${RELAY_DOMAIN}/privkey.pem}"
    : "${RELAY_GROUP_EDGE_CERT_FILE:=/data/certs/wildcard/fullchain.pem}"
    : "${RELAY_GROUP_EDGE_KEY_FILE:=/data/certs/wildcard/privkey.pem}"
    : "${RELAY_GROUP_FILE:=/data/group.json}"
    : "${RELAY_GROUP_EDGE_PORT:=443}"
    : "${RELAY_GROUP_ADMIN_TOKEN_FILE:=/data/admin-token}"
    : "${RELAY_GROUP_SIGNING_KEY_FILE:=/data/signing-key.pem}"
    # 上面的默认值要 export 给 node 生成器（否则 tls 路径会是空对象）
    export RELAY_TLS_CERT_FILE RELAY_TLS_KEY_FILE
    export RELAY_GROUP_EDGE_CERT_FILE RELAY_GROUP_EDGE_KEY_FILE
    export RELAY_GROUP_FILE RELAY_GROUP_EDGE_PORT
    export RELAY_GROUP_ADMIN_TOKEN_FILE RELAY_GROUP_SIGNING_KEY_FILE

    missing_cert=""
    for cert in "$RELAY_TLS_CERT_FILE" "$RELAY_TLS_KEY_FILE" "$RELAY_GROUP_EDGE_CERT_FILE" "$RELAY_GROUP_EDGE_KEY_FILE"; do
      if [ ! -f "$cert" ]; then
        echo "relay-entrypoint: 证书缺失：$cert" >&2
        missing_cert="1"
      fi
    done
    if [ -n "$missing_cert" ]; then
      echo "  请放置证书（容器内路径；./data 挂载到 /data）：" >&2
      echo "    控制面：data/certs/${RELAY_DOMAIN}/{fullchain.pem,privkey.pem}" >&2
      echo "    边缘通配：data/certs/wildcard/{fullchain.pem,privkey.pem}" >&2
      echo "  或用 RELAY_TLS_CERT_FILE / RELAY_GROUP_EDGE_CERT_FILE 等变量指定。" >&2
      exit 1
    fi

    mkdir -p "$(dirname "$CONFIG_PATH")"
    GENERATED_CONFIG="$CONFIG_PATH" node --input-type=module <<'NODE'
import { chmodSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const env = process.env;
const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};
const config = {
  domain: env.RELAY_DOMAIN,
  mode: 'group',
  dataPort: 443,
  controlPort: num(env.RELAY_CONTROL_PORT, 8443),
  httpPort: num(env.RELAY_HTTP_PORT, 80),
  dataHost: env.RELAY_DATA_HOST || '0.0.0.0',
  tls: { certFile: env.RELAY_TLS_CERT_FILE, keyFile: env.RELAY_TLS_KEY_FILE },
  tokensFile: env.RELAY_TOKENS_FILE || '/data/tokens.json',
  logLevel: env.RELAY_LOG_LEVEL || 'info',
  group: {
    file: env.RELAY_GROUP_FILE || '/data/group.json',
    mobilePort: num(env.RELAY_GROUP_MOBILE_PORT, 443),
    apiPort: num(env.RELAY_GROUP_API_PORT, 9443),
    apiBind: env.RELAY_GROUP_API_BIND || '0.0.0.0',
    adminPort: num(env.RELAY_GROUP_ADMIN_PORT, 9444),
    adminBind: env.RELAY_GROUP_ADMIN_BIND || '0.0.0.0',
    publicControlPort: num(env.RELAY_GROUP_PUBLIC_CONTROL_PORT, 8443),
    edge: {
      enabled: true,
      port: num(env.RELAY_GROUP_EDGE_PORT, 443),
      tls: { certFile: env.RELAY_GROUP_EDGE_CERT_FILE, keyFile: env.RELAY_GROUP_EDGE_KEY_FILE },
    },
    auth: { signingKeyFile: env.RELAY_GROUP_SIGNING_KEY_FILE || '/data/signing-key.pem' },
    adminTokenFile: env.RELAY_GROUP_ADMIN_TOKEN_FILE || '/data/admin-token',
    registration: { enabled: true },
  },
};
writeFileSync(env.GENERATED_CONFIG, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
chmodSync(env.GENERATED_CONFIG, 0o600);
NODE
    echo "relay-entrypoint: 已根据 .env 生成 ${CONFIG_PATH}（已存在则不会覆盖）"
    echo "relay-entrypoint: 需要高级配置可直接编辑 ${CONFIG_PATH}（模板见 server/group/relay.group.example.json）"
  fi

  if [ "$#" -gt 0 ]; then
    exec "$@"
  fi
  exec node packages/relay/bin/relay.js
fi

# classic：显式 --config 缺失时给出可操作提示（classic 通常用纯环境变量，不挂配置文件）
if [ -n "$CONFIG_PATH" ] && [ ! -f "$CONFIG_PATH" ]; then
  echo "relay-entrypoint: 找不到配置文件：$CONFIG_PATH" >&2
  exit 1
fi

if [ -z "${RELAY_HOST_ID:-}" ]; then
  echo "relay-entrypoint: RELAY_HOST_ID 未设置，请在 .env 中配置" >&2
  exit 1
fi

export RELAY_HOST_ID
export RELAY_HOST_TOKEN="${RELAY_HOST_TOKEN:-}"
export RELAY_TOKENS_FILE="${RELAY_TOKENS_FILE:-/data/tokens.json}"

node --input-type=module <<'NODE'
import { chmodSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import process from 'node:process';
import {
  normalizeHostId,
  readTokenStore,
  writeTokenStore,
} from './packages/relay/lib/tokens.js';

const hostId = normalizeHostId(process.env.RELAY_HOST_ID);
const provided = String(process.env.RELAY_HOST_TOKEN ?? '').trim();
const file = process.env.RELAY_TOKENS_FILE || '/data/tokens.json';
const store = readTokenStore(file);
const existing = store.tokens[hostId];

if (existing) {
  if (provided && existing.token !== provided) {
    console.error(
      `relay-entrypoint: ${hostId} 已有 token，与 RELAY_HOST_TOKEN 不一致；` +
        '不会自动轮换。需要轮换请先删除 data/tokens.json 中该条目或使用 token create。',
    );
  }
  process.exit(0);
}

const token = provided || randomBytes(32).toString('base64url');
store.tokens[hostId] = {
  token,
  createdAt: Date.now(),
  updatedAt: Date.now(),
};
writeTokenStore(file, store);

if (provided) {
  console.log(`relay-entrypoint: 已根据 RELAY_HOST_TOKEN 为 ${hostId} 写入 token`);
} else {
  const tokenFile = '/data/host-token.txt';
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  chmodSync(tokenFile, 0o600);
  console.log(`relay-entrypoint: 已自动生成 ${hostId} 的 token（仅本次）`);
  console.log(`relay-entrypoint: token 已写入 ${tokenFile}`);
  console.log(`relay-entrypoint: RELAY_HOST_TOKEN=${token}`);
}
NODE

if [ "$#" -gt 0 ]; then
  exec "$@"
fi
exec node packages/relay/bin/relay.js
