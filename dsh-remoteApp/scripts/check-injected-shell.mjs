#!/usr/bin/env node
/**
 * check-injected-shell.mjs — 在本地无头 Chrome 里验证「注入 DSH Web UI 的手机壳」行为。
 *
 * 为什么需要它：`mobileWebShell.ts` 是一段以字符串形式注入 WKWebView/WebView 的 JS，
 * tsc 只能检查外层 TS，`check:native` 也不覆盖它。这个脚本把脚本注入一个模仿 DSH
 * 会话头部布局的最小页面，断言：
 *   1. 脚本能初始化，viewport 被锁定，且不会重复写 <meta>（避免 iOS 反复重排）；
 *   2. **注入壳不再碰侧栏**：样式表里不得出现 `_sidebarCol` 规则，侧栏的
 *      position/opacity/pointer-events 保持 DSH 原生值 —— DSH 0.2.2 起窄屏抽屉
 *      由它自己实现（frame 上的 data-sidebar-drawer + 左上角 [data-sidebar-opener]），
 *      壳一旦覆盖这几条属性，原生入口打开抽屉就会变成「画面变暗、抽屉透明、点不动」
 *      （2026-11-16 真机回归）；
 *   3. token 流式渲染的高频 DOM 变更不会触发全量 querySelector（O(1) 快路径）；
 *   4. 窄屏（390×844）下 DSH 右侧栏（@deepseek-ai/dsh-client-ui-sidebar-right）的全屏面板：
 *      收起时不拦截聊天手势、打开时覆盖整个 WebView 视口且可交互、再次收起后恢复穿透
 *      （之前注入脚本把整列 `_rightbarCol` display:none，面板永远不可见）。
 *   5. 注入壳不再改造设置弹窗：DSH 0.2.2 起 settings-general 自带窄屏全屏布局
 *      （整屏 panel + 顶部标题/关闭 + 横向分区条），壳再注入手机栏会和原生返回/关闭
 *      抢位置、把分区挤成一排（2026-11-16 真机回归）。这里只保证壳没有相关覆盖。
 *   6. 外链（target=_blank 锚点 / window.open）：注入壳拦截 http(s) 外链并上报
 *      App（系统浏览器打开），同源锚点不受影响（原生 WebView 没有新窗口能力）。
 *   7. 隐藏「在主机本机打开」类入口（@deepseek-ai/dsh-client-ui-open-in-app 的
 *      split 控件/内部按钮/加载骨架，按稳定 data-* 属性；以及工作区的「添加工作区」＋
 *      按钮，按 aria-label）。同一 [data-slot] 里的其它插件按钮保持可见可点；这些动作
 *      永远发生在主机本机，规则与 WebView 宽度无关（手机/iPad 都隐藏，宽屏同样验证）。
 *
 * 用法：node scripts/check-injected-shell.mjs   （本机没有 Chrome 时自动跳过，退出码 0）
 * 开发对照：node scripts/check-injected-shell.mjs --shell-js /tmp/old-mobileWebShell.ts
 *   —— 把注入脚本换成另一份文件（例如 `git show 3112409:...` 的旧版本），用来证明用例能抓住回归。
 *   默认（CI / 日常自检）永远从 src/lib/mobileWebShell.ts 现取，不需要也不应该带这个参数。
 *
 * ⚠️ 这不是真机验证的替代品：只覆盖注入脚本的 DOM/布局行为，不覆盖 WKWebView 的
 * 进程回收恢复、iOS viewport 语义等原生行为（见 docs/diagnostics/03-app-webview.md）。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

const FIXTURE_HTML = `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh mobile shell fixture</title>
<style>
  body { margin: 0; }
  .PIRFFq_frame { display: grid; grid-template-columns: 280px minmax(0,1fr); height: 100vh; overflow: hidden; }
  .PIRFFq_sidebarCol { background: #eee; min-width: 0; overflow: hidden; }
  .PIRFFq_centerCol { display: flex; flex-direction: column; min-width: 0; overflow: hidden; }
  .kiGsTW_header { display: grid; grid-template-columns: auto minmax(0,1fr); min-height: 76px; padding: 10px 28px 0 20px; border-bottom: .5px solid #ccc; box-sizing: border-box; }
  .kiGsTW_headerLeading { display: flex; align-items: center; gap: 8px; grid-area: 1/1; flex: none; }
  .kiGsTW_titleRow { display: flex; align-items: center; grid-column: 2; min-height: 30px; }
  .railMarkBox { display: flex; align-items: center; justify-content: center; width: 40px; height: 40px; }
  .railMarkBox svg { width: 24px; height: 24px; }
  .fixtureRow { padding: 8px 12px; font: 13px sans-serif; text-align: left; background: 0 0; border: 0; }
</style></head>
<body>
<div class="PIRFFq_frame">
  <div class="PIRFFq_sidebarCol">
    <div class="railMarkBox ab_railMark"><svg viewBox="0 0 24 24"><path d="M2 12h20v8H2z"/></svg></div>
    <!-- 真实 DSH 侧栏（@deepseek-ai/dsh-client-ui-workspace）里的行：
         工作区行只展开/收起、会话行是导航、overflow 按钮展开「其余 N 个会话」。 -->
    <div class="fixtureRow" data-row-key="workspace:ws1" role="treeitem" aria-expanded="true">工作区</div>
    <div class="fixtureRow" data-row-key="session:s1" role="treeitem">会话 A</div>
    <button type="button" class="fixtureRow" data-row-key="overflow:ws1" aria-expanded="false">展开其余 4 个会话</button>
  </div>
  <div class="PIRFFq_centerCol">
    <header class="kiGsTW_header">
      <div class="kiGsTW_headerLeading" data-conversation-header-leading>
        <div data-slot="conversation.header.leading"></div>
      </div>
      <div class="kiGsTW_titleRow"><span>会话标题</span></div>
    </header>
    <div id="stream"></div>
  </div>
</div>
</body></html>`;

/**
 * 第二份 fixture：按 DSH 0.2.1-rc.3 的真实 DOM/CSS 复刻「会话 + 右侧栏全屏面板」。
 *
 * 规则来源（只读提取，未复制大段真实代码）：AppFrame.module.css（_frame/_centerCol/
 * _rightbarCol）、SidebarRight.module.css（_session/_panel/panelBody 与 data-sidebar-right-open
 * 的 transform/visibility 规则）、index-BNyAYEM7.css（dockkit 的 _tabCell/_tabHost/_paneBody 等）。
 * 类名保留真实哈希后缀，因为注入脚本用 `[class*="_rightbarCol"]` 这类稳定后缀选择器。
 *
 * 与真实 DSH 的已知偏差（只为让断言可重复，不改变被验证的行为）：
 *  - 只保留复现右栏开合所需的最小 CSS，省略主题变量/字体/滚动条等外观规则；
 *  - 会话正文、右栏内容、dockkit 的 tab strip 都是占位节点，不含真实 React 组件树；
 *  - panel 初始为「收起态」；打开态由测试直接补 data-sidebar-right-open 属性模拟 DSH
 *    （真实 DSH 由 React 状态切换该属性，CSS 规则完全一致）；
 *  - panel 的 inline width:100vw / --dsh-sidebar-width:100vw 与 DSH autoFullscreen
 *    （viewportWidth < 768）时一致。
 */
const RIGHTBAR_FIXTURE_HTML = `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh right sidebar fixture</title>
<style>
  :root {
    --dsw-alias-bg-base: #ffffff;
    --dsw-alias-border-l3: #e3e3e3;
    --dsw-alias-border-l4: #ececec;
    --dsw-specific-sidebar-fill: #f5f5f5;
    --ds-transition-duration-slow: 200ms;
    --ds-ease-in-out: cubic-bezier(.4, 0, .2, 1);
  }
  html, body, #root { height: 100%; margin: 0; }
  /* fixture 内部禁止页面级滚动，避免滚动条让“覆盖整个视口”的 rect 断言不稳定 */
  body { overflow: hidden; }
  /* ===== AppFrame.module.css（DSH 0.2.1-rc.3） ===== */
  .PIRFFq_frame { background: var(--dsw-alias-bg-base); grid-template-rows: minmax(0, 1fr) auto; height: 100%; display: grid; position: relative; overflow: hidden; }
  .PIRFFq_sidebarCol { background: var(--dsw-specific-sidebar-fill); border-right: .5px solid var(--dsw-alias-border-l3); min-width: 0; overflow: hidden; }
  .PIRFFq_centerCol { flex-direction: column; min-width: 0; display: flex; overflow: hidden; }
  .PIRFFq_rightbarCol { min-width: 0; position: relative; overflow: visible; }
  /* ===== 会话 header（保留 conversation.header.leading 槽位结构） ===== */
  .kiGsTW_header { display: grid; grid-template-columns: auto minmax(0, 1fr); min-height: 76px; padding: 10px 28px 0 20px; border-bottom: .5px solid #ccc; box-sizing: border-box; flex: none; }
  .kiGsTW_headerLeading { display: flex; align-items: center; gap: 8px; grid-area: 1/1; flex: none; }
  .kiGsTW_titleRow { display: flex; align-items: center; grid-column: 2; min-height: 30px; }
  .railMarkBox { display: flex; align-items: center; justify-content: center; width: 40px; height: 40px; }
  .railMarkBox svg { width: 24px; height: 24px; }
  #chat-log { flex: 1 1 auto; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 8px; padding: 12px; background: #fafafa; }
  #chat-log .filler { flex: 1 1 auto; }
  #chat-send { flex: none; height: 40px; }
  /* ===== SidebarRight.module.css（DSH 0.2.1-rc.3，关键规则逐字保留） ===== */
  .Dv5QdW_session { display: contents; }
  .Dv5QdW_session[hidden] { display: none; }
  .Dv5QdW_panel { --dsh-dockkit-dock-layer: 10; --dsh-dockkit-float-layer: 60; pointer-events: none; flex-direction: column; min-width: 0; display: flex; position: absolute; top: 0; bottom: 0; right: 0; overflow: clip; }
  .Dv5QdW_panel [data-dockkit-host=dock], .Dv5QdW_panel [data-dockkit-empty], .Dv5QdW_panel [data-dockkit-divider] { transform: translateX(var(--dsh-sidebar-width)); visibility: hidden; transition: transform var(--ds-transition-duration-slow) var(--ds-ease-in-out), visibility 0s linear var(--ds-transition-duration-slow); }
  .Dv5QdW_panel[data-sidebar-right-open] [data-dockkit-host=dock], .Dv5QdW_panel[data-sidebar-right-open] [data-dockkit-empty], .Dv5QdW_panel[data-sidebar-right-open] [data-dockkit-divider] { visibility: visible; transition: transform var(--ds-transition-duration-slow) var(--ds-ease-in-out); transform: none; }
  .Dv5QdW_panel[data-sidebar-right-panel=fullscreen] { --dsh-dockkit-dock-layer: 40; }
  .Dv5QdW_iconButton { width: 28px; height: 28px; color: #61666b; border-radius: 6px; cursor: pointer; background: 0 0; border: none; flex: none; justify-content: center; align-items: center; padding: 6px; line-height: 1; display: inline-flex; }
  .Dv5QdW_panelBody { flex: auto; min-height: 0; display: flex; }
  /* ===== dockkit（index-BNyAYEM7.css，关键规则逐字保留） ===== */
  ._surface_6nhg2_125 { display: flex; flex: 1 1 auto; min-width: 0; min-height: 0; }
  ._tabLayout_6nhg2_134 { display: grid; flex: 1 1 auto; grid-template-rows: minmax(0, 1fr); min-width: 0; min-height: 0; }
  ._tabCell_6nhg2_142 { display: flex; min-width: 0; min-height: 0; z-index: var(--dsh-dockkit-dock-layer, 10); }
  ._tabCell_6nhg2_142[hidden] { display: none; }
  ._tabHost_6nhg2_162 { min-width: 0; min-height: 0; pointer-events: auto; }
  ._tabHost_6nhg2_162:not(._float_6nhg2_156) { background: var(--dsw-alias-bg-base); }
  ._tabHostHeader_6nhg2_177 { flex: none; }
  ._tabHostBody_6nhg2_181 { position: relative; min-width: 0; }
  ._pane_6nhg2_209 { display: flex; flex: 1 1 auto; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
  ._tabStrip_6nhg2_237 { display: flex; flex: none; gap: 4px; align-items: center; height: 28px; padding: 10px 6px 0 var(--dsh-dockkit-strip-inline-start, 10px); touch-action: none; }
  ._stripTabs_6nhg2_257 { display: flex; flex: 0 1 auto; align-items: center; min-width: 0; overflow-x: auto; overflow-y: hidden; }
  ._stripFill_6nhg2_288 { flex: 1 1 0; min-width: 0; }
  ._stripChrome_6nhg2_296 { display: flex; flex: none; gap: 8px; align-items: center; height: 28px; margin-left: 4px; }
  ._paneBody_6nhg2_318 { position: relative; flex: 1 1 auto; min-width: 0; min-height: 0; overflow: auto; }
  ._tab_6nhg2_134 { position: relative; display: flex; flex: 0 1 auto; align-items: center; min-width: 80px; max-width: 170px; height: 28px; padding: 0 10px; font-size: 13px; line-height: 1; white-space: nowrap; border-radius: 6px; user-select: none; }
</style></head>
<body>
<div id="root">
  <div class="PIRFFq_frame" style="grid-template-columns: 56px minmax(0px, 1fr) minmax(0px, 0px);">
    <div class="PIRFFq_sidebarCol">
      <div class="railMarkBox ab_railMark"><svg viewBox="0 0 24 24"><path d="M2 12h20v8H2z"/></svg></div>
    </div>
    <div class="PIRFFq_centerCol">
      <header class="kiGsTW_header">
        <div class="kiGsTW_headerLeading" data-conversation-header-leading>
          <div data-slot="conversation.header.leading"></div>
        </div>
        <div class="kiGsTW_titleRow"><span>会话标题</span></div>
      </header>
      <div id="chat-log">
        <p>用户：这是会话内容，右栏收起时这里应该能正常接收手势。</p>
        <div class="filler"></div>
        <button id="chat-send" type="button">发送</button>
      </div>
    </div>
    <div class="PIRFFq_rightbarCol" data-rightbar-col>
      <div class="Dv5QdW_session" data-sidebar-right-session="session-fixture">
        <div class="Dv5QdW_panel" data-sidebar-right-session="session-fixture" data-sidebar-right-panel="fullscreen" aria-hidden="true" style="width: 100vw; --dsh-sidebar-width: 100vw;">
          <div class="Dv5QdW_panelBody">
            <div class="_surface_6nhg2_125" data-dockkit-surface>
              <div class="_tabLayout_6nhg2_134" style="grid-template-columns: minmax(0, 1fr);">
                <div class="_tabCell_6nhg2_142" data-dockkit-host="dock" data-dockkit-column="0" style="grid-column: 1; grid-row: 1;">
                  <section class="_tabHost_6nhg2_162 _pane_6nhg2_209" tabindex="-1" data-dockkit-pane="pane-fixture" data-dockkit-pane-active="true">
                    <div class="_tabHostHeader_6nhg2_177">
                      <div class="_tabStrip_6nhg2_237">
                        <div class="_stripTabs_6nhg2_257"><span class="_tab_6nhg2_134" data-sidebar-right-tab="tab-fixture">右栏面板</span></div>
                        <div class="_stripFill_6nhg2_288"></div>
                        <div class="_stripChrome_6nhg2_296" data-dockkit-strip-chrome>
                          <button type="button" class="Dv5QdW_iconButton" data-sidebar-right-toggle aria-label="收起右侧栏"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v16H4z"/></svg></button>
                        </div>
                      </div>
                    </div>
                    <div class="_tabHostBody_6nhg2_181 _paneBody_6nhg2_318">
                      <div id="rightbar-content" style="padding: 12px;">右侧栏内容（打开后覆盖会话区）</div>
                    </div>
                  </section>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
</body></html>`;

const OPEN_IN_APP_FIXTURE_HTML = `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh open-in-app fixture</title>
<style>
  :root {
    --dsw-alias-bg-base: #ffffff;
    --dsw-alias-label-primary: #1f2328;
    --dsw-alias-label-secondary: #61666b;
    --dsw-alias-border-l2: #d0d7de;
    --dsw-alias-border-l4: #e3e3e3;
    --dsw-alias-interactive-bg-hover: rgba(31, 35, 40, 0.08);
    --dsw-radius-xs: 4px;
    --dsw-radius-sm: 6px;
    --dsw-radius-md: 8px;
    --dsw-font-family: -apple-system, system-ui, sans-serif;
  }
  html, body { height: 100%; margin: 0; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-family: var(--dsw-font-family); }
  body { overflow: hidden; }
  /* ===== 会话 header（最小布局；完整 header 结构见另外两份 fixture） ===== */
  .fixture-header { display: flex; align-items: center; gap: 8px; min-height: 56px; padding: 8px 12px; border-bottom: 1px solid var(--dsw-alias-border-l4); box-sizing: border-box; }
  .fixture-header-leading { display: flex; align-items: center; min-width: 34px; min-height: 30px; }
  .fixture-header-title { flex: 1 1 auto; min-width: 0; font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* 会话 header 右侧 utilities 槽：open-in-app 与其它插件按钮并列。 */
  .fixture-utilities { display: flex; align-items: center; gap: 8px; flex: none; }
  .fixture-workspace-header { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--dsw-alias-border-l4); }
  .fixture-workspace-title { flex: 1 1 auto; font-size: 12px; color: var(--dsw-alias-label-secondary); }
  .fixture-other-button { height: 28px; padding: 0 10px; font-size: 12px; border-radius: 6px; border: .5px solid var(--dsw-alias-border-l4); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
  /* ===== OpenTargetButton.module.css（DSH 0.2.1-rc.3，关键规则逐字保留） ===== */
  .ga5fXW_menuAnchor { flex: none; align-self: center; display: inline-flex; }
  .ga5fXW_split { box-sizing: border-box; border: .5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-sm); height: 24px; font-family: var(--dsw-font-family); align-items: stretch; display: inline-flex; overflow: hidden; }
  .ga5fXW_main, .ga5fXW_chevron { color: var(--dsw-alias-label-primary); white-space: nowrap; cursor: pointer; background: 0 0; border: 0; justify-content: center; align-items: center; font-size: 11px; line-height: 16px; display: inline-flex; }
  .ga5fXW_main { gap: 4px; padding: 3px 5px; }
  .ga5fXW_chevron { border-left: .5px solid var(--dsw-alias-border-l4); color: var(--dsw-alias-label-secondary); padding: 3px 4px 3px 3px; }
  .ga5fXW_split[data-size=large] { border-radius: var(--dsw-radius-md); border-color: var(--dsw-alias-border-l2); height: 36px; }
  .ga5fXW_split[data-size=large] .ga5fXW_main { gap: 6px; padding: 6px 14px; font-size: 14px; }
  .ga5fXW_split[data-size=large] .ga5fXW_chevron { padding: 6px 10px; }
  .ga5fXW_skeleton { border-radius: var(--dsw-radius-xs); background: var(--dsw-alias-interactive-bg-hover); flex: none; display: inline-block; }
</style></head>
<body>
<header class="fixture-header">
  <div class="fixture-header-leading"><div data-slot="conversation.header.leading"></div></div>
  <div class="fixture-header-title">会话标题</div>
  <div class="fixture-utilities" data-slot="conversation.session.header.utilities">
    <!-- 同一 slot 里的其它插件按钮：注入壳只能隐藏 open-in-app 控件，不能整段隐藏 slot。 -->
    <button type="button" class="fixture-other-button" id="other-plugin-button">其它插件按钮</button>
    <!-- 目录打开控件（会话 header）：compact split，主按钮 + 下拉箭头。 -->
    <div class="ga5fXW_split" data-open-target="directory" data-size="compact" data-state="idle">
      <button type="button" class="ga5fXW_main" aria-label="在 Finder 中显示"><svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M2 4h4l1.5 2H14v6H2z" fill="currentColor"/></svg></button>
      <button type="button" class="ga5fXW_chevron" aria-haspopup="menu" aria-expanded="false" aria-label="更多打开方式"><svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></button>
    </div>
    <!-- 文件打开控件（右栏文件 tab）：compact split，带 data-open-path* 标记。 -->
    <div class="ga5fXW_split" data-open-target="file" data-open-path="" data-size="compact" data-state="idle">
      <button type="button" class="ga5fXW_main" data-open-path-open="" aria-label="用默认应用打开"><svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3 2h7l3 3v9H3z" fill="none" stroke="currentColor" stroke-width="1.2"/></svg></button>
      <button type="button" class="ga5fXW_chevron" data-open-path-more="" aria-haspopup="menu" aria-expanded="false" aria-label="更多打开方式"><svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></button>
    </div>
    <!-- 不可预览文件的 prominent 控件：大号 split，主按钮带 unpreviewable 标记。 -->
    <div class="ga5fXW_split" data-open-target="file" data-size="large" data-state="idle">
      <button type="button" class="ga5fXW_main" data-open-path-unpreviewable="">在默认应用中打开</button>
    </div>
    <!-- 文件关联仍在查询时的加载骨架（skeleton 在 split 主按钮内）。 -->
    <div class="ga5fXW_split" data-open-target="file" data-open-path="" data-size="compact" data-state="busy">
      <button type="button" class="ga5fXW_main" data-open-path-open="" aria-label="正在查询可用应用">
        <span class="ga5fXW_skeleton" data-open-target-skeleton="" aria-hidden="true" style="width: 13px; height: 13px;"></span>
      </button>
      <button type="button" class="ga5fXW_chevron" data-open-path-more="" aria-haspopup="menu" aria-expanded="false" aria-label="更多打开方式"><svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></button>
    </div>
  </div>
</header>
<div class="fixture-workspace-header">
  <span class="fixture-workspace-title">工作区</span>
  <button type="button" class="fixture-other-button" id="workspace-add-button" aria-label="添加工作区">＋</button>
</div>
<div style="padding: 16px; color: #61666b;">会话内容（fixture 占位）</div>
</body></html>`;

/** Counts querySelector calls so the churn assertion has something to measure. */
const INSTRUMENT_JS = `(() => {
  window.__shellStats = { querySelector: 0, viewportWrites: 0 };
  const stats = window.__shellStats;
  const qs = Document.prototype.querySelector;
  Document.prototype.querySelector = function patched(sel) {
    stats.querySelector += 1;
    return qs.call(this, sel);
  };
  const setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function patchedSet(name, value) {
    if (this.tagName === 'META' && name === 'content' && this.getAttribute('name') === 'viewport') {
      stats.viewportWrites += 1;
    }
    return setAttribute.call(this, name, value);
  };
})();`;

/**
 * open-in-app fixture 的样式快照（窄屏/宽屏各跑一次）：
 *  - split 控件根用 getComputedStyle().display 判断是否被注入 CSS 隐藏；
 *  - 控件内部按钮/骨架用 getClientRects()/offsetParent 判断是否真的不再渲染
 *    （它们的 computed display 仍是自己的 inline-flex/inline-block，只有祖先 display:none
 *     才会不渲染，所以不能只看 getComputedStyle）；
 *  - 同 slot 的「其它插件按钮」必须保持可见、可命中（证明没有整段隐藏 slot）。
 */
const OPEN_IN_APP_SNAPSHOT_JS = `(() => {
  const splitRoots = Array.prototype.slice.call(document.querySelectorAll('[data-open-target]'));
  const innerSelectors = [
    '[data-open-path-open]',
    '[data-open-path-more]',
    '[data-open-path-unpreviewable]',
    '[data-open-target-skeleton]',
  ];
  const inner = Array.prototype.slice.call(document.querySelectorAll(innerSelectors.join(','))).map((element) => ({
    tag: element.tagName.toLowerCase(),
    attrs: innerSelectors.filter((selector) => element.matches(selector)),
    clientRects: element.getClientRects().length,
    rendered: element.offsetParent !== null,
  }));
  const workspaceAdd = document.getElementById('workspace-add-button');
  const workspaceAddStyle = workspaceAdd ? getComputedStyle(workspaceAdd) : null;
  const sibling = document.getElementById('other-plugin-button');
  const siblingStyle = sibling ? getComputedStyle(sibling) : null;
  const siblingRect = sibling ? sibling.getBoundingClientRect() : null;
  const hit = siblingRect
    ? document.elementFromPoint(siblingRect.left + siblingRect.width / 2, siblingRect.top + siblingRect.height / 2)
    : null;
  return {
    viewportWidth: window.innerWidth,
    mobileMedia: window.matchMedia('(max-width: 760px)').matches,
    splitCount: splitRoots.length,
    splitDisplays: splitRoots.map((element) => getComputedStyle(element).display),
    inner,
    workspaceAdd: workspaceAdd ? {
      display: workspaceAddStyle.display,
      clientRects: workspaceAdd.getClientRects().length,
      rendered: workspaceAdd.offsetParent !== null,
    } : null,
    sibling: sibling ? {
      display: siblingStyle.display,
      visibility: siblingStyle.visibility,
      clientRects: sibling.getClientRects().length,
      hit: Boolean(hit && (hit === sibling || sibling.contains(hit))),
    } : null,
  };
})()`;

const shellPath = fileURLToPath(new URL('../src/lib/mobileWebShell.ts', import.meta.url));

/**
 * 注入脚本来源：默认永远是仓库当前的 src/lib/mobileWebShell.ts（CI/日常自检的路径）。
 * `--shell-js <path>` 只给本地对照用（例如 `git show 3112409:...` 的旧版本），
 * 用来证明新增断言能抓住回归；不要在 CI 里传。
 */
function resolveShellFile(argv) {
  const flag = '--shell-js';
  const index = argv.indexOf(flag);
  if (index === -1) return shellPath;
  const override = argv[index + 1];
  if (!override) throw new Error(`${flag} 需要一个文件路径参数`);
  return override;
}

function extractShellJs(file = shellPath) {
  const source = readFileSync(file, 'utf8');
  const marker = 'String.raw`';
  const start = source.indexOf(marker) + marker.length;
  const end = source.lastIndexOf('`');
  if (start < marker.length || end <= start) throw new Error(`无法从 ${file} 提取注入脚本`);
  return source.slice(start, end);
}

function findChrome() {
  return CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
}

async function waitForChrome(port, child) {
  for (let i = 0; i < 100; i += 1) {
    if (child.exitCode !== null) throw new Error(`Chrome 提前退出（code=${child.exitCode}）`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch { /* 还没起来，重试 */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Chrome 在 10s 内没有启动');
}

function openCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
      return;
    }
    events.push(message);
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, (message) => (message.error
      ? reject(new Error(`${method}: ${JSON.stringify(message.error)}`))
      : resolve(message.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { ready, send, events, close: () => ws.close() };
}

async function runChecks(chromePath, shellJs) {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'dsh-shell-check-'));
  const fixtureFile = join(fixtureDir, 'fixture.html');
  const rightbarFixtureFile = join(fixtureDir, 'rightbar-fixture.html');
  const openInAppFixtureFile = join(fixtureDir, 'open-in-app-fixture.html');
  writeFileSync(fixtureFile, FIXTURE_HTML, 'utf8');
  writeFileSync(rightbarFixtureFile, RIGHTBAR_FIXTURE_HTML, 'utf8');
  writeFileSync(openInAppFixtureFile, OPEN_IN_APP_FIXTURE_HTML, 'utf8');
  const port = 9450 + Math.floor(Math.random() * 300);
  const child = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${join(fixtureDir, 'profile')}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--allow-file-access-from-files',
    'about:blank',
  ], { stdio: 'ignore' });

  try {
    await waitForChrome(port, child);
    const created = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' });
    const target = await created.json();
    const cdp = openCdp(target.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT_JS });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: shellJs });
    await cdp.send('Page.navigate', { url: `file://${fixtureFile}` });
    await new Promise((resolve) => setTimeout(resolve, 1600));

    const evaluate = async (expression) => {
      const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) {
        throw new Error(`页面内 JS 抛异常: ${JSON.stringify(result.exceptionDetails).slice(0, 400)}`);
      }
      return result.result?.value;
    };

    const initial = await evaluate(`(() => {
      const meta = document.querySelector('meta[name="viewport"]');
      const style = document.getElementById('dsh-mobile-shell-style');
      const sidebar = document.querySelector('[class*="_sidebarCol"]');
      const sidebarStyle = sidebar ? getComputedStyle(sidebar) : null;
      return {
        installed: Boolean(window.__dshMobileShellInstalled),
        viewport: meta ? meta.getAttribute('content') : null,
        viewportWrites: window.__shellStats.viewportWrites,
        // 回归护栏：窄屏抽屉由 DSH 原生实现，壳不能再给侧栏写任何几何/可见性规则，
        // 否则原生入口打开抽屉时会变成「画面变暗、抽屉透明、点不动」。
        sidebarRulesInShell: Boolean(style && /_sidebarCol/.test(style.textContent || '')),
        sidebarPosition: sidebarStyle ? sidebarStyle.position : null,
        sidebarOpacity: sidebarStyle ? sidebarStyle.opacity : null,
        sidebarPointerEvents: sidebarStyle ? sidebarStyle.pointerEvents : null,
      };
    })()`);

    const churn = await evaluate(`(async () => {
      const before = window.__shellStats.querySelector;
      await new Promise((resolve) => {
        let batch = 0;
        const stream = document.getElementById('stream');
        const tick = () => {
          for (let i = 0; i < 5; i += 1) {
            const span = document.createElement('span');
            span.textContent = 'token ' + batch + '-' + i;
            stream.appendChild(span);
          }
          batch += 1;
          if (batch >= 30) return resolve();
          setTimeout(tick, 16);
        };
        tick();
      });
      return {
        batches: 30,
        querySelectorDelta: window.__shellStats.querySelector - before,
        viewportWritesAfterLoad: window.__shellStats.viewportWrites,
      };
    })()`);

    // ===== 第二阶段：窄屏（390×844）下的 DSH 右侧栏全屏面板 =====
    // 必须用真实移动视口，否则 @media (max-width: 760px) 不生效；DSH 在 viewportWidth < 768
    // 时把 sidebar-right 面板自动切成 fullscreen（inline width:100vw + data-sidebar-right-panel）。
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      screenWidth: 390,
      screenHeight: 844,
      deviceScaleFactor: 3,
      mobile: true,
    });
    await cdp.send('Page.navigate', { url: `file://${rightbarFixtureFile}` });
    // 新 document 会重新执行 addScriptToEvaluateOnNewDocument 注入，等壳初始化完成再测。
    const waitForPage = async (expression, timeoutMs = 8000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          if (await evaluate(expression)) return true;
        } catch { /* 导航/执行上下文切换过程中会短暂失败，重试 */ }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return false;
    };
    const rightbarReady = await waitForPage(`Boolean(
      window.__dshMobileShellInstalled
      && document.getElementById('dsh-mobile-shell-style')
      && document.querySelector('[data-sidebar-right-panel]')
      && document.querySelector('[data-dockkit-host="dock"]')
    )`);

    const rightbar = await evaluate(`(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const panel = document.querySelector('[data-sidebar-right-panel]');
      const dockHost = document.querySelector('[data-dockkit-host="dock"]');
      const chatLog = document.getElementById('chat-log');
      const chatButton = document.getElementById('chat-send');
      const toggleButton = panel ? panel.querySelector('[data-sidebar-right-toggle]') : null;

      const centerOf = (element) => {
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      };
      const hitInfo = (element) => {
        const point = centerOf(element);
        if (!point) return null;
        const hit = document.elementFromPoint(point.x, point.y);
        return {
          tag: hit ? hit.tagName.toLowerCase() : null,
          id: hit && hit.id ? hit.id : '',
          insideElement: Boolean(element && hit && (hit === element || element.contains(hit))),
          insidePanel: Boolean(panel && hit && (hit === panel || panel.contains(hit))),
        };
      };
      const snapshot = () => {
        const rect = panel ? panel.getBoundingClientRect() : null;
        const dockStyle = dockHost ? getComputedStyle(dockHost) : null;
        const hit = document.elementFromPoint(195, 400);
        return {
          panelFound: Boolean(panel),
          panelOpen: Boolean(panel && panel.hasAttribute('data-sidebar-right-open')),
          panelPosition: panel ? getComputedStyle(panel).position : null,
          panelRect: rect ? {
            left: Math.round(rect.left * 10) / 10,
            top: Math.round(rect.top * 10) / 10,
            right: Math.round(rect.right * 10) / 10,
            bottom: Math.round(rect.bottom * 10) / 10,
            width: Math.round(rect.width * 10) / 10,
            height: Math.round(rect.height * 10) / 10,
          } : null,
          dockVisibility: dockStyle ? dockStyle.visibility : null,
          hitTag: hit ? hit.tagName.toLowerCase() : null,
          hitId: hit && hit.id ? hit.id : '',
          hitInPanel: Boolean(panel && hit && (hit === panel || panel.contains(hit))),
          hitInChat: Boolean(chatLog && hit && (chatLog === hit || chatLog.contains(hit))),
          hitPointerEvents: hit ? getComputedStyle(hit).pointerEvents : null,
        };
      };
      // elementFromPoint 找到真实命中节点后派发一次冒泡 click（等于一次真实 tap：
      // 先经过命中测试；命中的可能是 svg/path 等子节点，click 会冒泡到按钮）。
      const tapAt = (element) => {
        if (!element) return false;
        const point = centerOf(element);
        if (!point) return false;
        const hit = document.elementFromPoint(point.x, point.y);
        if (!hit) return false;
        let fired = false;
        element.addEventListener('click', () => { fired = true; }, { once: true });
        hit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return fired;
      };

      // 收起态：DSH 默认隐藏（dock host translateX(100vw)+visibility:hidden），面板自身
      // pointer-events:none，所以聊天区必须能被命中、能收到点击。
      await sleep(300);
      const collapsed = snapshot();
      const chatHitCollapsed = hitInfo(chatButton);
      const chatClickableCollapsed = tapAt(chatButton);

      // 模拟 DSH 展开：React 给面板加 data-sidebar-right-open，CSS 随之把 dock host
      // 切成 transform:none + visibility:visible（面板从此覆盖整个视口）。
      panel.setAttribute('data-sidebar-right-open', 'true');
      await sleep(400);
      const opened = snapshot();
      const toggleHit = hitInfo(toggleButton);
      const toggleClickable = tapAt(toggleButton);
      const chatHitOpened = hitInfo(chatButton);
      const chatClickableOpened = tapAt(chatButton);

      // 模拟收起：移除属性后 dock host 又移出视口，聊天手势恢复。
      panel.removeAttribute('data-sidebar-right-open');
      await sleep(400);
      const recollapsed = snapshot();

      return {
        installed: Boolean(window.__dshMobileShellInstalled),
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          dpr: window.devicePixelRatio,
          mobileMedia: window.matchMedia('(max-width: 760px)').matches,
        },
        collapsed,
        chatHitCollapsed,
        chatClickableCollapsed,
        opened,
        toggleHit,
        toggleClickable,
        chatHitOpened,
        chatClickableOpened,
        recollapsed,
      };
    })()`);

    // ===== 第四阶段：窄屏隐藏「在主机本机打开」控件（open-in-app） =====
    // 该插件在会话 header utilities / 右栏文件 tab 渲染「打开 / 在文件夹中显示」split 控件，
    // 点击会在主机本机打开：手机上应只隐藏这些控件，同 slot 的其它插件按钮必须保留。
    await cdp.send('Page.navigate', { url: `file://${openInAppFixtureFile}` });
    const openInAppReady = await waitForPage(`Boolean(
      window.__dshMobileShellInstalled
      && document.getElementById('dsh-mobile-shell-style')
      && window.matchMedia('(max-width: 760px)').matches
      && document.getElementById('other-plugin-button')
      && document.getElementById('workspace-add-button')
      && document.querySelectorAll('[data-open-target]').length === 4
      && document.querySelectorAll(
        '[data-open-path-open], [data-open-path-more], [data-open-path-unpreviewable], [data-open-target-skeleton]'
      ).length === 6
    )`);
    const openInAppMobile = await evaluate(OPEN_IN_APP_SNAPSHOT_JS);

    // 宽屏（1000×800）：App 在 iPad 上同样不应出现「在主机本机打开」控件，规则与宽度无关。
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1000,
      height: 800,
      screenWidth: 1000,
      screenHeight: 800,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const openInAppDesktop = await evaluate(OPEN_IN_APP_SNAPSHOT_JS);

    const exceptions = cdp.events
      .filter((event) => event.method === 'Runtime.exceptionThrown')
      .map((event) => event.params?.exceptionDetails?.text ?? 'unknown exception');
    cdp.close();
    await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`);
    return {
      initial,
      churn,
      rightbarReady,
      rightbar,
      openInAppReady,
      openInAppMobile,
      openInAppDesktop,
      exceptions,
    };
  } finally {
    child.kill('SIGTERM');
    // Chrome 退出时 profile 目录可能还在写；清理失败不应影响检查结果。
    try {
      rmSync(fixtureDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch { /* 交给系统临时目录清理 */ }
  }
}

const checks = [];
function check(label, condition, detail) {
  checks.push({ label, ok: Boolean(condition), detail });
}

/** 面板 rect 是否覆盖整个 390×844 视口（±1px，容忍亚像素/DPR 取整）。 */
function rectCoversViewport(rect, width, height) {
  return Boolean(
    rect
    && Math.abs(rect.left) <= 1
    && Math.abs(rect.top) <= 1
    && Math.abs(rect.right - width) <= 1
    && Math.abs(rect.bottom - height) <= 1,
  );
}
function formatRect(rect) {
  return rect ? `${rect.left},${rect.top},${rect.right},${rect.bottom}（${rect.width}×${rect.height}）` : 'none';
}
function formatHit(snapshot) {
  if (!snapshot) return 'none';
  const where = snapshot.hitInPanel ? '面板内' : (snapshot.hitInChat ? '会话内容' : '其他');
  return `hit=${snapshot.hitTag}${snapshot.hitId ? `#${snapshot.hitId}` : ''}（${where}）`;
}

const chromePath = findChrome();
if (!chromePath) {
  console.log('⚠️  未找到 Chrome/Chromium，跳过注入脚本行为检查（不算失败）。');
  process.exit(0);
}
if (typeof WebSocket === 'undefined' || typeof fetch === 'undefined') {
  console.log('⚠️  当前 Node 缺少 fetch/WebSocket（需要 Node 22+），跳过注入脚本行为检查。');
  process.exit(0);
}

let shellFile;
try {
  // 默认永远是 src/lib/mobileWebShell.ts；--shell-js 仅供本地对照旧版本。
  shellFile = resolveShellFile(process.argv.slice(2));
} catch (error) {
  console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
if (shellFile !== shellPath) {
  console.log(`⚠️  外部注入脚本对照模式：${shellFile}（正常自检应为 src/lib/mobileWebShell.ts）`);
}
console.log(`== 注入手机壳行为检查（fixture: 无头 Chrome） ==`);
let result;
try {
  result = await runChecks(chromePath, extractShellJs(shellFile));
} catch (error) {
  console.error(`❌ 无法运行检查：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const {
  initial,
  churn,
  rightbarReady,
  rightbar,
  openInAppReady,
  openInAppMobile,
  openInAppDesktop,
  exceptions,
} = result;
check('注入脚本已初始化', initial.installed);
check('注入壳不覆盖侧栏样式（原生抽屉才可用）', !initial.sidebarRulesInShell, 'style 里不应出现 _sidebarCol 规则');
check('侧栏未被壳改成 fixed/透明（position/opacity/pointer-events 保持 DSH 值）',
  initial.sidebarPosition === 'static' && initial.sidebarOpacity === '1' && initial.sidebarPointerEvents === 'auto',
  `position=${initial.sidebarPosition}, opacity=${initial.sidebarOpacity}, pointerEvents=${initial.sidebarPointerEvents}`);
check('viewport 被锁定（user-scalable=no）', String(initial.viewport ?? '').includes('user-scalable=no'), initial.viewport);
check('加载阶段只写一次 viewport（无重复重排）', initial.viewportWrites === 1, `writes=${initial.viewportWrites}`);
check('流式 DOM 变更不触发全量 querySelector（O(1) 快路径）', churn.querySelectorDelta === 0, `querySelector×${churn.querySelectorDelta} / ${churn.batches} batches`);
check('流式渲染后不再改写 viewport', churn.viewportWritesAfterLoad === 1, `writes=${churn.viewportWritesAfterLoad}`);

// ---- 第二阶段：窄屏（390×844）右侧栏全屏覆盖层 ----
check(
  '窄屏右栏 fixture 已加载（注入脚本在新文档重新执行）',
  rightbarReady && rightbar.installed && rightbar.collapsed.panelFound,
  `ready=${rightbarReady}, installed=${rightbar.installed}, panel=${rightbar.collapsed.panelFound}`,
);
check(
  '窄屏视口生效（390×844, mobile, DPR=3, media query 命中）',
  rightbar.viewport.width === 390
    && rightbar.viewport.height === 844
    && rightbar.viewport.dpr === 3
    && rightbar.viewport.mobileMedia,
  `${rightbar.viewport.width}×${rightbar.viewport.height} @${rightbar.viewport.dpr}x, media=${rightbar.viewport.mobileMedia}`,
);
check(
  '右栏收起时不拦截聊天：elementFromPoint(195,400) 命中会话内容',
  rightbar.collapsed.hitInChat && !rightbar.collapsed.hitInPanel,
  formatHit(rightbar.collapsed),
);
check(
  '右栏收起时聊天按钮可命中并可点击',
  Boolean(rightbar.chatHitCollapsed && rightbar.chatHitCollapsed.insideElement) && rightbar.chatClickableCollapsed,
  `hit=${rightbar.chatHitCollapsed ? `${rightbar.chatHitCollapsed.tag}${rightbar.chatHitCollapsed.id ? `#${rightbar.chatHitCollapsed.id}` : ''}` : 'none'}, clicked=${rightbar.chatClickableCollapsed}`,
);
check(
  '右栏收起时 dock host 不可见（visibility hidden）',
  rightbar.collapsed.dockVisibility === 'hidden',
  `visibility=${rightbar.collapsed.dockVisibility}, position=${rightbar.collapsed.panelPosition}`,
);
check(
  '右栏展开后全屏覆盖视口（rect 0,0,390,844，误差 ≤1px）',
  rectCoversViewport(rightbar.opened.panelRect, 390, 844),
  `rect=${formatRect(rightbar.opened.panelRect)}`,
);
check(
  '右栏展开后 elementFromPoint(195,400) 命中面板内部（可交互、在聊天层之上）',
  rightbar.opened.hitInPanel && rightbar.opened.hitPointerEvents !== 'none',
  `${formatHit(rightbar.opened)}, pointer-events=${rightbar.opened.hitPointerEvents}`,
);
check(
  '右栏展开后面板内按钮 data-sidebar-right-toggle 可命中并可点击',
  Boolean(rightbar.toggleHit && rightbar.toggleHit.insideElement) && rightbar.toggleClickable,
  `hit=${rightbar.toggleHit ? `${rightbar.toggleHit.tag}${rightbar.toggleHit.id ? `#${rightbar.toggleHit.id}` : ''}` : 'none'}, clicked=${rightbar.toggleClickable}`,
);
check(
  '右栏展开后会话层被面板覆盖（聊天按钮不再可点）',
  Boolean(rightbar.chatHitOpened && rightbar.chatHitOpened.insidePanel) && !rightbar.chatClickableOpened,
  `hit=${rightbar.chatHitOpened ? `${rightbar.chatHitOpened.tag}${rightbar.chatHitOpened.id ? `#${rightbar.chatHitOpened.id}` : ''}` : 'none'}, clicked=${rightbar.chatClickableOpened}`,
);
check(
  '右栏再次收起后恢复点击穿透',
  rightbar.recollapsed.hitInChat && !rightbar.recollapsed.hitInPanel && rightbar.recollapsed.dockVisibility === 'hidden',
  formatHit(rightbar.recollapsed),
);

// ---- 第四阶段：窄屏隐藏「在主机本机打开」控件（open-in-app） ----
check(
  '窄屏 open-in-app fixture 已加载（4 个控件 / 同 slot 其它插件按钮）',
  openInAppReady && openInAppMobile.splitCount === 4 && openInAppMobile.inner.length === 6,
  `ready=${openInAppReady}, splits=${openInAppMobile.splitCount}, inner=${openInAppMobile.inner.length}`,
);
check(
  '窄屏隐藏「在主机本机打开」控件根（display:none）',
  openInAppMobile.splitCount === 4
    && openInAppMobile.splitDisplays.every((display) => display === 'none'),
  `displays=${openInAppMobile.splitDisplays.join('/')}`,
);
check(
  '窄屏 open-in-app 内部主按钮/下拉箭头/加载骨架不再渲染（属性规则生效）',
  openInAppMobile.inner.length === 6
    && openInAppMobile.inner.every((item) => item.clientRects === 0 && !item.rendered),
  openInAppMobile.inner.map((item) => `${item.attrs.join('+')}:rects=${item.clientRects}`).join('; '),
);
check(
  '同 slot 的其它插件按钮仍可见可点（没有整段隐藏 [data-slot]）',
  Boolean(openInAppMobile.sibling)
    && openInAppMobile.sibling.display !== 'none'
    && openInAppMobile.sibling.visibility === 'visible'
    && openInAppMobile.sibling.clientRects === 1
    && openInAppMobile.sibling.hit === true,
  `display=${openInAppMobile.sibling?.display}, visibility=${openInAppMobile.sibling?.visibility}, hit=${openInAppMobile.sibling?.hit}`,
);
check(
  '工作区「添加工作区」＋按钮被隐藏（原生目录选择只会在主机弹文件夹对话框）',
  Boolean(openInAppMobile.workspaceAdd)
    && openInAppMobile.workspaceAdd.display === 'none'
    && openInAppMobile.workspaceAdd.clientRects === 0
    && !openInAppMobile.workspaceAdd.rendered,
  `display=${openInAppMobile.workspaceAdd?.display}, rects=${openInAppMobile.workspaceAdd?.clientRects}`,
);
check(
  '宽屏（1000×800 / iPad）同样隐藏「添加工作区」按钮',
  Boolean(openInAppDesktop.workspaceAdd)
    && openInAppDesktop.workspaceAdd.display === 'none'
    && openInAppDesktop.workspaceAdd.clientRects === 0
    && !openInAppDesktop.workspaceAdd.rendered,
  `display=${openInAppDesktop.workspaceAdd?.display}, rects=${openInAppDesktop.workspaceAdd?.clientRects}`,
);
check(
  '宽屏（1000×800 / iPad）同样隐藏 open-in-app 控件（规则与宽度无关）',
  openInAppDesktop.viewportWidth === 1000
    && !openInAppDesktop.mobileMedia
    && openInAppDesktop.splitCount === 4
    && openInAppDesktop.splitDisplays.every((display) => display === 'none')
    && openInAppDesktop.inner.every((item) => item.clientRects === 0 && !item.rendered),
  `viewport=${openInAppDesktop.viewportWidth}, media=${openInAppDesktop.mobileMedia}, displays=${openInAppDesktop.splitDisplays.join('/')}`,
);

check('页面无未捕获 JS 异常', exceptions.length === 0, exceptions.join('; '));

for (const item of checks) {
  console.log(`  ${item.ok ? '✅' : '❌'} ${item.label}${item.detail ? `（${item.detail}）` : ''}`);
}
const failed = checks.filter((item) => !item.ok);
console.log('');
if (failed.length > 0) {
  console.log(`❌ 注入手机壳检查失败：${failed.length}/${checks.length} 项`);
  process.exit(1);
}
console.log(`✅ 注入手机壳检查通过（${checks.length} 项）—— 真机行为仍需在 iPhone 上验收`);
