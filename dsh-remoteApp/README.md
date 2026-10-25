# DSH Remote App


> 许可证：**AGPL-3.0-or-later**（完整文本见根目录 [`LICENSE`](../LICENSE)）。
DSH 远程访问的手机端外壳：**Expo / React Native (TypeScript)**，iOS 优先、Android 同步搭骨架。

> 相关文档：
> [根目录总览](../README.md) ·
> [服务器部署](../server/README.md) ·
> [主机插件](../dsh-remoteService/packages/host-plugin/README.md) ·
> [服务端 monorepo](../dsh-remoteService/README.md)

它做四件事：

1. **扫码配对**：扫主机桌面端生成的 `dshremote://pair?...` 二维码（或手动粘贴），本地校验主机地址、完整 SHA-256 指纹、有效期。
2. **安全存储**：`expo-secure-store`（iOS Keychain / Android EncryptedSharedPreferences）保存 host / deviceId / 证书 PEM；**设备私钥永不进入 JS**。
3. **加载 DSH Web UI**：`https://<hostId>.<relayDomain>/?dsh_mobile=1`，顶部状态条、刷新；外部链接（`target=_blank` / `window.open`，如查询用量/充值/意见反馈）在 App 内嵌浏览器打开（可一键切系统浏览器）。
4. **mTLS 客户端证书**：自定义原生 WebView（iOS `WKNavigationDelegate.didReceive challenge` + `SecIdentity`；Android `WebViewClient.onReceivedClientCertRequest` + Keystore）在 TLS 握手中出示设备证书。

接口契约见 [`../dsh-remoteService/docs/ADMIN-API.md`](../dsh-remoteService/docs/ADMIN-API.md)，设计依据见
[`../docs/remote-access-evaluation.zh.md`](../docs/remote-access-evaluation.zh.md) §4.3（配对）/ §4.4（密钥层级）/ §4.7（App 设计）。

---

## 当前状态（2026-10-25）

| 项 | 状态 |
|---|---|
| iOS Release 构建 / 真机安装 | ✅ 已完成（手动签名 + `devicectl`；无 dev-client/DevMenu） |
| iOS 原生 mTLS WebView（Secure Enclave 设备证书） | ✅ 真机通过 |
| 配对 / 设备证书 / 撤销 / 审计 / App 锁 | ✅ 已实现 |
| Android 源码（mTLS WebView / CSR / Keystore） | ✅ 源码完成；⏳ 未在有 Android SDK 的环境编译 |
| iOS 推送 | ✅ 自托管 APNs 直连（APNs device token + aps-environment；通知取会话标题+助手回复摘要；点击通知跳对应会话，2026-10-25 真机验证；App 锁屏时按系统通知显示）；Android FCM 未接入 |
| 前台推送 | ✅ App 内通知卡片（默认不弹系统横幅，5s 自动消失；当前会话不弹卡片）；后台/锁屏仍是系统通知 |
| 设置页 | ✅ 版本信息 / 应用内通知开关 / 通知权限 / 发送测试通知 / 清理 WebView 缓存 / 设备与安全入口 |
| 手机布局（`?dsh_mobile=1`，注入手机壳） | ✅ 会话侧栏→左侧抽屉；窄屏右栏→全屏覆盖层；窄屏设置→全屏 + 分区菜单抽屉（左上返回退出设置）；外链→App 内嵌浏览器（`ExternalPageScreen`，可切系统浏览器）（`src/lib/mobileWebShell.ts`、`src/screens/WebViewScreen.tsx`；`npm run check:shell` 无头 Chrome 回归） |
| 服务端 relay / 主机插件 | ✅ 见 `dsh-remoteService` 与 `server/` |

> 原生构建需要 macOS + Xcode；本仓库不提交生成的 `ios/`/`android/` 目录和签名材料。

## 目录结构

```
dsh-remoteApp/
├── App.tsx                        # 极简导航状态机：loading → pairing → webview ⇄ devices
├── index.ts                       # Expo 入口（registerRootComponent）
├── app.json                       # name/scheme/bundle id/android package/plugins
├── tsconfig.json                  # strict + noUncheckedIndexedAccess
├── package.json                   # Expo SDK 58（RN 0.88 / React 19）
├── src/
│   ├── theme.ts                   # 颜色/间距/共享样式
│   ├── lib/
│   │   ├── protocol.ts            # 配对 URI 解析/校验、指纹展示、API 路径与信封类型（纯函数）
│   │   ├── store.ts               # SecureStore 封装（连接记录 + 分块证书 PEM；web 无持久化回退）
│   │   └── pairing.ts             # 可注入 PairingTransport 的配对流程骨架（CSR → /pair → 轮询 → 持久化）
│   └── screens/
│       ├── PairingScreen.tsx      # 相机扫码 + 手动粘贴 + 指纹/SAS/备用码 + 桌面确认等待
│       ├── WebViewScreen.tsx      # 主界面：状态条 / 刷新 / 外链 / mTLS WebView 接入 TODO
│       └── DevicesScreen.tsx      # 设备与安全：本地身份/证书状态、POC 证书导入、重新配对
└── modules/dsh-mtls/              # 本地 Expo Module（POC，未编译）
    ├── expo-module.config.json
    ├── package.json
    ├── src/index.ts               # JS 桥（requireOptionalNativeModule，缺失时优雅降级）
    ├── ios/
    │   ├── DSHMTLS.podspec
    │   ├── DSHMTLSModule.swift    # Module 定义：函数 + View 注册
    │   ├── DSHMTLSIdentityStore.swift  # Keychain：SecPKCS12Import / 按 label 查 SecIdentity / 诊断
    │   └── DSHMTLSWebView.swift   # WKWebView + 客户端证书挑战 + 导航事件
    └── android/
        ├── build.gradle
        └── src/main/java/com/dsh/remote/mtls/
            ├── DshMtlsModule.kt       # Module 定义（函数 + View 注册）
            ├── DshMtlsIdentityStore.kt # KeyChain / AndroidKeyStore 身份查找
            ├── DshMtlsWebViewClient.kt # onReceivedClientCertRequest → request.proceed(...)
            └── DshMtlsWebView.kt       # ExpoView 包 WebView + JS bridge + 事件
```

---

## 前置要求

- **macOS + 完整 Xcode**（App Store 安装，打开一次同意许可；`xcode-select -p` 应指向 `Xcode.app/Contents/Developer`，而不是 Command Line Tools）。
- **CocoaPods**（`brew install cocoapods` 或 `sudo gem install cocoapods`）。
- **Node.js ≥ 20**、npm ≥ 10（本 POC 用 Node v24.16.0 / npm 11 验证）。
- **Apple Developer 账号**：真机安装需要签名；免费账号可签 7 天（推送/部分能力受限，POC 的 mTLS 不需要付费能力，但推送需要付费账号）。
- **iPhone 运行 iOS 16.4+**（Expo SDK 58 / RN 0.88 的最低部署目标；本项目通过 `expo-build-properties` 固定为 16.4）。
- **主机侧已经跑起来**：`dsh-remoteService` 的 relay + host plugin（提供 `/__dsh_remote/pair` 与 mTLS 隧道；接口见 ADMIN-API.md）。没有主机时只能验证 UI 与协议解析。

> **Expo Go 不可用**：`modules/dsh-mtls` 是本地原生模块，Expo Go 不包含它；必须构建 **dev client**。代码在模块缺失时不会崩溃，只会显示"当前构建未链接 mTLS 原生模块"。

---

## 快速开始（iOS 真机）

```bash
cd dsh-remoteApp
npm install                 # 已完成；锁文件见 package-lock.json

# 1) 生成原生工程（ios/、android/ 由 config 生成，已加入 .gitignore）
npx expo prebuild --clean

# 2) 首次真机运行（会自动 pod install；需要已连接的 iPhone / 模拟器）
npx expo run:ios --device

# 3) 之后日常开发只需启动 Metro + dev client
npx expo start
```

首次签名配置（只需一次）：

```bash
open ios/*.xcworkspace     # 在 Xcode 中打开
# 选择 target → Signing & Capabilities
#   Team: 你的 Apple Developer Team
#   Bundle Identifier: com.amesucre.dshremote（已与注册的 App ID 对齐）
```

> `bundleIdentifier` / `android.package` 已固定为 `com.amesucre.dshremote`。

### 局域网（无线）安装到 iPhone（不插 USB）

前提：iPhone 至少插过一次 USB 并在 Xcode → Window → Devices and Simulators 里勾选
**Connect via network**；之后 CoreDevice 会通过同一局域网管理它（`Transport Type: localNetwork`）。
本项目实测可行（Mac 有线 + iPhone Wi-Fi 同一网段，`devicectl install` 约 2 秒完成）。

```bash
# 0) 确认设备已被 CoreDevice 通过局域网发现
xcrun devicectl list devices
xcrun devicectl device info details --device <UDID> | grep -E "Transport Type|Developer Mode"

# 1) 查签名材料（描述文件必须包含该设备 UDID；开发描述文件有有效期）
security find-identity -v -p codesigning
ls ~/Library/MobileDevice/Provisioning\ Profiles/

# 2) 构建已签名的 Release（内嵌 JS bundle，不依赖 Metro）
cd dsh-remoteApp
xcodebuild -workspace ios/DSHRemote.xcworkspace -scheme DSHRemote -configuration Release \
  -destination 'generic/platform=iOS' -derivedDataPath /tmp/dsh-ios-release \
  CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM=<TEAM_ID> \
  PROVISIONING_PROFILE_SPECIFIER=<PROFILE_UUID> \
  CODE_SIGN_IDENTITY='Apple Development: <NAME> (<CERT_ID>)' build

# 3) 局域网安装 + 启动（走 Wi-Fi，无需 USB）
xcrun devicectl device install app --device <UDID> \
  /tmp/dsh-ios-release/Build/Products/Release-iphoneos/DSHRemote.app
xcrun devicectl device process launch --device <UDID> com.amesucre.dshremote

# 4) 验证（可选）
xcrun devicectl device info apps --device <UDID> --bundle-id com.amesucre.dshremote
xcrun devicectl device capture screenshot --device <UDID> --destination /tmp/phone.png
```

> 注意：
> - Release 构建把 JS 打进 `main.jsbundle`（Hermes 字节码），手机端不需要 Metro/开发服务器。
> - 改了 `app.json` 的 `version`/`buildNumber` 后，`xcodebuild` 实际读的是 prebuild 生成的
>   `ios/DSHRemote/Info.plist`；不重新 `expo prebuild` 的话要手动同步该文件，否则装上去仍显示旧版本号。
> - 描述文件的**有效期与签名证书无关**：正常的开发描述文件 `TimeToLive` 是 **365 天**（证书也是约 1 年）。如果只有 7 天，通常是创建时选了某些短时效选项（例如门户里的「离线支持」选项），或当前生效的是免费个人团队（Personal Team）的资源。创建后、安装前先校验：
>   ```bash
>   security cms -D -i <描述文件>.mobileprovision | plutil -p - | grep -E '"Name"|"ExpirationDate"|"TimeToLive"'
>   # 正常应看到 TimeToLive => 365、ExpirationDate 约一年后
>   security cms -D -i <App>.app/embedded.mobileprovision | plutil -p - | grep -E '"ExpirationDate"|"TimeToLive"'
>   ```
>   描述文件过期后 App 会启动失败，需要重新签名安装（设备 UDID 不在描述文件里同理）。
> - 同一 bundle id 覆盖安装会保留 App 数据（SecureStore 里的配对信息不丢，无需重新配对）。

Android（结构已就绪，未在本机验证）：

```bash
npx expo prebuild --clean
npx expo run:android --device
```

---

## 配置

`app.json` 关键项：

| 字段 | 值 | 说明 |
|---|---|---|
| `name` / `slug` | `DSH Remote` / `dsh-remote` | 显示名 / EAS slug |
| `scheme` | `dshremote` | 与二维码 URI 一致；未来可处理深链 |
| `ios.bundleIdentifier` | `com.amesucre.dshremote` | 已注册 App ID |
| `android.package` | `com.amesucre.dshremote` | 与 iOS 对齐 |
| `ios.infoPlist.ITSAppUsesNonExemptEncryption` | `false` | 仅标准 TLS/证书，免出口合规文档 |
| `plugins` | expo-camera / expo-secure-store / expo-local-authentication / expo-notifications / expo-build-properties | 权限文案与 iOS 16.4 部署目标 |
| `extra.dshRemote.relayDomain` | `relay.example.com` | 仅文档/POC 提示用，实际域名来自配对 URI |
| `extra.dshRemote.useNativeMtlsWebView` | `false` | 预留开关；当前由"原生模块可用 + `certRef` 存在"自动决定 |

`barcode-scanner` 未使用：Expo SDK 58 的 `expo-camera` `CameraView` 自带二维码扫描（`expo-barcode-scanner` 已废弃）。

---

## 配对流程（App 侧）

对应 [§4.3](../docs/remote-access-evaluation.zh.md) 与 [ADMIN-API.md §2/§3](../dsh-remoteService/docs/ADMIN-API.md)：

1. 桌面端「设置 → 远程访问 → 配对新设备」生成一次性密钥（32B，≤120s，单次使用）并显示二维码：
   `dshremote://pair?v=1&host=<hostId>.<relayDomain>&secret=<base64url>&hostfp=<base64url sha256>&exp=<unix 秒>&relay=<relayDomain>`
   - 直连端口模式下 `host` 会带端口，例如
     `host=h_xxx.relay.example.com:11443`；App 支持 `host:port`。
2. `PairingScreen` 扫码/粘贴 → `src/lib/protocol.ts` **本地严格校验**：
   - scheme/authority/path、`v=1`、host 必须是 `relay` 域名的子域（防篡改）、secret/hostfp 必须是 32 字节 base64url、`exp` 未过期、参数不重复。
   - 展示 **完整指纹**（分组显示）+ **短指纹**（人眼对照，仅展示、不作为 pin）+ 倒计时。
3. 「开始配对」→ 设备密钥 + CSR（**下一里程碑为原生生成**；POC 可打开"POC 调试选项 → 占位 CSR"仅用于 mock 主机）→ `POST https://<host>/__dsh_remote/pair`
   body：`{ secret, csrPem, deviceName, platform }`。
4. 主机若要求桌面确认，返回 `{ status: 'pending', ticket }`；`PairingScreen` 显示"等待桌面端确认"，每 1.5s 轮询
   `GET /__dsh_remote/pair/status?ticket=...`，直到 `paired | denied | expired`。
5. 收到 `paired` 后：**校验响应里的 hostFingerprint 必须等于二维码里的**（不一致 → `fingerprint_mismatch`，中止），把 host 元数据 + 证书 PEM 写入 SecureStore，并调用原生 `setClientIdentity(certRef)`。
6. 进入 `WebViewScreen` 加载 `https://<host>/?dsh_mobile=1`。

安全细节（实现对照）：
- **私钥不落 JS**：POC 的 `importP12` 由原生 Keychain/Keychain 安装；正式版在 Secure Enclave/AndroidKeyStore 内生成。
- **配对密钥不落日志**：`PairingUri.secret` 只在内存与 POST body 中出现，UI 不显示、不打印。
- **错误可读**：`PairingError` 带 `code`（network/timeout/denied/expired/fingerprint_mismatch/unsupported…），页面按 code 给出中文提示与重试路径。
- **传输可替换**：`PairingTransport` 接口允许后续换成原生 mTLS 传输（`createNativeMtlsTransportPlaceholder()` 已留位），页面代码无需改动。

---

## mTLS 原生模块（`modules/dsh-mtls`）

### JS API（`modules/dsh-mtls/src/index.ts`）

| 导出 | 作用 |
|---|---|
| `isDshMtlsAvailable` | 当前构建是否链接了原生模块（Expo Go 为 `false`） |
| `setClientIdentity(label)` / `clearClientIdentity()` / `getClientIdentityLabel()` | 配置/读取用于 TLS 客户端证书挑战的 Keychain/Keystore label |
| `importClientIdentityFromP12(base64, password, label?)` | **POC 调试**：把设备证书+私钥导入系统安全区（iOS：Keychain；Android：系统证书安装界面） |
| `generateCsr(commonName)` | **下一里程碑**：原生生成 P-256 密钥 + PKCS#10 CSR（当前抛 `DshMtlsUnsupportedError` 语义的错误） |
| `getDiagnostics()` | 身份是否存在、证书主题、到期时间、原生构建信息（不含密钥材料） |
| `getDshMtlsWebView()` | 返回原生 mTLS WebView 组件；模块缺失时返回 `null` |
| `defaultClientIdentityLabel(deviceId)` | 统一的 label 命名约定：`com.dsh.remote.device.<deviceId>` |

模块缺失时全部**优雅降级**：`requireOptionalNativeModule` 返回 `null`，`DevicesScreen` 显示"未链接"，`WebViewScreen` 回退到 `react-native-webview` 并显示 403 预警。

### 接入点（`src/screens/WebViewScreen.tsx`）

当前逻辑（POC）：

```ts
const NativeMtlsWebView = useMemo(() => getDshMtlsWebView(), []);
const useNativeMtlsView = NativeMtlsWebView !== null && Boolean(connection.certRef);
```

- 原生模块已编译 **且** 有设备身份（`certRef`）→ 使用 `<NativeMtlsWebView url=... clientIdentityLabel=... />`。
- 否则用 `react-native-webview`，并在顶部显示黄色提示：**它不会出示客户端证书，主机要求 mTLS 时会出现 403**（这是 POC 的预期失败模式，不是 bug）。

文件内有一段完整 TODO 注释说明替换步骤与 iOS/Android 的挑战回调实现位置。

### iOS 实现要点（`ios/`）

- `DSHMTLSWebView.swift`：`WKWebView` 子类 + `WKNavigationDelegate`。
  - `didReceive challenge`：
    - `NSURLAuthenticationMethodClientCertificate` → 按 label 从 Keychain 取 `SecIdentity` + 证书链 → `URLCredential(identity:certificates:persistence:.forSession)`；
    - 找不到身份时 `cancelAuthenticationChallenge` 并向 JS 发 `onLoadingError`（绝不静默继续）；
    - `ServerTrust` 用系统默认校验（TODO：可选 pin TLS 叶证书 SPKI）。
  - 把 `didStartProvisionalNavigation / didFinish / didFail*` 映射为 `onLoadingStart / onLoadingFinish / onLoadingError`。
  - `WKScriptMessageHandler` 暴露 `window.webkit.messageHandlers.dshMtlsBridge` → JS `onMessage`。
- `DSHMTLSIdentityStore.swift`：`SecPKCS12Import` 导入 + `SecItemAdd(kSecValueRef: label:)`、按 `kSecClassIdentity + kSecAttrLabel` 查找、`SecCertificateCopySubjectSummary`/有效期诊断、删除。
- `DSHMTLSModule.swift`：`Name("DSHMTLS")`、函数注册、`View(DshMtlsWebView.self)` + props/events。

### Android 实现要点（`android/`）

- `DshMtlsWebViewClient.kt`：`onReceivedClientCertRequest` → `DshMtlsIdentityStore.resolveIdentity(...)` → `request.proceed(privateKey, chain)`；失败 `request.cancel()` 并上报事件。**不放行 TLS 错误**（`onReceivedSslError` 一律 `cancel`）。
- `DshMtlsIdentityStore.kt`：
  - 系统 KeyChain（用户安装的 PKCS#12）：`KeyChain.getPrivateKey/getCertificateChain`；
  - AndroidKeyStore（正式路径）：`KeyStore("AndroidKeyStore").getKey(alias, null)` + certificate；
  - **AndroidKeyStore 不能导入外部私钥**，所以 `importP12` 走系统证书安装界面（`KeyChain.createInstallIntent` + `EXTRA_PKCS12`，需用户确认）。
- `DshMtlsWebView.kt`：`ExpoView` 包 `WebView`，暴露 `dshMtlsBridge` JS 接口与加载事件。
- `expo-module.config.json` 指向 `com.dsh.remote.mtls.DshMtlsModule`，Expo Autolinking 会自动发现 `modules/` 下的本地模块（已用 `npx expo-modules-autolinking search --platform ios` 验证）。

---

## POC：手动安装设备证书/私钥（验证 mTLS 链路）

> 正式流程（下一里程碑）：App 原生生成密钥 + CSR → `POST /pair` → 主机设备 CA 签发 → 原生把证书与私钥一起装进 Keychain/Keystore。
> 在 CSR 实现之前，用下面的手动路径验证 "客户端证书挑战 → 主机 mTLS → DSH UI 加载" 这一段。

请在 **Mac** 上执行（需要主机侧设备 CA 的签发能力；具体命令以 host plugin POC 脚本为准）：

```bash
# 1) 生成 P-256 设备密钥 + CSR（仅 POC；正式版密钥在手机安全区内生成）
openssl ecparam -name prime256v1 -genkey -noout -out device.key.pem
openssl req -new -key device.key.pem -subj "/CN=DSH Remote POC Device" -out device.csr.pem

# 2) 用主机的设备 CA 签发（CA 必须就是主机插件用来校验 mTLS 的那个设备 CA）
openssl x509 -req -in device.csr.pem -CA device-ca.pem -CAkey device-ca.key \
  -CAcreateserial -days 30 -out device-cert.pem

# 3) 打包 PKCS#12（iOS/Android 都能识别）
openssl pkcs12 -export -inkey device.key.pem -in device-cert.pem \
  -out device.p12 -passout pass:dshpoc

# 4) 复制 base64
base64 -i device.p12 | pbcopy        # macOS
# Linux: base64 -w0 device.p12
```

然后在 App 中：

1. 进入主界面右上角 ⚙︎ →「设备与安全」。
2. 展开「POC 调试：导入设备证书（PKCS#12）」。
3. 粘贴 base64、密码填 `dshpoc` →「导入设备证书」。
   - iOS：`SecPKCS12Import` 写入 Keychain，并自动 `setClientIdentity(<label>)`；
   - Android：打开系统证书安装界面，确认后 KeyChain alias 生效。
4. 成功后 `certRef` 会写回本地连接记录；返回主界面会切换到原生 mTLS WebView 并重新加载。
5. 在「设备与安全 → 原生 mTLS 模块」确认 `identityPresent = 是`、证书主题/到期时间正确。

**注意**：POC 手动证书只是测试链路；私钥在 Mac 上生成意味着它不再是"不可导出"，正式发布前必须切换到原生密钥生成。

---

## 本次交付实际执行过的验证

```text
$ npm install
# OK（Expo SDK 58 依赖安装成功；见 package-lock.json）

$ npx tsc --noEmit
# 无输出，exit code 0

$ npx expo config --type public
# 配置解析成功（修复过 expo-build-properties 要求的 iOS deploymentTarget ≥ 16.4）

$ npx expo-modules-autolinking search --platform ios
# 输出包含 dsh-mtls → modules/dsh-mtls（本地 Expo Module 会被链接）

$ node <protocol.ts 编译后的 Node 自测>
# 14 passed, 0 failed
#   覆盖：合法 URI / 过期 / relay 域名不匹配 / secret 长度 / 版本 / 重复参数 /
#         错误 scheme / 错误 authority / exp 格式 / 开发端口 / 指纹格式 /
#         备用码校验 / API URL 拼接 / buildPairingUri 往返
```

**未执行**（本机环境限制，不能声称完成）：

- `npx expo prebuild` / `pod install` / `npx expo run:ios` —— 需要完整 Xcode；
- Android Gradle 构建 —— 需要 Android SDK；
- EAS Build / TestFlight —— 需要 Apple Developer 账号；
- 真机 mTLS 握手 —— 需要 iPhone + 运行中的主机插件。

---

## POC 验收清单（在你的 Mac + iPhone 上）

- [ ] `npx expo prebuild --clean && npx expo run:ios --device` 构建成功，App 启动显示配对页。
- [ ] 扫码（或粘贴）主机二维码：页面显示 host、**完整指纹**、短指纹、剩余有效期。
- [ ] 主机侧收到 `POST /__dsh_remote/pair`（host 日志）；若要求审批，手机显示"等待桌面端确认"，桌面点「允许」后手机进入主界面。
- [ ] （POC 手动证书）「设备与安全」显示 `identityPresent = 是`，证书主题/到期时间正确。
- [ ] 主界面 WebView 成功加载 DSH UI（`https://<hostId>.<relayDomain>/?dsh_mobile=1`）。
- [ ] 对照组：未导入证书 / 使用 `react-native-webview` 时，主机返回 **403**（证明 mTLS 确实在生效，而不是被绕过）。
- [ ] iOS 设备控制台（Xcode → Window → Devices and Simulators → Open Console，或 Xcode 调试日志）能看到客户端证书挑战；主机侧 audit 记录本次访问。
- [ ] 页面内普通外链在系统浏览器打开；刷新按钮/下拉刷新可用；返回键行为正常。
- [ ] 重新配对：清除本地凭据 → 回到扫码页；旧证书在主机侧可撤销（桌面 UI）。
- [ ] 推送 token（`provider=apns` + `environment`）经 mTLS 注册到 `POST /__dsh_remote/push-token`（需主机先配置 APNs 私钥）。

---

## 已知差距 / TODO

**安全/身份**
- 原生 CSR 与 Secure Enclave / AndroidKeyStore 密钥生成（`generateCsr` 目前抛未实现异常）。
- 证书自动续期（默认 30 天，可配 7–90 天）与到期提醒。
- 可选：pin TLS 叶证书 SPKI（注意 `hostfp` 是**主机身份公钥**指纹，不是 TLS 证书指纹，二者不能混用）。
- App 锁：已接入生物识别（`expo-local-authentication`），交互/超时行为待真机验收。
- POC 的 `importP12` 是调试入口，不属于正式身份体系。

**功能**
- 推送：iOS 自托管 APNs 已接入（APNs device token + environment，经原生 mTLS 注册；前台应用内通知；通知点击跳会话已 2026-10-25 真机验证，其余验收项见 `docs/ACCEPTANCE.md`）；Android FCM 未接入。
- 设备列表/撤销：管理 API 只对本机浏览器开放且远程代理 deny，POC 在桌面端操作；后续可加 mTLS 隧道接口或深链。
- 多主机切换（一期单主机）；会话列表/审批等原生页面（App 审核 4.2 的长期对策）。
- iOS 下拉刷新：`react-native-webview` 无 iOS 下拉刷新，当前用顶部刷新按钮；原生 WebView 落地时可补。
- 文件上传/下载（WebView 原生选择器、分享面板）未专门处理。
- Android 的 KeyChain alias 选择/安装后回填、`importP12` 密码校验、AndroidKeyStore 正式路径需真机联调。

**工程**
- 未写 Jest/RNTL 组件测试；协议层已有 Node 自测（可提成正式测试）。
- 未配置 EAS Build 凭据、未做 CI。
- 应用图标/启动屏沿用模板资源，需替换为正式素材。
- `ios/`、`android/` 由 prebuild 生成，不入库；改了原生模块需重新 `prebuild --clean`（或 `pod install`）。
- WKWebView 客户端证书挑战在真机上的行为（含 WebSocket `/api/remote.mux`）必须实测；若不触发，fallback 是 `WKURLSchemeHandler` + `URLSession` 代理方案（见源码注释）。

---

## 排错

| 现象 | 原因/处理 |
|---|---|
| 启动报 "No bundle URL present" | Metro 没起：`npx expo start`；确认 dev client 与 Metro 同一网络。 |
| "当前构建未链接 mTLS 原生模块" | 用的是 Expo Go。`npx expo run:ios` 构建 dev client。 |
| WebView 一直 403 | 预期：`react-native-webview` 不带客户端证书，或证书未导入/不被主机 CA 信任。见「POC：手动安装设备证书」。 |
| `pod install` 失败 / 找不到 DSHMTLS | 先 `npx expo prebuild --clean`；确认 `modules/dsh-mtls/expo-module.config.json` 存在且 podspec 在 `ios/` 下。 |
| Xcode 签名错误 | Team 未选 / bundle id 冲突：在 Xcode 里设置 Team，或改 `app.json` 的 `ios.bundleIdentifier` 后重新 prebuild。 |
| `SecPKCS12Import` 失败（status ≠ 0） | 密码错误或 p12 不含证书+私钥（检查 `openssl pkcs12 -info -in device.p12`）。 |
| Android 导入后 `identityPresent=false` | 系统安装界面未确认完；或 alias 与 `setClientIdentity` 的 label 不一致。重新进入该页刷新诊断。 |
| 扫码无反应（模拟器） | iOS 模拟器没有可用相机；用"手动粘贴配对链接"。 |
| 扫码后“网络连接失败” | ① 旧二维码没带新端口，重新生成；② `*.relayDomain` 泛解析缺失；③ 手机开了代理/VPN/Private Relay；④ 云安全组/防火墙没放通直连端口；⑤ 主机数据面证书不是 `*.<relayDomain>` 或主机子域证书。用手机 Safari 打开配对 URL 验证。 |
| 配对请求到了主机但 App 无响应 | 检查主机是否在等待桌面「允许配对」；确认 App 与主机时钟正常。 |

---

## 参考

- 接口契约：[`../dsh-remoteService/docs/ADMIN-API.md`](../dsh-remoteService/docs/ADMIN-API.md)
- 方案评估（§4.3 配对、§4.4 密钥层级、§4.7 App 设计）：[`../docs/remote-access-evaluation.zh.md`](../docs/remote-access-evaluation.zh.md)
- Expo SDK 58 / RN 0.88；本地 Expo Module 文档：`npx create-expo-module --local`、Expo Modules API（`Module` / `View` / `EventDispatcher` / `Prop`）。
