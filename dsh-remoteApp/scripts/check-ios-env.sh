#!/usr/bin/env bash
# 检查 iOS 真机构建/验收环境（macOS）。
#   npm run check:ios-env
# 退出码 0 = 可开始构建；非 0 = 有阻塞项（逐项提示）。
set -uo pipefail
FAIL=0
WARN=0
ok()   { printf '  ✅ %s\n' "$1"; }
bad()  { printf '  ❌ %s\n' "$1"; FAIL=$((FAIL+1)); }
warn() { printf '  ⚠️  %s\n' "$1"; WARN=$((WARN+1)); }

echo "== DSH Remote iOS 构建环境检查 =="
if [ "$(uname -s)" != "Darwin" ]; then
  bad "不是 macOS（iOS 构建需要 macOS）"
  exit 1
fi
ok "macOS $(sw_vers -productVersion)"

echo "[1/6] Xcode"
DEV_DIR=$(xcode-select -p 2>/dev/null || true)
XCODE_APP="/Applications/Xcode.app"
if [ -d "$XCODE_APP" ]; then
  XC_BUILD="$XCODE_APP/Contents/Developer/usr/bin/xcodebuild"
  if [ -x "$XC_BUILD" ]; then
    VERSION=$(DEVELOPER_DIR="$XCODE_APP/Contents/Developer" "$XC_BUILD" -version 2>/dev/null | head -1 || true)
    ok "已安装 ${VERSION}（${XCODE_APP}）"
  else
    warn "Xcode.app 存在但 xcodebuild 不可执行"
  fi
  if printf '%s' "$DEV_DIR" | grep -q 'CommandLineTools'; then
    bad "xcode-select 仍指向 Command Line Tools（运行：sudo xcode-select -s /Applications/Xcode.app/Contents/Developer）"
  else
    ok "xcode-select: $DEV_DIR"
  fi
  if DEVELOPER_DIR="$XCODE_APP/Contents/Developer" "$XC_BUILD" -checkFirstLaunchStatus >/dev/null 2>&1; then
    ok "Xcode license 已接受"
  else
    bad "Xcode license 未接受（运行：sudo xcodebuild -license accept）"
  fi
  if DEVELOPER_DIR="$XCODE_APP/Contents/Developer" "$XC_BUILD" -showsdks 2>/dev/null | grep -q 'iphoneos'; then
    ok "iPhoneOS SDK 可用"
  else
    warn "iPhoneOS SDK 未确认（可能 license/首次启动未完成）"
  fi
else
  bad "未安装完整 Xcode（App Store 安装后：sudo xcode-select -s /Applications/Xcode.app/Contents/Developer）"
fi

echo "[2/6] CocoaPods"
if command -v pod >/dev/null 2>&1; then ok "pod $(pod --version 2>/dev/null)"; else warn "未安装 CocoaPods（expo prebuild 需要：sudo gem install cocoapods 或 brew install cocoapods）"; fi

echo "[3/6] Node / Expo"
if command -v node >/dev/null 2>&1; then ok "node $(node --version)"; else bad "node 未安装"; fi
if command -v npx >/dev/null 2>&1; then ok "npx 可用"; else bad "npx 未安装"; fi

echo "[4/6] 代码签名身份"
IDENTITIES=$(security find-identity -v -p codesigning 2>/dev/null | grep -c '"' || true)
if [ "${IDENTITIES:-0}" -gt 0 ]; then ok "找到 ${IDENTITIES} 个代码签名身份"; else warn "未找到代码签名身份（免费 Apple ID 也可用 Xcode 自动签名）"; fi

echo "[5/6] 真机/模拟器"
if command -v xcrun >/dev/null 2>&1; then
  DEVICES=$(DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcrun xctrace list devices 2>/dev/null | grep -iE 'iPhone|iPad' | head -5 || true)
  if [ -n "$DEVICES" ]; then
    ok "检测到设备："
    printf '%s\n' "$DEVICES" | sed 's/^/       /'
  else
    warn "未检测到已连接的 iPhone/iPad（可先用模拟器验证 UI，但 Secure Enclave mTLS 必须真机）"
  fi
  BOOTED=$(DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcrun simctl list devices booted 2>/dev/null | grep -c 'Booted' || true)
  [ "${BOOTED:-0}" -gt 0 ] && ok "有 ${BOOTED} 个已启动模拟器" || warn "没有已启动模拟器"
else
  bad "xcrun 不可用"
fi

echo "[6/6] 推送凭据（APNs / EAS）"
warn "推送需要 Apple Developer 账号 + EAS projectId/APNs key（见 docs/ACCEPTANCE.md §5）；本检查不代填。"

echo ""
if [ "$FAIL" -gt 0 ]; then
  echo "❌ iOS 环境未就绪：${FAIL} 个阻塞项（warnings: ${WARN}）"
  echo "   安装完整 Xcode 后重新运行：npm run check:ios-env"
  exit 1
fi
echo "✅ iOS 环境就绪（warnings: ${WARN}）—— 下一步：npx expo prebuild --platform ios && npx expo run:ios --device"
