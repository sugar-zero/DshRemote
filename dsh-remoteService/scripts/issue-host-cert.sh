#!/usr/bin/env bash
# 为方案 B2 的主机插件申请 <hostId>.<relayDomain> 证书（DNS-01，私钥只留在主机）。
#
# 前置：
#   - 安装 acme.sh：curl https://get.acme.sh | sh -s email=you@example.com
#   - 设置对应 DNS 服务商的 API 环境变量（示例 Cloudflare：CF_Token；权限只需 Zone.DNS Edit）
#   - 该 DNS API token 只放在主机，不要放到 relay —— 这是 B2「relay 无法冒充主机」的关键
#
# 用法：
#   CF_Token=xxx ./scripts/issue-host-cert.sh h_ab12cd34 relay.example.com [dns_cf]
#
# 成功后把打印的 tlsCertFile / tlsKeyFile 填到 DSH「设置 → 远程访问」；
# 插件会每小时检查证书文件变化并自动重建 TLS 监听（acme.sh cron 默认自动续期）。
set -euo pipefail

HOST_ID="${1:?usage: issue-host-cert.sh <hostId> <relayDomain> [acme-dns-plugin]}"
RELAY_DOMAIN="${2:?usage: issue-host-cert.sh <hostId> <relayDomain> [acme-dns-plugin]}"
DNS_PLUGIN="${3:-dns_cf}"
FQDN="${HOST_ID}.${RELAY_DOMAIN}"
CERT_DIR="${DSH_HOME:-$HOME/.dsh}/remote-access/certs"

if ! command -v acme.sh >/dev/null 2>&1; then
  if [ -x "$HOME/.acme.sh/acme.sh" ]; then
    ACME="$HOME/.acme.sh/acme.sh"
  else
    echo "错误：找不到 acme.sh。安装：curl https://get.acme.sh | sh -s email=you@example.com" >&2
    exit 1
  fi
else
  ACME="$(command -v acme.sh)"
fi

mkdir -p "$CERT_DIR"
chmod 700 "$(dirname "$CERT_DIR")" "$CERT_DIR" 2>/dev/null || true

echo "==> 申请证书 $FQDN（DNS-01 / $DNS_PLUGIN）"
"$ACME" --issue --dns "$DNS_PLUGIN" -d "$FQDN" --keylength ec-256

echo "==> 安装到 $CERT_DIR"
"$ACME" --install-cert -d "$FQDN" \
  --fullchain-file "$CERT_DIR/fullchain.pem" \
  --key-file       "$CERT_DIR/privkey.pem"
chmod 600 "$CERT_DIR/fullchain.pem" "$CERT_DIR/privkey.pem"

cat <<MSG

✅ 证书就绪：
   tlsCertFile = $CERT_DIR/fullchain.pem
   tlsKeyFile  = $CERT_DIR/privkey.pem

下一步：
 1) 在 DSH 侧栏「远程访问 → 设置」填入上面两个路径与 relayUrl/hostId/hostToken；
 2) 打开「启用远程访问」；
 3) 若 DSH 以独立 launchd 服务运行，确认该服务用户能读到 $CERT_DIR（权限 700/600）。
 4) 续期：acme.sh cron 自动执行；插件检测到文件更新后自动重载 TLS，无需重启 DSH。

安全提醒：DNS API token 只应保存在主机（环境变量/受保护脚本），不要配到 relay。
MSG
