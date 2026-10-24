# DSH Remote App 真机验收手册

本手册用于在**有 Xcode/iPhone 或 Android SDK/设备**的机器上完成 App 的真机验收。
本仓库开发机没有这些环境，因此 App 目前只通过了 TS/协议/原生源码一致性检查；
真机验收必须按本手册执行并记录结果。

---

## 0. 环境就绪检查

> 如果 Xcode 已安装但 `npm run check:ios-env` 仍报错，通常还需要（需管理员密码）：
>
> ```bash
> sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
> sudo xcodebuild -license accept
> brew install cocoapods        # 或 sudo gem install cocoapods
> ```


```bash
cd dsh-remoteApp
npm install

# iOS（需要完整 Xcode，不是 Command Line Tools）
npm run check:ios-env
# 期望最后一行为：✅ iOS 环境就绪
# 如提示仅 CLT：从 App Store 安装 Xcode，然后
#   sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
#   sudo xcodebuild -license accept
#   brew install cocoapods   (或 sudo gem install cocoapods)

# Android（需要 Android SDK + JDK 17+）
npm run check:android-env
# 期望最后一行为：✅ Android 环境就绪
```

其它前置：

```bash
npx expo config --type public      # Expo 配置可解析
npx tsc --noEmit                   # TS 0 错误
npm run check:native               # JS bridge ↔ iOS/Android 原生接口一致
```

---

## 1. Host（电脑端）准备

```bash
# 1) 启动一个独立 web 实例（不要与 Desktop App 共用 DSH_HOME）
dsh --profile web --no-open --port 3080

# 2) 打开 http://127.0.0.1:3080 → 设置 → 远程访问
#    - 启用远程访问
#    - relay 地址 / hostId / hostToken / relayDomain
#    - 生产证书文件（或本地开发自签）
#    - 开启「新设备配对需要本机确认」

# 3) 部署自检（生产 relay 就绪时）
cd dsh-remoteService
./scripts/check-deploy.sh <relay-domain> <hostId>
```

记录：hostId = `________`，relayDomain = `________`。

---

## 2. iOS 构建

```bash
cd dsh-remoteApp
npx expo prebuild --platform ios        # 生成 ios/，会 pod install
npx expo run:ios --device               # 选择你的 iPhone
```

> 必须用 `run:ios` 构建 dev client，**Expo Go 不含本地原生模块 `dsh-mtls`**。
> 首次运行需在 iPhone 上信任开发者证书（设置 → 通用 → VPN与设备管理）。

## 3. iOS 验收清单

| # | 步骤 | 期望结果 | 结果 |
|---|---|---|---|
| 1 | 冷启动 App | 若已开启 App 锁，立即要求 Face ID/Touch ID；解锁后进入 | ☐ |
| 2 | 桌面 DSH → 远程访问 → 生成配对二维码 | 手机扫码，显示主机指纹/SAS，确认后桌面弹出「允许/拒绝」 | ☐ |
| 3 | 本机点「允许」 | App 显示已配对，自动安装设备证书 | ☐ |
| 4 | 打开远程会话 | WKWebView 加载 `https://<hostId>.<relayDomain>/`；**无 403/空白** | ☐ |
| 5 | 设备页 → 主机状态 | 显示 hostId/域名/TLS 证书到期/relay 已连接/设备数 | ☐ |
| 6 | DSH 会话内操作（发消息/切换/WS 状态） | 正常；WS 不断连（可看设备页 relay 状态） | ☐ |
| 7 | 关闭 App 再回前台 | 再次要求生物识别（App 锁开启时） | ☐ |
| 8 | 推送：桌面触发一轮任务结束 | iPhone 收到**通用标题/正文**通知，不含会话内容 | ☐ |
| 9 | iOS 设置 → 通知 → DSH Remote | 权限已授予；后台/锁屏也能收到 | ☐ |
| 10 | 桌面设备页撤销该设备 | 手机当前会话/WS 立即断开，后续请求 403 | ☐ |
| 11 | 重新配对 | 新证书可正常访问；旧设备仍被撤销 | ☐ |
| 12 | 主机证书轮换（acme.sh 覆盖 cert/key） | 手机访问不中断（或重连后恢复） | ☐ |

原生模块自检（可选）：在设备页打开诊断，应显示
`identityPresent=true`、`subject=CN=...`、`notAfter=...`、`nativeBuild=DSHMTLS/...`。

## 4. Android 构建/验收

```bash
npx expo prebuild --platform android
npx expo run:android --device
```

验收清单同 iOS，差异：

- 生物识别：指纹/面部（`expo-local-authentication`），设备页开关；
- AndroidKeyStore 证书安装：配对后设备页 `identityPresent=true`；
- 推送：FCM 通道（EAS 配置），通知内容同样内容无关；
- 撤销设备后连接断开（同 #10）。

## 5. 推送凭据（iOS/Android）

推送需要：

1. Apple Developer 账号 → APNs key（.p8）或 EAS 托管凭据；
   - 本机签名材料放在 `Certificates/`（已被 `.gitignore` 忽略），不要提交
   - 在 Apple Developer / Xcode 中确认 Team ID 与 App ID 和项目配置一致
   - 注意 provisioning profile 到期前需重新生成；
2. `eas init` 生成 EAS `projectId`，写入 `app.json` 的 `extra.eas.projectId`；
3. Android：Firebase 项目 + `google-services.json`（`npx expo install expo-notifications` 已配置插件）；
4. 服务端 relay 的 `RELAY_PUSH_*` 配置（默认 Expo Push endpoint）。

Host 端 token 注册接口：`POST /__dsh_remote/push-token`（mTLS），App 在配对成功后调用
`registerPushToken`；未配置 EAS/APNs 时 App 会记录警告但主流程不中断。

## 6. 验收记录模板

| 项目 | 结果 | 证据（截图/日志） |
|---|---|---|
| iOS 编译（generic，无签名） | ✅ BUILD SUCCEEDED（2026-10-24） | /tmp/ios-build3.log |
| iOS 真机安装/启动 | ✅ 已安装并启动，JS bundle 加载成功 | `mockups/ios-pairing.png` |
| Secure Enclave 身份（identityPresent） | ✅ P-256 key `SE=true`，CSR 经 host CA 签发，链/公钥校验通过 | `/tmp/metro.log`、`/tmp/iphone-se-cert.pem` |
| iOS WebView mTLS | ✅ 真机 + 本地 Docker relay + 本机 host：原生 mTLS WebView 成功加载 DSH UI，Keychain 身份生效 | `mockups/ios-mtls-dsh-ui.png` |
| Secure Enclave 身份（identityPresent） | | |
| 配对 + 桌面确认 | | |
| 推送（内容无关） | | |
| 生物识别 App 锁 | | |
| 设备撤销立即断链 | | |
| 证书轮换 | | |
| Android WebView mTLS | | |
| Android 推送 | | |

把截图/日志放到 `dsh-remoteApp/docs/evidence/`（可选），并在 `POC-REPORT.md` 勾选对应项。

## 7. 常见问题

| 现象 | 排查 |
|---|---|
| `xcodebuild` 报 command line tools | 安装完整 Xcode 并 `sudo xcode-select -s ...` |
| `pod install` 失败 | `brew install cocoapods`；`npx expo prebuild --clean` |
| WebView 403 `device-revoked` | 设备被撤销；重新配对 |
| WebView 403 `unknown-device` | 证书与 host 设备表不匹配；检查配对是否用同一 hostId |
| WebView 空白/TLS 错误 | 检查主机证书域名/SAN 是否为 `<hostId>.<relayDomain>`，以及系统时间 |
| 生物识别开关灰掉 | 设备无 Face ID/Touch ID/指纹，或未录入 |
| 推送 token 注册失败 | `requestWithClientCert` 是否编译进 dev client；APNs/FCM 凭据 |
| 撤销后手机仍能访问 | 确认 host 插件版本包含撤销断链逻辑（本轮已实现） |
