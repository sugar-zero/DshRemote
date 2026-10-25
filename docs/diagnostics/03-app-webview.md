# 03 — App 侧（iOS/Android WebView + 注入手机壳）跳动 / 重载 / 白屏分析

- 范围：`dsh-remoteApp`（Expo SDK 58 / RN 0.88 / React 19）——注入的 DSH 手机壳、`WebViewScreen`、原生 mTLS WebView（Swift/Kotlin）。
- 背景（不重复论证）：手机端"点开会话加载历史很久/失败"的**主因在 host 侧**——DSH 的 WebSocket 心跳在 ~4MB 会话历史快照经慢速中继传输 > ~6s 时判死 `/api/remote.mux`，客户端反复重连；同时 DSH 在 `connection/reset` 后重算模型目录，造成"模型选择器突然刷新"的观感。该问题由 host 插件代理修复（WS ping→pong）。
- 本文只处理 **app 侧**：不放大症状的工程缺陷、进程被回收后的恢复、以及布局跳动源。
- 安全姿态不变：mTLS 挑战逻辑、私钥/证书不出原生、origin 白名单、`mixedContentMode=never`、SSL 错误一律 cancel 均未改动。

## 0. 结论（TL;DR）

1. **app 侧没有发现能独立导致"历史加载慢"的原因**（吞吐与快照大小都在 relay/host 侧）。但发现了两个会让它**看起来更糟**的缺陷：
   - iOS WKWebView 的 WebContent 进程被系统回收后，原生层没有任何回调处理 → 页面变空白/停在最后一帧，且 JS 收不到事件，用户看到的就是"一直加载/卡死"；
   - 注入手机壳在**每次 DOM 变更**时都全量 `document.querySelector`（含 3 个 logo 选择器），在渲染 4MB 历史 / 流式输出 token 期间持续占用主线程。
2. **"屏幕周期性跳一下"**：主因是 DSH 自身的重连→重渲染（host 修复后消失）；但 app 侧确有 4 个可测量的跳动源，已全部修掉：
   - 鲸鱼按钮是 DSH header 左侧 grid 列的唯一内容，DSH 重渲染换掉槽位节点时该列从 34px 塌陷到 0 → 标题横移，再由注入脚本补挂回来（实测 -34px → 0px）；
   - viewport `<meta>` 在加载后被重复写 2 次（共 3 次），iOS 会重新计算 viewport/重排（实测 3 → 1 次）；
   - 错误条插在 WebView 上方，出现/消失挤压 WebView ~50px → 改为 absolute 覆盖层；
   - 顶部进度条条件渲染导致 topBar 高度 ±10px → 改为常驻槽位 + opacity。
3. 顺带修复一个 **pre-existing 编译错误**（`git blame` 指向 `c558aea`）：iOS 模块里 `configuration.preferences.isInspectable` 不存在该成员，**任何一次 iOS 重新构建都会失败**。已改到 `WKWebView.isInspectable`。没有这个修复，本次原生改动无法编译进包。
4. 验证（本机即可复跑）：`npx tsc --noEmit` ✅ 0 error；`npm run check:native` ✅ 0 warning；新增 `npm run check:shell` ✅ 12/12；DSHMTLS pod iOS Simulator 编译 ✅ `BUILD SUCCEEDED`。
5. 生效条件：Swift/Kotlin 改动需要**重新构建原生 App**；纯 JS 改动（注入壳、`WebViewScreen`、bridge 类型）在 dev client 里 Metro reload 即可。**本次没有执行 `expo prebuild`，没有改 `ios/`、`android/` 生成工程，没有重启 DSH。**

## 1. 症状 → 证据映射

| 症状 | 是否 app 侧原因 | 证据（改动前） | 处理 |
| --- | --- | --- | --- |
| 点开会话"加载历史"很久 / 失败 | ❌ 主因 host（心跳判死 + 4MB 快照 + relay 带宽） | 团队已确认，见 `docs/diagnostics/01/02` 与 host 插件修复 | app 侧不做干预（reload 只会把 4MB 重新拉一遍） |
| 同上，但表现为"白屏 / 卡住不动" | ✅ 放大器 | iOS 原生只实现 `didStart/didFinish/didFail*`，**没有** `webViewWebContentProcessDidTerminate`；Android **没有** `onRenderProcessGone`（默认行为是杀掉整个 App） | 见 §3.1 / §3.2 |
| 同上，页面在渲染历史时卡顿 | ✅ 放大器 | 注入壳的 `MutationObserver(body, subtree)` 每次回调都跑 `placeTrigger()` + `installNativeMark()`（最多 4 次全量 `querySelector`）。实测 30 个 mutation 批次 = **31 次 querySelector** | 见 §3.3（O(1) 快路径后 = 0 次） |
| 屏幕周期性"跳"、模型选择器突然刷新 | ⚠️ 主因 DSH 重连后重渲染 | `@deepseek-ai/dsh-client-ui-model-selection/lib/client.js:1002`：`ctx.on("connection/reset", () => { this.catalog.resetGeneration(); ... })` | host 修复；app 侧不通过 reload 干预 |
| 跳动 1：标题行左右横移 | ✅ app 侧 | DSH header 是 grid（`auto minmax(0,1fr)`），左侧 `headerLeading` 是 `auto` 列；我们的鲸鱼按钮是该列唯一内容。DSH 重渲染替换槽位节点时列宽 34px→0。实测替换瞬间标题横移 **-34px** | 见 §3.3（槽位 `min-width` + 同帧补挂 → 0px） |
| 跳动 2：整页重排/滚动位置变化 | ✅ app 侧 | `mobileWebShell.ts` 旧代码在 init/500ms/1500ms 各写一次 viewport meta（内容完全相同）。实测写出 **3 次** | 见 §3.3（只写差异 → 1 次） |
| 跳动 3：出现错误提示时整屏被挤压 | ✅ app 侧 | 错误条位于 WebView **上方**，出现/消失时 WebView 高度变化约 50px | 见 §3.4（absolute 覆盖层） |
| 跳动 4：加载开始/结束时内容上下跳 | ✅ app 侧 | 进度条 `status === 'connecting' ? <View .../> : null`，topBar 高度在 2px+8px 间距间变化 | 见 §3.4（常驻槽位 + opacity） |
| 偶发误报"连接异常" | ✅ app 侧 | iOS 把 `NSURLErrorCancelled(-999)`（重定向/外链/导航取消）当错误上报；Android 把**任意子资源**失败（图片/favicon）当主文档失败上报 | 见 §3.1 / §3.2 |
| 首次打开偶发"没有抽屉/鲸鱼入口"（桌面侧栏） | ⚠️ 潜在竞态 | `WKUserScript` 只对"注册之后开始"的导航生效，而 Expo props 应用顺序不保证 `url` 在 `injectedJavaScript` 之后 | 见 §3.1（首次加载让出一个 runloop） |
| React 重渲染重建原生 WebView | ❌ 已审查，无此问题 | `App.tsx:218` 以 `connection.host` 为 key；`WebViewScreen.tsx:278` 以 `reloadKey` 为 key；`url`/`clientIdentityLabel`/`injectedJavaScript`/`style` 均为稳定值，`applyUrl` 有 `loadedUrlString` 去重 | 不改 |

## 2. 关键证据细节

### 2.1 DSH header 结构与"我们塞进去的按钮"

`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` 内的 `@deepseek-ai/dsh-client-ui-conversation/lib/client.js`：

- `:17962-17975` 渲染 `<header class="…_header">`，其中 `div._headerLeading[data-conversation-header-leading]` 里是 `renderSlot("conversation.header.leading", {})`；
- `:20020-20030` 注册该 slot：`"conversation.header.leading": { kind: "single", scope: "root" }`；
- `:17386`（编译后的 CSS Modules 字符串）：
  - `.kiGsTW_header { display:grid; grid-template-columns: auto minmax(0,1fr); … }`
  - `.kiGsTW_headerLeading { display:flex; grid-area:1/1; flex:none; … }`
  - `.kiGsTW_titleRow { grid-column:2; … }`
  → **第 1 列宽度 = headerLeading 内容宽度**；列里只剩我们的按钮时约 34px，按钮被移除时列宽塌陷为 0。
- 槽位当前是空的：对 182MB 的 `app.asar` 全量 `LC_ALL=C grep -ac "conversation.header.leading"` = **4**，全部位于 `dsh-client-ui-conversation`；没有任何模块向该槽位注册内容。因此旧 CSS 里"隐藏同槽位其它按钮"的规则在 DSH 0.2.1-rc.3 **不会隐藏任何东西**（保留并加注释，见 §3.3）。

### 2.2 模型选择器为何在重连后刷新

`@deepseek-ai/dsh-client-ui-model-selection/lib/client.js:1002`：`ModelDirectoryResolver` 监听 `connection/reset` → `catalog.resetGeneration()` + `directory.resetConnected()`。该服务是 app 外（DSH UI 内部）行为，app 侧无法消除；host 侧的 mux 保活修复保证不再触发 `connection/reset` 涟漪。

### 2.3 缺失的原生恢复回调

```bash
git show HEAD:dsh-remoteApp/modules/dsh-mtls/ios/DSHMTLSWebView.swift | grep -c webViewWebContentProcessDidTerminate   # 0
git show HEAD:dsh-remoteApp/modules/dsh-mtls/android/src/main/java/com/dsh/remote/mtls/DshMtlsWebViewClient.kt | grep -c onRenderProcessGone  # 0
```

iOS 的 WebContent 进程被内存压力杀掉时**不会**触发 `didFail`，页面停在最后一帧（通常是发送按钮还在转圈的"加载中"），与"历史加载不出来"难以区分；Android 未处理 `onRenderProcessGone` 时系统会直接杀掉 App。

### 2.4 pre-existing 编译错误

```bash
cd dsh-remoteApp/ios && xcodebuild -project Pods/Pods.xcodeproj -target DSHMTLS \
  -configuration Debug -sdk iphonesimulator -arch arm64 CODE_SIGNING_ALLOWED=NO build
# 修复前：
#   modules/dsh-mtls/ios/DSHMTLSWebView.swift:69:31: error: value of type 'WKPreferences' has no member 'isInspectable'
# 修复后：
#   ** BUILD SUCCEEDED **
```

`git blame` 显示该行来自 `c558aea perf(app): keep WebView mounted and enable persistent disk cache`（2026-10-25 02:50）。也就是说**下一次 iOS 重建本来就会失败**，与本任务无关但必须先修。

## 3. 改动清单

### 3.1 iOS 原生：`modules/dsh-mtls/ios/DSHMTLSWebView.swift`

| 行 | 改动 | 原因 |
| --- | --- | --- |
| 66–79 | `configuration.preferences.isInspectable` → `webView.isInspectable`（`#if DEBUG`，移到 WKWebView 创建之后） | WKPreferences 无此成员；修复 pre-existing 编译错误 |
| 91–113 | 注册 `UIApplication.didBecomeActiveNotification` 观察者（`deinit` 移除） | 进程在后台被回收时 reload 不可靠，回前台再补 |
| 119–138 | 首次 `applyUrl`：若 `injectedJavaScript` 尚未注册，则**让出一个 runloop** 再 load；脚本到达时立即开始导航 | `WKUserScript` 只对注册之后开始的导航生效；Expo props 应用顺序不保证 url 在脚本之后 → 首个页面可能完全没有手机壳（抽屉/鲸鱼入口丢失） |
| 140–167 | `applyInjectedJavaScript`：脚本相同则跳过；空脚本不清空已有脚本 | 避免每次 props 更新 `removeAllUserScripts` 造成脚本短暂缺失 |
| 218–223 | `didFinish` 里重置进程回收恢复预算 | 加载成功 = 已恢复，避免后续误判"连续回收" |
| 248–267 | 新增 `webViewWebContentProcessDidTerminate`：上报 `reason: "content-process-terminated"`（60s 窗口内最多自动 reload 2 次；超限则交给用户点「重试」，JS 重建原生视图后预算清零） | 白屏自愈；有上限防止"回收→reload→又回收"循环 |
| 270–283 | 新增 `reloadLoadedPage()`：前台 `reload()`，后台记 `pendingForegroundReload` | 与上一条配套 |
| 287–292 | `emitLoadingError` 过滤 `NSURLErrorDomain / NSURLErrorCancelled(-999)` | 导航取消（重定向、外链交给系统浏览器、重建）不是连接故障；误报会弹错误条并挤压布局 = "跳一下" |

> mTLS 挑战逻辑（`didReceive challenge`，`NSURLAuthenticationMethodClientCertificate`）**一行未改**。

### 3.2 Android 原生

`modules/dsh-mtls/android/.../DshMtlsWebViewClient.kt`

| 行 | 改动 | 原因 |
| --- | --- | --- |
| 50–58 | `onReceivedError` 只在 `request == null || request.isForMainFrame` 时上报 | 子资源（图片/font/favicon）失败不代表隧道断开；误报会弹错误条挤布局 |
| 70–86 | 新增 `onRenderProcessGone` override（`@TargetApi(26)`），回调 `didCrash` 并 `return true` | 不处理时系统默认杀 App；返回 true 表示自己处理，之后该 WebView 不可再用 |

`modules/dsh-mtls/android/.../DshMtlsWebView.kt`

| 行 | 改动 | 原因 |
| --- | --- | --- |
| 40 / 49 | `renderProcessGone` 标志；进程死后不再 `evaluateJavascript` | 避免对已死 WebView 调用 |
| 64–95 | 渲染进程回收回调：发 `onLoadingError`（`reason: "render-process-gone"`, `recoverable: true`），把死 WebView 从视图树摘掉 | JS 侧据此重建原生视图 |
| 117–120 | `applyUrl` 对 `renderProcessGone` 直接返回 | 避免 `loadUrl` 抛 `IllegalStateException` |
| 125–133 | `onDetachedFromWindow`：只有 `renderProcessGone` 的实例才 `destroy()` | 显式销毁死 WebView，避免渲染进程资源泄漏；不影响正常 detach/reattach |

### 3.3 注入手机壳：`src/lib/mobileWebShell.ts`

| 行 | 改动 | 原因 |
| --- | --- | --- |
| 70–76 | 新增 `[data-slot="conversation.header.leading"] { min-width:34px; min-height:30px }`；保留隐藏规则并注释"当前槽位为空、规则不影响 DSH 0.2.1-rc.3" | 按钮被 DSH 重渲染移除时该 grid 列不再塌陷 → 标题不横移 |
| 81–102 | viewport：缓存 `<meta>`，**内容相同则不写**；保留 500ms/1500ms 兜底检查（纯读取） | 避免 iOS 反复计算 viewport/重排（实测写出 3 次 → 1 次） |
| 113–134 | `installNativeMark()` 扫描节流：最多 1s 一次 | 鲸鱼 logo 未出现时不再每次 DOM 变更查 3 个全量选择器 |
| 136–173 | 缓存 header 槽位引用 + `isConnected` O(1) 判断；`placeTrigger()` 只在按钮真被移除时搬 DOM；槽位缺失时延迟 800ms 才退化为 fixed 悬浮；1s `setInterval` → 3s 低频兜底（同时重试 logo） | 消除每次 mutation 的全量查询与"头部内/左上悬浮"来回跳 |
| 233–255 | `pageshow` 时补一次；`MutationObserver` 增加 O(1) 快路径（按钮在槽位、logo 已装、背景层在 → 直接 return） | 流式渲染高频路径零查询零 DOM 写；真被移除时仍在同一微任务内同步补挂（赶在绘制前） |

### 3.4 App UI 层：`src/screens/WebViewScreen.tsx`

| 行 | 改动 | 原因 |
| --- | --- | --- |
| 99–101 / 111–121 | `nativeRecoveryRef`（60s 内最多自动重建 2 次）；用户手动「重试」清零预算 | 防止崩溃循环；手点重试后恢复自动恢复能力 |
| 167–207 | `recoverNativeView()`、`handleNativeLoadingFinish()`（成功后清错误条，与 RN 路径对齐）、`handleNativeError()`（`render-process-gone` → 重建原生视图；iOS 的 `content-process-terminated` 由原生自愈，不重建） | Android 渲染进程死后必须换新原生视图；iOS 自动 reload 后错误条要及时消失 |
| 251–257 | 进度条常驻，用 `opacity` 显隐 | 消除 topBar ±10px 高度变化 |
| 319–336 / 435–451 | 错误条改为 WebView 上方 `absolute` 覆盖层（在 WebView 之后渲染以覆盖），实色背景 + danger 下边框 | 消除错误条出现/消失时 WebView 被挤压 ~50px |
| 278 / 284–285 | 原生视图绑定 `handleNativeLoadingFinish` / `handleNativeError` | 与上两条配套 |

### 3.5 JS bridge 类型：`modules/dsh-mtls/src/index.ts`

`DshMtlsWebViewErrorEvent.nativeEvent` 增加可选 `reason?: string` 与 `recoverable?: boolean`（Android/iOS 原生传给 JS 的机器可读原因；不含任何敏感信息）。

### 3.6 新增校验脚本（本机可复跑）

- `dsh-remoteApp/scripts/check-injected-shell.mjs`：把注入脚本放进无头 Chrome 的一个"仿 DSH header"页面（`grid-template-columns: auto minmax(0,1fr)` + `[data-slot="conversation.header.leading"]` + `_railMark` logo），断言 12 项：初始化、按钮在槽位、logo、viewport 锁定且只写一次、槽位重建后标题不横移、同帧补挂、流式变更 0 次 querySelector、抽屉开关、无未捕获异常。
- `package.json` 新增 `"check:shell": "node scripts/check-injected-shell.mjs"`（找不到 Chrome 时自动跳过、不算失败）。

## 4. 验证结果

### 4.1 必跑检查（本机通过）

| 命令 | 结果 |
| --- | --- |
| `cd dsh-remoteApp && npx tsc --noEmit` | ✅ exit 0（0 error） |
| `cd dsh-remoteApp && npm run check:native` | ✅ 0 failures / 0 warnings |
| `cd dsh-remoteApp && npm run check:shell` | ✅ 12/12（fixture 无头 Chrome） |
| `cd dsh-remoteApp/ios && xcodebuild -project Pods/Pods.xcodeproj -target DSHMTLS -configuration Debug -sdk iphonesimulator -arch arm64 CODE_SIGNING_ALLOWED=NO build` | ✅ `** BUILD SUCCEEDED **`（含本次全部 Swift 改动；用已生成的 Pods 工程，未执行 prebuild） |

### 4.2 注入壳 before / after（同一 fixture，旧脚本用 `git show HEAD:…` 抽取）

| 指标 | 改动前 | 改动后 |
| --- | --- | --- |
| 加载阶段 viewport `<meta>` 写入次数 | 3 | **1** |
| DSH 重建 header 槽位瞬间标题横移 | -34px | **0px** |
| 30 个流式 mutation 批次触发的 `document.querySelector` 次数 | 31 | **0** |
| 初始化阶段 querySelector 次数（同一 fixture） | 13 | 7 |
| 抽屉开/关、鲸鱼 logo、未捕获异常 | 正常 / 无 | 正常 / 无 |

复现方式（本机，不依赖 DSH/relay）：

```bash
cd dsh-remoteApp && npm run check:shell
```

### 4.3 未执行的验证（诚实声明）

- **真机运行**：没有在 iPhone 上跑新构建（设备构建/安装由用户执行，见 §5）。
- **Android Kotlin 编译**：本机没有 Android SDK，只有 `check-native-sources.mjs` 的静态检查（括号/API/接口一致）；Kotlin 改动需在 Android 构建流水线上验证。
- **进程回收恢复的真实触发**：`webViewWebContentProcessDidTerminate` / `onRenderProcessGone` 需要真机内存压力才能自然触发，本机无法制造；代码路径只做了编译级与逻辑级验证。

## 5. 生效条件 / 构建说明

| 改动 | 生效方式 |
| --- | --- |
| `src/lib/mobileWebShell.ts`、`src/screens/WebViewScreen.tsx`、`modules/dsh-mtls/src/index.ts` | **纯 JS**：dev client 里 Metro reload / 重开 App 即可（`npx expo start` + `r`）；打包版需要重新打 bundle |
| `modules/dsh-mtls/ios/DSHMTLSWebView.swift` | **必须重新构建 iOS 原生**（本次改动只在 Swift 里，JS 侧无法替代） |
| `modules/dsh-mtls/android/**/*.kt` | **必须重新构建 Android 原生** |
| 新增 `scripts/check-injected-shell.mjs` + `package.json` script | 无需构建 |

- 不需要 `pod install`：没有新增/删除源文件，podspec 的 `source_files` 是 `**/*.{h,m,mm,swift}` glob，`ios/Pods` 现有工程会直接编译新源码。
- **不需要也不应该执行 `npx expo prebuild`**：`ios/`、`android/` 生成工程已存在且会被重新生成覆盖；本次没有改 app.json/native 配置。
- iOS 重建（任选其一）：
  - `cd dsh-remoteApp && npx expo run:ios --device`；或
  - 按 `STATUS.md` 里既有命令：`xcodebuild -workspace DSHRemote.xcworkspace -scheme DSHRemote -configuration Debug -destination 'id=<IPHONE_UDID>' … build` + `xcrun devicectl device install app …`。
- Android：`cd dsh-remoteApp && npx expo run:android --device`（需 Android SDK）。

## 6. 明确不做 / 后续提案（需 Lead 决策）

1. **iOS 原生 WebView 缺导航策略（origin allow-list）**：RN 路径有 `onShouldStartLoadWithRequest` + `originWhitelist`（`WebViewScreen.tsx:134-149, 305, 315`），但原生 mTLS 视图没有 `webView(_:decidePolicyFor:decisionHandler:)`——页面里点任意链接都会在同一个 WebView 里跳走（外链不会走系统浏览器，也无法返回）。建议后续加一个 `allowedOrigin` prop + `decidePolicyFor`（非 tunnel 的 linkActivated 交给 `UIApplication.open`）。**本次不做**：属于行为变更、需要新 prop、且无法真机验证；不在"跳动/重载"范围内。
2. **Android 注入时机**：目前 `onPageStarted` 里 `evaluateJavascript`，不是严格 documentStart；可用 `androidx.webkit` 的 `WebViewCompat.addDocumentStartJavaScript`（需要额外依赖）。本次不做。
3. **"页面卡住自动 reload"看门狗**：不采用。DSH 的"加载历史"卡住时 reload 会重新拉 4MB 快照并丢失会话/滚动位置，host 修复后重连会自动恢复；app 侧只做**进程死亡**的恢复，不做页面级看门狗。
4. **调整既有移动布局 CSS**（`[class*="_frame"]{display:block}`、`_centerCol` 宽高、`_rightbarCol` 隐藏）：本次不动。它们是让 DSH 在手机上可用的关键覆盖，没有证据表明会造成周期跳动；改动的风险大于收益。（后续：`_rightbarCol` 隐藏确实会让 DSH 右侧栏打不开，已在 2026-10-25 单独修复，见 [`05-mobile-right-panel.md`](05-mobile-right-panel.md)。）
5. **Android 原生侧完整重建 WebView**（不依赖 JS remount）：不做。改为 JS 侧 `key` 重建原生视图（已实现、可测）；Kotlin 未编译验证，native recreate 风险高。
6. **`_header` 槽位隐藏规则**：当前槽位为空、规则无副作用，保留（见 §2.1）。若未来 DSH 在该槽位放按钮，**保留**能避免与鲸鱼入口重叠；若想彻底去掉，需先真机确认无内置控件。

## 7. 安全姿态核对

- mTLS 客户端证书挑战（iOS `didReceive challenge` / Android `onReceivedClientCertRequest`）**未改动**；私钥仍只在 Secure Enclave / Keychain / AndroidKeyStore，JS 侧看不到任何私钥或证书原文。
- `originWhitelist`、`mixedContentMode="never"`、`onReceivedSslError` 一律 `handler.cancel()`：**均未改动**（只在 §6 提案里讨论补齐原生路径）。
- 新增的 `reason/recoverable` 字段只描述 UI 状态，不含主机名、证书、token 等敏感内容。
- 新增 `check-injected-shell.mjs` 只访问本机临时 HTML 文件，不联网、不接触 DSH/relay/证书。

## 8. 残留风险 & 真机验收清单

**残留风险**

- `[data-slot="conversation.header.leading"]` 的 `min-width` 依赖 DSH 内部结构；DSH 升级若改槽位/布局，最坏退化：按钮回到 fixed 悬浮（已有 800ms 退化逻辑），不会崩。
- iOS 进程回收恢复有 60s/2 次的预算；连续崩溃时会停在错误条，需要用户点「重试」（会重建原生视图并清零预算）。
- iOS 在**后台**被回收时延后到 `didBecomeActive` 才 reload；若 App 本身被系统杀掉则走冷启动（重新加载页面）。
- Android 改动未经真实 Gradle 编译，`onRenderProcessGone` 的 `RenderProcessGoneDetail` 使用 `@TargetApi(26)`，minSdk 24 的设备上该回调不会触发（行为等价于改动前，即无恢复能力）。
- 3s 低频兜底 interval 仍常驻；若后续关注功耗，可在 `document.visibilityState === 'hidden'` 时暂停（本次不引入，避免额外状态）。

**真机验收建议（重建后）**

1. 打开一个**大历史**会话：观察是否仍出现"一直加载"；host 修复生效时 mux 不应再每 5–15s 重连（对照 host audit 日志）。
2. 观察会话标题栏：重连发生时标题/模型选择器是否还会横移（应无 -34px 级的横移）。
3. 让 App 进入后台停留一段时间（制造内存压力），回前台：页面应自动恢复；若被回收，应看到"系统回收了网页进程…"错误条并在自动 reload 后消失。
4. 手动点顶部「刷新」：内容不应出现"先上跳 10px 再回来"。
5. 触发一次错误（例如关掉主机/代理）：错误条应覆盖在页面顶部而不是把 WebView 挤下去；恢复后自动消失。
6. 旋转/调整窗口或前后来回切 App：抽屉/鲸鱼入口仍在 header 内，不出现"左上角悬浮"与"header 内"来回跳。
7. 点消息里的外部链接（原生视图当前会在 WebView 内跳走 —— 已知差距，见 §6.1）：确认不会出现错误条误报/白屏。
8. Android（有构建后）：`adb shell am kill` WebView 渲染进程或制造 OOM，观察 App 不崩溃、自动重建页面。
