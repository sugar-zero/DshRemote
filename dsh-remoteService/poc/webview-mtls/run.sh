#!/usr/bin/env bash
# macOS WKWebView mTLS 验证（无需 Xcode，Command Line Tools 即可；与 iOS WKNavigationDelegate 同一套 API）。
#
#   bash poc/webview-mtls/run.sh
#
# 验证内容：WKWebView 加载要求客户端证书的 HTTPS 站点时，delegate 收到
# NSURLAuthenticationMethodClientCertificate 挑战并能返回 SecIdentity；服务器
# 确认收到设备证书（CN=dsh-poc-device）。
set -euo pipefail
cd "$(dirname "$0")"
BUILD=".build"
mkdir -p "$BUILD"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "需要 swiftc（macOS Command Line Tools 即可）：xcode-select --install" >&2
  exit 1
fi

echo "==> 生成测试 CA / 服务器证书 / 客户端证书+PKCS#12"
node generate-certs.mjs

echo "==> 编译 Swift WKWebView mTLS 测试"
swiftc -O -swift-version 5 wk-mtls.swift -o "$BUILD/wk-mtls" 2>/dev/null

echo "==> 启动要求客户端证书的 HTTPS 服务"
node server.mjs > "$BUILD/server.log" 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT
PORT=""
for _ in $(seq 1 50); do
  PORT=$(grep -o 'PORT=[0-9]*' "$BUILD/server.log" 2>/dev/null | cut -d= -f2 || true)
  [ -n "$PORT" ] && break
  sleep 0.2
done
if [ -z "$PORT" ]; then
  echo "server 未启动：" >&2; cat "$BUILD/server.log" >&2; exit 1
fi
echo "    server: https://127.0.0.1:$PORT/ (mTLS required)"

echo "==> 运行 WKWebView"
RESULT=$("$BUILD/wk-mtls" "https://127.0.0.1:$PORT/" "$BUILD/client.p12" "poc-pass" "$BUILD/ca.pem")
echo "    $RESULT"
case "$RESULT" in
  *"MTLS OK: dsh-poc-device"*)
    echo "✅ WKWebView mTLS POC PASS：客户端证书挑战已由 WKNavigationDelegate 正确处理"
    ;;
  *)
    echo "❌ WKWebView mTLS POC FAIL" >&2
    exit 1
    ;;
esac
