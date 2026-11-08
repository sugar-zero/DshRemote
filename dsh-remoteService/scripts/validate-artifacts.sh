#!/usr/bin/env bash
# 部署/脚本产物静态校验（无需 VPS/Docker daemon）。
#
#   ./scripts/validate-artifacts.sh
#
# 覆盖：
#   - shell 脚本语法（bash -n）
#   - 所有 Node 运行时入口/模块语法（node --check）
#   - relay Dockerfile 与本机 dev compose（有 docker 时 docker compose config）
#   - 示例 JSON 可解析
set -uo pipefail
cd "$(dirname "$0")/.."
FAIL=0
WARN=0
ok()   { printf '  ✅ %s\n' "$1"; }
bad()  { printf '  ❌ %s\n' "$1"; FAIL=$((FAIL+1)); }
warn() { printf '  ⚠️  %s\n' "$1"; WARN=$((WARN+1)); }

echo "== shell 脚本语法 =="
for file in scripts/*.sh packages/relay/*.sh; do
  [ -f "$file" ] || continue
  if bash -n "$file" 2>/dev/null; then ok "$file"; else bad "$file 语法错误"; fi
done

echo "== Node 入口语法 =="
NODE_FILES=$(find packages -name '*.js' -not -path '*/node_modules/*' -not -path '*/test/*' -not -path '*/test-certs/*')
for file in $NODE_FILES; do
  if [ -f "$file" ] && node --check "$file" 2>/dev/null; then ok "$file"; else
    [ -f "$file" ] && bad "$file 语法错误"
  fi
done

echo "== relay dev compose =="
if command -v docker >/dev/null 2>&1; then
  if docker compose -f packages/relay/docker-compose.yml config -q 2>/dev/null; then
    ok "packages/relay/docker-compose.yml"
  else
    bad "docker compose config 失败"
  fi
else
  warn "未安装 docker，跳过 compose 校验"
fi

echo "== server 部署 compose（dummy env）=="
if command -v docker >/dev/null 2>&1; then
  TMP_ENV_DIR=$(mktemp -d)
  cat > "$TMP_ENV_DIR/group.env" <<'EOF'
RELAY_DOMAIN=relay.example.com
EOF
  cat > "$TMP_ENV_DIR/push-hub.env" <<'EOF'
HUB_PUBLIC_URL=https://push.example.com
HUB_APNS_KEY_DIR=/tmp/dsh-push-hub-apns
HUB_APNS_KEY_FILE=/data/apns/AuthKey_TEST000000.p8
HUB_APNS_KEY_ID=TEST000000
HUB_APNS_TEAM_ID=TEST000000
HUB_APNS_TOPIC=com.example.dshremote
EOF
  if (cd ../server && docker compose --env-file "$TMP_ENV_DIR/group.env" -f docker-compose.group.yml config -q 2>/dev/null); then
    ok "../server/docker-compose.group.yml"
  else
    bad "../server/docker-compose.group.yml 渲染失败"
  fi
  if (cd ../server && docker compose --env-file "$TMP_ENV_DIR/push-hub.env" -f docker-compose.push-hub.yml config -q 2>/dev/null); then
    ok "../server/docker-compose.push-hub.yml"
  else
    bad "../server/docker-compose.push-hub.yml 渲染失败"
  fi
  rm -rf "$TMP_ENV_DIR"
else
  warn "未安装 docker，跳过 server compose 校验"
fi

echo "== JSON =="
for file in packages/relay/relay.example.json ../server/group/relay.group.example.json; do
  case "$file" in
    *.json)
      if node -e "JSON.parse(require('fs').readFileSync('$file','utf8'))" 2>/dev/null; then ok "$file"; else bad "$file 不是合法 JSON"; fi
      ;;
  esac
done

echo ""
if [ "$FAIL" -gt 0 ]; then
  echo "❌ 产物静态校验失败（fail=$FAIL, warnings=${WARN}）"
  exit 1
fi
echo "✅ 产物静态校验通过（warnings: ${WARN}）"
