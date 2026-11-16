# DSH Remote App

iOS 客户端：扫码配对到运行 DSH 的 Mac，远程查看/继续会话、处理审批，可选接收任务提醒。

## 使用

1. 在主机 DSH「设置 → 远程访问」生成配对二维码；
2. App 内「配对新主机」扫码；
3. 主机确认后即可进入会话；
4. 主机端可随时撤销设备；App 侧可删除本机配对、清理缓存、开启 App 锁。

## 构建（self / 自部署 App）

要求：macOS + Xcode、CocoaPods；`ios/` 由 `expo prebuild` 生成，不入库。

```bash
cd dsh-remoteApp
npm install
npx expo prebuild -p ios --no-install
cd ios
CP_HOME_DIR="$PWD/../.pods-home" CP_CACHE_DIR="$PWD/../.pods-cache" pod install
cd ..
xcodebuild -workspace ios/DSHRemote.xcworkspace -scheme DSHRemote \
  -configuration Release -destination 'generic/platform=iOS' \
  -derivedDataPath /tmp/dsh-ios-build \
  CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM=<TEAM_ID> \
  PROVISIONING_PROFILE_SPECIFIER=<PROFILE_UUID> \
  CODE_SIGN_IDENTITY='Apple Development: <NAME> (<CERT_ID>)' build
```

self 构建默认使用 `self` 推送通道（不注入额外变量）；推送由 relay 用部署方自己的 APNs Key 发送。

## 版本与静态检查

- 版本/构建号：`app.json`、`package.json`、`modules/dsh-mtls/android/build.gradle` 同步
- `npx tsc --noEmit`
- `npm run check:native`
- `npm run check:shell`

签名材料/描述文件只留在仓库外，不要提交。

真机验收记录见 [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md)。
