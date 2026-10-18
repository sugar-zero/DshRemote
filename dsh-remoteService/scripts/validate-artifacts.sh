#!/usr/bin/env bash
# 部署/脚本产物静态校验（无需 VPS/Docker daemon）。
#
#   ./scripts/validate-artifacts.sh
#
# 覆盖：
#   - shell 脚本语法（bash -n）
#   - relay compose YAML（docker compose config）
#   - launchd plist（macOS plutil）
#   - 所有 Node 运行时入口语法（node --check）
#   - 示例 JSON 可解析
set -uo pipefail
cd "$(dirname "$0")/.."
FAIL=0
WARN=0
ok()   { printf '  ✅ %s\n' "$1"; }
bad()  { printf '  ❌ %s\n' "$1"; FAIL=$((FAIL+1)); }
warn() { printf '  ⚠️  %s\n' "$1"; WARN=$((WARN+1)); }

echo "== shell 脚本语法 =="
for file in scripts/*.sh deploy/*.sh packages/relay/*.sh poc/*.sh poc/*/*.sh; do
  [ -f "$file" ] || continue
  if bash -n "$file" 2>/dev/null; then ok "$file"; else bad "$file 语法错误"; fi
done

echo "== Node 入口语法 =="
NODE_FILES=$(find packages -name '*.js' -not -path '*/node_modules/*' -not -path '*/test/*' -not -path '*/test-certs/*'; echo poc/run-poc.js poc/bench-relay.js poc/docker-e2e/run.mjs)
for file in $NODE_FILES; do
  if [ -f "$file" ] && node --check "$file" 2>/dev/null; then ok "$file"; else
    [ -f "$file" ] && bad "$file 语法错误"
  fi
done

echo "== relay docker compose =="
if command -v docker >/dev/null 2>&1; then
  if docker compose -f packages/relay/docker-compose.yml config -q 2>/dev/null; then
    ok "packages/relay/docker-compose.yml"
  else
    bad "docker compose config 失败"
  fi
else
  warn "未安装 docker，跳过 compose 校验"
fi

echo "== launchd plist =="
if command -v plutil >/dev/null 2>&1; then
  if plutil -lint deploy/launchd/com.dsh.web.plist >/dev/null 2>&1; then ok "launchd plist"
  else bad "launchd plist 语法错误"; fi
else
  warn "非 macOS，跳过 plutil"
fi

echo "== JSON =="
if command -v node >/dev/null 2>&1; then
  for file in packages/relay/relay.example.json; do
    if node -e "JSON.parse(require('fs').readFileSync('$file','utf8'))" 2>/dev/null; then ok "$file"; else bad "$file 不是合法 JSON"; fi
  done
fi

echo ""
if [ "$FAIL" -gt 0 ]; then
  echo "❌ 校验失败：${FAIL} 项（warnings: ${WARN}）"
  exit 1
fi
echo "✅ 产物静态校验通过（warnings: ${WARN}）"
