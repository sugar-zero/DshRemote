#!/bin/sh
# Relay 容器入口：在启动 relay 前，根据 .env 自动确保 host token 存在。
#
#   RELAY_HOST_ID      必填，例如 h_ab12cd34
#   RELAY_HOST_TOKEN   可选；若设置，则直接用该 token（与主机插件保持一致）
#                      未设置时自动生成随机 token，并写入 /data/host-token.txt
#
# 已存在 token 时不会自动轮换，避免每次重启把主机踢下线。
set -eu

cd /app

# 群体服务版（A 模式）：主机通过邀请码自助注册，不再需要预置 RELAY_HOST_ID/token。
if [ "${RELAY_MODE:-}" = "group" ] || [ -n "${RELAY_GROUP_FILE:-}" ]; then
  echo "relay-entrypoint: group 模式（主机自助注册，跳过 host token 预置）"
  if [ "$#" -gt 0 ]; then
    exec "$@"
  fi
  exec node packages/relay/bin/relay.js
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
