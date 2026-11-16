# 13 — App（iOS WebView）输入框删字时页面上下跳动：根因与修复

- 现象（用户 2026-11-01 真机录屏）：在 DSH Remote App（群体版，0.1.8 build 15）里打开会话，
  点输入框弹出键盘后**连续删除文字**，整个聊天区/输入框在两个位置之间**上下来回跳**。
- 影响范围：iOS App（WKWebView），只在**软键盘弹出时**出现；不涉及 host 插件 / relay / 推送。
- 结论：**不是 DSH 渲染抖动，也不是 host 数据问题**，是 iOS WKWebView 的键盘避让
  （`scrollView.contentInset`）与页面自身滚动互相拉扯；App 侧没有做键盘避让（WebView 没缩小）导致。

## 1. 录屏逐帧证据

素材：7.53s / 1320×2868 / 60fps（iPhone 17 Pro Max 录屏），转 30fps 逐帧分析（共 226 帧）。

| 观察 | 数据 |
|---|---|
| 键盘是否移动 | **不动**：键盘/输入辅助条（↑↓✓）在画面中的位置逐帧一致 → 抖动不是键盘动画 |
| 整页内容位移 | 两次稳定状态之间，内容（同一段聊天文本）竖直位移约 **186 CSS px**（≈558 设备像素，见全局位移搜索最优 dy≈+186/440 宽缩放） |
| 抖动触发时机 | 每次屏上「删除键高亮」的下一帧，页面在状态 A/B 之间切换一次；未删字时两状态各自稳定 |
| DSH 自己的 header（会话标题/「对话/轨迹」） | 键盘弹出后**两状态都看不到**（页面已被上滚，header 在屏幕外）|
| 输入框（composer） | 状态 A：在键盘上方可见；状态 B：被键盘/辅助条盖住，几乎不可见 |

结论：键盘弹出后，WKWebView 把整个网页上滚了一段；每次输入/删除事件，页面滚动位置在
两个 offset 之间来回切换。

## 2. 机制（为什么只有 App 这样）

1. DSH Web UI 是**自滚动布局**：`html, body, #root { height: 100% }`，聊天区在内部
   `scrollBody` 里滚，composer 在页面底部；桌面浏览器没有软键盘，所以从不触发这个问题。
2. iOS WKWebView 在输入框获得焦点、软键盘弹出时，会给自己的 `scrollView` 加
   **键盘 contentInset**，并自动 `scrollRectToVisible` 把「光标」滚进可见区域。此时网页的
   **布局视口仍是整屏高**，composer 在视口最底部（被键盘盖住）→ WKWebView 必须把页面
   上滚才能露出光标。
3. DSH 输入框是 **CodeMirror（contenteditable）**：它在每次输入/选区变化时也会用
   `visualViewport`（键盘弹出后变矮）计算可见区，并尝试把光标滚进可见区（会滚祖先滚动容器）。
   于是同一帧里存在**两套滚动意图**（WebKit 自己的 + CodeMirror 的），二者目标 offset 不同，
   下一次按键又反过来 → 页面在 A/B 两个 offset 之间来回跳。
4. App 侧 `WebViewScreen` 之前**没有键盘避让**：WebView 始终铺满全屏，键盘只是盖在下面，
   所以只能依赖 WKWebView 自动滚页面 → 抖动。

## 3. 修复

`dsh-remoteApp/src/screens/WebViewScreen.tsx`：把承载 WebView 的容器换成
`KeyboardAvoidingView`（iOS `behavior="padding"`，Android 不启用避免与系统 `adjustResize` 叠加）：

```tsx
<KeyboardAvoidingView
  style={styles.webviewWrap}
  behavior={Platform.OS === 'ios' ? 'padding' : undefined}
>
  {/* WebView + 加载/错误覆盖层 */}
</KeyboardAvoidingView>
```

效果：键盘出现时 WebView 的 frame 直接缩到键盘上方 → 网页布局视口 = 可见区，
composer 始终在键盘上方可见；WKWebView 不需要再滚页面，CodeMirror 也不需要滚祖先，
两套滚动意图都消失。附带改善：DSH 自己的会话 header 也不会再被键盘顶出屏幕。

- 版本：App **0.1.8 build 16**（versionCode 16；版本号沿用未发布的 0.1.8，只递增构建号，
  与 AGENTS「同一任务内多次构建可不重复加版本号」一致）。
- Android 不改（`behavior=undefined`；Android WebView 由 Activity `adjustResize` 处理）。

## 4. 验证计划

- 本机：`npx tsc --noEmit`、`npm run check:native`、`npm run check:shell`；
  iOS Release 签名构建并 `devicectl` 安装（build 16）。
- 真机（用户确认，**必须实测**）：
  1. 点输入框弹键盘：聊天区不整体上滚，会话 header 仍在原位，输入框在键盘上方可见；
  2. 连续删除文字 10 次以上：页面/输入框不再上下跳；
  3. 键盘收起后布局恢复，无残留空白；
  4. 回归：滚动会话、发送消息、切换会话、App 锁、推送点击（0.1.8 功能）正常。
- 若仍抖动（说明 WKWebView 仍自行加 inset），下一步备选：
  原生层对 `WKWebView.scrollView` 的 `contentInset` 做 KVO 归零（或注入 JS 用
  `visualViewport` 手动收缩页面高度）；届时另立切片，不在本次盲改。

## 5. 相关文件

- `dsh-remoteApp/src/screens/WebViewScreen.tsx`（本次修复）
- `dsh-remoteApp/src/lib/mobileWebShell.ts`（注入手机壳：viewport 锁定/safe-area；本次未改）
- `docs/diagnostics/03-app-webview.md`（历史「跳动源」分析，本次是新的键盘场景）
