#!/usr/bin/env bash
# B2 部署自检：DNS / relay 健康 / 控制面端口 / relay 证书 / 主机子域证书。
#
#   ./scripts/check-deploy.sh relay.example.com h_ab12cd34 [8443]
#
# 前提：relay 已部署、主机插件已启用并在线、DNS 已生效。
set -uo pipefail
DOMAIN="${1:?usage: check-deploy.sh <relay-domain> <hostId> [control-port]}"
HOST_ID="${2:?usage: check-deploy.sh <relay-domain> <hostId> [control-port]}"
CONTROL_PORT="${3:-8443}"
HOST_FQDN="${HOST_ID}.${DOMAIN}"
FAIL=0
WARN=0

ok()   { printf '  ✅ %s\n' "$1"; }
bad()  { printf '  ❌ %s\n' "$1"; FAIL=$((FAIL+1)); }
warn() { printf '  ⚠️  %s\n' "$1"; WARN=$((WARN+1)); }
need() { command -v "$1" >/dev/null 2>&1 || { warn "未安装 $1，跳过相关检查"; return 1; }; }

echo "== B2 部署自检 =="
echo "relay domain : $DOMAIN"
echo "host fqdn    : $HOST_FQDN"
echo

echo "[1/5] DNS"
if need dig; then
  RELAY_A=$(dig +short "$DOMAIN" A | head -1)
  HOST_A=$(dig +short "$HOST_FQDN" A | head -1)
  [ -n "$RELAY_A" ] && ok "A $DOMAIN -> $RELAY_A" || bad "A $DOMAIN 未解析"
  [ -n "$HOST_A" ] && ok "A $HOST_FQDN -> $HOST_A（泛解析）" || bad "A $HOST_FQDN 未解析（检查 *.DOMAIN 泛解析）"
  [ -n "$RELAY_A" ] && [ -n "$HOST_A" ] && [ "$RELAY_A" != "$HOST_A" ] && warn "relay 与主机子域解析到不同 IP"
fi

echo "[2/5] relay /healthz"
if need curl; then
  HEALTH=$(curl -fsS --max-time 8 "http://$DOMAIN/healthz" 2>/dev/null || true)
  if [ -z "$HEALTH" ]; then
    bad "GET http://$DOMAIN/healthz 失败（80 端口/防火墙？）"
  elif printf '%s' "$HEALTH" | grep -q '"ok":true'; then
    ok "healthz: $HEALTH"
    if printf '%s' "$HEALTH" | grep -q "\"$HOST_ID\""; then
      ok "hostId $HOST_ID 在线"
    else
      bad "healthz 里没有 $HOST_ID：主机插件未连接/ token 不对/ hostId 不一致"
    fi
  else
    bad "healthz 响应异常: $HEALTH"
  fi
fi

echo "[3/5] 控制面端口 $CONTROL_PORT"
if need nc; then
  nc -z -w 3 "$DOMAIN" "$CONTROL_PORT" >/dev/null 2>&1 && ok "TCP $DOMAIN:$CONTROL_PORT 可达" || bad "TCP $DOMAIN:$CONTROL_PORT 不可达"
else
  warn "跳过（无 nc）"
fi

echo "[4/5] relay 控制面证书（$DOMAIN:$CONTROL_PORT）"
if need openssl; then
  CERT=$(echo | openssl s_client -connect "$DOMAIN:$CONTROL_PORT" -servername "$DOMAIN" 2>/dev/null | openssl x509 -noout -subject -enddate 2>/dev/null || true)
  if [ -z "$CERT" ]; then
    bad "无法完成 TLS 握手（证书链/端口）"
  else
    ok "$(printf '%s' "$CERT" | tr '\n' ' ')"
  fi
fi

echo "[5/5] 主机子域证书（$HOST_FQDN:443，经 relay 透传到主机插件）"
if need openssl; then
  CERT2=$(echo | openssl s_client -connect "$DOMAIN:443" -servername "$HOST_FQDN" 2>/dev/null | openssl x509 -noout -subject -enddate 2>/dev/null || true)
  if [ -z "$CERT2" ]; then
    bad "无法完成 TLS 握手（主机插件未运行/证书未配置/relay 未路由）"
  else
    ok "$(printf '%s' "$CERT2" | tr '\n' ' ')"
    printf '%s' "$CERT2" | grep -q "CN *= *$HOST_FQDN" || warn "证书 subject 与 $HOST_FQDN 不完全匹配（看 SAN）"
  fi
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "✅ 自检通过（warnings: $WARN）"
  echo "下一步：手机 App 扫码配对 → 打开 https://$HOST_FQDN/"
else
  echo "❌ 自检失败项: $FAIL（warnings: $WARN）"
  echo "排障见 docs/DEPLOY.md §8。"
  exit 1
fi
