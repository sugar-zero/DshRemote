# 05 — 手机 App 右侧栏打不开：窄屏全屏面板被注入手机壳 CSS 隐藏

> 症状（用户反馈）：远程 App（iOS WKWebView / Android WebView）里，DSH 会话 header
> 右侧角落的「展开右侧栏」按钮可见；点击后按钮消失（状态确实变成已展开），但看不到
> 任何面板——看起来像「面板打开到了屏幕右边、App 看不到」。
>
> 范围：`dsh-remoteApp/src/lib/mobileWebShell.ts`（注入 DSH Web UI 的手机壳 CSS）；
> DSH Web UI **0.2.1-rc.3** 的 `@deepseek-ai/dsh-client-ui-sidebar-right`（右栏）与
> `@deepseek-ai/dsh-client-ui-layout`（三栏 frame）。

## 0. TL;DR

1. **根因在 app 侧**：注入手机壳在窄屏 `@media (max-width: 760px)` 里有一条
   `[class*="_rightbarCol"] { display: none !important; }`，把 DSH 右栏整列隐藏。
2. **DSH 侧**：frame 宽度 < 768px 时右栏**自动全屏**（`autoFullscreen`）——面板一直挂在
   `_rightbarCol` 里，`position:absolute; top:0; bottom:0; right:0; width:100vw`，打开即
   覆盖整个窗口；展开按钮在 `conversation.session.header.corner`，`expanded` 后按钮
   自身返回 `null`（消失）。
3. 两者叠加 = 用户看到「点一下按钮没了、面板也没有」：按钮消失是 DSH 的正常反应，
   面板不可见是手机壳 CSS 造成的。
4. **修复**：窄屏下不再隐藏整列，改为让 `_rightbarCol` 不生成盒子（`display:contents`）——
   DSH 原生全屏面板（`position:absolute` + inline `width:100vw`）的包含块上移到 `_frame`，
   正好铺满整个 WebView；不覆盖面板几何、不改层叠（不加 `z-index`）。
5. **验证**：`npm run check:shell` 新增无头 Chrome（390×844）右栏断言通过；旧版注入壳在
   同一 fixture 上失败（用例能抓回归）；`npx tsc --noEmit`、`npm run check:native` 通过。
6. **生效**：纯 JS（注入壳），无需重建原生；dev client Metro reload / 发布包重打 JS bundle。

## 1. DSH 右栏在窄屏的真实结构（0.2.1-rc.3）

`@deepseek-ai/dsh-client-ui-layout`（`lib/client.js`）：

```text
.PIRFFq_frame{height:100%;display:grid;position:relative;overflow:hidden}
  ├─ .PIRFFq_sidebarCol
  ├─ .PIRFFq_centerCol              ← 会话区
  └─ .PIRFFq_rightbarCol{min-width:0;position:relative;overflow:visible}
       └─ .Dv5QdW_session{display:contents}        ← sidebar-right 插件
            └─ .Dv5QdW_panel[data-sidebar-right-panel=fullscreen|push]
                   style="width:100vw;--dsh-sidebar-width:100vw"（窄屏 fullscreen 时）
```

`@deepseek-ai/dsh-client-ui-sidebar-right`（`lib/client.js`）：

- `RightbarSeat`：`autoFullscreen = viewportWidth < 768`；`track = shown && !autoFullscreen`。
  也就是手机宽度下打开右栏**不占 track，直接全屏**。
- `SidebarPanel`：inline `width: fullscreen ? "100vw" : width`；
  `data-sidebar-right-panel="fullscreen"`、`data-sidebar-right-open`（展开时才有）。
- 面板 CSS：`.Dv5QdW_panel{position:absolute;top:0;bottom:0;right:0;overflow:clip;
  pointer-events:none}`。
- 收起/展开的视觉：`[data-dockkit-host=dock]` 收起时
  `transform:translateX(var(--dsh-sidebar-width)); visibility:hidden`，展开时
  `transform:none; visibility:visible`；dock host 本身 `pointer-events:auto` 且不透明背景。
- 展开按钮：注册在 `conversation.session.header.corner` 槽位
  （`[data-sidebar-right-expand]`）；`useStore(...expanded) ? null : <Button onClick=setExpanded>`。

所以在手机宽度下：DSH 已经把右栏当成「全屏覆盖层」在画，**唯一的问题是这一层挂在一个
被我们 `display:none` 的祖先下面**。

## 2. 症状链路（为什么是「按钮消失 + 什么都没有」）

1. 手机壳 CSS（旧版）：

   ```css
   @media (max-width: 760px) {
     [class*="_frame"] { display: block !important; }   /* 三栏 → 单列 */
     [class*="_centerCol"] { width: 100% !important; height: 100% !important; }
     [class*="_rightbarCol"] { display: none !important; }  /* ← 根因 */
   }
   ```

2. header 角落的展开按钮在 center 列里，不受影响 → 用户看得到。
3. 点击 → `actions.setExpanded(sessionId, true)` → `ExpandButton` 返回 `null`（按钮消失），
   `SidebarPanel` 加上 `data-sidebar-right-open`，内容从 `translateX(100vw)` 滑回。
4. 但 `_rightbarCol` 是 `display:none`：整棵子树不在渲染树里，面板画布 0×0/不可见。
5. 用户观测 = 「按钮没了 + 什么都没出现」→ 自然猜测「打开到了右边、App 看不到」。
   实际上面板从未被绘制（不是定位到视口外）。

> 为什么当初会这么写：手机壳最初只处理「桌面三栏 → 手机单列 + 左侧抽屉」，右栏没有
> 纳入手机端交互。DSH 后来给右栏增加了「窄屏自动全屏」行为，这条规则就从「不显示右栏」
> 变成了「把唯一的入口点死」。

## 3. 修复（`dsh-remoteApp/src/lib/mobileWebShell.ts`）

窄屏媒体查询内：

```css
/* 删除：'[class*="_rightbarCol"] { display: none !important; }' */

/* 新增：让右栏列不生成盒子，DSH 全屏面板以 _frame 为包含块铺满 WebView */
[class*="_rightbarCol"] { display: contents !important; }
```

原理：

- `_rightbarCol` 不生成盒子后，它的子节点（`.Dv5QdW_session` 也是 `display:contents`，
  所以真正生效的是面板）在包含块解析上"跳过"该列，上移到最近的定位祖先
  `_frame`（DSH 原生 CSS：`position:relative; height:100%; overflow:hidden`）。
- 面板自身就是 DSH 为窄屏全屏准备的几何：`position:absolute; top:0; bottom:0; right:0`
  + inline `width:100vw` → 正好覆盖整块 WebView。
- 我们**不覆盖任何几何属性、不改层叠**：DSH 的展开/收起动画（`transform` +
  `visibility`）、`pointer-events`（面板 `none` / dock host `auto`）、浮动窗的
  `position:fixed` 全部保持原样。
- 只在 `max-width: 760px` 生效；> 760px（平板/横屏/桌面窗口）继续走 DSH 原生布局，
  注入 CSS 不生效。

为什么不改成 `[data-sidebar-right-panel] { position:fixed; inset:0 ... }`：
两者都能工作（已实测面板 rect 相同），但后者要覆盖面板的定位与尺寸、依赖
`data-sidebar-right-panel` 属性，并且在 DSH 未来调整"窄屏是否自动全屏"时会强行把
`push` 模式也变全屏；`display:contents` 只是把列从盒树里拿掉，剩下的交给 DSH 原生
几何，改动面最小、最接近浏览器窄窗口下的原生行为。

不要在这个修复里加 `z-index` / `transform` / `filter` / `contain`：

- 加高 `z-index`（例如 9000）会盖住手机壳自己的左侧抽屉（z-index 9000）和 DSH 的
  `shell.overlay`（z-index 20）；DSH 的 Modal/菜单是 `document.body` 上的 portal
  （z-index 1000/1100），同样会被盖住；
- 在面板或祖先上加 `transform`/`filter`/`contain` 会让 dockkit 的 `position:fixed`
  浮动窗以该元素为包含块，浮窗位置会错。

面板的关闭仍用 DSH 自己的控件（tab 条最右端的「收起」按钮，`[data-sidebar-right-toggle]`），
没有新增任何自定义按钮；App 原生顶栏的返回/刷新也不受影响。

## 4. 验证

### 4.1 无头 Chrome fixture（`cd dsh-remoteApp && npm run check:shell`）

`scripts/check-injected-shell.mjs` 新增右栏阶段：按 DSH 0.2.1-rc.3 的真实 DOM/CSS 复刻
`_frame / _centerCol / _rightbarCol / ._session(display:contents) / [data-sidebar-right-panel] /
dock host(transform+visibility+pointer-events)`，用 CDP `Emulation.setDeviceMetricsOverride`
把视口设为 **390×844 mobile**，断言：

- 收起态：面板内容不可见、`elementFromPoint(195,400)` 命中会话内容（覆盖层不抢触摸）；
- 展开态（模拟 DSH 打开：`data-sidebar-right-open` + dock host `transform:none; visibility:visible`）：
  面板 rect 覆盖 `0,0,390,844`（±1px），`elementFromPoint` 命中面板内部，面板 chrome 按钮可点；
- 再收起：恢复点击穿透；
- 窄屏左侧抽屉仍可开关；全程无未捕获 JS 异常。

旧版注入壳（`git show HEAD:dsh-remoteApp/src/lib/mobileWebShell.ts` 的 `display:none` 版本）
在同一 fixture 上被同一组断言判失败（exit 1，展开态 rect=0,0,0,0、命中会话内容、chrome 按钮
不可点、聊天按钮仍可点）→ 用例能抓住这次回归。额外的「半修复」对照（只删 `display:none`、
不处理列/面板定位）同样失败（面板落在首屏下方、高 0），说明断言不是只对本次完整修复有效。

### 4.2 本机命令与结果

```bash
cd dsh-remoteApp
npx tsc --noEmit      # ✅ 0 error
npm run check:native  # ✅ 0 warning / 0 failure
npm run check:shell   # ✅ 23/23（原 12 项 + 新增 11 项右栏断言，连跑 3 次无 flake）
```

### 4.3 未执行 / 未验证（诚实声明）

- **未在 iPhone/Android 真机或模拟器上运行**：视觉、动画、键盘、旋转需按 §6 验收。
- fixture 复刻的是 DSH 0.2.1-rc.3 的 DOM/CSS 子集，不是真实 DSH 页面；DSH 改版后
  选择器/行为可能变化（退化风险见 §5）。
- 没测真实 relay 链路（本次改动只在 WebView 内 CSS，与网络无关）。

## 5. 残留风险

- **DSH 升级改版**：若 `data-sidebar-right-panel` / 该 DOM 结构变化，本规则失效，最坏退化
  为「右栏仍不可见」（与修复前一致），不会影响会话主流程；需要随 DSH 版本更新注入壳。
- **浮动窗**：旧规则下手机端连 dockkit 浮窗也看不到；现在若用户在右栏里主动把 tab 浮出，
  浮窗会按 dockkit 逻辑出现在屏幕上（手机屏小，属边缘交互，未做专门适配）。
- **761–767px 视口**：手机壳媒体查询（≤760）不生效，而 DSH 自动全屏阈值是 <768，这段宽度
  由 DSH 原生布局处理（`_rightbarCol` 未被隐藏），预期正常；属罕见宽度，未真机验证。
- 面板打开时左边缘右滑仍可拉出会话抽屉（抽屉 z-index 高于面板），出现叠加；不影响操作，
  未专门处理。
- 面板打开时 App 原生顶栏仍在（WebView 在原生顶栏之下），返回/刷新可用；关闭面板用面板
  自己的「收起」按钮。

## 6. 真机验收建议

1. 打开任意会话（新建或历史）→ 点 header 右侧角落的「展开右侧栏」按钮 →
   右栏**全屏**覆盖整个 WebView；顶部 tab 条、右上「收起」按钮可见可点；文件/浏览器/
   终端等 tab 可切换。
2. 点「收起」→ 回到会话；再展开一次；切到另一个会话重复一次（每个会话独立布局）。
3. 收起状态下：上下滚动、点消息、长按复制、输入框聚焦/键盘弹出都正常（覆盖层不拦截）。
4. 旋转到横屏（> 760px）：走 DSH 原生布局，右栏不再全屏覆盖（与桌面窄窗口行为一致）。
5. 打开右栏时触发 DSH 弹窗（审批卡、tab 菜单、模型选择等），确认弹窗显示在面板之上
   （我们没加 z-index）。
6. 打开右栏时点 App 原生「‹」返回 → 正常退出；重新进入主机页面后右栏状态按 DSH 的
   session 级持久化恢复。

## 7. 生效条件

| 改动 | 生效方式 |
| --- | --- |
| `dsh-remoteApp/src/lib/mobileWebShell.ts` | **纯 JS**：dev client 里 Metro reload / 重开 App；发布/手动签名包需重新打 JS bundle 并安装 |
| 原生 / host 插件 / relay / DSH | **无需改动、无需重启** |

- 不需要 `expo prebuild`，不涉及 `ios/`、`android/` 生成工程。
- Host 插件与 relay 不受影响：本次问题纯属 WebView 内的 CSS。
