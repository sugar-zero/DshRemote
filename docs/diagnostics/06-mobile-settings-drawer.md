# 06 — 手机端设置弹窗太挤：改全屏 + 分区菜单抽屉

> 症状（用户反馈）：App 里从左侧栏（会话侧栏抽屉）点「设置」后，设置仍是桌面端的
> 左右布局（左分区菜单 188px + 右内容），手机上内容区只剩 ~154px，表单/说明全部
> 挤成竖排。期望：设置全屏、左侧菜单改成抽屉、保留左上返回退出设置。
>
> 范围：`dsh-remoteApp/src/lib/mobileWebShell.ts`（注入 DSH Web UI 的手机壳）；
> DSH Web UI **0.2.1-rc.3** 的 `@deepseek-ai/dsh-client-ui-settings-general`（设置 modal）。

## 0. TL;DR

1. **根因**：DSH 设置是 body portal 的居中 modal —— `.panel` 宽 800、
   `max-width: calc(100vw - 48px)`，左侧 `.nav` 固定 188px，右侧 `.content` 自适应。
   390×844 的 WebView 里 `panel` 被压成 342×796，减去 188px 菜单后内容区
   （`.options`）只剩 **154×742**。
2. **修复**（纯注入 CSS/JS，不改 DSH 源码）：
   - 窄屏（`max-width: 760px`）下把 `[data-shortcut-modal="settings"]` 的 panel 固定
     为铺满 WebView；
   - 左 `nav` 变成左侧离屏抽屉（宽 `min(86vw, 320px)`）：右上菜单按钮或左缘右滑打开，
     点抽屉项 / 点抽屉外 / 左滑收起；
   - 内容区顶部注入手机栏：**左上返回**（调 DSH 原生 close 退出设置）、标题（取 DSH
     `settings.header` 槽位文案）、右侧菜单按钮；DSH 原生 header 隐藏。
3. **可退**：所有覆盖挂在 `html.dsh-settings-mobile` 下（注入成功才加），且只用
   `data-shortcut-modal="settings"` 稳定属性 + panel 直系子节点/稳定类名后缀定位：
   DSH 改版导致识别失败时，最坏退化为原生居中 modal，设置仍可用。
4. **验证**：`npm run check:shell` 新增真实 DOM/CSS 的设置 fixture 与 20 项断言，
   43/43 通过；同一 fixture 换旧注入壳跑 16 项失败，并复现 342×796 / 内容 154×742。
5. **生效**：纯 JS（注入壳），**无需重建原生**；dev client Metro reload，发布包重打
   JS bundle。App 版本不变（0.1.5 build 6）。

## 1. 真实结构（DSH 0.2.1-rc.3）

`@deepseek-ai/dsh-client-ui-settings-general` 的 `SettingsRoot.js` 把弹窗 portal 到
`document.body`（类名是 CSS Modules，哈希前缀 `_77Pn0W_`；这里用稳定后缀表达）：

```text
document.body
└─ ._overlay                          position:fixed; inset:0; z-index:1000; flex 居中
   ├─ ._mask                          点它关闭设置
   └─ ._panel[data-shortcut-modal="settings"]
        │   width:800; height:min(800, 100vh - 2*max(24, overlay-top));
        │   max-width:calc(100vw - 48px); display:flex; overflow:hidden
        ├─ nav._nav                   宽 188；._navTitle / ._navList / button._navCell
        └─ div._content               flex:1; flex-direction:column
             ├─ div._header           高 54；._actions + button._close
             └─ div._options          flex:1; overflow-y:auto; padding:0 24px 24px
```

旧注入壳只在 390×844 下量到的几何（无头 Chrome，`check:shell --shell-js <旧版>`）：

| 元素 | rect | 尺寸 |
|---|---|---|
| `_panel` | (24, 24) – (366, 820) | 342 × 796 |
| `_nav` | (24, 24) – (212, 820) | 188 × 796 |
| `_options`（内容区） | (212, 78) – (366, 820) | **154 × 742** |

即：390px 宽屏幕里，设置内容只有 154px —— 这就是「太局促」的来源。

## 2. 修复

效果示意（fixture 复刻真实 DSH CSS 的布局预览，非真机截图）：
[before](../../mockups/mobile-settings-before.png) → [after](../../mockups/mobile-settings-after.png)，
[抽屉打开](../../mockups/mobile-settings-drawer.png)。

### 2.1 panel 全屏

```css
@media (max-width: 760px) {
  html.dsh-settings-mobile [data-shortcut-modal="settings"] {
    position: fixed !important; inset: 0 !important;
    width: 100% !important; max-width: 100% !important;
    height: 100% !important; max-height: 100% !important;
    border-radius: 0 !important; box-shadow: none !important;
  }
}
```

### 2.2 分区菜单 → 左侧抽屉

```css
html.dsh-settings-mobile [data-shortcut-modal="settings"] > nav {
  position: fixed !important; left: 0; top: 0; bottom: 0;
  width: min(86vw, 320px) !important; max-width: 320px !important;
  z-index: 6;
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base, #1b1c1e)) !important;
  transform: translateX(-103%); visibility: hidden;
  transition: transform 220ms ease, visibility 0s linear 220ms;
}
html.dsh-settings-mobile.dsh-settings-nav-open [data-shortcut-modal="settings"] > nav {
  transform: translateX(0); visibility: visible; transition: transform 220ms ease;
}
```

- `nav` 原宽 188/无背景，改成抽屉后补了不透明背景（否则透出下面内容）。
- 打开/关闭统一由 `html.dsh-settings-nav-open` 驱动（注入脚本负责加/删，和侧栏
  抽屉 `html.dsh-mobile-drawer-open` 同一套思路）。
- `_navList` 原本就是 `overflow-y:auto`，抽屉高度被 fixed 上下边约束后仍可滚动。

### 2.3 抽屉遮罩 + 「点外不误触」

抽屉遮罩是注入脚本插入 panel 的真实节点 `.dsh-mobile-settings-backdrop`
（`position:absolute; inset:0; z-index:5`），不是伪元素：

- nav 上有 `transform`，**伪元素的 fixed 会以 nav 为包含块**，铺不满视口；
- 真实节点还能直接绑 click 收抽屉，并且 `z-index:5 < nav:6`，抽屉永远在上层。

点击兜底在 `document` 的 capture 阶段完成（见 `mobileWebShell.ts` 里的 click 处理）：

1. 点在抽屉里：若是分区按钮 → 收抽屉，**放行**给 DSH 切分区；
2. 点在手机栏：不处理（返回/菜单按钮自己处理）；
3. 点其它位置：收抽屉 + `preventDefault/stopPropagation`，**吞掉这次点击**，
   避免误触设置表单/开关（验证项：「点抽屉外不误触设置控件」）。

### 2.4 手机顶栏（左上返回、标题、菜单）

注入节点插在 `_content` 最前面（`_content` 是纵向 flex：手机栏 / 隐藏的 `_header` /
`_options`），因此内容区高度和滚动仍由 DSH 自己管理，不需要覆盖 `.options` 的
`overflow/padding`：

```text
[‹ 返回] [   设置   ] [☰ 菜单]
```

- **返回** = 左上角退出设置：点 DSH 原生 `_header > button._close`（走它自己的
  `onClose`/store 语义）；若注入后原生按钮意外丢失，依次兜底为「点 `_mask`」→
  「派发 Escape」（DSH `useModalLayer` 监听 Escape）。
- **标题**：取 `_navTitle` 的文本（`设置`），不硬编码。
- **菜单**：`aria-expanded` 随抽屉状态切换；再点一次收起。
- 同时隐藏 DSH 原生 `_header`（其右上角 × 是原来的退出入口，已被左上返回取代）。
- 设置打开期间隐藏手机壳自己的鲸鱼入口：没有会话 header 时它走 fixed 兜底
  （`z-index:9001`），会盖住左上返回。

### 2.5 状态同步（高频路径零查询）

设置弹窗由 React 按需挂载/卸载，注入壳在 `MutationObserver` 里同步：

- **未装**：只在「直接加到 `document.body` 的节点」里找
  `[data-shortcut-modal="settings"]`（body portal 的 overlay），命中才安装；
- **已装**：只做 `isConnected` 的 O(1) 检查；bar 被 DSH 重渲染移除时重装。
  这保持了右栏修复时定下的约束：token 流式渲染时每批 mutation 都进来，
  **稳态不允许 querySelector / 写 DOM**（`check:shell` 的 churn 断言）。
- `resize` / `pageshow` 走低频补装：>760px 时整体拆掉手机壳、恢复 DSH 原生；
  转回窄屏时若设置还开着则重新装上。
- 设置关闭（portal 卸载）：清 `html.dsh-settings-mobile` / `dsh-settings-nav-open`
  与缓存引用（bar/backdrop 随 panel 一起被移除）。

不修改 DSH 的 React 树结构与事件语义：只新增 2 个 DOM 节点（手机栏、遮罩）+ html
状态类，DSH 的分区切换、设置读写、关闭逻辑都保持原样。

## 3. 验证

```bash
cd dsh-remoteApp
npx tsc --noEmit          # 通过
npm run check:native      # 通过
npm run check:shell       # 43/43 通过（新增 20 项设置断言）
```

`check:shell` 新增的第三份 fixture（`SETTINGS_FIXTURE_HTML`）按真实 DSH 0.2.1-rc.3
的 DOM/CSS 复刻设置弹窗（portal 结构、`data-shortcut-modal="settings"`、
`_panel/_nav/_content/_header/_close/_options` 关键规则逐字保留；分区内容用占位
节点代替真实 React 表单），断言覆盖：

1. 打开设置后装上手机壳（手机栏 + html 状态类）；
2. panel 全屏 rect = 0,0,390,844（误差 ≤1px）；
3. DSH 原生 `_header` 隐藏；
4. 手机栏在顶部（高 52）、标题取自 DSH `设置`；
5. 返回按钮在左上（≤12px）；
6. 分区菜单默认收起（visibility hidden、抽屉整体在负屏外）；
7. 内容区从手机栏下方开始且占满 390 宽；
8. 设置打开时鲸鱼入口隐藏；
9. 点菜单 → 抽屉 320px 宽、从左侧进入、遮罩出现；
10. 抽屉打开后左分区可命中；
11. 点抽屉外只收抽屉、不触发内容按钮（点击计数保持 0）；
12. 收抽屉后内容区恢复可点（计数 +1）；
13. 点分区项 → 收抽屉 + DSH 分区切换生效；
14. 点左上返回 → DSH 原生 close 执行、portal 卸载、手机壳状态清理；
15. 再次打开设置 → 手机壳重新装上；
16. DSH 重渲染换掉 nav 节点后，抽屉仍可开、点分区仍能收起（缓存失效时按直系子节点重解析）；
17. 手机栏被 DSH 重渲染移除后，按 `isConnected` 自动补装；
18. 宽屏 1000×800 → 恢复 DSH 原生（panel 800、nav static、无手机栏）；
19. 宽屏转回窄屏 → 已打开的设置重新装上手机壳（resize 补装）；
20. 全程无未捕获 JS 异常。

回归对照（证明用例能抓住旧行为）：

```bash
# 3112409 = 本功能之前的提交（旧的注入壳）
git show 3112409:dsh-remoteApp/src/lib/mobileWebShell.ts > /tmp/mobileWebShell-old.ts
cd dsh-remoteApp
node scripts/check-injected-shell.mjs --shell-js /tmp/mobileWebShell-old.ts
# → 16/43 失败；其中：
#   窄屏设置全屏   rect=24,24,366,820（342×796）
#   内容占满全宽   options=212,78,366,820（154×742）
```

真机目视验收见 [`dsh-remoteApp/docs/ACCEPTANCE.md`](../../dsh-remoteApp/docs/ACCEPTANCE.md)
第 21 项（本机开发环境没有 Xcode/iPhone，未做真机截图）。

## 4. 生效方式 / 已知限制

- **生效**：改的是 App 侧注入的 JS 字符串（`mobileWebShell.ts`），不涉及 iOS/Android
  原生源码，**不需要重建原生包**；dev client Metro reload 即可，Release 包需要重新
  打包/安装 JS bundle（版本号无需变化）。
- **依赖**：`data-shortcut-modal="settings"` 属性、panel 直系 `nav` / `div._content`、
  `._navTitle` / `._header` 类名后缀。DSH 若改结构：识别不到时不会注入手机栏，
  CSS 覆盖又都挂在 `html.dsh-settings-mobile` 下，因此最坏退化为原来的居中 modal
  （仍是可用状态，不会白屏/锁死）。
- **断点**：>760px（平板/横屏）沿用 DSH 原生居中 modal，和侧栏/右栏的手机壳断点一致。
- **未覆盖**：iOS 真机上的安全区/键盘弹出目视效果；iOS 26 的玻璃材质主题差异
  （只改了几何与层叠，未覆盖主题变量）。
