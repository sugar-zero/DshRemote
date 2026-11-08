# DSH Remote App


> 许可证：**AGPL-3.0-or-later**（完整文本见根目录 [`LICENSE`](../LICENSE)）。
> 手机端外壳：**Expo / React Native (TypeScript)**，iOS 优先、Android 同步搭骨架。
>
> 相关文档：
> [根目录总览](../README.md) ·
> [服务器部署](../server/README.md) ·
> [主机插件](../dsh-remoteService/packages/host-plugin/README.md) ·
> [服务端 monorepo](../dsh-remoteService/README.md)

> **本 App 只有群体服务版（A 模式 / token 鉴权）。**
> 原先 classic/单体版的设备 mTLS 证书模式（CSR、PKCS#12 证书导入、原生 mTLS WebView、
> 证书诊断）已**全部从 App 删除**，不会回退；
> iOS APNs 推送 0.1.8 起重新接入；0.1.9（R2）起**官方推送与 relay 解耦**：官方 App 用设备密钥
> 向官方 hub 换设备凭证、主机直连 hub，部署方自签 App 仍经 relay（见下文「推送」章节）；
> 「重启主机 DSH」作为群体版可选组件保留（host 端开启后 App 顶栏出现 ⏻）。

它做这些事：

1. **扫码配对**：扫主机「远程访问」生成的 `dshremote://pair?v=2&...&auth=token` 二维码
   （或手动粘贴），本地严格校验主机地址、完整 SHA-256 指纹、端口、有效期。
2. **安全存储**：`expo-secure-store`（iOS Keychain / Android EncryptedSharedPreferences）保存
   主机元数据、设备 ID、设备密钥 label；**设备私钥只在 Secure Enclave / AndroidKeyStore**，
   永不进入 JS；会话 token **不落盘**。
3. **加载 DSH Web UI**：`https://<hostId>.<relayDomain>:<port>/?dsh_mobile=1`。
   relay 在边缘终止手机 TLS、按短时 token 校验后反代到主机；外部链接（`target=_blank` /
   `window.open`，如查询用量/充值/意见反馈）在 App 内嵌浏览器打开（可一键切系统浏览器）。
4. **token 会话**：challenge → 原生 P-256 签名 → 短时 token（15–30 分钟）→
   `__Host-dsh_session` cookie（host-only / Secure / SameSite=Strict）；进入主机、回前台、
   每 30s native 续期，token 只在内存与 WebView cookie store。
5. **页面外壳**：注入手机布局（抽屉/全屏侧栏/设置壳/内嵌浏览器）；iOS 可 defer 底部系统手势。
6. **iOS APNs 推送（0.1.8+；0.1.9 R2）**：进入主机拿到会话 token 后登记 APNs device token
   （`/__dsh_remote/push-token`，64 hex + `aps-environment`；token 不落盘、不打印）；
   官方构建额外用设备密钥向官方 hub 换 per-device credential（SecureStore 缓存），主机直连 hub；
   前台/后台/锁屏显示系统通知；点通知按 `data.host`/`data.hostId` 打开对应主机，
   `data.sessionId`（self 模式）存在时进入后调用 `window.__DSH_REMOTE_OPEN_SESSION__` 直达会话；
   设置页「推送」卡显示状态（自部署/官方模式）、开关与「重新注册」。Android FCM 未接入。
5. **App 锁**：全局开关在 App「设置」页（只从主机列表右上角 ⚙ 进入），只负责**冷启动解锁**；
   如需某台主机在打开时也要求 Face ID / Touch ID，在该主机的「设备与安全」里单独开启
   「打开此连接时要求面容」（入口：主机列表卡片上的 ⚙，或**进入主机后**顶栏的 ⚙；
   仅在全局 App 锁开启时生效；进入主机后的同步/心跳/切会话不会要求）。
6. **底部边缘手势（iOS）**：进入主机页面时 defer 底部（Home 指示条）的「上滑回主屏」系统
   手势——页面里的可拖动悬浮挂件贴到屏幕最底边时，仍能从底边起手拖动而不会把 App 切到后台；
   离开主机页面恢复系统默认。代价：在主机页面里从最底边上滑回主屏需连划两次（第一次只高亮）。
   该行为默认开启，可在 App「设置 → 主机页面手势 → 挂件贴底拖动」关闭（关闭后恢复一次上滑
   回主屏，但挂件贴最底边时从底边起手拖仍可能被系统手势抢走）。

接口契约（群体版）见 `dsh-remoteService/docs/group-service-design.zh.md` 与 relay README §10；
本分支只保留群体版；classic/单体版的设备管理/证书/推送/重启接口已从服务端删除。

---

## 当前状态（0.2.0 / 构建号 18，官方构建已装机、待用户验收）

| 项 | 状态 |
|---|---|
| iOS Release 构建 / 真机安装 | build 15 已装机验收；build 16 已装机；0.1.9 build 17 已装机（self 包）；**0.2.0 build 18 官方包（`EXPO_PUBLIC_PUSH_CHANNEL=official` + 官方 hub 地址）签名构建 ✅ 并已装机（2026-11-08），待用户验收**；手动签名，无 dev-client/DevMenu |
| 群体版配对（v2 token + P-256 设备密钥 + SAS 确认） | ✅ 0.1.0 真机通过；0.1.1 剥离 classic 后**待用户复测** |
| token 会话（challenge→签名→token→`__Host-` cookie、单飞/重试、404 设备失效提示） | ✅ 0.1.0 真机通过；0.1.1 **待复测** |
| 主机列表 / 连接设置（设备与安全）/ App 设置页 | ✅ 已实现；**0.1.6+ 起 App 设置页只保留版本 / App 锁 / 主机页面手势 / 缓存**，设备与安全只从「每个主机」进入（列表卡片 ⚙ 或进入主机后顶栏 ⚙） |
| 底部边缘系统手势（iOS，0.1.7+） | ✅ 进入主机页面 defer「上滑回主屏」一次（挂件贴底可拖），离开恢复默认；App 设置里可关闭（默认开） |
| 键盘弹出后删字页面上下跳（build 16 起修复，0.1.9/17 继续包含） | ✅ 已修复（WebView 加 `KeyboardAvoidingView`，页面不再被 WKWebView 滚来滚去）；**待用户真机复测**，见 [`../docs/diagnostics/13-app-keyboard-composer-bounce.md`](../docs/diagnostics/13-app-keyboard-composer-bounce.md) |
| 隧道 WebView（`react-native-webview` + 注入手机壳） | ✅ `npm run check:shell` 无头 Chrome 回归；真机 **待复测** |
| ExternalPageScreen 内嵌浏览器 | ✅ 保留（群体版外链用） |
| iOS/Android 原生模块 | ✅ 只保留群体版：`DSHMTLSGroupKeys.swift` / `DshMtlsGroupKeys.kt`（P-256 密钥/签名/cookie/缓存清理） |
| iOS APNs 推送（0.1.8+；0.1.9 R2） | ✅ 已实现：进入主机登记 token、点通知打开主机/会话、设置页「推送」卡（开关/通道/状态/重新注册）；**待用户真机验收** |
| 推送 R2（0.1.9，官方 App 设备直连 hub；self 仍经 relay） | ✅ 已实现：设备密钥向官方 hub 换 per-device credential（SecureStore 缓存/续期）、`/__dsh_remote/push-token` 扩展字段、设置页通道与按通道设备数；**待用户真机验收** |
| 「重启主机 DSH」 | ✅ 恢复为群体版可选组件（host-plugin ≥0.2.1；主机设置 → 远程访问 → 组件开启后 App 顶栏显示 ⏻） |
| classic/单体 mTLS（CSR/证书/P12/原生 mTLS WebView/证书诊断） | ❌ 已删除 |
| Android 构建 | ⏳ 源码只保留 group 能力；未在有 Android SDK 的环境编译 |

> 原生构建需要 macOS + Xcode；本仓库不提交生成的 `ios/`/`android/` 目录和签名材料。
> 改原生模块后必须重新 `expo prebuild` + `pod install` 再构建，不能只换 JS bundle。

## 目录结构

```
dsh-remoteApp/
├── App.tsx                        # 极简导航状态机：loading → pairing → home ⇄ webview | devices | settings
├── index.ts                       # Expo 入口（registerRootComponent）
├── app.json                       # name/scheme/bundle id/android package/plugins/版本号
├── tsconfig.json                  # strict + noUncheckedIndexedAccess
├── package.json                   # Expo SDK 58（RN 0.88 / React 19）
├── src/
│   ├── theme.ts                   # 颜色/间距/共享样式
│   ├── lib/
│   │   ├── protocol.ts            # v2 配对 URI 解析/校验、指纹展示、群体版 URL 与信封类型（纯函数）
│   │   ├── group.ts               # 群体版配对 + token 会话（challenge→签名→token→cookie）
│   │   ├── push.ts                # iOS APNs：权限/device token/environment/登记 + 设置页开关与状态
│   │   ├── pushConfig.ts          # 推送通道打包配置（EXPO_PUBLIC_PUSH_CHANNEL/_HUB；默认 self/空）
│   │   ├── pushHub.ts             # R2 官方推送：设备凭证登记（challenge→设备签名→enroll→credential）
│   │   ├── store.ts               # SecureStore 封装（只存群体版连接记录；classic 记录加载时丢弃）
│   │   ├── appLock.ts             # App 锁（生物识别）
│   │   ├── deviceName.ts          # 系统设备名 / 配对默认设备名
│   │   └── mobileWebShell.ts      # 注入 DSH Web UI 的手机布局壳（字符串 JS）
│   └── screens/
│       ├── PairingScreen.tsx      # 相机扫码 + 手动粘贴 + 指纹 + 桌面确认等待（SAS）
│       ├── HomeScreen.tsx         # 已配对主机列表（打开/连接设置/删除/配对新主机/App 设置）
│       ├── WebViewScreen.tsx      # 主界面：token 会话 + 隧道 WebView + 外链；顶栏 ⚙ → 该主机连接设置
│       ├── DevicesScreen.tsx      # 设备与安全（每台主机的连接设置）：主机信息/设备密钥 label/面容开关/解除配对
│       ├── SettingsScreen.tsx     # App 系统设置（仅从主机列表进入）：版本 / App 锁 / 推送 / 清理缓存
│       ├── LockScreen.tsx         # App 锁
│       └── ExternalPageScreen.tsx # 内嵌浏览器（外链）
├── scripts/
│   ├── check-native-sources.mjs   # 原生模块源码一致性检查（含 classic 文件必须已删除）
│   └── check-injected-shell.mjs   # 注入手机壳的无头 Chrome 回归
└── modules/dsh-mtls/              # 本地 Expo Module（模块名保留 DSHMTLS，内部只有 group 代码）
    ├── expo-module.config.json
    ├── src/index.ts               # JS 桥（requireOptionalNativeModule，缺失时优雅降级）
    ├── ios/
    │   ├── DSHMTLS.podspec
    │   ├── DSHMTLSModule.swift    # Module 定义：group 函数 + setSessionCookie + clearWebCache + 底部手势 defer
    │   ├── DSHMTLSBottomEdgeGestures.swift # iOS 底部边缘系统手势 defer（挂件贴底拖动）
    │   └── DSHMTLSGroupKeys.swift # Secure Enclave P-256 密钥生成/公钥导出/ECDSA 签名/删除
    └── android/
        ├── build.gradle
        └── src/main/java/com/dsh/remote/mtls/
            ├── DshMtlsModule.kt       # Module 定义（group 函数 + cookie + 缓存清理 + 手势 defer no-op）
            └── DshMtlsGroupKeys.kt    # AndroidKeyStore P-256 密钥/签名
```

---

## 前置要求

- **macOS + 完整 Xcode**（App Store 安装，打开一次同意许可；`xcode-select -p` 应指向 `Xcode.app/Contents/Developer`）。
- **CocoaPods**（`brew install cocoapods` 或 `sudo gem install cocoapods`）。
- **Node.js ≥ 20**、npm ≥ 10。
- **Apple Developer 账号**：真机安装需要签名。推送还需 App ID 开启 Push Notifications 能力：
  `expo-notifications` config plugin 会在构建产物里生成 `aps-environment` entitlement
  （开发签名 = development；TestFlight/App Store = production，由签名 profile 决定）。
  服务端（relay / 官方 hub）需要自己的 APNs Auth Key（`.p8`），**不在 App 仓库**。
- **iPhone 运行 iOS 16.4+**（Expo SDK 58 / RN 0.88 的最低部署目标，`expo-build-properties` 固定为 16.4）。
- **主机侧已经跑起来**：`dsh-remoteService` 的 relay + host plugin，且主机在桌面 DSH
  「远程访问」里开启了群体服务（生成 v2 token 配对二维码）。没有主机时只能验证 UI 与协议解析。

- **官方推送（R2，仅官方构建）**：官方 App 构建需注入 `EXPO_PUBLIC_PUSH_CHANNEL=official` +
  `EXPO_PUBLIC_PUSH_HUB=https://push.example.com`（占位符；真实地址只放本机构建环境/CI secret）；
  官方 hub 需已部署（https、`HUB_PUBLIC_URL`、APNs topic = 官方 bundle id、`HUB_ENROLL_ENABLED=true`）。
  部署方自签（self）构建不注入，继续经 relay 推送（relay 配自己的 APNs key）。

> **Expo Go 不可用**：`modules/dsh-mtls` 是本地原生模块，Expo Go 不包含它；必须构建原生包。
> 代码在模块缺失时不会崩溃，只会提示"当前构建未链接原生模块"。

---

## 构建与安装（iOS 真机）

```bash
cd dsh-remoteApp
npm install                 # 已完成；锁文件见 package-lock.json

# 1) 生成原生工程（ios/、android/ 由 config 生成，已加入 .gitignore）
npx expo prebuild -p ios --no-install

# 2) 原生依赖（Pods）
cd ios
mkdir -p .pods-home .pods-cache
CP_HOME_DIR="$PWD/.pods-home" CP_CACHE_DIR="$PWD/.pods-cache" pod install
cd ..

# 3) Release 构建（手动签名参数按你本机替换；不要提交任何签名材料）
xcodebuild -workspace ios/DSHRemote.xcworkspace -scheme DSHRemote -configuration Release \
  -destination 'generic/platform=iOS' -derivedDataPath /tmp/dsh-ios-group \
  CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM=<TEAM_ID> \
  PROVISIONING_PROFILE_SPECIFIER=<PROFILE_UUID> \
  CODE_SIGN_IDENTITY='Apple Development: <NAME> (<CERT_ID>)' build

# 4) 安装 + 启动（USB 或已配对的局域网设备）
xcrun devicectl device install app --device <IPHONE_UDID> \
  /tmp/dsh-ios-group/Build/Products/Release-iphoneos/DSHRemote.app
xcrun devicectl device process launch --device <IPHONE_UDID> <BUNDLE_ID>
```

> - Release 构建把 JS 打进 `main.jsbundle`（Hermes 字节码），手机端不需要 Metro。
> - 改了 `app.json` 的 `version`/`buildNumber` 后要重新 `expo prebuild`：`xcodebuild` 实际读的是
>   生成的 `ios/DSHRemote/Info.plist`。
> - 同一 bundle id 覆盖安装会保留 App 数据（SecureStore 里的群体版配对信息不丢）；
>   但 classic 版遗留的连接记录在 0.1.1 首次加载时会被直接丢弃，需要重新扫码配对。
> - 签名/描述文件属敏感材料：只留在仓库外，不要提交、不要写进文档。

---

## 配置

`app.json` 关键项：

| 字段 | 值 | 说明 |
|---|---|---|
| `name` / `slug` | `DSH Remote` / `dsh-remote` | 显示名 / EAS slug |
| `scheme` | `dshremote` | 与二维码 URI 一致 |
| `ios.bundleIdentifier` / `android.package` | `<BUNDLE_ID>` | 已注册 App ID（两端对齐） |
| `version` | `0.2.0`（iOS build **18** / Android versionCode **18**） | 群体版 App 版本线（0.2.0 build 18 = 官方构建；0.1.9 build 17 = self 包，代码相同） |
| `ios.buildNumber` / `android.versionCode` | `18` / `18` | 每次构建递增，便于区分安装包（build 17 = R2 self 包；build 18 = 官方构建，代码相同） |
| `ios.infoPlist.ITSAppUsesNonExemptEncryption` | `false` | 仅标准 TLS，免出口合规文档 |
| `plugins` | expo-camera / expo-secure-store / expo-local-authentication / **expo-notifications（color `#4F8DF7`）** / expo-build-properties | 权限文案、APNs entitlement（`aps-environment`）与 iOS 16.4 部署目标 |
| `EXPO_PUBLIC_PUSH_CHANNEL` / `EXPO_PUBLIC_PUSH_HUB`（**构建环境变量**，不在 app.json） | 默认 `self` / 空 | 官方构建注入 `official` + 官方 hub 公开地址；**真实地址/凭据不写进仓库**（build 18 已按此构建），self 构建无需设置 |

`modules/dsh-mtls/android/build.gradle` 的 `versionCode` 与 `versionName` 同 `app.json` 保持一致。

---

## 群体版配对流程（App 侧）

1. 主机端生成一次性密钥（32B，≤120s，单次使用）并显示二维码：
   `dshremote://pair?v=2&host=<hostId>.<relayDomain>&port=<port>&secret=<base64url>&hostfp=<base64url sha256>&exp=<unix 秒>&auth=token&relay=<relayDomain>&hostid=<hostId>`
2. `PairingScreen` 扫码/粘贴 → `src/lib/protocol.ts` **本地严格校验**：
   - scheme/authority/path、`v=2`、`auth=token`、host 必须是 `<hostid>.<relayDomain>`（防篡改）、
     port 合法、secret/hostfp 必须是 32 字节 base64url、`exp` 未过期、参数不重复。
   - 展示 **完整指纹**（分组）+ **短指纹**（人眼对照，仅展示、不作为 pin）+ 倒计时。
3. 「开始配对」→ 原生生成/复用 P-256 设备密钥（Secure Enclave / AndroidKeyStore）→
   `POST https://<host>:<port>/__dsh_remote/pair`，body：`{ secret, publicKey, deviceName, platform }`。
4. 主机若要求桌面确认，返回 `{ status: 'pending', ticket, sas? }`；App 显示"等待桌面确认"（含 SAS），
   每 1.5s 轮询 `GET /__dsh_remote/pair/status?ticket=...`，直到 `paired | denied | expired`。
5. 收到 `paired` 后：**校验响应里的 hostFingerprint 必须等于二维码里的**（不一致 →
   `fingerprint_mismatch`，中止），把主机元数据 + `deviceKeyLabel` 写入 SecureStore，进入主界面。

安全细节（实现对照）：
- **私钥不落 JS**：P-256 私钥在 Secure Enclave（iOS）/ AndroidKeyStore 内生成和持有，
  JS 只能拿到公钥（配对用）和签名结果。
- **配对密钥不落日志**：`GroupPairingUri.secret` 只在内存与 POST body 中出现，UI 不显示、不打印。
- **错误可读**：`GroupPairingError` 带 `code`（network/timeout/denied/expired/fingerprint_mismatch/
  pending_timeout/native_unavailable…），页面按 code 给出中文提示与重试路径。

---

## token 会话流程（进入主机后）

```
POST /__group/auth/challenge { deviceId }
  → { nonce, expiresAt }
原生 signGroupChallenge(label, base64(hostId \n deviceId \n nonce))
  → base64url(DER ECDSA-SHA256)
POST /__group/auth/token { deviceId, nonce, signature }
  → { token, expiresAt }（15–30 分钟）
原生 setSessionCookie({ url, name:'__Host-dsh_session', value:token, maxAgeSeconds })
  → WebView 后续请求自动携带 cookie
```

- 进入主机 / 重新可见 / 回前台 / 每 30s 调用一次 `ensureGroupSessionIfNeeded`；缓存有效时只重放
  cookie，不重复请求；并发调用单飞，避免重复消费 challenge。
- 首次进入偶发 401/403 时自动强制刷新一次 token 再重试（60s 内最多一次）。
- relay 返回 404 / `unknown_device`：提示「设备已在主机侧失效，请删除本机连接后重新扫码配对」。
- token 只在内存 + WebView cookie store：**不写 SecureStore、不打印、不落日志**。

---

## 推送（iOS APNs；R2：官方推送与 relay 解耦）

契约见根目录 [`docs/group-push-r2-contract.zh.md`](../docs/group-push-r2-contract.zh.md) §3/§5
（O1 历史契约 [`docs/group-push-design.zh.md`](../docs/group-push-design.zh.md)；self 推送仍有效，official 转发已删除）。

**两条通道**：

| 通道 | 构建标记 | 登记 / 发送路径 |
|---|---|---|
| `self`（默认；部署方自签 App） | 不注入（或 `EXPO_PUBLIC_PUSH_CHANNEL=self`） | App → 主机 `/__dsh_remote/push-token` → 主机经 **relay 自己的 APNs 通道**推送 |
| `official`（官方 App） | `EXPO_PUBLIC_PUSH_CHANNEL=official` + `EXPO_PUBLIC_PUSH_HUB=https://<官方 hub>` | App 用**群体版设备密钥**向官方 hub 换 per-device credential → 交给主机 → 主机**直连官方 hub** 推送（不依赖部署方 relay 的推送配置） |

**App 登记链路**：

```
进入主机 / 回前台 / 会话 token 可用（或设置页「重新注册」）
  → 通知权限（请求一次；被拒不阻断进入主机）
  → APNs device token（getDevicePushTokenAsync，64 hex）
    + environment（getIosPushNotificationServiceEnvironmentAsync，读不到按 production）
  → [official] POST {hub}/v1/enroll/challenge {devicePublicKey}
       → pushEnrollMessage(版本/challengeId/nonce/devicePublicKey/hostId/token/environment/bundleId，
         UTF-8、\n 连接、无末尾换行) → base64 → 设备私钥 ECDSA-SHA256 签名
       → POST {hub}/v1/enroll → credential + expiresAt
         （SecureStore 缓存；key = hash(endpoint|token|hostId)，剩余 >24h 复用）
  → 原生请求（带 __Host-dsh_session）POST https://<host>:<port>/__dsh_remote/push-token
       self:     { provider:'apns', token, environment }                         // 旧 body 不变
       official: { provider:'apns', token, environment,
                   channel:'official', bundleId, hubEndpoint, credential }
  → 200 { ok:true, data:{ registered:true, channel:'self'|'official' } }
```

- **官方通道失败不回退 relay**：hub 不可达 / 凭证换不到 → 不发送登记，设置页显示
  「官方推送暂不可用：<原因>」，进入主机 / 回前台时自动重试（避免同一通知重复推送）。
- **token / credential 安全**：APNs device token 只出现在请求体；credential 只存 SecureStore
  （value 不含 token 明文，key 是 `endpoint|token|hostId` 的摘要 hash）；两者都不打印、不进错误文案。
- **打包配置**：`src/lib/pushConfig.ts` 读构建期常量；仓库默认 `self` + 空 endpoint（**不写真实地址**）。
  官方构建由 owner 注入 `EXPO_PUBLIC_PUSH_CHANNEL=official EXPO_PUBLIC_PUSH_HUB=https://<hub>`。
- **失败降级**：self 的 401/403/503/超时语义与 0.1.8 相同；official 额外处理 hub 限流、
  challenge 过期（自动换一次）、`unsupported_bundle_id`（官方构建配置不匹配）、`enroll_disabled` 等可读原因。
- **通知点击**：`body.host`/`body.hostId` 匹配本机已配对连接打开对应主机；`body.sessionId`
  （self 模式）存在时，WebView 页面加载完成后注入
  `window.__DSH_REMOTE_OPEN_SESSION__(sessionId)` 直达会话；official 模式不带 sessionId。
- **设置页「推送」卡**：本地开关（默认开）、「推送通道：官方（设备直连）/ 自部署（经 relay）」、
  状态文案（未注册 / 已注册（官方推送/自部署）/ 权限被拒 / 服务器未开启 / 错误原因）、
  服务器状态（`/__dsh_remote/status.push`：R2 按通道的 `self.devices` / `official.devices`
  与 `lastError`、`mode=self|official|mixed`、官方 `hub`；旧版 Host 回退扁平字段）、「重新注册」。
- **关闭开关的边界**：只停止本机登记；主机侧「设置 → 远程访问 → 推送提醒」关闭或设备撤销后
  才会彻底停止推送；官方 credential 到期（hub 默认 30 天，0.3.1 起）后由 App 进入主机/回前台时续期。
- **Android**：FCM 未接入（返回明确原因「Android FCM 未接入」）。

> 真机验收需要：官方包内置官方 hub 地址且 hub 已部署（https）；self 需要 relay 配好 APNs；
> 主机侧 host-plugin **≥0.2.6** 才支持 official 设备直连。模拟器 / Expo Go 拿不到 device token 属预期。

---

## 原生模块（`modules/dsh-mtls`，内部只有群体版）

### JS API（`modules/dsh-mtls/src/index.ts`）

| 导出 | 作用 |
|---|---|
| `isDshMtlsAvailable` | 当前构建是否链接了原生模块（Expo Go 为 `false`） |
| `generateGroupDeviceKey(label?)` | 生成/复用 P-256 设备密钥，返回 base64url 未压缩公钥 + label |
| `getGroupDevicePublicKey(label?)` | 读取已存在设备公钥（不存在为 `null`） |
| `signGroupChallenge(label, messageBase64)` | ECDSA-SHA256 签 challenge，返回 base64url DER |
| `clearGroupDeviceKey(label?)` | 删除设备密钥（解除配对时用；幂等） |
| `setGroupSessionCookie(options)` | 把短时 token 注入 `__Host-` host-only cookie |
| `clearWebCache()` | 清理 WebView 缓存/Cookie/本地存储（设置页「清理缓存」） |

模块缺失时全部**优雅降级**：`requireOptionalNativeModule` 返回 `null`，配对页/设置页给出可读提示。

### 原生实现要点

- **iOS**（`ios/`）：
  - `DSHMTLSGroupKeys.swift`：`SecKeyCreateRandomKey`（Secure Enclave 优先，失败回退软件 Keychain）、
    按 `applicationTag` 查私钥、`SecKeyCopyExternalRepresentation` 导出 65B 未压缩点、
    `SecKeyCreateSignature(.ecdsaSignatureMessageX962SHA256)` 签名。
  - `DSHMTLSModule.swift`：`Name("DSHMTLS")` + group 函数 + `setSessionCookie`
    （`HTTPCookie`：Secure/SameSite=Strict/host-only；HttpOnly 由 relay `Set-Cookie` 在 WebView 内写入）
    + `clearWebCache`（`WKWebsiteDataStore.removeData` + `URLCache`）。
- **Android**（`android/`）：
  - `DshMtlsGroupKeys.kt`：`KeyGenParameterSpec`（EC `secp256r1`、PURPOSE_SIGN、StrongBox 优先）、
    `Signature("SHA256withECDSA")`；公钥（非秘密）按 alias 缓存在 SharedPreferences。
  - `DshMtlsModule.kt`：group 函数 + `CookieManager.setCookie`
    （`Path=/; Secure; HttpOnly; SameSite=Strict`，不设 Domain）+ 缓存/Cookie/存储清理。
- `expo-module.config.json` 指向 `DSHMTLSModule` / `com.dsh.remote.mtls.DshMtlsModule`；
  Expo Autolinking 自动发现 `modules/` 下的本地模块。

---

## 手机布局（注入 `MOBILE_WEB_SHELL_JS`）

- 会话侧栏 → 左侧抽屉；窄屏右栏 → 全屏覆盖层；窄屏设置 → 全屏 + 分区菜单抽屉；
  外链 → App 内嵌浏览器（`ExternalPageScreen`，可切系统浏览器）；
  窄屏隐藏 DSH 的「在主机本机打开」控件（open-in-app，只按稳定 `data-*` 属性隐藏控件本身、
  不整段隐藏插件槽位）。实现见 `src/lib/mobileWebShell.ts` / `src/screens/WebViewScreen.tsx`，
  `npm run check:shell` 用无头 Chrome 回归。

---

## 验证命令

```bash
cd dsh-remoteApp
npx tsc --noEmit          # TypeScript 全量检查
npm run check:native      # JS bridge ↔ iOS/Android 原生导出 + classic 文件已删除 + 括号平衡
npm run check:shell       # 注入手机壳的无头 Chrome 回归（59 项）
npm run check:ios-env     # Xcode / CocoaPods 环境自检
npm run check:android-env # Android SDK 环境自检
```

原生构建/真机验证不能只靠静态检查；按上面「构建与安装」把包装到真机并实测。

---

## 真机验收清单（0.1.9 build 17 — 待用户验收）

> 本版本 = **R2「官方推送与 relay 解耦」** + build 16 的键盘避让修复（build 16 尚未由用户验收，
> 本轮一并复验）。官方 App 构建内置官方 hub 地址（`EXPO_PUBLIC_PUSH_CHANNEL=official`
> `EXPO_PUBLIC_PUSH_HUB=https://<hub>`），用设备密钥向 hub 换 per-device credential 后交给主机，
> 主机**直连 hub** 推送（不依赖部署方 relay 的推送配置）；部署方自签 App（self）仍经 relay。
> **构建/安装成功 ≠ 验收通过，以下由用户实测后勾选。**

- [ ] 覆盖安装 0.1.9 (**build 17**) 后 App 正常启动；已有配对 / App 锁 / 推送偏好保持（无需重新配对）。
- [ ] **键盘/输入框（build 16 修复，本轮复验）**：进入会话点输入框 → 聊天区不再整体上滚、会话 header 仍在；
      连续删除文字 10+ 次，页面与输入框**不再上下跳**；键盘收起后布局恢复、无残留空白。
- [ ] **official 通道**：官方 App 在**未开启推送的部署方 relay** 下进入主机 → 设置页显示
      「推送通道：官方（设备直连）」、状态「已注册（官方推送）」；主机 `/__dsh_remote/status.push.official.devices ≥ 1`。
- [ ] official 设备触发 turn-end / ask_user_question → 手机在前台/后台/锁屏收到系统通知；点通知打开对应主机。
- [ ] official 凭证自动续期：凭证剩余 <24h 后回前台/重新进入主机会重新向 hub 登记（无需手动操作）；
      hub 不可达时显示「官方推送暂不可用：<原因>」，主流程不受影响，恢复后自动重试。
- [ ] **self 通道回归**：自部署 App 仍经 relay 推送正常（前台/后台/锁屏、点通知打开主机/会话）；
      `status.push.self.devices` 正确；同一主机混用 self + official 设备时两者各自收到。
- [ ] 主机「推送提醒」关闭 → 两种通道都不再推送；设备撤销后主机清理对应 token（status 设备数减少）。
- [ ] App「推送」开关关闭后不再登记新 token；重新打开 +「重新注册」恢复；hub/relay 未开启推送时显示明确状态。
- [ ] 日志、设置页、主机 status 不含 token / credential / 密钥（安全项）。
- [ ] 其它功能不回归：配对、会话/消息/WebSocket、token 续期、重启主机 ⏻、外链内嵌浏览器、清理缓存、App 锁。

## 历史真机验收清单（0.1.8 build 16 — **已被 0.1.9 build 17 取代，验收项并入上方清单**）



> 本版本新增 **iOS APNs 推送**：进入主机登记 APNs device token、前台/后台/锁屏系统通知、
> 点通知打开对应主机（self 模式直达会话）、App 设置页「推送」卡（开关/状态/重新注册）。
> 需要服务端已配置推送（self：relay `group.push` 用部署方 APNs key；official：官方 hub）且
> 主机「设置 → 远程访问 → 推送提醒」开启。**构建/安装成功 ≠ 验收通过，以下由用户实测后勾选。**
>
> build 16 另修复「键盘弹出后删除文字页面上下跳动」：WebView 外层加 `KeyboardAvoidingView`
> （iOS `padding`），键盘出现时 WebView 缩到键盘上方，页面不再被 WKWebView 自动滚动。
> 根因/修复细节见 [`../docs/diagnostics/13-app-keyboard-composer-bounce.md`](../docs/diagnostics/13-app-keyboard-composer-bounce.md)。

- [ ] 覆盖安装 0.1.8 (**build 16**) 后 App 正常启动；已有配对 / App 锁 / 推送偏好保持（无需重新配对）。
- [ ] **键盘/输入框（build 16 修复）**：进入会话点输入框 → 聊天区不再整体上滚、会话 header 仍在；
      连续删除文字 10+ 次，页面与输入框**不再上下跳**；键盘收起后布局恢复、无残留空白。
- [ ] 首次进入主机弹出系统「允许通知」；允许后设置页「推送」显示「已注册（模式：自部署/官方）」；
      拒绝后显示「通知权限被拒」，进入主机/会话等主流程不受影响。
- [ ] **self 模式**：App 在前台、后台、锁屏三种状态下都能收到系统通知（`turn-end`「任务已完成」与
      `ask_user_question`「正在等待你的回答」各验证一次；会话摘要通知一次）。
- [ ] **official 模式**：经官方推送 hub 收到通用文案通知；点通知打开对应主机（不带 sessionId）。
- [ ] 点通知：App 在后台运行与被杀（冷启动）两种状态下都能打开通知对应主机；
      self 模式带 `sessionId` 时进入后直接打开该会话。
- [ ] 通知对应主机不在本机（已解除配对）时提示无法打开，不崩溃、不跳到错误主机。
- [ ] 主机「设置 → 远程访问 → 推送提醒」关闭后不再收到推送；App「推送」卡服务器状态同步变化。
- [ ] App「推送」开关关闭后不再登记新 token；重新打开后点「重新注册」恢复登记；
      relay 未开启推送时 App 显示「服务器未开启推送」且主流程正常。
- [ ] 其它功能不回归：配对、会话/消息/WebSocket、token 续期、重启主机 ⏻、外链内嵌浏览器、清理缓存、App 锁。

## 历史真机验收清单（0.1.7 build 14 — ✅ 2026-11-01 用户验收通过）

> 本次三处改动：① **进入主机后**顶栏 ⚙ 改为打开该主机的连接设置，App「系统设置」页去掉
> 底部「设备与安全」入口（纯 JS/TS）；② iOS 进入主机页面时 **defer 底部「上滑回主屏」**
> 系统手势，让页面里的悬浮挂件贴到屏幕最底边也能拖动（原生模块，需重新构建安装）；
> ③ 该手势行为在 App 设置里做成开关「主机页面手势 → 挂件贴底拖动」（**默认开启**），
> 关掉即恢复「一次上滑回主屏」（挂件贴底拖动可能被系统手势抢走）。
> 构建/安装成功 ≠ 验收通过，以下由用户实测后勾选。

- [x] 覆盖安装 0.1.7 (build 14) 后 App 能启动；已有配对记录 / App 锁 / 单主机面容开关保持（无需重新扫码）。
- [x] **进入主机后**点顶栏 ⚙ → 打开这台主机的「设备与安全」（不是 App 系统设置）；左上返回回到主机页面（页面不重新加载、会话与滚动位置保留）。
- [x] 从**主机列表**（外面）右上角 ⚙ 进入 App「系统设置」：有版本 / App 锁 / 「主机页面手势 → 挂件贴底拖动」/ 清理缓存，底部**没有**「设备与安全」入口。
- [x] 主机卡片上的 ⚙ 仍打开该主机的「设备与安全」，返回回到主机列表。
- [x] **挂件拖动**：在主机页面把左下角/右下角悬浮挂件拖到屏幕最底边后，仍能按住它自由拖动，App 不会被切到后台；一次上滑只高亮 Home 指示条、再上滑一次才回主屏。
- [x] 「挂件贴底拖动」开关**默认开启**；**关闭**后重新进入主机，从最底边上滑恢复**一次**回主屏（挂件贴底时从底边起手拖可能被系统手势抢走）；再打开后恢复两次上滑 + 挂件贴底可拖。
- [x] 离开主机页面（回主机列表/设置页）后，底部上滑恢复为**一次**回主屏。
- [x] 「设备与安全」页功能不回归：主机信息 / 设备密钥 label / 「打开此连接时要求面容」开关 / 解除本机配对（解除后回到列表或扫码页）。
- [x] 其它功能不回归：重启主机 ⏻ 显示/重启/自动恢复、WS 断线自动重连、外链内嵌浏览器、清理缓存、App 锁冷启动。

## 历史真机验收清单（0.1.5 build 11 — ✅ 2026-11-01 用户验收通过）

- [x] 覆盖安装 0.1.5 (build 11) 后 App 能启动；旧连接记录按预期丢弃/迁移。
- [x] 扫码/粘贴 **v2 token 二维码** 完成群体版配对（桌面确认 + SAS 一致）。
- [x] 进入主机：DSH 手机布局正常（左侧抽屉、右侧栏全屏、设置抽屉、外链内嵌浏览器）。
- [x] 会话列表 / 消息收发 / WebSocket 实时流正常；长时间停留或切后台再回来仍正常（token 续期）。
- [x] 主机侧撤销设备后，重新进入会提示「设备已在主机侧失效」，删除本机记录后可重新配对。
- [x] **不再收到任何推送**（0.1.5 版本行为；0.1.8 起 iOS 重新支持 APNs 推送，见上方 0.1.8 清单）。
- [x] 设置页只有版本 / 清理缓存 / 设备与安全；没有 classic/mTLS/证书/推送相关项。
- [x] 主机「组件」开启/关闭并保存后，App 短暂断线**自动恢复/重新加载**（不再显示「自动重连未恢复」），顶栏 ⏻ 随之动态出现/消失；点击可重启并自动恢复（host-plugin ≥0.2.4）。
- [x] 「设备与安全」显示 token 认证/主机 ID/端口/设备密钥 label + 该主机的「打开此连接时要求面容」开关；全局 App 锁开关在「设置」页；无证书信息。
- [x] 外链在 App 内嵌浏览器打开；左上返回回 DSH。
- [x] 解除本机配对后回到列表/扫码页；重新扫码可再次配对。

---

## 已知差距 / TODO

**功能**
- Android 原生构建与真机验证：源码只保留 group 能力（AndroidKeyStore P-256、cookie、缓存清理），
  未在有 Android SDK 的环境编译；FCM 推送未接入（App 返回「Android FCM 未接入」）。
- 推送只有 iOS APNs（Android FCM 未接入）。R2 `official` 通道只对**内置官方 hub 地址的官方构建**生效
  （仓库默认 `self` + 空 endpoint，真实 hub 地址由 owner 注入，不写进仓库）；official 模式不带
  `sessionId`（点通知只打开主机）；credential 缓存有效期由 hub 决定（默认 30 天，0.3.1 起；进入主机/回前台续期）。
- App 本地「推送」开关只停止新登记，已登记 token 的注销依赖主机侧开关 / 设备撤销 / relay 重启。
- 设备列表/撤销仍只在主机侧「远程访问」里操作（App 不调用主机本地管理 API）。
- 文件上传/下载（WebView 原生选择器、分享面板）未专门处理。
- App 锁：生物识别交互/超时行为待真机复测（0.1.2 已改为仅在冷启动/打开主机连接时触发）。

**工程**
- 未写 Jest/RNTL 组件测试；协议解析/群体流程目前靠静态检查与真机验收。
- 未配置 EAS Build 凭据、未做 CI。
- 应用图标/启动屏沿用模板资源，需替换为正式素材。
- `ios/`、`android/` 由 prebuild 生成，不入库；改原生模块需重新 `prebuild` + `pod install`。

---

## 排错

| 现象 | 原因/处理 |
|---|---|
| 启动报 "No bundle URL present" | Metro 没起：`npx expo start`；确认 dev client 与 Metro 同一网络。 |
| "当前构建未链接原生模块" / `native_unavailable` | 用的是 Expo Go，或装了旧包。重新 `expo prebuild && pod install` 构建原生包。 |
| 扫码提示"版本不支持" | 二维码是 classic v1（`auth` 缺失/`v=1`）：App 只支持群体版 v2 token 二维码，请在主机远程访问里重新生成。 |
| 配对后页面 401 | token 刚签发但 relay 设备表/隧道未就绪：App 会自动刷新一次；仍失败则返回列表重进。 |
| 页面提示「设备已在主机侧失效」 | 主机侧已删除/重置该设备：返回主机列表删除本机记录，重新扫码配对。 |
| WebView 一直转圈 / 白屏 | 确认主机在线、relay 可达、手机网络能访问 relay 域名；用手机 Safari 打开隧道地址验证。 |
| 扫码无反应（模拟器） | iOS 模拟器没有可用相机；用"手动粘贴配对链接"。 |
| 扫码后“网络连接失败” | ① 二维码过期/旧端口，重新生成；② `*.relayDomain` 泛解析缺失；③ 手机代理/VPN/Private Relay；④ 云安全组未放通服务端口。 |
| 配对请求到了主机但 App 无响应 | 主机可能正在等待桌面「允许配对」；确认 App 与主机时钟正常。 |
| 收不到推送（self 模式） | 检查：① 是否为带 `aps-environment` 的签名包（模拟器/Expo Go 拿不到 device token）；<br>② 系统「设置 → 通知 → DSH Remote」是否允许；③ App 设置页「推送」状态与主机「推送提醒」开关；<br>④ relay `group.push` 是否启用、APNs key/teamId/topic 与 environment 是否匹配（服务端日志）。 |
| 设置页「推送」显示服务器未开启推送 | relay 未启用 `group.push.enabled`（或其 mode 配置无效）：由部署方在 relay 配置里开启并重启 relay。 |
| 设置页「推送」显示未注册/登记失败 | 进入一次主机即可自动登记；仍失败可点「重新注册」。`push-not-connected` 表示主机到 relay 的控制连接暂不可用，稍后自动重试。 |
| 设置页「推送通道：官方」但状态「官方推送暂不可用」 | 检查：① 官方构建是否注入 `EXPO_PUBLIC_PUSH_HUB`（必须 https）；② 手机能否访问官方 hub；③ hub `HUB_ENROLL_ENABLED` / `HUB_PUBLIC_URL` / `apns.topic` 是否与官方 bundle id 匹配。`unsupported_bundle_id` = 官方构建配置不匹配；`rate_limited` 稍后再试。 |
| 主机 status.push 只有自部署设备（official 设备没统计到） | 主机 host-plugin 需 **≥0.2.6** 才支持 official 设备直连与按通道统计；旧版 Host 不认 hub 字段。 |
| `pod install` 失败 / 找不到 DSHMTLS | 先 `npx expo prebuild -p ios --no-install`；确认 `modules/dsh-mtls/expo-module.config.json` 与 podspec 存在。 |
| Xcode 签名错误 | Team/描述文件不匹配：确认设备 UDID 在描述文件里，或改 bundle id 后重新 prebuild。 |

---

## 参考

- 群体服务版设计（token/relay/cookie/租户隔离/攻击用例）：[`../dsh-remoteService/docs/group-service-design.zh.md`](../dsh-remoteService/docs/group-service-design.zh.md)
- relay 边缘认证接口：[`../dsh-remoteService/packages/relay/README.md`](../dsh-remoteService/packages/relay/README.md) §10
- 主机插件：[`../dsh-remoteService/packages/host-plugin/README.md`](../dsh-remoteService/packages/host-plugin/README.md)
- Expo SDK 58 / RN 0.88；本地 Expo Module 文档：`npx create-expo-module --local`、Expo Modules API。
