# DSH Remote App 真机验收手册

本手册用于在**有 Xcode/iPhone 或 Android SDK/设备**的机器上完成 App 的真机验收。
本仓库开发机没有这些环境，因此 App 目前只通过了 TS/协议/原生源码一致性检查；
真机验收必须按本手册执行并记录结果。

> **0.1.8 起 App 重新接入 iOS APNs 推送；0.1.9（R2）起官方推送与 relay 解耦**
> （见下方「0.1.9」章节）。本文件中 0.1.8 之前版本记录里出现的「无推送 / 无 aps-environment /
> 设置页无推送项」只描述**当时版本**；当前版本「设置页 → 推送」有开关/通道/状态/重新注册，
> 构建产物带 `aps-environment` entitlement，官方构建额外使用官方推送 hub。

---

## 0.2.0 build 18（R2 官方构建：official 通道）真机验收记录 — 待用户验收（2026-11-08）

> 说明：本包是 **0.1.9 build 17 的同一份 App 代码**，版本号递增为 **0.2.0**、构建号 **18**，并注入
> **官方通道构建配置**：`EXPO_PUBLIC_PUSH_CHANNEL=official` + `EXPO_PUBLIC_PUSH_HUB=https://<hub 公网基址>`
> （真实地址只在构建环境，不入库；仓库默认仍是 `self` + 空地址）。
> 前置：官方 hub 0.3.0 已部署且公网 HTTPS 可达（`/v1/enroll/challenge` 返回 200），
> `HUB_PUBLIC_URL` 与 App 内置地址一致；`aps-environment=development`（APNs sandbox 通道）。
> **以下结果尚未由用户确认，不得勾选。**

| 项目 | 值 |
|---|---|
| 构建通道 | `official`（官方 hub 设备直连；**非 self 包**，不再走 relay 转发） |
| 构建结果 | ✅ `** BUILD SUCCEEDED **`（产物 `CFBundleShortVersionString=0.2.0`、`CFBundleVersion=18`；entitlement `aps-environment=development`；`main.jsbundle` 内联了 hub 地址与 `dshremote-push-enroll-v1`，无 `EXPO_PUBLIC_*` 运行时残留） |
| 构建目录 | `/tmp/dsh-ios-build-r2-official`（本机临时目录，不入库） |
| 安装 | ✅ `devicectl` 覆盖安装成功（设备端 `0.2.0 / 18`），`devicectl` 启动成功（后续交互需用户解锁操作） |
| 静态检查 | `npx tsc --noEmit`、`npm run check:native`、`npm run check:shell` 通过 |
| 版本说明 | `app.json` / `package.json` / `modules/dsh-mtls`（package.json + android build.gradle + ios podspec）均已同步为 0.2.0 / build 18；`ios/Info.plist` 已同步（未重新 prebuild） |

### 验收结果（2026-11-08 用户真机确认）

- [x] 打开 App → 进入主机；设置页「推送通道：官方（设备直连）」、状态「已注册（官方推送）」；
      主机审计出现 `push-token ok`；`status.push.official.devices ≥ 1`（用户确认“显示注册完成了”）。
- [x] official 设备触发 `turn-end` → 手机在**锁屏/后台**收到系统通知；点通知**打开对应主机**（用户确认）。
- [x] `ask_user_question`（等待作答）→ 锁屏/后台收到「正在等待你的回答」通知（用户确认）；
      主机审计对应 `push-trigger sent`。
- [x] 主机「推送提醒」**关闭并保存** → 测试 turn-end **收不到**通知（用户确认；配置 `pushEnabled=false`）；
      重新**打开并保存** → 测试推送**收到**（用户确认）。
- [x] 键盘/输入框回归（build 16 修复）：点输入框聊天区不再整体上滚；连续删字不再上下跳（用户确认“打字不再跳了”）。
- [x] hub 公网自检：`POST https://<hub>/v1/enroll/challenge` → 200；`/healthz` 显示
      `credential.enabled=true`、`enroll.enabled=true`、`credential.ttlDays=30`（不含 token/credential/密钥）。
- [ ] official 凭证续期（剩余 <24h 自动重新登记）：默认 TTL 已延长到 **30 天**（hub 0.3.1），
      本轮未等到自然到期，**留作观察项**（下次 App 打开且剩余 <24h 时应自动续期）。
- [ ] 设备撤销后清理对应 token：涉及重新配对，**留到后续单独验证**。
- [ ] 其它功能全量回归（重启主机 ⏻ / 外链内嵌浏览器 / 清理缓存 / App 锁）：本轮只覆盖配对/会话/消息/WebSocket
      的日常使用，其余项留到后续回归。
- [x] 已知限制（记录，不阻塞验收）：App 本地推送开关关闭**不会注销已登记 token**（只停止新登记），
      所以主机「推送提醒」仍开着时手机仍会收到通知；总闸在主机侧。后续版本计划把 credential 生命周期移交主机
      （见 `todo/TODO.md` P1）。

> self 通道回归需要**重新安装 self 包**（0.1.9 build 17 或同代码构建），与官方包不能在同一台手机上同时验证；
> 若只有一台手机，self 回归可放到另一轮/另一台设备。

---

## 0.1.9 build 17（R2：官方推送与 relay 解耦）真机验收记录 — 待用户验收

> 来源：用户已拍板的 **R2 方案**（根目录 `docs/group-push-r2-contract.zh.md` §5 App 契约；
> 背景 `docs/group-push-routing-options.zh.md` §3.3）。官方 App 构建时内置官方 hub 地址
> （`EXPO_PUBLIC_PUSH_CHANNEL=official` + `EXPO_PUBLIC_PUSH_HUB=https://<hub>`），用群体版
> **设备 P-256 密钥**向官方 hub 登记换 per-device credential，再把 credential 交给主机
> （`/__dsh_remote/push-token` 扩展字段）；主机**直连官方 hub** 推送，**不依赖部署方 relay
> 的推送配置**。部署方自签 App（self，仓库默认构建）仍经 relay 推送（旧 body 向后兼容）。
>
> 本版本同时包含 build 16 的**键盘避让修复**（build 16 尚未由用户验收，本轮一并复验）。
> **以下结果尚未由用户确认，不得勾选。**
>
> **前置条件（official 通道，缺一不可）**：
> 1. 官方 App 构建注入了 `EXPO_PUBLIC_PUSH_CHANNEL=official` 与 `EXPO_PUBLIC_PUSH_HUB`
>    （https 基址；真实地址只在构建环境，不入库）；
> 2. 官方 hub 已部署（`HUB_PUBLIC_URL` 与该地址一致、`apns.topic` = 官方 bundle id、
>    `HUB_ENROLL_ENABLED=true`）；**必须是设备能信任的 https**（本机自签证书需先在
>    iPhone 上信任该 CA，或用正式证书反代；App 侧不跳过 TLS 校验）；
> 3. 主机 host-plugin **≥0.2.6**（支持 official 设备凭证字段、直连 hub 分流与按通道 status）；
> 4. relay **不需要**配置任何推送（R2 的验收点之一）。
> self 通道回归仍需 relay 配置 `group.push`（同 0.1.8 前置）。

| 项目 | 值 |
|---|---|
| App 版本 | 0.1.9（buildNumber **17** / Android versionCode **17**） |
| 构建 | iOS Release **签名构建**（`CODE_SIGN_STYLE=Manual` + `DEVELOPMENT_TEAM=<TEAM_ID>` + `PROVISIONING_PROFILE_SPECIFIER=<PROFILE_UUID>` + `CODE_SIGN_IDENTITY='Apple Development: <NAME> (<CERT_ID>)'`；前置 `expo prebuild -p ios --no-install` → `pod install`） |
| 构建结果 | ✅ `** BUILD SUCCEEDED **`（产物 `CFBundleShortVersionString=0.1.9`、`CFBundleVersion=17`；entitlement `aps-environment = development`；JS bundle 含 R2 登记代码） |
| 构建目录 | `/tmp/dsh-ios-build-r2`（本机临时目录，不入库） |
| 安装 | ✅ `devicectl` 覆盖安装成功（设备端 `0.1.9 / 17`）；**本包为「默认 self」构建**（未注入 `EXPO_PUBLIC_PUSH_CHANNEL=official`），用于键盘回归/self 通道；官方 R2 验收需按下方「官方构建」重新构建（build 18）并安装。启动时设备处于锁屏，`devicectl launch` 被系统拒绝（Locked），待用户解锁后启动 |
| 官方构建（R2 验收用，待做） | `EXPO_PUBLIC_PUSH_CHANNEL=official EXPO_PUBLIC_PUSH_HUB=https://<真实 hub 域名> npx expo prebuild -p ios --no-install` → pod install → 同参数 xcodebuild（真实域名不入库；构建号 18） |
| entitlement | 同 0.1.8：`aps-environment = development`（发布 profile → production） |
| 静态检查 | `npx tsc --noEmit`、`npm run check:native`、`npm run check:shell` 均通过（shell 59 项断言） |

### 本版本改动（R2 App 侧）

1. `src/lib/pushConfig.ts`（新）：`PUSH_CHANNEL` 读 `EXPO_PUBLIC_PUSH_CHANNEL`（仅 `official`
   才 official，否则 self）；`PUSH_HUB_ENDPOINT` 读 `EXPO_PUBLIC_PUSH_HUB`（去尾斜杠）；
   仓库默认 self + 空 endpoint（不写真实地址）。
2. `src/lib/pushHub.ts`（新）：官方通道设备凭证登记 —— SecureStore 缓存 credential
   （key = `endpoint|token|hostId` 的摘要 hash，剩余 >24h 复用）→ `/v1/enroll/challenge` →
   `pushEnrollMessage`（与 server protocol 0.3.1 逐字节一致）→ `signGroupDeviceMessage`
   （设备私钥 ECDSA-SHA256）→ `/v1/enroll` → 保存 credential/expiresAt；失败只返回可读原因、
   不打印 token/credential、**不回退 relay**。
3. `src/lib/group.ts`：导出 `encodeAsciiToBase64`（签名消息 base64）、`readGroupDevicePublicKey`、
   `signGroupDeviceMessage`（R2 复用设备密钥签名）。
4. `src/lib/protocol.ts`：R2 常量（`PUSH_ENROLL_VERSION`/路径）、`pushEnrollMessage()`（纯函数）、
   `push` 状态按通道扩展类型（`self`/`official`/`mode=mixed`）。
5. `src/lib/push.ts`：official 时先换设备凭证，`/__dsh_remote/push-token` body 增加
   `{channel:'official', bundleId, hubEndpoint, credential}`；self 保持旧 body；拿不到凭证时
   不发 official 登记并记录原因；`PushStatus` 增加 `channel`。
6. `SettingsScreen.tsx`：「推送」卡显示「推送通道：官方（设备直连）/ 自部署（经 relay）」+
   按通道的已登记设备数/失败原因（`status.push.self/official`，旧版 Host 回退扁平字段）。
7. 版本 0.1.9 / buildNumber **17** / versionCode **17** 三处同步（package/app.json/gradle；
   模块 package.json/podspec 同步）。

### 待用户确认的验收项（未勾选）

- [ ] 覆盖安装 0.1.9 (build 17) 后 App 正常启动；已有配对 / App 锁 / 推送偏好保持（无需重新配对）。
- [ ] **键盘/输入框（build 16 修复，本轮复验）**：进入会话点输入框 → 聊天区不再整体上滚、会话 header 仍在；
      连续删除文字 10+ 次，页面与输入框不再上下跳；键盘收起后布局恢复、无残留空白。
- [ ] **official 通道**：官方 App 在**未开启推送的部署方 relay** 下进入主机 → 设置页显示
      「推送通道：官方（设备直连）」、状态「已注册（官方推送）」；主机 `/__dsh_remote/status.push.official.devices ≥ 1`。
- [ ] official 设备触发 `turn-end` / `ask_user_question` → 手机在前台/后台/锁屏收到系统通知；
      点通知打开对应主机（official 不带 sessionId）。
- [ ] official 凭证自动续期：凭证剩余 <24h 后回前台/重新进入主机会重新向 hub 登记；
      hub 不可达时显示「官方推送暂不可用：<原因>」，主流程不受影响，恢复后自动重试。
- [ ] **self 通道回归**：自部署 App 仍经 relay 推送正常（前台/后台/锁屏、点通知打开主机/会话，
      带 sessionId 时直达会话）；`status.push.self.devices` 正确。
- [ ] 混用：同一主机同时有 self + official 设备时两种设备各自收到（App 只有一种时跳过此项）。
- [ ] 主机「推送提醒」关闭 → 两种通道都不再推送；设备撤销后主机清理对应 token（status 设备数减少）。
- [ ] App「推送」开关关闭后不再登记新 token；重新打开 +「重新注册」恢复；hub/relay 未开启推送时显示明确状态。
- [ ] 日志、设置页、主机 `status` 不含 token / credential / 密钥（安全项）。
- [ ] 其它功能不回归：配对、会话/消息/WebSocket、token 续期、重启主机 ⏻、外链内嵌浏览器、清理缓存、App 锁。

### 回归命令（本机）

```bash
cd dsh-remoteApp && npx tsc --noEmit
cd dsh-remoteApp && npm run check:native
cd dsh-remoteApp && npm run check:shell
# 构建/装机由 Lead 统一执行；目标 `** BUILD SUCCEEDED **`（见本文件「构建与安装（iOS）」）
```

---

## 历史真机验收记录（0.1.8 build 16 — **已被 0.1.9 build 17 取代，验收项并入上方清单**）

> 来源：① 群体服务版推送切片（根目录 `docs/group-push-design.zh.md` §7 App 契约）；
> ② 用户反馈「键盘弹出后删除文字页面上下跳动」（根因/修复见
> [`../../../docs/diagnostics/13-app-keyboard-composer-bounce.md`](../../../docs/diagnostics/13-app-keyboard-composer-bounce.md)）。
> build 15 → **build 16** 的唯一代码差异：WebView 外面加 `KeyboardAvoidingView`（iOS `padding`）；
> 推送功能与 build 15 相同，构建号仅用于区分安装包。App 新增：
> 进入主机拿到会话 token 后登记 APNs device token（`POST /__dsh_remote/push-token`，
> body `{provider:'apns', token, environment}`）；前台/后台/锁屏系统通知；点通知按
> `data.host`/`data.hostId` 打开对应主机（self 模式带 `data.sessionId` 时直达会话）；
> App 设置页「推送」卡（开关/状态/重新注册/服务器状态）。
> **以下结果尚未由用户确认，不得勾选。**
>
> **前置条件（缺一不可）**：
> 1. 服务端 relay 已升级到 **0.3.1** 并配置 `group.push`（`/healthz` 应出现 `push` 字段）；
> 2. 本机 **DSH 已重启** 以加载 host-plugin **0.2.5**（插件是 `link:` 安装，代码改动不会热更新；
>    未重启时 `/__dsh_remote/push-token` 不存在，App 登记会失败）；
> 3. App 已升级到 **0.1.8 (build 16)** 并在系统弹窗中允许通知。
> 排障：主机审计出现 `proxy-deny` 且路径是 `/__dsh_remote/push-token`、或 App 设置一直
> 「未注册」，先确认第 2 条（重启 DSH）。

| 项目 | 值 |
|---|---|
| App 版本 | 0.1.8（buildNumber **16** / Android versionCode **16**） |
| 构建 | iOS Release（**手动签名**：`CODE_SIGN_STYLE=Manual` + `DEVELOPMENT_TEAM=<TEAM_ID>` + `PROVISIONING_PROFILE_SPECIFIER=<PROFILE_UUID>` + `CODE_SIGN_IDENTITY='Apple Development: <NAME> (<CERT_ID>)'`；Team/描述文件/证书不入库）；前置 `expo prebuild -p ios --no-install` → `pod install`（ExpoNotifications 58.1.7） |
| 构建结果 | `** BUILD SUCCEEDED **`（签名产物 `CFBundleShortVersionString=0.1.8`、`CFBundleVersion=16`；签名 entitlement 含 `aps-environment = development`、`application-identifier = <TEAM_ID>.com.amesucre.dshremote`） |
| 构建目录 | `/tmp/dsh-ios-build-kb`（本机临时目录，不入库） |
| 安装 | ✅ `devicectl` 覆盖安装并启动成功（设备端确认 `0.1.8 / 16`）→ **iPhone 17 Pro Max（iOS 27.0）**（UDID/设备名不入库）；**安装成功 ≠ 测过，推送/键盘两项验收待用户实测** |
| entitlement | 已生成：`ios/DSHRemote/DSHRemote.entitlements` 含 `aps-environment = development`（`expo-notifications` plugin 写入；发布签名 profile 会覆盖为 production） |
| 依赖 | `expo-notifications@~58.1.5`（安装解析到 58.1.7；config plugin，color `#4F8DF7`） |
| 静态检查 | `npx tsc --noEmit`、`npm run check:native`、`npm run check:shell` 均通过（shell 59 项断言） |

### 服务端本地集成验证（Lead，**非用户验收**，2026-11-01）

> 以下为服务端链路的本地运行态冒烟，不代表真机推送验收；真机项仍由用户实测后勾选。

1. **relay `official` 模式 + stub hub（真实进程）**：12/12 通过 —— `push.register` 回
   `push.registered(ok, mode=official)`；`push.send` 回 `push.result(ok, delivered=1)`；
   hub 只收到 `{kind,host,tokens}`（Bearer relay token 正确、**无 title/body/sessionId**）；
   重复意图回 `skipped=cooldown`；非法 kind 回 `invalid_request`。
2. **relay `self` 模式 + 真实 APNs sandbox**：5/5 通过 —— 用随机生成的 P-256 key 冒充
   provider key，Apple 返回 `InvalidProviderToken`：relay 归类为**配置错误**、`pruned` 为空
   （不清理设备 token），证明 JWT/HTTP2/sandbox 路由与错误分类链路真实可用
   （未发出真实通知，随机 key 无法通过 Apple 鉴权）。
3. **真实 host-plugin `RelayConnector` ↔ 真实 relay 跨实现联调**：10/10 通过 —— token 登记、
   推送意图、hub 内容剥离；**relay 重启（token 表清空）后 connector 自动重连并补报 token**
   （`/healthz` 的 `push.tokens` 恢复）。
4. **真实 push-hub 进程 + CLI + 真实 APNs**：13/13 通过 —— `relay create/list`（store 0600 只存
   sha256、list 不显示 token）、`/healthz`、`/v1/push` 鉴权（错误 token 401）与 schema
   （带 title/body → 400）、真实 APNs 配置错误归类（failed=1/pruned=[]）、日志不含 token。
5. **relay-entrypoint 配置自动生成**：8/8 通过 —— self/official 两组 env → `relay.json` 的
   `group.push`（0600）、已有配置不覆盖、缺 `RELAY_DOMAIN`/证书时给出可操作报错；
   compose 渲染核对 push env 与 `data/apns` 只读挂载。
6. **单测/静态**：`dsh-remoteService npm test` **275/275**、`validate:artifacts` 通过；
   App 三项静态检查通过。

### 本版本改动

1. `src/lib/push.ts`（新）：通知权限、APNs device token（64 hex）、`aps-environment`、
   经原生 `groupHttpFetch` 登记 `/__dsh_remote/push-token`、状态与 SecureStore 开关（默认开）；
   token 不落盘、不打印。
2. `src/lib/group.ts`：新增 `onGroupSessionAvailable()` 事件（只带连接标识，不含 token），
   供 App 在「会话 token 可用/刷新」时重试推送登记。
3. `src/lib/protocol.ts`：`/__dsh_remote/push-token` URL、`push` 服务端状态类型。
4. `App.tsx`：`configureNotificationHandler`（前台也显示系统通知）、通知点击监听、
   冷启动 `getLastNotificationResponseAsync`、回前台重试、`sessionId` 跳会话请求。
5. `WebViewScreen.tsx`：`openSessionRequest` → 页面加载就绪后注入
   `window.__DSH_REMOTE_OPEN_SESSION__(sessionId)`（插件未就绪时写 pending）。
6. `SettingsScreen.tsx`：「推送」卡（开关 / 状态文案 / 重新注册 / 从主机 `/status` 读服务端状态）。
7. 版本 0.1.8 / buildNumber **16** / versionCode **16** 同步；`app.json` 增加 `expo-notifications` plugin。
8. **build 16（键盘避让修复）**：`WebViewScreen.tsx` 的 WebView 容器改为 `KeyboardAvoidingView`
   （iOS `behavior="padding"`，Android 不启用）。修复「键盘弹出后删除文字页面上下跳」：
   根因是 WKWebView 用 `scrollView.contentInset` 自动滚页面去露出光标，DSH 100% 高度布局下
   composer 在页面底部，配合 CodeMirror 自己的滚动意图导致页面在两个 offset 间来回跳；
   缩小 WebView 后页面布局视口=键盘上方可见区，无需再滚页。详见
   [`../../../docs/diagnostics/13-app-keyboard-composer-bounce.md`](../../../docs/diagnostics/13-app-keyboard-composer-bounce.md)。

### 待用户确认的验收项（未勾选）

- [ ] 覆盖安装 0.1.8 (**build 16**) 后 App 正常启动；已有配对 / App 锁 / 推送偏好保持（无需重新配对）。
- [ ] **键盘/输入框（build 16 修复）**：进入会话点输入框 → 聊天区不再整体上滚、会话 header 仍在；
      连续删除文字 10+ 次，页面与输入框**不再上下跳**；键盘收起后布局恢复无空白。
- [ ] 首次进入主机弹出系统「允许通知」；允许后设置页「推送」显示「已注册（模式：自部署/官方）」；
      拒绝后显示「通知权限被拒」，进入主机/会话等主流程不受影响。
- [ ] **self 模式**：App 前台、后台、锁屏三种状态都能收到系统通知
      （`turn-end`「任务已完成」+ `ask_user_question`「正在等待你的回答」，会话摘要通知各一次）。
- [ ] **official 模式**：经官方推送 hub 收到通用文案通知；点通知打开对应主机（不带 sessionId）。
- [ ] 点通知跳转：App 在后台运行与被杀（冷启动）都能打开对应主机；self 模式带 `sessionId`
      时进入后直达该会话；主机不在本机时提示、不跳到错误主机。
- [ ] 主机「设置 → 远程访问 → 推送提醒」**关闭开关**后不再收到推送；App「推送」卡服务器状态同步变化。
- [ ] App「推送」开关关闭后不再登记新 token；重新打开后点「重新注册」恢复登记。
- [ ] relay 未开启推送时 App 显示「服务器未开启推送」，主流程（进入主机/会话）正常。
- [ ] 其它功能不回归：配对、会话/消息/WebSocket、token 续期、重启主机 ⏻、外链内嵌浏览器、清理缓存、App 锁。

### 回归命令（本机）

```bash
cd dsh-remoteApp && npx tsc --noEmit
cd dsh-remoteApp && npm run check:native
cd dsh-remoteApp && npm run check:shell
# iOS Release 免签名编译验证目标为 `** BUILD SUCCEEDED **`（见本文件「构建与安装（iOS）」）
```

---

## 0.1.7（主机内设置入口调整 + iOS 底部边缘手势 defer）真机验收记录 — ✅ 2026-11-01 用户验收通过

> 来源：用户反馈
> ①「App 进入主机后右上角设置进入的是系统设置，正常应该是进入该链接（该主机）的设置；
>    在外面进入的才是系统设置」；
> ②「系统设置中最底部的『设备与安全』应该去掉，从每个主机里去看」；
> ③「左下角的挂件拖动：此前可以随意拖动，现在从屏幕最底边起手拖会直接把 App 切到后台」。
>
> 0.1.7 一并包含两批改动（0.1.6 build 12 只是①的中间构建，未交付验收）：
>
> - 进入主机后，顶栏 ⚙ → 打开**这台主机**的「设备与安全」（连接设置）；返回回到主机页面
>   （WebView 常驻，不重新加载）；App「系统设置」只从主机列表（外面）右上角 ⚙ 进入，
>   底部「设备与安全」卡片删除；主机列表卡片上的 ⚙ 仍打开该主机的「设备与安全」。
> - iOS：进入主机页面时 **defer 底部（Home 指示条）的「上滑回主屏」系统手势**。页面里的
>   可拖动悬浮挂件贴到屏幕最底边后，从底边起手拖动不再被系统手势抢走；离开主机页面恢复
>   系统默认。代价：主机页面里从最底边上滑回主屏需连划两次（第一次只高亮 Home 指示条）。
> - 该手势行为做成了 App 设置里的开关（「主机页面手势 → 挂件贴底拖动」，**默认开启**）：
>   想换回一次上滑回主屏的用户可以关掉（详见下方验收项）。
>
> **以下结果尚未由用户确认，不得勾选。**

| 项目 | 值 |
|---|---|
| App 版本 | 0.1.7（buildNumber 14 / Android versionCode 14） |
| 构建 | iOS Release（手动签名），`expo prebuild -p ios --no-install` + `pod install` + `xcodebuild` |
| 构建结果 | `** BUILD SUCCEEDED **`（Xcode Release，手动签名；bundle 版本读到 0.1.7 / 14）；`devicectl` 安装并启动成功 |
| 安装 | 已覆盖安装并启动到用户验收用 iPhone（UDID/序列号不入库；设备侧显示 0.1.7 / 14） |
| 构建目录 | `/tmp/dsh-ios-group-gesture14`（本机临时目录，不入库） |
| 原生模块 | 新增 `DSHMTLSBottomEdgeGestures.swift`（iOS 底部边缘手势 defer）+ JS bridge `setBottomEdgeGestureDeferral`（Android no-op） |
| 静态检查 | `npx tsc --noEmit`、`npm run check:native`、`npm run check:shell` 均通过（59 项 shell 断言） |

### 本版本改动

1. **导航入口（纯 JS/TS）**：
   - `App.tsx`：新增 `devicesReturnRoute`（'home' | 'webview'）——「设备与安全」按进入来源返回；
     WebView 顶栏 ⚙ 改接 `handleOpenConnectionSettings`（→ devices，返回 webview）。
   - `WebViewScreen.tsx`：`onOpenSettings` → `onOpenConnectionSettings`，注释/无障碍文案改「连接设置」；
     新增底部手势 defer 的 effect（页面可见时开、离开时关）。
   - `SettingsScreen.tsx`：删除底部「设备与安全」卡片与 `connection` / `onOpenDevices` props；
     App 锁说明改为「在该主机卡片 ⚙（或进入主机后顶栏 ⚙）打开设备与安全，再开启面容开关」。
2. **App 设置里的手势开关（纯 JS/TS）**：
   - `src/lib/settings.ts`（新）：`bottomEdgeGestureDeferral` 偏好（SecureStore，默认开；
     关闭时写 `'0'`）。
   - `SettingsScreen.tsx`：新增「主机页面手势 → 挂件贴底拖动」开关（仅 iOS 展示），
     说明开启/关闭各自的取舍。
   - `WebViewScreen.tsx`：每次进入主机页面时读取该偏好再决定是否 defer；离开/锁屏恢复默认。
3. **iOS 底部边缘手势 defer（原生）**：
   - `DSHMTLSBottomEdgeGestures.swift`（新）：运行时替换 `UIViewController` 的
     `preferredScreenEdgesDeferringSystemGestures` 基类实现（公开 API，进程内生效）：
     开启返回 `.bottom`，关闭返回 `.none`（系统默认）；切换时通知系统刷新。
   - `DSHMTLSModule.swift`：新增 `AsyncFunction("setBottomEdgeGestureDeferral")`。
   - `DshMtlsModule.kt`：同名 no-op（Android 无等价接口），保持 JS↔原生导出一致。
   - `modules/dsh-mtls/src/index.ts`：新增 `setBottomEdgeGestureDeferral(enabled)` bridge。
   - `scripts/check-native-sources.mjs`：新增方法/文件/API 断言。
4. 版本号 0.1.7 / buildNumber 14 / versionCode 14 同步（`package.json`、`app.json`、
   `modules/dsh-mtls/{package.json,ios/DSHMTLS.podspec,android/build.gradle}`、`package-lock.json`）。

### 验收项（2026-11-01 用户实测确认通过）

- [x] 覆盖安装 0.1.7 (build 14) 后 App 正常启动；已有配对记录 / App 锁 / 单主机面容开关保持（无需重新扫码）。
- [x] **进入主机后**点顶栏 ⚙ → 打开这台主机的「设备与安全」（不是 App 系统设置）；左上返回回到主机页面（页面不重新加载、会话与滚动位置保留）。
- [x] 从**主机列表**（外面）右上角 ⚙ 进入 App「系统设置」：有版本 / App 锁 / 「主机页面手势 → 挂件贴底拖动」/ 清理缓存，底部**没有**「设备与安全」入口。
- [x] 主机卡片上的 ⚙ 仍打开该主机的「设备与安全」，返回回到主机列表。
- [x] **挂件拖动**：把悬浮挂件拖到屏幕最底边后，仍能按住它自由拖动，App 不会被切到后台；一次上滑只高亮 Home 指示条、再上滑一次才回主屏。
- [x] 「挂件贴底拖动」开关**默认开启**；**关闭**后重新进入主机，从最底边上滑恢复**一次**回主屏（挂件贴底时从底边起手拖可能被系统手势抢走）；再打开后恢复两次上滑 + 挂件贴底可拖（开关在下次进入主机时生效）。
- [x] 离开主机页面（回主机列表/设置页）后，底部上滑恢复为一次回主屏。
- [x] 「设备与安全」页功能不回归：主机信息 / 设备密钥 label / 「打开此连接时要求面容」开关 / 解除本机配对（解除后回到列表或扫码页）。
- [x] 其它功能不回归：重启主机 ⏻ 显示/重启/自动恢复、WS 断线自动重连、外链内嵌浏览器、清理缓存、App 锁冷启动。

> 用户 **2026-11-01** 实测确认通过：主机内 ⚙ → 本主机「设备与安全」、系统设置入口/无设备与安全、挂件贴底拖动、开关关闭后一次上滑均按预期。

### 回归命令（本机）

```bash
cd dsh-remoteApp && npx tsc --noEmit
cd dsh-remoteApp && npm run check:native
cd dsh-remoteApp && npm run check:shell
# iOS Release 构建（buildNumber 14）见本文件「构建与安装（iOS）」
```

---

## 0.1.5（WS 批量断开去抖 + 自动重连修复）真机验收记录 — ✅ 2026-11-01 用户验收通过

> 来源：用户实测（App 0.1.4 build 10 + host 0.2.3）反馈——主机保存「允许手机重启主机 DSH」
> 后 App 连接断开但**不自动重连**，显示「与主机的实时连接已断开，自动重连未恢复，请点击刷新重试」，
> 必须手动刷新。根因：host 保存时会断开 Upgrade/WebSocket，`mobileWebShell` 对每个 WS 各上报一次
> `dsh-ws-close`，同一瞬间多个 close 把 60s/2 次的自动恢复预算一次耗尽。0.1.5 在 App 侧做去抖，
> 即使 host 侧（0.2.4）行为未变也不会再被一波 close 打爆。
> **以下结果尚未由用户确认，不得勾选。**

| 项目 | 值 |
|---|---|
| App 版本 | 0.1.5（buildNumber 11 / Android versionCode 11） |
| 构建 | iOS Release（手动签名），`expo prebuild -p ios --no-install` + `pod install` + `xcodebuild` |
| 构建结果 | `** BUILD SUCCEEDED **`（Xcode Release，手动签名；bundle 版本读到 0.1.5 / 11）；`devicectl` 安装并启动成功，进程存活 |
| 安装 | `devicectl` 覆盖安装并启动到用户验收用 iPhone（UDID/序列号不入库） |
| 构建目录 | `/tmp/dsh-ios-group-clean11`（本机临时目录，不入库） |
| 原生模块 | 与 0.1.4 相同（本版本无原生改动） |
| 静态检查 | `npx tsc --noEmit`、`npm run check:native`、`npm run check:shell` 均通过（另用状态机模拟验证了「一波 5 个 close 只恢复一次 / reload 后仍断才累加预算 / 2 次后报错 / ws-open 重置」） |
| entitlement | 构建产物无 `aps-environment`（**仅 ≤0.1.7 历史**：0.1.8 起由 expo-notifications plugin 生成并支持推送，见顶部 0.1.8 章节） |

### 本版本改动（WebSocket 自动恢复）

1. **同一波 close 去抖**：`dsh-ws-close` 处理增加两层去抖——已有排队中的恢复（`pending`）时忽略
   后续 close；2s 内的多个 close 只算一次恢复尝试。host 保存设置同时断多个 socket 时只触发一次恢复。
2. **预算按「reload 后仍失败」累加**：只有「自动 reload 完成后再次 close」才消耗 60s 窗口内的
   2 次预算（`reloadedSinceClose`）；首次 close 只尝试恢复、不计数。
3. **预算重置**：`dsh-ws-open`（实时连接真正恢复）或普通页面加载成功（首次进入 / 用户刷新 /
   清理缓存 / 重启恢复）时清零；自动恢复 reload 的加载完成不清零（用于判断是否真的连续失败）。
4. **进行中不再报错**：预算未耗尽时显示警告色提示「与主机的实时连接已断开，正在自动重连…」
   （带 spinner、不显示「重试」按钮）；只有预算确实耗尽（连续 2 次自动 reload 后仍 close）才显示
   原来的错误文案与「重试」按钮。
5. 自动恢复仍走现有 `reload()`（先确保 group session 有效，必要时续期 token）；恢复成功后由
   `dsh-ws-open` / 页面加载完成**立即刷新一次组件状态**，0.1.4 的 10s 组件轮询兜底保留。
6. 保留 0.1.2–0.1.4 全部能力：重启主机 ⏻（二次确认/202 轮询/恢复自动 reload）、App 锁
   （全局冷启动 + 单连接开关）、无推送。

### 待用户确认的验收项（未勾选）

- [x] 覆盖安装 0.1.5 (build 11) 后 App 正常启动；0.1.4 的配对记录与连接开关保持（无需重新扫码）。
- [x] **主机保存「允许手机重启主机 DSH」（组件开关）后**：App 短暂断线后**自动恢复/重新加载**，
      不出现「自动重连未恢复，请点击刷新重试」错误，无需手动刷新。
- [x] 主机保存组件开关后，App 顶栏 ⏻ 在保存后自动出现/消失（10s 内，或重连后立即刷新）。
- [x] 主机短暂重启/断网恢复后，App 能自动重新加载并恢复实时流；不弹错误。
- [x] 若主机确实长时间不可达：最多自动尝试 2 次后显示「自动重连未恢复，请点击刷新重试」+
      「重试」按钮；点「重试」可恢复。
- [x] 重启主机 ⏻ 功能不回归：组件开启时出现、二次确认、主机恢复后页面自动重载。
- [x] App 锁不回归：冷启动解锁；单连接「打开此连接时要求面容」按设置生效。
- [x] 前后台仍**不收到任何推送**；设置页没有通知/推送项。（**仅 ≤0.1.7 历史行为**：0.1.8 起支持 iOS APNs 推送，见顶部 0.1.8 章节）
- [x] 群体版既有功能不回归：配对（含 SAS）、会话/消息/WebSocket、token 续期、设备撤销提示、
      外链内嵌浏览器、清理缓存。

### 回归命令（本机）

```bash
cd dsh-remoteApp && npx tsc --noEmit
cd dsh-remoteApp && npm run check:native
cd dsh-remoteApp && npm run check:shell
# iOS Release 构建（buildNumber 11）见本文件「构建与安装（iOS）」
```

### 备注 / 未决

- host 侧（0.2.4）会把「保存组件」改成只断主 mux；App 本轮去抖确保即使 host 一次断多个 socket
  也不会再耗光恢复预算（客户端自保）。
- relay 0.3.0 不重新部署；Android 本机无 SDK，未构建（仅静态检查）。
- 「页面加载成功重置预算」对普通加载成立；自动恢复 reload 的加载完成保留预算，等 `dsh-ws-open`
  或下一次 close 判断是否真正恢复（避免主机一直断开时无限 reload）。

---

> 结论：**用户 2026-11-01 确认验收完毕**（主机保存组件后 App 自动恢复并刷新 ⏻，无需手动刷新/重试）。


## 0.1.4（组件开关动态刷新）真机验收记录 — 待用户验收

> 来源：用户反馈「单机版有的组件开关动态刷新没了」——Host 修改「允许手机重启主机 DSH」后，
> App 顶栏 ⏻ 不会动态出现/消失，需要退出主机再进。0.1.4 新增进入主机后每 **10s** 拉一次
> `/__dsh_remote/status`（仅在页面可见且非重启中时），保存后最多 10s 内自动更新 ⏻。
> **以下结果尚未由用户确认，不得勾选。**

| 项目 | 值 |
|---|---|
| App 版本 | 0.1.4（buildNumber 10 / Android versionCode 10） |
| 构建 | iOS Release（手动签名）；构建目录 `/tmp/dsh-ios-group-clean10` |
| 安装 | 已覆盖安装并启动（UDID 不入库） |
| 前置 | host-plugin ≥ **0.2.2**（组件保存已修复）；relay 0.3.0 无需重部署 |
| entitlement | 无 `aps-environment`（仍无推送能力） |

### 待用户确认

- [ ] 主机开启「允许手机重启主机 DSH」并保存后，**不退出主机**，App 顶栏 ⏻ 在约 10s 内自动出现；
- [ ] 主机关闭该组件并保存后，⏻ 在约 10s 内自动消失（不会误点）；
- [ ] 重启功能本身仍正常（点 ⏻ → 确认 → 主机重启 → 自动恢复）；
- [ ] 回归：配对/进入/手机布局/会话/消息/外链正常；App 锁行为（全局冷启动 + 单连接可选）不变；无任何推送。

---

## 0.1.3（App 锁语义调整：全局只冷启动 + 单连接可选面容）真机验收记录 — 待用户验收

> 来源：用户对 0.1.2 的 App 锁语义提出调整——顶层 App 锁不应导致每次打开连接都要求面容；
> 改为「全局 App 锁只负责冷启动解锁」，并给每台连接增加独立的「打开此连接时要求面容」开关。
> **以下结果尚未由用户确认，不得勾选**；用户验收通过后再补充结论与日期。
>
> 前置：主机端需更新到 **host-plugin ≥ 0.2.2**（0.2.2 修复组件开关保存问题；
> 远程重启自 0.2.1 起提供）。App 侧不依赖该保存修复，但重启 ⏻ 需主机插件已更新且
> 在主机「设置 → 远程访问 → 组件」开启「允许手机重启主机 DSH」。relay 本轮不重新部署（0.3.0 不变）。

| 项目 | 值 |
|---|---|
| App 版本 | 0.1.3（buildNumber 9 / Android versionCode 9） |
| 构建 | iOS Release（手动签名），`expo prebuild -p ios --no-install` + `pod install` + `xcodebuild` |
| 构建结果 | `** BUILD SUCCEEDED **`（Xcode Release，手动签名；bundle 版本读到 0.1.3 / 9）；`devicectl` 安装并启动成功，进程存活 |
| 安装 | `devicectl` 覆盖安装并启动到用户验收用 iPhone（UDID/序列号不入库） |
| 构建目录 | `/tmp/dsh-ios-group-clean9`（本机临时目录，不入库） |
| 原生模块 | 与 0.1.2 相同（含 `groupHttpFetch`：带 `__Host-dsh_session` cookie 的 HTTPS 请求）；本版本无原生改动 |
| 静态检查 | `npx tsc --noEmit`、`npm run check:native`、`npm run check:shell` 均通过 |
| entitlement | 构建产物无 `aps-environment`（**仅 ≤0.1.7 历史**：0.1.8 起由 expo-notifications plugin 生成并支持推送，见顶部 0.1.8 章节） |

### 本版本改动（App 锁语义）

1. **全局 App 锁 = 只负责冷启动解锁**（设置页「App 锁（冷启动解锁）」）：
   开启后仅在 App 冷启动首次进入时要求 Face ID / Touch ID；打开主机连接、同步信息、
   心跳、切换会话、回前台均不再要求识别（不再对所有连接生效）。
2. **单连接开关**：`StoredConnection` 新增可选 `requireBiometricOnOpen`（旧记录没有该字段
   = false，加载时只保留 true，迁移安全）。「设备与安全」页（DevicesScreen）为当前主机显示
   「打开此连接时要求面容」开关；全局 App 锁关闭时开关禁用并提示
   「需先在「设置」中开启 App 锁，此开关才会生效」。
3. `App.tsx`：打开连接（主页点开 / 配对完成进入）时只有
   **全局 App 锁开启 && 该连接 `requireBiometricOnOpen === true`** 才 `setLocked(true)`；
   解锁成功后不会被系统 active 回调重新上锁（仍不监听 AppState）。
4. 保留 0.1.2 的「重启主机 DSH」UI（顶栏 ⏻ / 二次确认 / 202 后轮询探活 / 恢复自动 reload）
   与无推送状态；原生 `groupHttpFetch` 与 group token 会话逻辑未改。

### 待用户确认的验收项（未勾选）

- [ ] 覆盖安装 0.1.3 (build 9) 后 App 正常启动；0.1.2 的配对记录可继续使用（无需重新扫码）。
- [ ] **全局 App 锁开启时**：App 冷启动首次进入要求 Face ID / Touch ID；解锁后进入主机列表。
- [ ] **打开任意主机（未单独开启开关）不再要求面容**（即使全局 App 锁开启）。
- [ ] 「设备与安全」页有「打开此连接时要求面容」开关（在当前主机信息下方）。
- [ ] 打开该主机的「打开此连接时要求面容」后：从主机列表打开这台主机要求一次面容；
      打开其它主机不要求（其它主机不受影响）。
- [ ] **全局 App 锁关闭时**：设备页该开关禁用并提示「需先在「设置」中开启 App 锁」；
      即使此前记录为开启，打开连接也不要求面容。
- [ ] 冷启动解锁一次后，进入主机后的同步信息 / 心跳 / 切换会话 / 回前台均**不再**弹面容。
- [ ] **重启 ⏻**：主机开启组件后顶栏出现 ⏻，点击可重启主机并在恢复后自动重载（0.1.2 行为不回归）。
- [ ] 前后台仍**不收到任何推送**；设置页没有通知/推送项。
- [ ] 群体版既有功能不回归：配对（含 SAS）、会话/消息/WebSocket、token 续期、设备撤销提示、
      外链内嵌浏览器、清理缓存。

### 回归命令（本机）

```bash
cd dsh-remoteApp && npx tsc --noEmit
cd dsh-remoteApp && npm run check:native
cd dsh-remoteApp && npm run check:shell
# iOS Release 构建（buildNumber 9）见本文件「构建与安装（iOS）」
```

### 备注 / 未决

- host 端「组件开关保存」bug 由 host-fix 在 host-plugin 0.2.2 修复（与 App 无关）；
  用户验收重启 ⏻ 前需先更新主机插件，否则组件即使打开也可能保存不上。
- relay 0.3.0 本轮不重新部署；status/restart 走原生 `groupHttpFetch` 的显式 cookie，不依赖 relay Bearer。
- Android 本机无 SDK，未构建（仅静态检查）。

---

## 0.1.2（App 锁触发时机/位置修复 + 恢复群体版「重启主机 DSH」）真机验收记录 — 待用户验收

> 来源：用户对 0.1.1 真机验收反馈两件事——
> A) 开启 App 锁后，进入 App 每次「同步信息 / 心跳」都会强制面容识别；App 锁开关应放到 App 设置页。
> B) 「重启主机 DSH」不属于单体版功能，群体版需要加回。
> **以下结果尚未由用户确认，不得勾选**；用户验收通过后再补充结论与日期。
>
> 前置：主机端需升级到 **host-plugin ≥ 0.2.1**（恢复 `/__dsh_remote/status` 的
> `restart.enabled` 与 `/__dsh_remote/restart`；`GET status` / `POST restart` 均按
> `__Host-dsh_session` cookie 或 Bearer token 鉴权）。relay 本轮**不重新部署**（0.3.0 不变）。

| 项目 | 值 |
|---|---|
| App 版本 | 0.1.2（buildNumber 8 / Android versionCode 8） |
| 构建 | iOS Release（手动签名），`expo prebuild -p ios --no-install` + `pod install` + `xcodebuild` |
| 构建结果 | `** BUILD SUCCEEDED **`（Xcode Release，手动签名；bundle 版本读到 0.1.2 / 8） |
| 安装 | 已用 `devicectl` 覆盖安装并启动到用户验收用 iPhone（UDID/序列号不入库）；启动后进程存活 |
| 构建目录 | `/tmp/dsh-ios-group-clean8`（本机临时目录，不入库） |
| 原生模块 | `modules/dsh-mtls` 新增 `groupHttpFetch`：带 `__Host-dsh_session` cookie（+ Bearer）的 HTTPS 请求，供主机 status/restart 内部接口使用；不使用设备证书 / mTLS |
| 静态检查 | `npx tsc --noEmit`、`npm run check:native`、`npm run check:shell` 均通过 |
| entitlement | 构建产物无 `aps-environment`（**仅 ≤0.1.7 历史**：0.1.8 起由 expo-notifications plugin 生成并支持推送，见顶部 0.1.8 章节） |

### 本版本改动

1. **App 锁**：开关从「设备与安全」页移到 **App 设置页**（版本卡片之后）。
   锁屏只在①冷启动（开关开启时）与②打开主机连接（主页点开主机 / 配对成功进入 WebView）时触发；
   **删除**了 App.tsx 里两个 `AppState === 'active'` 监听（原先每次回前台/解锁回调都会重新上锁，
   是反复弹面容的根因）。进入主机后的同步信息、心跳、切会话、回前台都**不再**要求生物识别。
2. **重启主机 DSH**：进入主机后通过原生 `groupHttpFetch` 请求
   `GET /__dsh_remote/status`（带会话 cookie），仅当返回 `data.restart.enabled === true`
   时在顶栏显示 ⏻；点击 → 二次确认 → `POST /__dsh_remote/restart` → 202 后显示「重启中」
   并轮询 status 探活（每 1.5s、单次 3s 超时、最多 30s）→ 主机恢复后自动重新加载 WebView。
   失败按 401/405/501（`host-restart-disabled` / `host-restart-unavailable`）/502/503 给可读提示，
   文案不再出现「设备证书 / mTLS / 证书已失效」。
3. 版本线：App **0.1.2**、iOS **buildNumber 8**、Android **versionCode 8**
   （`app.json` / `package.json` / `modules/dsh-mtls/android/build.gradle` 同步）。

### 待用户确认的验收项（未勾选）

- [ ] 覆盖安装 0.1.2 (build 8) 后 App 正常启动；0.1.1 的群体版配对记录可继续使用，无需重新扫码。
- [ ] **App 锁开关在「App 设置」页**（版本卡片之后），「设备与安全」页不再有 App 锁开关。
- [ ] 开启 App 锁后：App 冷启动首次进入要求 Face ID/Touch ID；从主页点开主机连接要求一次 Face ID/Touch ID。
- [ ] **进入主机后不再反复弹面容**：同步信息 / 心跳 / 切换会话 / 切后台再回前台 / 解锁弹窗收起后，
      均不再出现面容识别；解锁成功后界面保持解锁状态。
- [ ] 关闭 App 锁后不再要求识别；开关状态重启 App 后保持。
- [ ] 主机「远程访问 → 组件」开关**关闭**时，进入主机顶栏**没有** ⏻（只有返回/设置/刷新）。
- [ ] 主机打开「允许手机重启主机 DSH」后进入主机，顶栏出现 ⏻。
- [ ] 点 ⏻ → 二次确认 → 主机 DSH 重启；App 显示「重启中」，主机恢复后页面**自动重新加载**并恢复实时连接。
- [ ] 组件未开启 / 主机不支持时点重启的提示可读（如「主机未允许手机重启 DSH…」），
      且不出现「设备证书 / mTLS」措辞。
- [ ] **前后台均仍不收到任何推送**；设置页没有通知/推送项。（**仅 ≤0.1.7 历史行为**：0.1.8 起支持 iOS APNs 推送）
- [ ] 群体版既有功能不回归：配对（含 SAS 确认）、会话列表/消息收发、WebSocket 实时流、
      切后台回前台 token 续期、设备撤销提示、外链在 App 内嵌浏览器打开、清理缓存。

### 回归命令（本机）

```bash
cd dsh-remoteApp && npx tsc --noEmit
cd dsh-remoteApp && npm run check:native
cd dsh-remoteApp && npm run check:shell
# iOS Release 构建（buildNumber 8）见本文件「构建与安装（iOS）」
```

### 备注 / 未决

- relay 边缘（0.3.0，本轮不重部署）对普通隧道流量**只校验 `__Host-dsh_session` cookie**；
  App 的 JS `fetch` 拿不到 WebView 的 cookie store，因此 status/restart 改走原生
  `groupHttpFetch`（显式 cookie + Bearer）。若未来 relay 支持 Bearer，可去掉 cookie 兼容。
- 若主机端尚未升级到 host-plugin ≥ 0.2.1：status 响应没有 `restart` 字段 → ⏻ 不显示（预期）。
- Android 本机无 SDK，未构建（与 0.1.1 相同，仅静态检查）。

---

## 0.1.1（剥离 classic / 只保留群体版）真机验收记录 — 待用户验收

> 来源：App 已删除全部 classic/单体 mTLS 模式与 APNs 推送 / 应用内通知 / 远程重启主机，
> 只保留群体版（v2 token 配对 + P-256 设备密钥 + 短时 token）。
> **以下结果尚未由用户确认，不得勾选**；用户验收通过后再补充结论与日期。
>
> 前置：服务端需先升级到 **relay 0.3.0 / host-plugin 0.2.0**（本分支只含群体版）；
> 旧 App 连接记录会被丢弃，需重新扫码配对。

| 项目 | 值 |
|---|---|
| App 版本 | 0.1.1（buildNumber 7 / Android versionCode 7） |
| 构建 | iOS Release（手动签名），`expo prebuild -p ios --no-install` + `pod install` + `xcodebuild` |
| 安装 | 覆盖安装到用户验收用 iPhone（`devicectl`；UDID/序列号不入库） |
| 构建目录 | `/tmp/dsh-ios-group-clean`（本机临时目录，不入库） |
| 原生模块 | `modules/dsh-mtls` 只含群体版：P-256 设备密钥 / 签名 / `__Host-` cookie / 缓存清理 |
| 静态检查 | `npx tsc --noEmit`、`npm run check:native`、`npm run check:shell` 均通过 |
| entitlement | 构建产物无 `aps-environment`（**仅 ≤0.1.7 历史**：0.1.8 起重新支持 iOS APNs 推送） |

### 待用户确认的验收项（未勾选）

- [ ] 覆盖安装 0.1.1 (build 7) 后 App 正常启动；0.1.0 的群体版配对记录可继续使用（升级迁移），
      classic 版遗留记录被丢弃。
- [ ] 扫码/粘贴 v2 token 二维码完成群体版配对（桌面确认 + SAS 一致）。
- [ ] 进入主机后 DSH 手机布局正常；会话列表 / 消息收发 / WebSocket 实时流正常。
- [ ] 切后台再回前台、长时间停留后仍能正常访问（token 续期）。
- [ ] 主机侧撤销设备后，重新进入提示「设备已在主机侧失效」并引导重新配对。
- [ ] **前后台均不再收到任何推送**；设置页没有通知/推送项。（**仅 ≤0.1.7 历史行为**：0.1.8 起支持 iOS APNs 推送）
- [ ] 主界面顶栏没有「重启主机」按钮（只有返回 / 设置 / 刷新）。
- [ ] 设置页只有版本 / 清理缓存 / 设备与安全，无 classic/mTLS/证书项。
- [ ] 「设备与安全」页显示 token 认证、主机 ID、端口、P-256 设备密钥 label、App 锁开关；
      无证书 / mTLS 诊断 / 证书导入项。
- [ ] 外链在 App 内嵌浏览器打开；解除本机配对后可重新扫码配对。

### 回归命令（本机）

```bash
cd dsh-remoteApp && npx tsc --noEmit
cd dsh-remoteApp && npm run check:native
cd dsh-remoteApp && npm run check:shell
# iOS Release 构建（buildNumber 7）见 dsh-remoteApp/README.md「构建与安装」
```

---

## 群体服务版（A 模式 / token 鉴权）真机验收记录 — 2026-11-01

> 分支 `feat/group-service`：relay 终止 TLS、主机出站隧道、设备 P-256 密钥 + 短时 token
> （无客户端证书）。**用户于 2026-11-01 确认通过**（原话要点：切回 nginx 前置链路后重新配对，
> 可正常进入界面）。以下标识全部脱敏。

| 项目 | 值 |
|---|---|
| App | 0.1.0（群体版起始版本线）buildNumber 6（iOS Release，真机安装） |
| host-plugin | 0.1.23 |
| relay | 0.2.13（验收镜像）；0.2.14 仅日志降噪，功能一致 |
| 设备 | iPhone 真机（iOS 真机系统，Secure Enclave P-256）；UDID/序列号不入库 |
| 网络 | 5G 蜂窝 / Wi-Fi 均验证；公网 relay + 部署方 nginx 前置链路 |

### 验收项

| 项目 | 结果 | 说明 |
|---|---|---|
| 扫码配对（v2 token 模式） | ✅ | relay `challenge issued` + `token issued`，主机设备表新增设备 |
| 配对后立刻进入 | ✅ | 无 401/404；token 一次签发，页面直接加载 |
| DSH 手机布局 | ✅ | 左侧抽屉覆盖式（不挤压正文）、点会话放大、返回正常 |
| 页面内导航 | ✅ | 不再跳到 App 内嵌浏览器（隧道地址带端口时也识别为隧道内） |
| WebSocket 实时通道 | ✅ | `/api/remote.mux` 经隧道升级成功，可收发流式消息 |
| 配对后「重试」可用 | ✅ | 修复前「重试才能进」的连接复用问题已消除 |
| 设备「最近连接」 | ✅ | 群体版鉴权成功即更新 `lastSeen`，管理台不再显示「从未连接」 |
| 停用 nginx 直连对照 | ✅ | 直连 edge 端口与 nginx SNI 前置两种形态均可用 |

### 本分支修复的问题（对应现象）

1. **配对后立刻 401、点重试又能进**：relay 边缘隧道只处理连接上第一个请求，iOS keep-alive
   复用连接导致 pairing 之后的 challenge 被透传到主机明文代理。修复：relay 对隧道化请求强制
   `Connection: close`（WebSocket Upgrade 除外）。
2. **页面能开但「暂无会话 / 一直重新连接中」**：主机 loopback 明文代理未处理 WebSocket 升级。
   修复：host-plugin 增加 upgrade 代理（同一套 token+设备校验后交给 `DshProxy.handleUpgrade`）。
3. **跳内嵌浏览器 / 手机布局丢失**：隧道地址带显式端口时被误判为外链。修复：隧道 URL 按
   hostname（忽略端口）匹配。
4. **设备失效后无限 401/重试**：relay 返回 `unknown_device` 时 App 给出「设备已在主机侧失效，
   请删除本机连接重新扫码配对」的明确提示，并只对刚配对窗口做一次短暂重试。
5. **challenge 并发/重复导致 token 401**：relay 允许同一设备多个未消费 challenge（互不覆盖）。
6. **配对后 redirect 的旧连接**：relay 在主机控制连接替换/短暂重连时不再清空设备表。

### 回归命令（本机）

```bash
cd dsh-remoteService && npm test            # 195/195
cd dsh-remoteService && npm run validate:artifacts
cd dsh-remoteApp && npx tsc --noEmit
cd dsh-remoteApp && npm run check:native
cd dsh-remoteApp && npm run check:shell
# iOS Release 构建（buildNumber 6）
xcodebuild -workspace DSHRemote.xcworkspace -scheme DSHRemote -configuration Release \
  -destination 'generic/platform=iOS' build
```

---

---

## 构建与安装（iOS）

```bash
cd dsh-remoteApp
npm install
npx expo prebuild -p ios --no-install
cd ios && CP_HOME_DIR="$PWD/.pods-home" CP_CACHE_DIR="$PWD/.pods-cache" pod install
cd ..

# A) 免签名编译验证（开发机/代理用，不装机；确认原生工程与 expo-notifications 可编译）
xcodebuild -workspace ios/DSHRemote.xcworkspace -scheme DSHRemote -configuration Release \
  -destination 'generic/platform=iOS' -derivedDataPath /tmp/dsh-ios-build \
  CODE_SIGNING_ALLOWED=NO build
# 期望 `** BUILD SUCCEEDED **`；并确认推送 entitlement 已生成：
plutil -p ios/DSHRemote/DSHRemote.entitlements   # 应包含 "aps-environment" => "development"

# B) 真机签名安装（由持有签名材料的人执行）
xcodebuild -workspace ios/DSHRemote.xcworkspace -scheme DSHRemote -configuration Release \
  -destination 'generic/platform=iOS' -derivedDataPath /tmp/dsh-ios-build \
  CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM=<TEAM_ID> \
  PROVISIONING_PROFILE_SPECIFIER=<PROFILE_UUID> \
  CODE_SIGN_IDENTITY='Apple Development: <NAME> (<CERT_ID>)' build
xcrun devicectl device install app --device <IPHONE_UDID> /tmp/dsh-ios-build/Build/Products/Release-iphoneos/DSHRemote.app
xcrun devicectl device process launch --device <IPHONE_UDID> <BUNDLE_ID>
```

> - 签名材料、Team ID、描述文件 UUID、UDID、bundle id 走本机参数/环境变量，不入库。
> - 推送：`expo-notifications` plugin 在 `ios/DSHRemote/DSHRemote.entitlements` 生成
>   `aps-environment`（development）；TestFlight/App Store 签名 profile 会覆盖为 production。
>   **只有带该 entitlement 的签名包**才能拿到 APNs device token（模拟器 / Expo Go 不行）。
> - 改了 `app.json` 的 `version`/`buildNumber` 或 plugins 后必须重新 `expo prebuild` +
>   `pod install`：`xcodebuild` 实际读生成后的 `ios/DSHRemote/Info.plist` 与 entitlements。
> - **R2 官方包构建**（仅 owner 做）：在同一条命令前注入构建环境变量
>   `EXPO_PUBLIC_PUSH_CHANNEL=official EXPO_PUBLIC_PUSH_HUB=https://push.example.com`
>   （占位符；真实 hub 地址只放构建环境/CI secret，不入库）。
>   `self`（部署方自签）构建不注入这两个变量，继续走 relay 推送。

Android（当前开发机无 SDK）：需要 Android SDK + JDK 17+，`npx expo prebuild -p android` 后
`npx expo run:android --variant release`；同一份 JS/原生 group 模块，验收项同 iOS。

## 回归命令

```bash
cd dsh-remoteApp && npx tsc --noEmit
cd dsh-remoteApp && npm run check:native
cd dsh-remoteApp && npm run check:shell
cd dsh-remoteApp && npx expo config --type public
```

## 已知限制

- Android 未构建/未真机（仅静态检查）。
- 推送仅 iOS APNs（Android FCM 未接入）。R2 `official` 通道只对**内置官方 hub 地址的官方构建**生效
  （仓库默认 self + 空 endpoint；真实地址由 owner 构建时注入，不入库）；official 不带 sessionId
  （点通知只打开主机）；credential 缓存有效期由 hub 决定（默认 7 天，进入主机/回前台续期）。
  App 本地「推送」开关只停止新登记，已登记 token 的注销依赖主机侧「推送提醒」/设备撤销/relay 重启。
- iOS 原生无法程序化设置 HttpOnly cookie（依赖 relay `Set-Cookie`；App 注入的会话 cookie 为 Secure/SameSite=Strict/host-only）。
- 旧 classic/单体版连接记录会在升级后直接丢弃（本分支只支持群体版）。

## 证据与脱敏

截图/日志放 `dsh-remoteApp/docs/evidence/`（可选）；提交前按根目录 `AGENTS.md`「三」脱敏
（域名、hostId、设备 ID、UDID、序列号、token、cookie、二维码一律替换为占位符）。
