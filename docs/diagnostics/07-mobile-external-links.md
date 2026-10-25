# 07 — 手机端「查询用量 / 充值 / 意见反馈」点击没反应：外链没有交给系统浏览器

> 症状（用户反馈）：App 里「设置 → 账号与余额」点「更多」后的「查询用量 / 充值 /
> 更多账号信息」，以及侧栏账号菜单里的「意见反馈」，点击后完全没有反应。
>
> 范围：`dsh-remoteApp/src/lib/mobileWebShell.ts`（注入手机壳）+
> `src/screens/WebViewScreen.tsx`（桥消息处理）；DSH Web UI **0.2.1-rc.3** 的
> `@deepseek-ai/dsh-client-ui-settings-account`。

## 0. TL;DR

1. **不是按钮被隐藏，也不是安全限制**：账号页照常渲染，余额/赠金也正常显示；这三个入口
   依赖「打开新页面」。
2. **根因**：DSH 里它们是平台外链（`<a target="_blank">`，或「意见反馈」的
   `window.open`）：桌面 DSH 用 Electron 的 `dshPlatform` 桥打开内嵌平台页，浏览器里
   打开新标签页；而 App 的**原生 mTLS WebView 没有新窗口能力**——
   iOS 侧 `DSHMTLSWebView.swift` 只有 `WKNavigationDelegate`、没有 `WKUIDelegate` 的
   `createWebViewWith`；Android 侧 `setSupportMultipleWindows(false)` 且没有
   `onCreateWindow`。于是 WebKit 直接把 `target=_blank` 丢弃 = 用户看到的「完全没反应」。
3. **修复**（纯 JS，不动原生）：注入壳在 capture 阶段拦截 http(s) 外链锚点，并包装
   `window.open`，把地址通过已有的 `dshMtlsBridge` 上报 `dsh-remote/open-external`；
   App 侧校验只放行 http(s)、排除隧道主机，在 **App 内嵌浏览器**（`react-native-webview`
   全屏覆盖层，顶部返回/刷新/在浏览器打开、底部显示完整 URL）里打开——等价桌面 DSH
   内嵌 DeepSeek 平台页的体验；内嵌页里可一键切系统浏览器。
4. **验证**：`check:shell` 新增 3 项断言（锚点拦截并上报、同源不拦截、`window.open`
   拦截），全套 **49/49** 通过；删掉锚点拦截 / window.open 拦截的两个 mutant 各
   **1/49** 失败；旧注入壳 **19/49** 失败。
5. **生效**：纯 JS（注入壳 + 桥消息 + 内嵌浏览器组件；`react-native-webview` 已在原生
   工程里链接，无需重建原生）；真机验收见 `dsh-remoteApp/docs/ACCEPTANCE.md` 第 22 项。

## 1. 真实来源（DSH 0.2.1-rc.3 账号模块）

`@deepseek-ai/dsh-client-ui-settings-account` 的 `AccountSection`（设置 → 账号与余额）：

```text
「更多」按钮（本地展开）→ links 行（仅登录/凭证已存时注册）：
  <a href={usageUrl} target="_blank" rel="noreferrer">查询用量</a>
  <a href={topUpUrl} target="_blank" rel="noreferrer">充值</a>
  <a href={platform 根地址} target="_blank">更多账号信息</a>
```

- `openUsage` / `topUp` 的 click handler 只在 `openPlatformPage !== undefined` 时
  `preventDefault()` 并打开内嵌平台页；而 `openPlatformPage` 只有在
  `globalThis.dshPlatform` 存在（Desktop Electron）时才注入。
- 浏览器里没有 `dshPlatform` → 走 `<a target="_blank">` 的默认新标签页。
- 账号菜单（侧栏底部头像/「更多」）的「意见反馈」调用 `window.open(contactUrl, "_blank")`。

App 侧现状：

- iOS `modules/dsh-mtls/ios/DSHMTLSWebView.swift`：只有 `WKNavigationDelegate`（客户端
  证书、加载事件、进程回收恢复），**没有实现 `WKUIDelegate`**；`target="_blank"` /
  `window.open` 触发的新窗口请求无人处理 → 丢弃。
- Android `DshMtlsWebView.kt`：`setSupportMultipleWindows(false)`，且
  `DshMtlsWebViewClient` 没有 `onCreateWindow` / `shouldOverrideUrlLoading`。
- `react-native-webview` 回退路径本来有 `onShouldStartLoadWithRequest → 系统浏览器`，
  但生产用原生 mTLS View，所以这条兜底覆盖不到。

> 顺带说明：这不是「远程管理入口被隐藏」那种安全边界（见
> `dsh-remoteService/docs/POC-REPORT.md` 1.29 / `client.js` 的 `isRemoteWebView`），
> 账号页本身在远程 WebView 里是可见、可用的，只是外链跳不出去。

## 2. 修复

### 2.1 注入壳：拦截外链并上报

`mobileWebShell.ts` 在 document 的 capture 阶段：

```js
document.addEventListener('click', function (event) {
  var anchor = event.target && event.target.closest && event.target.closest('a[href]');
  if (!anchor || anchor.hasAttribute('download')) return;
  var url = externalHttpUrlOf(anchor.getAttribute('href') || anchor.href || '');
  if (!url) return;                       // 同源 / 非 http(s)：保持原样
  event.preventDefault();
  event.stopPropagation();
  notifyMtlsBridge({ type: 'dsh-remote/open-external', url: url });
}, true);
```

同时包装 `window.open`（「意见反馈」这类不是锚点的场景）：http(s) 外链同样走桥并返回
`null`，其它情况继续调用原生实现。

`externalHttpUrlOf` 的边界：

- 只接受 `http:` / `https:`；
- 同主机名（含不同端口）/ 同 origin 的地址不拦截（隧道内地址交给外部浏览器只会打不开，
  且外部浏览器没有设备证书）；
- `download` 属性、`javascript:`/`data:` 等一律不动。

桥函数 `notifyMtlsBridge` 新增 `window.ReactNativeWebView.postMessage` 兜底，使
`react-native-webview` 回退路径也能收到桥消息（原来只有原生 mTLS View 的
`window.dshMtlsBridge` / `webkit.messageHandlers`）。

### 2.2 App：校验后在 App 内嵌浏览器打开

`WebViewScreen.tsx` 的 `handleBridgeMessage` 新增分支：校验 http(s)、排除隧道主机后调用
`onOpenExternal(url)`（没有该 prop 时退回 `Linking.openURL`）。`App.tsx` 收到后打开
`ExternalPageScreen`：

```text
┌──────────────────────────────────────────────┐
│ ‹   页面标题 / host          ↻    ↗ 在浏览器打开 │
├──────────────────────────────────────────────┤
│                                              │
│   react-native-webview（独立 cookie 容器）     │
│   https://platform.deepseek.com/...          │
│                                              │
├──────────────────────────────────────────────┤
│ 底部：当前完整 URL（等宽小字）                 │
└──────────────────────────────────────────────┘
```

- 顶部 `‹`：**始终**关闭内嵌页、回到 DSH（等价桌面内嵌页的「返回 DeepSeek Harness」）。
  不做「先回内嵌页历史」——平台页会持续 `pushState`，`canGoBack` 永远为真，按钮看起来
  像卡住/没反应（实机反馈过这个问题）；页内导航用平台页自己的 UI；
- `↻`：重载；`↗`：用系统浏览器打开当前地址（登录/兼容性问题时的兜底）；
- 内嵌页只允许 http(s) 导航；`mailto:`/`tel:` 等 scheme 交给系统；
- 内嵌页与 DSH mTLS WebView 完全隔离：不共享 cookie/凭据，也不出示设备证书；平台页需要
  用户在内嵌页里登录 DeepSeek 账号（WKWebView 数据目录会持久化登录态）；
- 锁屏（App 锁）时自动关闭内嵌页，避免账号内容停在锁屏之下；
- Android 硬件返回键：内嵌页打开时同样先关闭内嵌页（`BackHandler`）。
- 不影响 mTLS 隧道、deny list、设备身份：隧道内链接仍在 DSH WebView 里加载。

### 2.3 为什么不用原生方案

更彻底的做法是在 iOS 实现 `WKUIDelegate.createWebViewWith`、Android 实现
`onCreateWindow`，但那是原生改动（要重建 App、走一遍签名/安装），而注入壳 + 桥消息
已经能覆盖「点链接→系统浏览器」的 iOS/Android 共同行为，且不用动安全姿态。以后若需要
「内嵌平台页」（桌面那种体验），才需要原生 WebView + 专门的平台桥，本期不做。

## 3. 验证

```bash
cd dsh-remoteApp
npx tsc --noEmit          # 通过
npm run check:native      # 通过
npm run check:shell       # 49/49 通过（设置 fixture 新增 3 项外链断言）
```

`check:shell` 的设置 fixture 里新增：

- `<a id="external-link" href="https://platform.example.com/usage" target="_blank">查询用量</a>`
- `<a id="internal-link" href="#settings-internal" target="_blank">内部锚点</a>`
- `#open-window-button`：点击调用 `window.open('https://platform.example.com/feedback')`
- fixture 里用 stub 的 `window.dshMtlsBridge` 记录桥消息。

断言：

1. 外链锚点被拦截，桥收到 `{type:'dsh-remote/open-external', url:'https://platform.example.com/usage'}`，
   页面 `location` 不变（点击被壳吞掉）；
2. 同源/非 http(s) 锚点不被当成外链（不产生 `open-external` 消息）；
3. `window.open` 外链被拦截，桥收到对应 feedback URL。

回归对照：

```bash
git show 3112409:dsh-remoteApp/src/lib/mobileWebShell.ts > /tmp/mobileWebShell-old.ts
cd dsh-remoteApp
node scripts/check-injected-shell.mjs --shell-js /tmp/mobileWebShell-old.ts
# → 19/49 失败（旧壳没有设置手机壳，也没有外链拦截）
```

mutant（临时改注入壳验证断言有效）：

```text
去掉锚点拦截 listener        → 1/49 失败（外链锚点断言）
window.open 不拦截外链        → 1/49 失败（意见反馈断言）
```

## 4. 生效方式 / 已知限制

- **生效**：纯 JS，无需重建原生包；dev client Metro reload，Release 包重打 JS bundle。
- **登录态**：查询用量/充值在 App 内嵌页里打开 DeepSeek 平台页，首次需要在内嵌页里登录
  DeepSeek 账号；登录态保存在 WebView 数据目录（与桌面 DSH 的 Electron 会话独立），App
  不传任何凭据。若平台页在内嵌 WebView 里被登录/风控策略阻挡，可用右上 `↗` 切系统浏览器。
- **非 http(s) 链接**：`mailto:` / `tel:` 等暂未走桥（原生 WebView 同样不能打开）；如果
  后续 DSH 页面里出现这类链接，需要把 scheme 白名单扩展到 `Linking.openURL` 支持的集合。
- **回到 App 后**：账号余额/用量数据不会立即刷新，DSH 在设置页重新打开时会重新读取
  （与桌面 DSH 从内嵌平台页返回后的行为一致）；如需强制刷新，可退出再进设置。
- **内嵌页内的新窗口/弹窗**：如果平台页内部再用 `window.open`/`target=_blank`（少数
  OAuth/帮助链接），内嵌 WebView 不一定支持；用右上 `↗` 切系统浏览器即可。
- **登录态**（重要）：桌面 DSH 打开平台页是「已登录」的，因为 Electron 主进程会给
  `platform.<domain>` 的每个请求注入主机持有的平台凭据（请求头 + cookie）并使用持久化
  session 分区（`dsh-platform-<hash(origin,userId)>`）。App 内嵌 WebView 拿不到这些凭据，
  所以首次打开需要在内嵌页里登录一次，之后 cookie 持久化；要做到桌面那样免登录，需要
  「平台会话桥」：主机经 mTLS 下发/代理平台会话 + App 原生层按域注入请求头/cookie——
  属于安全姿态变更（主机平台凭据会暴露给手机端），需要单独评审，本版未做。
- **真机未验收**：ACCEPTANCE 第 22 项仍为 ☐，需在 iPhone（以及 Android 构建可用时）上
  目视外链在 **App 内嵌浏览器**打开（返回/刷新/在浏览器打开可用）、返回 DSH 后状态正常。
