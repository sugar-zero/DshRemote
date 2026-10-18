#!/usr/bin/env bash
# POC：Swift（Secure Enclave 同款 API）生成 P-256 设备密钥 + PKCS#10 CSR，
# 交给 host 插件（openssl 路径）用设备 CA 签发，再用 openssl 校验证书链与公钥一致。
#
#   bash poc/native-csr/run.sh
#
# 该 Swift 生成器与 dsh-remoteApp/modules/dsh-mtls/ios/DSHMTLSCsr.swift 使用同一实现。
set -euo pipefail
cd "$(dirname "$0")"
BUILD=".build"
mkdir -p "$BUILD"

command -v swiftc >/dev/null || { echo "需要 swiftc（Command Line Tools 即可）" >&2; exit 1; }
command -v openssl >/dev/null || { echo "需要 openssl" >&2; exit 1; }

echo "==> 编译 Swift P-256 CSR 生成器"
swiftc -O -swift-version 5 gen-csr.swift -o "$BUILD/gen-csr" 2>/dev/null

echo "==> 生成设备密钥（Secure Enclave 不可用时回退软件钥匙串）+ CSR"
( cd "$BUILD" && ./gen-csr "dsh-poc-device" "com.dsh.remote.poc" )
cp "$BUILD/generated.csr" generated.csr

echo "==> openssl 校验 CSR 自签名"
openssl req -in generated.csr -verify -noout

echo "==> host 插件用真实设备 CA 签发 EC 证书"
TMP_HOME=$(mktemp -d)
DSH_HOME="$TMP_HOME" node sign-with-host.mjs
rm -rf "$TMP_HOME"

echo "==> 校验证书链"
openssl verify -CAfile ca.pem device.pem

echo "==> 校验证书公钥与 CSR 公钥一致"
CSR_HASH=$(openssl req -in generated.csr -pubkey -noout | openssl pkey -pubin -outform DER | openssl sha256 | awk '{print $2}')
CRT_HASH=$(openssl x509 -in device.pem -pubkey -noout | openssl pkey -pubin -outform DER | openssl sha256 | awk '{print $2}')
[ "$CSR_HASH" = "$CRT_HASH" ] || { echo "公钥不一致: $CSR_HASH != $CRT_HASH" >&2; exit 1; }

echo "✅ Native P-256 CSR → host 签发 → 证书链/公钥校验 PASS"
echo "   CSR:  $(pwd)/generated.csr"
echo "   cert: $(pwd)/device.pem  (CN=$(openssl x509 -in device.pem -noout -subject | sed 's/.*CN=//'))"
