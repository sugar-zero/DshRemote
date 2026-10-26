#!/usr/bin/env node
/**
 * check-injected-shell.mjs — 在本地无头 Chrome 里验证「注入 DSH Web UI 的手机壳」行为。
 *
 * 为什么需要它：`mobileWebShell.ts` 是一段以字符串形式注入 WKWebView/WebView 的 JS，
 * tsc 只能检查外层 TS，`check:native` 也不覆盖它。这个脚本把脚本注入一个模仿 DSH
 * 会话头部布局的最小页面，断言：
 *   1. 脚本能初始化，鲸鱼入口挂在 DSH 的 conversation.header.leading 槽位里；
 *   2. viewport 被锁定，且不会重复写 <meta>（避免 iOS 反复重排）；
 *   3. DSH 重渲染把槽位节点换掉时，鲸鱼入口会在同一帧内补挂回去，且标题不横移
 *      （槽位预留了 min-width，列宽不会塌陷）；
 *   4. token 流式渲染的高频 DOM 变更不会触发全量 querySelector（O(1) 快路径）；
 *   5. 抽屉能开、能关；全程没有 JS 异常；
 *   6. 窄屏（390×844）下 DSH 右侧栏（@deepseek-ai/dsh-client-ui-sidebar-right）的全屏面板：
 *      收起时不拦截聊天手势、打开时覆盖整个 WebView 视口且可交互、再次收起后恢复穿透
 *      （之前注入脚本把整列 `_rightbarCol` display:none，面板永远不可见）。
 *   7. 窄屏下 DSH 设置弹窗（@deepseek-ai/dsh-client-ui-settings-general）的手机壳：
 *      弹窗铺满视口、左侧分区菜单变成抽屉（默认收起）、左上返回关闭设置、
 *      点抽屉外不误触内容、关闭后清理状态、宽屏恢复 DSH 原生布局。
 *   8. 外链（target=_blank 锚点 / window.open）：注入壳拦截 http(s) 外链并上报
 *      App（系统浏览器打开），同源锚点不受影响（原生 WebView 没有新窗口能力）。
 *   9. 隐藏「在主机本机打开」控件（@deepseek-ai/dsh-client-ui-open-in-app）：
 *      只按稳定 data-* 属性隐藏 split 控件/内部按钮/加载骨架，同一 [data-slot] 里的
 *      其它插件按钮保持可见可点；该控件永远操作主机本机，规则与 WebView 宽度无关
 *      （手机/iPad 都隐藏，宽屏下同样验证）。
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

/**
 * 第三份 fixture：按 DSH 0.2.1-rc.3 的真实 DOM/CSS 复刻「设置弹窗」。
 *
 * 规则来源（只读提取，未复制大段真实代码）：@deepseek-ai/dsh-client-ui-settings-general
 * 的 SettingsRoot.module.css（_overlay/_mask/_panel/_nav/_navTitle/_navList/_navCell/
 * _content/_header/_actions/_close/_options）与 SettingsRoot.js 的 portal 结构
 * （弹窗根节点带 data-shortcut-modal="settings"，挂到 document.body）。
 *
 * 与真实 DSH 的已知偏差（只为让断言可重复，不改变被验证的行为）：
 *  - 主题变量取值是 fixture 自带的暗色近似值，不复制 DSH 主题；
 *  - 设置分区内容用占位卡片/按钮代替真实 React 表单；
 *  - 打开/关闭用 window.__openSettings() / 关闭按钮里 remove() 模拟 React 的
 *    portal 挂载/卸载（DOM 结构与 CSS 规则和真实 DSH 一致）；
 *  - 分区切换只改 data-section/标题，真实 DSH 由 slots 渲染对应 section；
 *  - 背景保留一条带 conversation.header.leading 槽位的会话 header：真实 App 里它也
 *    在（鲸鱼入口挂在这里），让注入壳的 O(1) 快路径处于正常稳态；
 *  - 内容区放一个外链（target=_blank）、一个同源锚点、一个 window.open 按钮，用来
 *    验证「外链交给 App（系统浏览器）」的注入逻辑（桥用 stub 记录消息）。
 * CSS 规则是 DSH 客户端样式的只读摘录，仅用于本地回归 fixture（与右栏 fixture 同一做法）。
 */
const SETTINGS_FIXTURE_HTML = `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh settings fixture</title>
<style>
  :root {
    --dsw-alias-bg-base: #17181a;
    --dsw-alias-bg-layer-2: #1f2023;
    --dsw-alias-bg-mask-1: rgba(0, 0, 0, 0.55);
    --dsw-mask-blur: blur(2px);
    --dsw-alias-label-primary: #e6e6e6;
    --dsw-alias-border-l3: #34363a;
    --dsw-alias-interactive-bg-hover: rgba(255, 255, 255, 0.08);
    --dsw-specific-sidebar-nav-item-hover: rgba(255, 255, 255, 0.06);
    --dsw-specific-sidebar-nav-item-active: rgba(255, 255, 255, 0.12);
    --dsw-radius-panel: 12px;
    --dsw-radius-md: 8px;
    --dsw-radius-sm: 6px;
    --dsw-elevation-prominent: 0 8px 32px rgba(0, 0, 0, 0.5);
  }
  html, body { height: 100%; margin: 0; background: #0e0f11; color: var(--dsw-alias-label-primary); font-family: -apple-system, system-ui, sans-serif; }
  body { overflow: hidden; }
  /* ===== SettingsRoot.module.css（DSH 0.2.1-rc.3，关键规则逐字保留） ===== */
  ._77Pn0W_overlay { z-index: 1000; justify-content: center; align-items: center; display: flex; position: fixed; inset: 0; }
  ._77Pn0W_mask { inset: var(--dsh-frame-chrome-top, 0px) 0 0; background: var(--dsw-alias-bg-mask-1); backdrop-filter: var(--dsw-mask-blur); position: absolute; }
  ._77Pn0W_panel { z-index: 1; width: 800px; height: min(800px, calc(100vh - 2 * max(24px, var(--dsh-frame-overlay-top, 24px)))); border-radius: var(--dsw-radius-panel); background: var(--dsw-alias-bg-layer-2); max-width: calc(100vw - 48px); box-shadow: var(--dsw-elevation-prominent); display: flex; position: relative; overflow: hidden; }
  ._77Pn0W_panel:focus { outline: none; }
  ._77Pn0W_nav { box-sizing: border-box; flex-direction: column; flex: none; gap: 18px; width: 188px; padding: 22px 12px 0; display: flex; }
  ._77Pn0W_navTitle { color: var(--dsw-alias-label-primary); padding: 0 12px; font-size: 16px; font-weight: 500; line-height: 24px; }
  ._77Pn0W_navList { flex-direction: column; gap: 4px; display: flex; overflow-y: auto; }
  ._77Pn0W_navCell { box-sizing: border-box; border-radius: var(--dsw-radius-md); cursor: pointer; height: 40px; color: var(--dsw-alias-label-primary); text-align: left; background: 0 0; border: none; align-items: center; gap: 8px; padding: 9px 16px 9px 12px; font-family: inherit; font-size: 14px; font-weight: 400; line-height: 22px; display: flex; }
  ._77Pn0W_navCell:hover { background: var(--dsw-specific-sidebar-nav-item-hover); }
  ._77Pn0W_navCell._77Pn0W_active { background: var(--dsw-specific-sidebar-nav-item-active); }
  ._77Pn0W_navIcon { flex: none; }
  ._77Pn0W_navLabel { white-space: nowrap; text-overflow: ellipsis; flex: 1; min-width: 0; overflow: hidden; }
  ._77Pn0W_content { flex-direction: column; flex: 1; min-width: 0; display: flex; }
  ._77Pn0W_header { box-sizing: border-box; flex: none; justify-content: space-between; align-items: flex-start; gap: 8px; height: 54px; padding: 20px 14px 8px 10px; display: flex; }
  ._77Pn0W_actions { justify-content: flex-end; align-items: center; gap: 8px; min-width: 0; margin-left: auto; display: flex; }
  ._77Pn0W_close { border-radius: var(--dsw-radius-sm); cursor: pointer; width: 28px; height: 28px; color: var(--dsw-alias-label-primary); background: 0 0; border: none; justify-content: center; align-items: center; padding: 0; display: inline-flex; }
  ._77Pn0W_close:hover { background: var(--dsw-alias-interactive-bg-hover); }
  ._77Pn0W_options { flex: 1; min-height: 0; padding: 0 24px 24px; overflow-y: auto; }
  ._77Pn0W_hiddenLabel { clip: rect(0 0 0 0); white-space: nowrap; width: 1px; height: 1px; position: absolute; overflow: hidden; }
  /* ===== 各 settings.section 的占位内容 ===== */
  #settings-section { display: flex; flex-direction: column; gap: 12px; padding-top: 12px; }
  .fixture-row { height: 56px; border-radius: 8px; background: #26282c; }
  #options-button { align-self: flex-end; height: 40px; padding: 0 16px; color: #fff; background: #3a63b8; border: 0; border-radius: 8px; }
  /* 背景会话 header：给注入壳的鲸鱼入口一个 leading 槽位（真实 App 里也存在），
     这样 token 流式渲染的 O(1) 快路径处于正常稳态。 */
  .fixture-header { display: flex; align-items: center; gap: 8px; min-height: 56px; padding: 8px 16px; border-bottom: 1px solid #26282c; }
  .fixture-header-leading { display: flex; align-items: center; min-width: 40px; min-height: 30px; }
  .fixture-header-mark { display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; }
  .fixture-header-mark svg { width: 22px; height: 22px; }
  .fixture-header-title { color: #9aa0a6; }
</style></head>
<body>
<div id="app-shell">
  <header class="fixture-header">
    <div class="fixture-header-mark ab_railMark"><svg viewBox="0 0 24 24" width="24" height="24"><path d="M2 12h20v8H2z"/></svg></div>
    <div class="fixture-header-leading"><div data-slot="conversation.header.leading"></div></div>
    <div class="fixture-header-title">会话标题</div>
  </header>
  <div style="padding: 24px; color: #777;">会话内容（设置弹窗打开时被遮住）</div>
</div>
<!-- 设置弹窗：真实 DSH 由 React portal 到 document.body，初始不挂载 -->
<div id="settings-overlay" class="_77Pn0W_overlay" role="presentation">
  <div class="_77Pn0W_mask" aria-hidden="true"></div>
  <div tabindex="-1" data-shortcut-modal="settings" class="_77Pn0W_panel" role="dialog" aria-modal="true" aria-labelledby="settings-title">
    <nav class="_77Pn0W_nav">
      <div class="_77Pn0W_navTitle" id="settings-title" tabindex="-1" data-modal-autofocus>设置</div>
      <div class="_77Pn0W_navList">
        <button type="button" class="_77Pn0W_navCell _77Pn0W_active" aria-current="true">
          <svg class="_77Pn0W_navIcon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="currentColor"/></svg>
          <span class="_77Pn0W_navLabel">通用设置</span>
        </button>
        <button type="button" class="_77Pn0W_navCell">
          <svg class="_77Pn0W_navIcon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="currentColor"/></svg>
          <span class="_77Pn0W_navLabel">模型</span>
        </button>
        <button type="button" class="_77Pn0W_navCell">
          <svg class="_77Pn0W_navIcon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="currentColor"/></svg>
          <span class="_77Pn0W_navLabel">账号</span>
        </button>
        <button type="button" class="_77Pn0W_navCell">
          <svg class="_77Pn0W_navIcon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="currentColor"/></svg>
          <span class="_77Pn0W_navLabel">插件</span>
        </button>
      </div>
    </nav>
    <div class="_77Pn0W_content">
      <div class="_77Pn0W_header">
        <div class="_77Pn0W_actions"></div>
        <button type="button" class="_77Pn0W_close" id="settings-close">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 2l10 10M12 2L2 12" stroke="currentColor" stroke-width="1.5"/></svg>
          <span class="_77Pn0W_hiddenLabel">关闭</span>
        </button>
      </div>
      <div class="_77Pn0W_options">
        <div id="settings-section" data-section="0">
          <h2 id="settings-section-title" style="margin: 0; font-size: 16px;">通用设置</h2>
          <p style="margin: 0; color: #9aa0a6; font-size: 13px; line-height: 20px;">占位说明：真机上这里是设置表单，窄屏时应当占满内容区宽度。</p>
          <a id="external-link" href="https://platform.example.com/usage" target="_blank" rel="noreferrer" style="color: #8ab4ff;">查询用量</a>
          <a id="internal-link" href="#settings-internal" target="_blank" style="color: #8ab4ff;">内部锚点</a>
          <button type="button" id="open-window-button" style="align-self: flex-start; height: 36px;">意见反馈</button>
          <div class="fixture-row"></div>
          <button type="button" id="options-button">内容区按钮</button>
          <div class="fixture-row"></div>
          <div class="fixture-row"></div>
        </div>
      </div>
    </div>
  </div>
</div>
<script>
  (function () {
    var overlay = document.getElementById('settings-overlay');
    var close = document.getElementById('settings-close');
    var cells = Array.prototype.slice.call(overlay.querySelectorAll('[class*="_navCell"]'));
    var section = document.getElementById('settings-section');
    var sectionTitle = document.getElementById('settings-section-title');
    var optionsButton = document.getElementById('options-button');
    // 注入壳的桥（真实 App 里由原生 WebView 注入）：记录外链消息供断言。
    var bridgeMessages = [];
    window.__bridgeMessages = bridgeMessages;
    window.dshMtlsBridge = {
      postMessage: function (text) { bridgeMessages.push(text); }
    };
    document.getElementById('open-window-button').addEventListener('click', function () {
      window.open('https://platform.example.com/feedback', '_blank');
    });
    window.__settingsOverlay = overlay;
    window.__openSettings = function () {
      if (!overlay.isConnected) document.body.appendChild(overlay);
    };
    // 模拟 React 卸载 portal
    close.addEventListener('click', function () { overlay.remove(); });
    // 模拟 DSH slots 切分区（切换 active + 渲染对应 section）
    cells.forEach(function (cell, index) {
      cell.addEventListener('click', function () {
        cells.forEach(function (item) {
          item.classList.remove('_77Pn0W_active');
          item.removeAttribute('aria-current');
        });
        cell.classList.add('_77Pn0W_active');
        cell.setAttribute('aria-current', 'true');
        section.setAttribute('data-section', String(index));
        sectionTitle.textContent = cell.textContent.trim();
      });
    });
    // 用来证明「抽屉打开时点内容区」不会误触到真实的设置控件
    optionsButton.addEventListener('click', function () {
      optionsButton.dataset.clicks = String(Number(optionsButton.dataset.clicks || '0') + 1);
    });
    // 初始不挂载：真实 DSH 在用户点侧栏「设置」时才 portal 到 body。
    overlay.remove();
  })();
</script>
</body></html>`;

/**
 * 第四份 fixture：按 DSH 0.2.1-rc.3 的真实 DOM/CSS 复刻「在主机本机打开」控件
 * （@deepseek-ai/dsh-client-ui-open-in-app 的 OpenTargetButton）。
 *
 * 规则来源（只读提取，未复制大段真实代码）：dsh-client-ui-open-in-app/lib/client.js 里
 * OpenTargetButton.js 的 DOM（`data-open-target` / `data-open-path-open|more|unpreviewable` /
 * `data-open-target-skeleton` / `data-size` / `data-state`）与 OpenTargetButton.module.css
 * 的 `_split/_main/_chevron/_skeleton` 几何规则。
 *
 * 场景：会话 header 右侧的 utilities 槽（真实 DSH 里 open-in-app 就注册在
 * `conversation.session.header.utilities` / `sidebar.right.tab.files.actions` 等 slot）
 * 同时放着「其它插件按钮」和 4 种形态的 open-in-app 控件：
 *   - 目录 compact split（会话 header：主按钮 + 下拉箭头）
 *   - 文件 compact split（`data-open-path` + `data-open-path-open` / `-more`）
 *   - 文件 prominent split（大号、`data-open-path-unpreviewable`）
 *   - 加载中 skeleton（`data-open-target-skeleton` 在 split 主按钮内）
 * 注入壳应只隐藏这些控件（不隐藏整个 `[data-slot]`），同 slot 的其它插件按钮保持可见
 * 可点；规则与宽度无关（App 的 WebView 都是远程设备，iPad 宽屏也隐藏）——窄屏与宽屏
 * 各跑一次快照。
 *
 * 与真实 DSH 的已知偏差（只为让断言可重复，不改变被验证的行为）：
 *  - 图标/文案都是占位，没有接入真实应用图标与宿主菜单（Menu portal）；
 *  - 只保留复现隐藏行为所需的最小 header/CSS，省略主题字体、tooltip 等外观规则。
 */
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
  const settingsFixtureFile = join(fixtureDir, 'settings-fixture.html');
  const openInAppFixtureFile = join(fixtureDir, 'open-in-app-fixture.html');
  writeFileSync(fixtureFile, FIXTURE_HTML, 'utf8');
  writeFileSync(rightbarFixtureFile, RIGHTBAR_FIXTURE_HTML, 'utf8');
  writeFileSync(settingsFixtureFile, SETTINGS_FIXTURE_HTML, 'utf8');
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
      const fab = document.querySelector('.dsh-mobile-native-trigger');
      const slot = document.querySelector('[data-slot="conversation.header.leading"]');
      const meta = document.querySelector('meta[name="viewport"]');
      return {
        installed: Boolean(window.__dshMobileShellInstalled),
        fabInSlot: Boolean(fab && slot && fab.parentElement === slot),
        fabHasWhaleSvg: Boolean(fab && fab.querySelector('svg')),
        viewport: meta ? meta.getAttribute('content') : null,
        viewportWrites: window.__shellStats.viewportWrites,
      };
    })()`);

    const reRender = await evaluate(`(async () => {
      const leading = document.querySelector('.kiGsTW_headerLeading');
      const oldSlot = leading.querySelector('[data-slot="conversation.header.leading"]');
      const titleRow = document.querySelector('.kiGsTW_titleRow');
      const beforeX = titleRow.getBoundingClientRect().left;
      const newSlot = document.createElement('div');
      newSlot.setAttribute('data-slot', 'conversation.header.leading');
      leading.replaceChild(newSlot, oldSlot);
      const immediateX = titleRow.getBoundingClientRect().left;
      await new Promise((resolve) => setTimeout(resolve, 0));
      const fab = document.querySelector('.dsh-mobile-native-trigger');
      return {
        titleShiftImmediatePx: Math.round((immediateX - beforeX) * 10) / 10,
        fabRepairedIntoSameSlot: Boolean(fab && fab.parentElement === newSlot),
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

    const drawer = await evaluate(`(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const isOpen = () => document.documentElement.classList.contains('dsh-mobile-drawer-open');
      const fab = document.querySelector('.dsh-mobile-native-trigger');
      fab.click();
      await sleep(30);
      const opened = isOpen();
      // 工作区行：只展开/收起会话列表，不应收起抽屉
      document.querySelector('[data-row-key^="workspace:"]').click();
      await sleep(30);
      const workspaceKept = isOpen();
      // 「展开其余 N 个会话」按钮：只是展开侧栏内容，不应收起抽屉（回归 bug）
      document.querySelector('[data-row-key^="overflow:"]').click();
      await sleep(30);
      const overflowKept = isOpen();
      // 会话行是导航：点击后应收起抽屉
      document.querySelector('[data-row-key^="session:"]').click();
      await sleep(30);
      const sessionClosed = !isOpen();
      // 重新打开：背景点击仍能收起
      fab.click();
      await sleep(30);
      const reopened = isOpen();
      document.querySelector('.dsh-mobile-backdrop').click();
      await sleep(30);
      return {
        opened,
        workspaceKept,
        overflowKept,
        sessionClosed,
        reopened,
        closed: !isOpen(),
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
      && document.querySelector('.dsh-mobile-native-trigger')
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

    // 窄屏下抽屉（左侧鲸鱼入口）仍应可用，不能被右栏覆盖层破坏。
    const mobileDrawer = await evaluate(`(async () => {
      const fab = document.querySelector('.dsh-mobile-native-trigger');
      if (!fab) return { hasFab: false, opened: false, closed: false };
      fab.click();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const opened = document.documentElement.classList.contains('dsh-mobile-drawer-open');
      const backdrop = document.querySelector('.dsh-mobile-backdrop');
      if (backdrop) backdrop.click();
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        hasFab: true,
        opened,
        closed: !document.documentElement.classList.contains('dsh-mobile-drawer-open'),
      };
    })()`);

    // ===== 第三阶段：窄屏（390×844）下的 DSH 设置弹窗（全屏 + 分区抽屉） =====
    // 真实 DSH 把设置做成居中 modal（panel 800 + 左 nav 188）；手机宽度下内容只剩 ~154px。
    // 这里验证注入壳：panel 铺满视口、nav 变抽屉、左上返回关闭设置、点抽屉外不误触。
    await cdp.send('Page.navigate', { url: `file://${settingsFixtureFile}` });
    const settingsReady = await waitForPage(`Boolean(
      window.__dshMobileShellInstalled
      && document.getElementById('dsh-mobile-shell-style')
      && typeof window.__openSettings === 'function'
      && document.querySelector('[data-shortcut-modal="settings"]') === null
    )`);

    const settings = await evaluate(`(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const rectOf = (element) => {
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return {
          left: Math.round(rect.left * 10) / 10,
          top: Math.round(rect.top * 10) / 10,
          right: Math.round(rect.right * 10) / 10,
          bottom: Math.round(rect.bottom * 10) / 10,
          width: Math.round(rect.width * 10) / 10,
          height: Math.round(rect.height * 10) / 10,
        };
      };
      const styleOf = (element) => (element ? getComputedStyle(element) : null);
      const hitInside = (element, x, y) => {
        const hit = document.elementFromPoint(x, y);
        return Boolean(element && hit && (hit === element || element.contains(hit)));
      };
      // 真实 tap：先命中测试，再在命中的节点上派发冒泡 click（和手指点击一致）。
      const tap = (element, point) => {
        if (!element) return { fired: false, hitTag: null, hitClass: '' };
        const rect = element.getBoundingClientRect();
        const x = point ? point.x : rect.left + rect.width / 2;
        const y = point ? point.y : rect.top + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        let fired = false;
        element.addEventListener('click', () => { fired = true; }, { once: true });
        if (hit) hit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return {
          fired,
          hitTag: hit ? hit.tagName.toLowerCase() : null,
          hitClass: hit && typeof hit.className === 'string' ? hit.className : '',
        };
      };
      const snapshot = () => {
        const panel = document.querySelector('[data-shortcut-modal="settings"]');
        const nav = panel ? panel.querySelector('nav') : null;
        const content = panel ? panel.children[1] : null;
        const header = content ? content.querySelector('[class*="_header"]') : null;
        const options = content ? content.querySelector('[class*="_options"]') : null;
        const bar = document.querySelector('.dsh-mobile-settings-bar');
        const barTitle = bar ? bar.querySelector('.dsh-mobile-settings-bar-title') : null;
        const backdrop = document.querySelector('.dsh-mobile-settings-backdrop');
        const fab = document.querySelector('.dsh-mobile-native-trigger');
        return {
          mobileClass: document.documentElement.classList.contains('dsh-settings-mobile'),
          navOpenClass: document.documentElement.classList.contains('dsh-settings-nav-open'),
          barFound: Boolean(bar),
          barTitle: barTitle ? (barTitle.textContent || '').trim() : null,
          panelRect: rectOf(panel),
          panelPosition: styleOf(panel) ? styleOf(panel).position : null,
          panelBorderRadius: styleOf(panel) ? styleOf(panel).borderRadius : null,
          navPosition: styleOf(nav) ? styleOf(nav).position : null,
          navVisibility: styleOf(nav) ? styleOf(nav).visibility : null,
          navInert: nav ? nav.hasAttribute('inert') : null,
          navPointerEvents: styleOf(nav) ? styleOf(nav).pointerEvents : null,
          navRect: rectOf(nav),
          headerDisplay: styleOf(header) ? styleOf(header).display : null,
          optionsRect: rectOf(options),
          barRect: rectOf(bar),
          backRect: rectOf(document.querySelector('.dsh-mobile-settings-back')),
          menuRect: rectOf(document.querySelector('.dsh-mobile-settings-menu')),
          backdropDisplay: styleOf(backdrop) ? styleOf(backdrop).display : null,
          fabDisplay: styleOf(fab) ? styleOf(fab).display : null,
          section: document.getElementById('settings-section').getAttribute('data-section'),
          sectionTitle: document.getElementById('settings-section-title').textContent,
          optionsClicks: document.getElementById('options-button').dataset.clicks || '0',
          closeButtonConnected: Boolean(document.getElementById('settings-close').isConnected),
        };
      };

      // 真实 DSH 的打开路径：React 把设置 portal 挂到 document.body；注入壳通过
      // MutationObserver 发现后装手机壳（不是刷新时预装的）。
      window.__openSettings();
      await sleep(300);

      const initial = snapshot();
      const navHitClosed = hitInside(document.querySelector('[data-shortcut-modal="settings"] nav'), 80, 300);

      // 外链：target=_blank 锚点 / window.open 都应上报给 App（系统浏览器），页面不导航；
      // 同源 / 非 http(s) 锚点不拦截。
      const pageHrefBefore = window.location.href;
      const messagesBefore = window.__bridgeMessages.length;
      const externalLinkTap = tap(document.getElementById('external-link'));
      await sleep(80);
      const externalOpenMessage = (() => {
        const texts = window.__bridgeMessages.slice(messagesBefore);
        for (const text of texts) {
          try {
            const message = JSON.parse(text);
            if (message.type === 'dsh-remote/open-external') return message;
          } catch { /* 非 JSON 消息忽略 */ }
        }
        return null;
      })();
      const pageHrefAfterExternal = window.location.href;
      const internalBefore = window.__bridgeMessages.length;
      const internalLinkTap = tap(document.getElementById('internal-link'));
      await sleep(80);
      const internalOpenedExternal = window.__bridgeMessages.slice(internalBefore).some((text) => {
        try { return JSON.parse(text).type === 'dsh-remote/open-external'; } catch { return false; }
      });
      const windowOpenBefore = window.__bridgeMessages.length;
      const windowOpenTap = tap(document.getElementById('open-window-button'));
      await sleep(80);
      const windowOpenMessage = (() => {
        const texts = window.__bridgeMessages.slice(windowOpenBefore);
        for (const text of texts) {
          try {
            const message = JSON.parse(text);
            if (message.type === 'dsh-remote/open-external') return message;
          } catch { /* 非 JSON 消息忽略 */ }
        }
        return null;
      })();
      const externalLinks = {
        external: {
          tapped: externalLinkTap.fired,
          url: externalOpenMessage ? externalOpenMessage.url : null,
          navigated: pageHrefAfterExternal !== pageHrefBefore,
        },
        internal: {
          tapped: internalLinkTap.fired,
          openedExternal: internalOpenedExternal,
        },
        windowOpen: {
          tapped: windowOpenTap.fired,
          url: windowOpenMessage ? windowOpenMessage.url : null,
        },
      };

      // 菜单 → 分区抽屉打开
      const menuTap = tap(document.querySelector('.dsh-mobile-settings-menu'));
      await sleep(320);
      const opened = snapshot();
      const navHitOpened = hitInside(document.querySelector('[data-shortcut-modal="settings"] nav'), 80, 300);

      // 抽屉打开时点内容区（右侧、抽屉外）：应只收起抽屉，不能触发下面的设置控件
      const optionsRect = document.getElementById('options-button').getBoundingClientRect();
      const outsidePoint = {
        x: Math.min(optionsRect.right - 8, window.innerWidth - 32),
        y: optionsRect.top + optionsRect.height / 2,
      };
      const outsideHit = document.elementFromPoint(outsidePoint.x, outsidePoint.y);
      const outsideHitIsBackdrop = Boolean(outsideHit && typeof outsideHit.className === 'string'
        && outsideHit.className.indexOf('dsh-mobile-settings-backdrop') !== -1);
      if (outsideHit) outsideHit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      await sleep(320);
      const afterOutsideTap = snapshot();

      // 抽屉收起后内容区恢复可交互
      const optionsTap = tap(document.getElementById('options-button'));
      await sleep(150);
      const afterContentTap = snapshot();

      // 重新开抽屉 → 点第二个分区：抽屉收起 + DSH 分区切换
      tap(document.querySelector('.dsh-mobile-settings-menu'));
      await sleep(320);
      const secondCell = document.querySelectorAll('[class*="_navCell"]')[1];
      const cellTap = tap(secondCell);
      await sleep(320);
      const afterSectionTap = snapshot();

      // 左上返回 = 退出设置（走 DSH 原生 close）
      const backTap = tap(document.querySelector('.dsh-mobile-settings-back'));
      await sleep(320);
      const closed = {
        overlayConnected: window.__settingsOverlay.isConnected,
        barFound: Boolean(document.querySelector('.dsh-mobile-settings-bar')),
        mobileClass: document.documentElement.classList.contains('dsh-settings-mobile'),
        navOpenClass: document.documentElement.classList.contains('dsh-settings-nav-open'),
        fabDisplay: (() => {
          const fab = document.querySelector('.dsh-mobile-native-trigger');
          return fab ? getComputedStyle(fab).display : null;
        })(),
      };

      // 再次打开：手机壳应能重新装上（panel 是新的 DOM/再次挂载）
      window.__openSettings();
      await sleep(320);
      const reopened = {
        barInjected: Boolean(document.querySelector('.dsh-mobile-settings-bar')),
        mobileClass: document.documentElement.classList.contains('dsh-settings-mobile'),
        panelRect: rectOf(document.querySelector('[data-shortcut-modal="settings"]')),
      };

      // 模拟 DSH 重渲染换掉整个 nav 节点。关键：抽屉先打开、再换节点（openSettingsNav
      // 因此不会替缓存补解析），cloneNode 也不会复制 click listener，这里手动给新 nav
      // 的分区按钮补一个（等价 React 重新挂载后的 handler）——用来验证注入壳在点击时
      // 按直系子节点重新解析 nav，而不是把点击当「抽屉外」吞掉。
      tap(document.querySelector('.dsh-mobile-settings-menu'));
      await sleep(320);
      const navOpenAfterReplace = document.documentElement.classList.contains('dsh-settings-nav-open');
      const navNode = document.querySelector('[data-shortcut-modal="settings"] nav');
      const navClone = navNode.cloneNode(true);
      const cloneCells = Array.prototype.slice.call(navClone.querySelectorAll('[class*="_navCell"]'));
      cloneCells.forEach(function (cell, index) {
        cell.addEventListener('click', function () {
          document.getElementById('settings-section').setAttribute('data-section', String(index));
          document.getElementById('settings-section-title').textContent = cell.textContent.trim();
        });
      });
      navNode.parentNode.replaceChild(navClone, navNode);
      tap(cloneCells[2]);
      await sleep(150);
      const navReplaced = {
        opened: navOpenAfterReplace,
        closed: !document.documentElement.classList.contains('dsh-settings-nav-open'),
        navWidth: rectOf(navClone) ? rectOf(navClone).width : null,
        sectionAfterReplace: document.getElementById('settings-section').getAttribute('data-section'),
      };

      // 模拟 DSH 重渲染把手机栏 / 抽屉遮罩移除：注入脚本应按 isConnected 自愈补装。
      const barEl = document.querySelector('.dsh-mobile-settings-bar');
      const backdropEl = document.querySelector('.dsh-mobile-settings-backdrop');
      if (barEl) barEl.remove();
      if (backdropEl) backdropEl.remove();
      await sleep(350);
      const barReinjected = {
        barInjected: Boolean(document.querySelector('.dsh-mobile-settings-bar')),
        backdropInjected: Boolean(document.querySelector('.dsh-mobile-settings-backdrop')),
        mobileClass: document.documentElement.classList.contains('dsh-settings-mobile'),
        backPresent: Boolean(document.querySelector('.dsh-mobile-settings-back')),
      };

      // 设置打开期间的流式 DOM 变更：注入壳稳态不应触发 Document.querySelector
      // （只允许 O(1) 的 isConnected / classList 检查）。
      const queryBefore = window.__shellStats ? window.__shellStats.querySelector : 0;
      await new Promise((resolve) => {
        let batch = 0;
        const stream = document.getElementById('settings-section');
        const tick = () => {
          for (let i = 0; i < 5; i += 1) {
            const span = document.createElement('span');
            span.textContent = 'settings row ' + batch + '-' + i;
            stream.appendChild(span);
          }
          batch += 1;
          if (batch >= 20) return resolve();
          setTimeout(tick, 16);
        };
        tick();
      });
      const settingsChurnQueryDelta = (window.__shellStats ? window.__shellStats.querySelector : 0) - queryBefore;

      // 模拟 DSH 重渲染整体换掉 _header：缓存的原生 close 节点失效，
      // 左上返回应按稳定类名后缀重新解析 close，否则只能靠注入失败的兜底路径。
      const oldHeader = document.querySelector('[data-shortcut-modal="settings"] [class*="_header"]');
      const newHeader = document.createElement('div');
      newHeader.className = '_77Pn0W_header';
      const newActions = document.createElement('div');
      newActions.className = '_77Pn0W_actions';
      const newClose = document.createElement('button');
      newClose.type = 'button';
      newClose.className = '_77Pn0W_close';
      newClose.innerHTML = '<span class="_77Pn0W_hiddenLabel">关闭</span>';
      newClose.addEventListener('click', function () { window.__settingsOverlay.remove(); });
      newHeader.appendChild(newActions);
      newHeader.appendChild(newClose);
      oldHeader.parentNode.replaceChild(newHeader, oldHeader);
      await sleep(100);
      const headerCloseTap = tap(document.querySelector('.dsh-mobile-settings-back'));
      await sleep(320);
      const headerReplaced = {
        clicked: headerCloseTap.fired,
        overlayConnected: window.__settingsOverlay.isConnected,
        barFound: Boolean(document.querySelector('.dsh-mobile-settings-bar')),
      };

      // 后面的宽屏 / 转回窄屏断言需要设置仍处于打开状态
      window.__openSettings();
      await sleep(320);

      return {
        viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
        initial,
        navHitClosed,
        menuTap,
        opened,
        navHitOpened,
        outsideHitIsBackdrop,
        afterOutsideTap,
        optionsTap,
        afterContentTap,
        cellTap,
        afterSectionTap,
        backTap,
        closed,
        reopened,
        navReplaced,
        barReinjected,
        settingsChurnQueryDelta,
        headerReplaced,
        externalLinks,
      };
    })()`);

    // 宽屏（1000×800）恢复 DSH 原生布局：手机壳必须整体退场（不留抽屉/手机栏）。
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1000,
      height: 800,
      screenWidth: 1000,
      screenHeight: 800,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const settingsDesktop = await evaluate(`(() => {
      const panel = document.querySelector('[data-shortcut-modal="settings"]');
      const nav = panel.children[0];
      const rect = panel.getBoundingClientRect();
      return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        mobileClass: document.documentElement.classList.contains('dsh-settings-mobile'),
        navOpenClass: document.documentElement.classList.contains('dsh-settings-nav-open'),
        barFound: Boolean(document.querySelector('.dsh-mobile-settings-bar')),
        panelRect: {
          left: Math.round(rect.left * 10) / 10,
          top: Math.round(rect.top * 10) / 10,
          width: Math.round(rect.width * 10) / 10,
          height: Math.round(rect.height * 10) / 10,
        },
        panelPosition: getComputedStyle(panel).position,
        panelBorderRadius: getComputedStyle(panel).borderRadius,
        navPosition: getComputedStyle(nav).position,
        navVisibility: getComputedStyle(nav).visibility,
      };
    })()`);

    // 转回窄屏：已打开的设置应重新装上手机壳（覆盖 resize 后补装路径）。
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      screenWidth: 390,
      screenHeight: 844,
      deviceScaleFactor: 3,
      mobile: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const settingsRemobile = await evaluate(`(() => {
      const panel = document.querySelector('[data-shortcut-modal="settings"]');
      const rect = panel ? panel.getBoundingClientRect() : null;
      return {
        mobileClass: document.documentElement.classList.contains('dsh-settings-mobile'),
        barInjected: Boolean(document.querySelector('.dsh-mobile-settings-bar')),
        panelRect: rect ? {
          left: Math.round(rect.left * 10) / 10,
          top: Math.round(rect.top * 10) / 10,
          right: Math.round(rect.right * 10) / 10,
          bottom: Math.round(rect.bottom * 10) / 10,
          width: Math.round(rect.width * 10) / 10,
          height: Math.round(rect.height * 10) / 10,
        } : null,
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
      reRender,
      churn,
      drawer,
      rightbarReady,
      rightbar,
      mobileDrawer,
      settingsReady,
      settings,
      settingsDesktop,
      settingsRemobile,
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
  reRender,
  churn,
  drawer,
  rightbarReady,
  rightbar,
  mobileDrawer,
  settingsReady,
  settings,
  settingsDesktop,
  settingsRemobile,
  openInAppReady,
  openInAppMobile,
  openInAppDesktop,
  exceptions,
} = result;
check('注入脚本已初始化', initial.installed);
check('鲸鱼入口在 conversation.header.leading 槽位内', initial.fabInSlot);
check('鲸鱼入口使用 DSH 原生 logo', initial.fabHasWhaleSvg);
check('viewport 被锁定（user-scalable=no）', String(initial.viewport ?? '').includes('user-scalable=no'), initial.viewport);
check('加载阶段只写一次 viewport（无重复重排）', initial.viewportWrites === 1, `writes=${initial.viewportWrites}`);
check('DSH 重建 header 时标题不横移（槽位预留宽度）', Math.abs(reRender.titleShiftImmediatePx) < 0.5, `shift=${reRender.titleShiftImmediatePx}px`);
check('鲸鱼入口在槽位重建后补挂回去', reRender.fabRepairedIntoSameSlot);
check('流式 DOM 变更不触发全量 querySelector（O(1) 快路径）', churn.querySelectorDelta === 0, `querySelector×${churn.querySelectorDelta} / ${churn.batches} batches`);
check('流式渲染后不再改写 viewport', churn.viewportWritesAfterLoad === 1, `writes=${churn.viewportWritesAfterLoad}`);
check('抽屉可打开', drawer.opened && drawer.reopened);
check('抽屉内工作区行不收起抽屉', drawer.workspaceKept);
check('抽屉内「展开其余 N 个会话」不收起抽屉（回归）', drawer.overflowKept);
check('抽屉内会话行点击后收起抽屉', drawer.sessionClosed);
check('抽屉可关闭（背景点击）', drawer.closed);

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
check(
  '窄屏下抽屉仍可打开（鲸鱼入口）',
  mobileDrawer.hasFab && mobileDrawer.opened && mobileDrawer.closed,
  `fab=${mobileDrawer.hasFab}, opened=${mobileDrawer.opened}, closed=${mobileDrawer.closed}`,
);

// ---- 第三阶段：窄屏设置弹窗（全屏 + 分区抽屉 + 左上返回） ----
check(
  '窄屏设置 fixture 已加载（portal 初始未挂载）',
  settingsReady,
  `ready=${settingsReady}`,
);
check(
  '设置打开后装上手机壳（手机栏 + html 状态类）',
  settings.initial.mobileClass && settings.initial.barFound,
  `mobileClass=${settings.initial.mobileClass}, bar=${settings.initial.barFound}`,
);
check(
  '外链锚点（target=_blank）被拦截并上报给 App（页面不导航，点击被壳吞掉）',
  settings.externalLinks.external.url === 'https://platform.example.com/usage'
    && !settings.externalLinks.external.navigated,
  `url=${settings.externalLinks.external.url}, navigated=${settings.externalLinks.external.navigated}`,
);
check(
  '同源/非 http(s) 锚点不被当成外链拦截',
  settings.externalLinks.internal.tapped && !settings.externalLinks.internal.openedExternal,
  `tapped=${settings.externalLinks.internal.tapped}, openedExternal=${settings.externalLinks.internal.openedExternal}`,
);
check(
  'window.open 外链（意见反馈）被拦截并上报给 App',
  settings.externalLinks.windowOpen.tapped
    && settings.externalLinks.windowOpen.url === 'https://platform.example.com/feedback',
  `tapped=${settings.externalLinks.windowOpen.tapped}, url=${settings.externalLinks.windowOpen.url}`,
);
check(
  '窄屏设置全屏覆盖视口（rect 0,0,390,844，误差 ≤1px）',
  rectCoversViewport(settings.initial.panelRect, 390, 844),
  `rect=${formatRect(settings.initial.panelRect)}`,
);
check(
  'DSH 原生设置 header 已隐藏（改由手机栏承担）',
  settings.initial.headerDisplay === 'none',
  `display=${settings.initial.headerDisplay}`,
);
check(
  '手机栏在内容区顶部、标题取自 DSH「设置」',
  Boolean(settings.initial.barRect)
    && Math.abs(settings.initial.barRect.top) <= 1
    && Math.abs(settings.initial.barRect.height - 52) <= 1
    && settings.initial.barTitle === '设置',
  `bar=${formatRect(settings.initial.barRect)}, title=${settings.initial.barTitle}`,
);
check(
  '返回按钮在左上角（≤12px）',
  Boolean(settings.initial.backRect)
    && settings.initial.backRect.left <= 12
    && settings.initial.backRect.top <= 12,
  `back=${formatRect(settings.initial.backRect)}`,
);
check(
  '分区菜单默认收起（抽屉移出左边界 + visibility hidden + inert + 不接手势）',
  settings.initial.navVisibility === 'hidden'
    && settings.initial.navInert === true
    && settings.initial.navPointerEvents === 'none'
    && (!settings.initial.navRect || settings.initial.navRect.right <= 1)
    && !settings.navHitClosed,
  `visibility=${settings.initial.navVisibility}, inert=${settings.initial.navInert}, pointer-events=${settings.initial.navPointerEvents}, rect=${formatRect(settings.initial.navRect)}`,
);
check(
  '设置内容占满全宽、从手机栏下方开始',
  Boolean(settings.initial.optionsRect)
    && Math.abs(settings.initial.optionsRect.top - 52) <= 1
    && Math.abs(settings.initial.optionsRect.width - 390) <= 1,
  `options=${formatRect(settings.initial.optionsRect)}`,
);
check(
  '设置打开时鲸鱼入口隐藏（不遮挡左上返回）',
  settings.initial.fabDisplay === 'none',
  `display=${settings.initial.fabDisplay}`,
);
check(
  '点菜单打开分区抽屉（左侧 320px 抽屉 + 遮罩 + inert 解除）',
  settings.menuTap.fired
    && settings.opened.navOpenClass
    && settings.opened.navVisibility === 'visible'
    && settings.opened.navInert === false
    && settings.opened.navPointerEvents === 'auto'
    && Boolean(settings.opened.navRect)
    && Math.abs(settings.opened.navRect.left) <= 1
    && Math.abs(settings.opened.navRect.width - 320) <= 1
    && settings.opened.backdropDisplay === 'block',
  `clicked=${settings.menuTap.fired}, open=${settings.opened.navOpenClass}, inert=${settings.opened.navInert}, nav=${formatRect(settings.opened.navRect)}, backdrop=${settings.opened.backdropDisplay}`,
);
check(
  '抽屉打开后左侧分区可命中',
  settings.navHitOpened,
  `hit=${settings.navHitOpened}`,
);
check(
  '点抽屉外只收起抽屉，不误触设置控件',
  settings.outsideHitIsBackdrop
    && !settings.afterOutsideTap.navOpenClass
    && settings.afterOutsideTap.optionsClicks === '0',
  `hitBackdrop=${settings.outsideHitIsBackdrop}, open=${settings.afterOutsideTap.navOpenClass}, clicks=${settings.afterOutsideTap.optionsClicks}`,
);
check(
  '收起抽屉后设置内容恢复可点',
  settings.optionsTap.fired && settings.afterContentTap.optionsClicks === '1',
  `clicked=${settings.optionsTap.fired}, clicks=${settings.afterContentTap.optionsClicks}`,
);
check(
  '点抽屉分区项：收起抽屉并切换 DSH 分区',
  settings.cellTap.fired
    && !settings.afterSectionTap.navOpenClass
    && settings.afterSectionTap.section === '1',
  `clicked=${settings.cellTap.fired}, open=${settings.afterSectionTap.navOpenClass}, section=${settings.afterSectionTap.section}`,
);
check(
  '点左上返回退出设置（走 DSH 原生 close 卸载 portal）',
  settings.backTap.fired
    && !settings.closed.overlayConnected
    && !settings.closed.barFound
    && !settings.closed.mobileClass
    && !settings.closed.navOpenClass,
  `clicked=${settings.backTap.fired}, overlay=${settings.closed.overlayConnected}, bar=${settings.closed.barFound}, mobileClass=${settings.closed.mobileClass}`,
);
check(
  '再次打开设置时手机壳重新装上',
  settings.reopened.barInjected
    && settings.reopened.mobileClass
    && rectCoversViewport(settings.reopened.panelRect, 390, 844),
  `bar=${settings.reopened.barInjected}, mobileClass=${settings.reopened.mobileClass}, rect=${formatRect(settings.reopened.panelRect)}`,
);
check(
  'DSH 重渲染换掉 nav 后：抽屉可开、点分区被放行并切到对应分区（缓存失效重解析）',
  settings.navReplaced.opened
    && settings.navReplaced.closed
    && settings.navReplaced.sectionAfterReplace === '2'
    && Math.abs(settings.navReplaced.navWidth - 320) <= 1,
  `opened=${settings.navReplaced.opened}, closed=${settings.navReplaced.closed}, section=${settings.navReplaced.sectionAfterReplace}, navWidth=${settings.navReplaced.navWidth}`,
);
check(
  '手机栏/遮罩被 DSH 重渲染移除后自动补装',
  settings.barReinjected.barInjected
    && settings.barReinjected.backdropInjected
    && settings.barReinjected.mobileClass
    && settings.barReinjected.backPresent,
  `bar=${settings.barReinjected.barInjected}, backdrop=${settings.barReinjected.backdropInjected}, mobileClass=${settings.barReinjected.mobileClass}, back=${settings.barReinjected.backPresent}`,
);
check(
  '设置关闭后鲸鱼入口恢复显示',
  settings.closed.fabDisplay !== 'none' && settings.closed.fabDisplay !== null,
  `fab display=${settings.closed.fabDisplay}`,
);
check(
  '设置打开期间流式 DOM 变更不触发全量 Document.querySelector（稳态零查询）',
  settings.settingsChurnQueryDelta === 0,
  `querySelector×${settings.settingsChurnQueryDelta} / 20 batches`,
);
check(
  'DSH 重渲染换掉 _header 后，左上返回仍能退出设置（close 缓存失效重解析）',
  settings.headerReplaced.clicked
    && !settings.headerReplaced.overlayConnected
    && !settings.headerReplaced.barFound,
  `clicked=${settings.headerReplaced.clicked}, overlay=${settings.headerReplaced.overlayConnected}, bar=${settings.headerReplaced.barFound}`,
);
check(
  '宽屏（1000×800）恢复 DSH 原生设置布局（无手机栏/抽屉）',
  settingsDesktop.viewport.width === 1000
    && !settingsDesktop.mobileClass
    && !settingsDesktop.barFound
    && settingsDesktop.panelPosition === 'relative'
    && Math.abs(settingsDesktop.panelRect.width - 800) <= 1
    && settingsDesktop.navPosition !== 'fixed'
    && settingsDesktop.navVisibility === 'visible',
  `viewport=${settingsDesktop.viewport.width}×${settingsDesktop.viewport.height}, mobileClass=${settingsDesktop.mobileClass}, panel=${settingsDesktop.panelRect.width}px ${settingsDesktop.panelPosition}, nav=${settingsDesktop.navPosition}/${settingsDesktop.navVisibility}`,
);
check(
  '从宽屏转回窄屏后设置重新装上手机壳（resize 补装）',
  settingsRemobile.mobileClass
    && settingsRemobile.barInjected
    && rectCoversViewport(settingsRemobile.panelRect, 390, 844),
  `mobileClass=${settingsRemobile.mobileClass}, bar=${settingsRemobile.barInjected}, rect=${formatRect(settingsRemobile.panelRect)}`,
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
