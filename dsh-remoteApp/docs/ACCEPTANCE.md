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
| 8 | 推送：桌面触发一轮任务结束 | iPhone 收到**会话标题 + 本轮助手回复摘要**通知（锁屏可见，注意隐私） | ☐ |
| 9 | iOS 设置 → 通知 → DSH Remote | 权限已授予；后台/锁屏也能收到 | ☐ |
| 10 | 桌面设备页撤销该设备 | 手机当前会话/WS 立即断开，后续请求 403 | ☐ |
| 11 | 重新配对 | 新证书可正常访问；旧设备仍被撤销 | ☐ |
| 12 | 主机证书轮换（acme.sh 覆盖 cert/key） | 手机访问不中断（或重连后恢复） | ☐ |
| 13 | 推送（App 在前台，设置→应用内通知开启） | 顶部出现应用内通知卡片，**不出现系统横幅**；5s 自动消失；点击卡片打开对应会话（非当前会话时） | ✅ 2026-10-25 |
| 14 | 推送（App 在后台/锁屏） | 出现系统通知（标题=会话标题，正文=助手回复摘要）；**点击通知打开对应会话**（冷启动/多主机也要正确） | ✅ 2026-10-25（单主机跳转已验证；多主机注册已补设备身份切换，待复验） |
| 15 | 设置页（Home / 主机页顶栏 ⚙︎） | 显示 App 版本 `0.1.5 (build 6)`；应用内通知开关可持久化；通知权限状态正确；「发送测试通知」行为符合开关 | ☐ |
| 16 | 设置页 → 清理 WebView 缓存 | 弹确认框；清理后 WebView 重新加载主机页面且状态正常（iOS：WKWebsiteDataStore 全类型 + URLCache；Android：HTTP 磁盘缓存 + Cookie/WebStorage + 认证缓存） | ☐ |
| 17 | 运行中会话：App 后台 2+ 分钟后回来 | 计时/状态与主机一致，不再出现旧值（如 4 分钟）与真实值（20 分钟）反复闪动 | ☐ |
| 18 | 会话 header 右角「展开右侧栏」按钮（含新建会话/历史会话） | 右栏**全屏**覆盖 WebView：顶部 tab 条与右上「收起」按钮可见可点，文件/浏览器/终端 tab 可切换；点「收起」回到会话；收起后聊天可正常滚动/点击/输入；横屏（>760px）走 DSH 原生布局不强制全屏 | ☐ |
| 19 | 前台推送正好属于当前正在查看的会话 | 不显示应用内通知卡片（页面本身已更新）；关闭应用内通知开关时连系统横幅也不显示；切到其它会话/页面时仍提示 | ✅ 2026-10-25 |
| 20 | 点击应用内卡片（推送属于其它会话） | 跳到对应会话；点击后卡片消失、页面加载正常 | ✅ 2026-10-25 |
| 21 | DSH 设置（左侧栏 → 设置）在手机上的布局 | 设置**全屏**（不再是 342px 居中弹窗）；左侧分区菜单默认收起，点右上菜单/左缘右滑打开抽屉，点分区项或抽屉外收起；左上 `‹` 返回退出设置；>760px（横屏/平板）恢复 DSH 原生居中弹窗 | ✅ 2026-10-25（iPhone 17 Pro Max / iOS 27.0 / 0.1.5 build 6，Release 真机；打开→菜单→切分区→返回→旋转均通过） |
| 22 | 设置 → 账号与余额 →「更多 → 查询用量 / 充值 / 更多账号信息」；账号菜单「意见反馈」 | 在 **App 内嵌浏览器**打开对应 DeepSeek 平台页（全屏覆盖层：左上返回/刷新/右上「在浏览器打开」、底部 URL）；**左上返回无条件关闭内嵌页回 DSH**（平台页 history 很长也不会卡住），Android 返回键同样；`↗` 可切系统浏览器；返回 DSH 后页面与设置仍在、会话正常；同源链接（会话/设置等）不受影响 | ✅ 2026-10-25（iPhone 17 Pro Max / iOS 27.0 / 0.1.5 build 6，Release 真机；内嵌页打开、左上返回关闭、↗ 切浏览器、关闭 App 后登录态仍在；返回 DSH 后状态正常） |

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
- 推送：本版本仅实现 iOS 自托管 APNs；Android FCM 通道尚未接入；
- 撤销设备后连接断开（同 #10）；
- 右侧栏全屏覆盖层（#18）同 iOS：为注入 WebView 的 JS/CSS，两端共用（尚未在 Android 设备验证）。

## 5. 推送（iOS，自托管 APNs）

App 默认由**主机直连 APNs**（不经过 relay / Expo）。iOS 配置：

1. Apple Developer（付费账号）→ Keys → 新建 **Apple Push Notifications service (APNs)** key：
   - **Environment** 选 **Sandbox & Production**（推荐一把 key 覆盖开发和发布；只选 Sandbox
     的 key 只能发开发包，上架/Ad Hoc 前要换成覆盖生产环境的 key）；
   - **Key Restriction** 选 **Team Scoped (All Topics)**（或 Topic Specific 选 App 的 bundle ID）；
   - 下载 `AuthKey_<KEY_ID>.p8`（只能下载一次），记下 Key ID；Team ID 在会员信息里；
   - 本机签名材料**只放仓库外**（例如 `~/.dsh/remote-access/signing/`，`chmod 600`），
     不要放进仓库任何目录（包括已被 `.gitignore` 忽略的 `Certificates/`——`.gitignore`
     不是安全边界）。
2. 在 DSH 主机：把 `.p8` 放到仓库外（例如 `~/.dsh/remote-access/apns/`，`chmod 600`），
   然后 DSH 设置 → 远程访问 → 推送：
   - 「推送提醒」开、「自托管直连 APNs」开；
   - APNs 私钥路径 / Key ID / Team ID / Topic（= `com.amesucre.dshremote`，以 app.json 的
     `ios.bundleIdentifier` 为准）；
   - 可选：同会话冷却（默认 30s）。
3. 重新构建并安装 App（本批次含原生变更 `evaluateJavaScript` / `clearWebCache`，**必须用新原生包**；
   原生 entitlement 已含 `aps-environment`，不需要改 Xcode）：

   ```bash
   cd dsh-remoteApp
   npx expo run:ios --device          # Debug + Metro
   # 或沿用 STATUS.md 里的手动签名 xcodebuild + devicectl install
   ```

4. 打开 App → 进入主机 → 允许通知；控制台应出现
   `[dsh-remote] push registered (apns/development)`（发布包为 `apns/production`）。
5. 主机侧确认注册：`~/.dsh/remote-access/push-tokens.json` 中 `provider=apns` 且带 `environment`。
6. 手机切后台/锁屏，在 DSH 完成一轮对话（非子代理）→ 收到通知：
   - **标题** = 该会话的标题（没有时退回首条用户消息）；
   - **正文** = 本轮最后一条助手回复的截断摘要（失败时带 `⚠️`，无文本时用状态兜底）；
   主机 audit 出现 `push-trigger`，`/status` 的 `push.tokens ≥ 1`。

> **前台 vs 后台**：App 在前台时默认不弹系统横幅，改在 App 内显示通知卡片（设置页可关闭
> 「应用内通知」，关闭后前台恢复系统横幅）；后台/锁屏始终是系统通知。
> **隐私提示**：通知标题/正文含会话内容，会经过 APNs 并可能显示在锁屏/通知中心；介意的话
> 请在 iOS 设置里关闭锁屏预览，或关闭推送。
> **环境匹配**：开发签名包 → APNs sandbox；App Store / Ad Hoc（distribution profile）→
> production。主机按 App 上报的 `aps-environment` 自动选择；**APNs key 的环境范围必须覆盖
> 当前 App 包**，否则 APNs 返回 `403 InvalidProviderToken`（换 key 后无需重新配对/重装，
> 设备 token 不变）。Android FCM 通道尚未接入。

## 6. 验收记录模板

| 项目 | 结果 | 证据（截图/日志） |
|---|---|---|
| iOS 编译（generic，无签名） | ✅ BUILD SUCCEEDED（2026-10-24） | /tmp/ios-build3.log |
| iOS 真机安装/启动 | ✅ 已安装并启动，JS bundle 加载成功 | `mockups/ios-pairing.png` |
| Secure Enclave 身份（identityPresent） | ✅ P-256 key `SE=true`，CSR 经 host CA 签发，链/公钥校验通过 | `/tmp/metro.log`、`/tmp/iphone-se-cert.pem` |
| iOS WebView mTLS | ✅ 真机 + 本地 Docker relay + 本机 host：原生 mTLS WebView 成功加载 DSH UI，Keychain 身份生效 | `mockups/ios-mtls-dsh-ui.png` |
| Secure Enclave 身份（identityPresent） | | |
| 配对 + 桌面确认 | | |
| 推送（会话标题 + 摘要） | | |
| 前台应用内通知（不弹系统横幅） | | |
| 设置页（版本/通知开关/清缓存） | | |
| 后台恢复后计时/状态一致 | | |
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
| 推送 token 注册失败 | 原生 mTLS 是否编译进 dev client；主机设置里的 APNs 私钥/Key ID/Team ID/Topic |
| 撤销后手机仍能访问 | 确认 host 插件版本包含撤销断链逻辑（本轮已实现） |
