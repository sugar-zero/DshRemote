#!/usr/bin/env bash
# 检查 Android 构建/验收环境。
#   npm run check:android-env
set -uo pipefail
FAIL=0
WARN=0
ok()   { printf '  ✅ %s\n' "$1"; }
bad()  { printf '  ❌ %s\n' "$1"; FAIL=$((FAIL+1)); }
warn() { printf '  ⚠️  %s\n' "$1"; WARN=$((WARN+1)); }

echo "== DSH Remote Android 构建环境检查 =="
echo "[1/5] JDK"
if command -v java >/dev/null 2>&1; then ok "$(java -version 2>&1 | head -1)"; else bad "java 未安装（需要 JDK 17+）"; fi

echo "[2/5] Android SDK"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
if [ -d "$SDK" ]; then
  ok "SDK: $SDK"
  if [ -x "$SDK/platform-tools/adb" ]; then ok "adb 存在"; else warn "缺少 platform-tools/adb"; fi
  if [ -x "$SDK/cmdline-tools/latest/bin/sdkmanager" ]; then ok "sdkmanager 存在"; else warn "缺少 cmdline-tools（可用 Android Studio 或 sdkmanager 安装）"; fi
else
  bad "Android SDK 未安装（安装 Android Studio 或 command-line tools，并设置 ANDROID_HOME）"
fi

echo "[3/5] 设备"
if command -v adb >/dev/null 2>&1; then
  DEVICES=$(adb devices 2>/dev/null | grep -v 'List of devices' | grep -c 'device$' || true)
  [ "${DEVICES:-0}" -gt 0 ] && ok "检测到 ${DEVICES} 台设备" || warn "没有已连接的 Android 设备（可用模拟器）"
else
  warn "adb 不在 PATH"
fi

echo "[4/5] Node / Expo"
if command -v node >/dev/null 2>&1; then ok "node $(node --version)"; else bad "node 未安装"; fi

echo "[5/5] 推送凭据（FCM）"
warn "Android 推送需要 Firebase/FCM 配置（见 docs/ACCEPTANCE.md §5）；本检查不代填。"

echo ""
if [ "$FAIL" -gt 0 ]; then
  echo "❌ Android 环境未就绪：${FAIL} 个阻塞项（warnings: ${WARN}）"
  exit 1
fi
echo "✅ Android 环境就绪（warnings: ${WARN}）—— 下一步：npx expo prebuild --platform android && npx expo run:android"
