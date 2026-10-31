#!/bin/sh
# Relay 容器入口（群体服务版，A 模式）。
#
# 0.3.0 起 relay 只服务群体版：主机通过邀请码自助注册，不再预置 RELAY_HOST_ID /
# RELAY_HOST_TOKEN，也不再自动生成 /data/tokens.json（classic token 预置已删除）。
#
# 首次启动时若显式给了 --config 且文件不存在，会按 .env 自动生成配置文件
# （0600，已存在则绝不覆盖；需要高级项时再手改该文件）。
#
# 自动生成用到的环境变量：
#   RELAY_DOMAIN                   必填
#   RELAY_TLS_CERT_FILE/KEY        控制面证书（默认 /data/certs/<domain>/fullchain|privkey.pem）
#   RELAY_GROUP_EDGE_CERT_FILE/KEY 边缘通配证书（默认 /data/certs/wildcard/fullchain|privkey.pem）
#   RELAY_GROUP_FILE               注册状态（默认 /data/group.json）
#   RELAY_GROUP_EDGE_PORT          边缘 TLS 端口（默认 443）
#   RELAY_GROUP_ADMIN_TOKEN_FILE   部署方后台 token（默认 /data/admin-token）
#   RELAY_GROUP_SIGNING_KEY_FILE   设备会话签名私钥（默认 /data/signing-key.pem）
set -eu

cd /app 2>/dev/null || true   # 本地测试直接跑脚本时可能没有 /app（镜像内一定存在）

# 解析显式 --config <path>（首次启动可据此自动生成配置文件）
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

echo "relay-entrypoint: group 模式（群体服务版；主机凭邀请码自助注册）"

if [ -n "$CONFIG_PATH" ] && [ ! -f "$CONFIG_PATH" ]; then
  if [ -z "${RELAY_DOMAIN:-}" ]; then
    echo "relay-entrypoint: 缺少 RELAY_DOMAIN，无法自动生成配置文件。" >&2
    echo "  请在 .env / .env.group 里设置 RELAY_DOMAIN=relay.example.com" >&2
    exit 1
  fi

  # 证书默认路径：控制面 <domain>，边缘通配 wildcard；可用环境变量覆盖
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
  controlPort: num(env.RELAY_CONTROL_PORT, 8443),
  httpPort: num(env.RELAY_HTTP_PORT, 80),
  listenHost: env.RELAY_LISTEN_HOST || env.RELAY_DATA_HOST || '0.0.0.0',
  tls: { certFile: env.RELAY_TLS_CERT_FILE, keyFile: env.RELAY_TLS_KEY_FILE },
  logLevel: env.RELAY_LOG_LEVEL || 'info',
  group: {
    file: env.RELAY_GROUP_FILE || '/data/group.json',
    mobilePort: num(env.RELAY_GROUP_MOBILE_PORT, 443),
    maxHosts: num(env.RELAY_GROUP_MAX_HOSTS, 200),
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
