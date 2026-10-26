/**
 * mobileWebShell — 注入 DSH Web UI 的手机端外壳（iOS WKWebView / Android WebView）。
 *
 * 目标（用户反馈）：
 *  1. 桌面侧栏在手机上变成「负一屏」抽屉：默认隐藏，左侧悬浮按钮/边缘滑动打开；
 *  2. 点击会话、功能、设置等任意侧栏项后自动收起抽屉，避免"点两次"；
 *  3. 抽屉以覆盖层出现，不挤压内容区宽度；
 *  4. 右侧栏（DSH sidebar-right 插件）在窄屏下由 DSH 自动以全屏呈现：打开时覆盖
 *     整个 WebView 视口，收起时不可见且不拦截聊天手势（之前整列 display:none，
 *     header 角落的展开按钮点了没反应）；
 *  5. 设置弹窗（DSH settings-general 的居中 modal）在手机上改为全屏：分区菜单
 *     （左 nav）变成离屏抽屉，内容区顶部有手机专用栏（左上返回 = 关闭设置、右侧
 *     菜单 = 打开抽屉）；点抽屉项/点抽屉外/左滑可收起抽屉。
 *  6. 外链（`<a target="_blank">` / `window.open` 的 http(s) 地址，如设置 → 账号与
 *     余额的「查询用量 / 充值 / 更多账号信息」、账号菜单「意见反馈」）通过桥交给
 *     App 打开（默认在 App 内嵌浏览器打开，等价桌面 DSH 的内嵌平台页；内嵌页里可
 *     一键切系统浏览器）。原生 WebView 没有新窗口能力，不拦截的话点击无反应。
 *
 * 关键：脚本通过 WKUserScript `.atDocumentStart` 注入，执行时 document.body 还不存在，
 * 因此必须等 DOMContentLoaded / body 可用后再初始化（之前版本在这里静默失败）。
 *
 * 选择器只用 DSH CSS Modules 类名的稳定后缀（如 _sidebarCol），不依赖哈希前缀。
 * 若 DSH 改版选择器失效，最坏退化为普通桌面侧栏，不影响页面加载。
 */

export const MOBILE_WEB_SHELL_JS = String.raw`
(function () {
  if (window.__dshMobileShellInstalled) return;
  window.__dshMobileShellInstalled = true;

  // --- DSH WebSocket liveness bridge -----------------------------------
  // The WebView is kept mounted for speed. When the host restarts, the DSH
  // page's /api/remote.mux WebSocket dies and the old page can stay black.
  // Report open/close to native so the shell can reload the page once.
  // No credentials or message contents are sent; only the socket URL/state.
  // 同一桥也用于「外链交给系统浏览器打开」（dsh-remote/open-external）。
  function notifyMtlsBridge(payload) {
    try {
      var text = JSON.stringify(payload);
      if (window.dshMtlsBridge && typeof window.dshMtlsBridge.postMessage === 'function') {
        window.dshMtlsBridge.postMessage(text);
      } else if (window.webkit && window.webkit.messageHandlers
        && window.webkit.messageHandlers.dshMtlsBridge) {
        window.webkit.messageHandlers.dshMtlsBridge.postMessage(text);
      } else if (window.ReactNativeWebView
        && typeof window.ReactNativeWebView.postMessage === 'function') {
        // react-native-webview 回退路径（非原生 mTLS View）也能收到桥消息。
        window.ReactNativeWebView.postMessage(text);
      }
    } catch (error) {
      // Bridge is optional (plain WebView / Expo Go).
    }
  }
  (function installWebSocketMonitor() {
    if (window.__dshWsMonitorInstalled) return;
    window.__dshWsMonitorInstalled = true;
    var NativeWebSocket = window.WebSocket;
    if (!NativeWebSocket) return;

    function WrappedWebSocket(url, protocols) {
      var socket = protocols === undefined
        ? new NativeWebSocket(url)
        : new NativeWebSocket(url, protocols);
      try {
        socket.addEventListener('open', function () {
          notifyMtlsBridge({ type: 'dsh-ws-open', url: String(url) });
        });
        socket.addEventListener('close', function (event) {
          notifyMtlsBridge({
            type: 'dsh-ws-close',
            url: String(url),
            code: event && event.code,
            reason: (event && event.reason) || ''
          });
        });
      } catch (error) {
        // Older WebViews may not support addEventListener on WebSocket.
      }
      return socket;
    }
    WrappedWebSocket.prototype = NativeWebSocket.prototype;
    WrappedWebSocket.CONNECTING = NativeWebSocket.CONNECTING;
    WrappedWebSocket.OPEN = NativeWebSocket.OPEN;
    WrappedWebSocket.CLOSING = NativeWebSocket.CLOSING;
    WrappedWebSocket.CLOSED = NativeWebSocket.CLOSED;
    window.WebSocket = WrappedWebSocket;
  })();

  var DRAWER_CLASS = 'dsh-mobile-drawer-open';
  var STYLE_ID = 'dsh-mobile-shell-style';
  // 设置弹窗（@deepseek-ai/dsh-client-ui-settings-general）在窄屏下的手机壳状态：
  //  - SETTINGS_MOBILE_CLASS：已装上手机专用顶栏（此时隐藏 DSH 原 header）；
  //  - SETTINGS_NAV_CLASS：分区菜单抽屉打开。
  // 设置弹窗根节点带 data-shortcut-modal="settings"（稳定属性，不依赖 CSS Modules 哈希）。
  var SETTINGS_PANEL_SELECTOR = '[data-shortcut-modal="settings"]';
  var SETTINGS_MOBILE_CLASS = 'dsh-settings-mobile';
  var SETTINGS_NAV_CLASS = 'dsh-settings-nav-open';
  var SETTINGS_BAR_CLASS = 'dsh-mobile-settings-bar';
  var SETTINGS_BACKDROP_CLASS = 'dsh-mobile-settings-backdrop';

  function init() {
    if (!document.body || !document.head) {
      setTimeout(init, 50);
      return;
    }
    if (document.getElementById(STYLE_ID)) return;

    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      'html, body { -webkit-text-size-adjust: 100% !important; touch-action: manipulation; }',
      // iOS 会在聚焦 <16px 的输入框时自动放大整页；统一到 16px 并锁 viewport。
      'input, textarea, select, [contenteditable="true"] { font-size: 16px !important; }',
      '@media (max-width: 760px) {',
      '  [class*="_sidebarCol"] {',
      '    position: fixed !important; left: 0 !important; top: 0 !important; bottom: 0 !important;',
      '    width: min(84vw, 280px) !important; max-width: 280px !important;',
      '    z-index: 9000 !important; transform: translateX(-102%);',
      '    transition: transform 220ms ease;',
      '    overflow: visible !important;',
      '    visibility: hidden; opacity: 0; pointer-events: none;',
      '    transition: transform 220ms ease, opacity 0s linear 220ms, visibility 0s linear 220ms;',
      '  }',
      '  html.' + DRAWER_CLASS + ' [class*="_sidebarCol"] { transform: translateX(0) !important; visibility: visible; opacity: 1; pointer-events: auto; transition: transform 220ms ease; }',
      // DSH 用 CSS grid（sidebar, center, rightbar）。sidebar 改为 fixed 后会脱离 grid，
      // 导致 center 落到 56px 的第一列（内容被挤成竖排）。手机端直接改成单列布局。
      // Release 构建的 App 会把这个 WebView 铺到屏幕底部（含 home indicator 区域）：
      // 在 DSH 页面容器里预留 safe-area 底部（背景用 DSH 主题色），输入框/正文就不会
      // 被 home indicator 压住，也不会出现 App 背景色的底部黑边。Debug 构建有底部
      // 信息条，WebView 不贴底，env() 自然为 0，不影响调试布局。
      '  [class*="_frame"] {',
      '    display: block !important;',
      '    box-sizing: border-box !important;',
      '    padding-bottom: env(safe-area-inset-bottom, 0px) !important;',
      '  }',
      '  [class*="_centerCol"] { width: 100% !important; height: 100% !important; }',
      // 右栏（@deepseek-ai/dsh-client-ui-sidebar-right）。frame 宽度 < 768px 时 DSH 让右栏
      // 自动全屏：面板本身是 position:absolute; top:0; bottom:0; right:0 + inline width:100vw，
      // 挂在 _rightbarCol 里。原来这里整列 display:none，于是会话 header 角落的「展开右栏」
      // 按钮点击后只会让按钮自己消失（expanded 后 ExpandButton 返回 null），全屏面板却被藏住
      // ——用户看到的就是“点了没反应/像开到了右边看不见”。
      // 窄屏下让列不生成盒子（display:contents）：面板的包含块上移到 _frame
      // （position:relative; height:100%），DSH 原生 fullscreen 几何（absolute + 100vw）
      // 正好铺满 WebView；收起态由 DSH 自己把内容 translateX(100vw) + visibility:hidden，
      // 面板自身 pointer-events:none，不拦截聊天手势。
      // 不要在这里加 z-index / transform / filter：会盖住 DSH 弹窗（body portal），或把
      // dockkit 的 position:fixed 浮动窗困在面板里。
      '  [class*="_rightbarCol"] { display: contents !important; }',
      '  .dsh-mobile-backdrop {',
      '    position: fixed; inset: 0; z-index: 8999; background: transparent;',
      '    opacity: 0; pointer-events: none; transition: opacity 200ms ease;',
      '  }',
      '  html.' + DRAWER_CLASS + ' .dsh-mobile-backdrop { opacity: 1; pointer-events: auto; }',
      '  .dsh-mobile-native-trigger {',
      '    position: static; flex: none; width: 32px; height: 30px; padding: 0; margin: 0 2px 0 0;',
      '    border: 0; background: transparent; color: inherit;',
      '    display: inline-flex; align-items: center; justify-content: center;',
      '    cursor: pointer; -webkit-tap-highlight-color: transparent;',
      '  }',
      '  .dsh-mobile-native-trigger svg { width: 22px; height: 22px; display: block; }',
      '  .dsh-mobile-native-trigger-fallback {',
      '    position: fixed !important; left: 10px; top: 8px; z-index: 9001;',
      '    width: 40px; height: 40px;',
      '  }',
      '  html.' + DRAWER_CLASS + ' .dsh-mobile-native-trigger { display: none !important; }',
      // 预留 header leading（左侧）槽位宽度：鲸鱼入口被 DSH 重渲染短暂移除时，
      // 该列不会从 34px 塌陷到 0，标题行也就不会先左移、再被我们的补挂脚本推回来。
      '  [data-slot="conversation.header.leading"] { min-width: 34px; min-height: 30px; box-sizing: border-box; }',
      // DSH 0.2.1-rc.3 的 conversation.header.leading 槽位没有任何内置注册项（asar 全量扫描
      // 只有 dsh-client-ui-conversation 引用），今天这条规则不会隐藏任何原生控件；
      // 保留是为了兼容以后在左侧槽位加按钮的 DSH 版本（避免和鲸鱼入口重叠）。
      '  [data-slot="conversation.header.leading"] > :not(.dsh-mobile-native-trigger) { display: none !important; }',
      // ── 设置弹窗（@deepseek-ai/dsh-client-ui-settings-general）：窄屏全屏 + 分区抽屉 ──
      // DSH 桌面端把设置做成居中 modal：panel 宽 800、左侧 nav 固定 188px、右侧内容。
      // 390px 宽的手机上 panel 被 max-width:calc(100vw - 48px) 压到 342px，减去 188px
      // 的 nav 后内容区只剩 ~154px：表单/说明全部挤成竖排（用户反馈「太局促」）。
      // 手机端改为：panel 铺满 WebView；nav 变成离屏抽屉（和左侧会话栏同一套交互习惯）；
      // 内容区顶部由注入的手机栏承担「左上返回关闭设置 + 菜单开抽屉」。
      // 只改布局/几何，不改 DSH 的分区渲染与关闭语义：返回按钮直接点 DSH 原生 close。
      // 所有覆盖都挂在 html.dsh-settings-mobile 下：注入失败时设置保持 DSH 原生
      // （顶栏在右上角、nav 内联）仍可使用，不会出现「抽屉入口没装上、菜单也没了」。
      '  html.' + SETTINGS_MOBILE_CLASS + ' [data-shortcut-modal="settings"] {',
      '    position: fixed !important; inset: 0 !important;',
      '    width: 100% !important; max-width: 100% !important;',
      '    height: 100% !important; max-height: 100% !important;',
      '    border-radius: 0 !important; box-shadow: none !important;',
      '  }',
      '  html.' + SETTINGS_MOBILE_CLASS + ' [data-shortcut-modal="settings"] > nav {',
      '    position: fixed !important; left: 0; top: 0; bottom: 0;',
      '    width: min(86vw, 320px) !important; max-width: 320px !important;',
      '    z-index: 6; padding-bottom: 20px !important;',
      '    background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base, #1b1c1e)) !important;',
      '    border-right: 1px solid var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.08));',
      '    box-shadow: 12px 0 32px rgba(0, 0, 0, 0.38);',
      '    transform: translateX(-103%); visibility: hidden; pointer-events: none;',
      '    transition: transform 220ms ease, visibility 0s linear 220ms;',
      '  }',
      '  html.' + SETTINGS_MOBILE_CLASS + '.' + SETTINGS_NAV_CLASS + ' [data-shortcut-modal="settings"] > nav {',
      '    transform: translateX(0); visibility: visible; pointer-events: auto; transition: transform 220ms ease;',
      '  }',
      // 抽屉遮罩：盖住内容区但保留抽屉可点；做成真实 DOM（伪元素会被 nav 的
      // transform 关进抽屉自己，铺不满视口），所以由注入脚本放进 panel。
      '  .' + SETTINGS_BACKDROP_CLASS + ' {',
      '    position: absolute; inset: 0; z-index: 5; display: none;',
      '    background: rgba(0, 0, 0, 0.42);',
      '  }',
      '  html.' + SETTINGS_NAV_CLASS + ' .' + SETTINGS_BACKDROP_CLASS + ' { display: block; }',
      // 装了手机栏之后才隐藏 DSH 原生 header（原生 close 仍在 DOM 里，返回按钮
      // 通过它触发 DSH 自己的 onClose；注入失败时 header 保留，设置仍可用）。
      '  html.' + SETTINGS_MOBILE_CLASS + ' [data-shortcut-modal="settings"] > div > [class*="_header"] { display: none !important; }',
      // 设置全屏时鲸鱼入口（可能因当前没有会话 header 而处于 fixed 兜底位置，z-index 比
      // 设置弹窗高）会盖住左上返回；设置页有自己的菜单入口，直接隐藏它。
      '  html.' + SETTINGS_MOBILE_CLASS + ' .dsh-mobile-native-trigger { display: none !important; }',
      '  .' + SETTINGS_BAR_CLASS + ' {',
      '    flex: none; box-sizing: border-box; height: 52px; padding: 6px;',
      '    display: flex; align-items: center; gap: 4px;',
      '    background: var(--dsw-alias-bg-base, #17181a);',
      '    border-bottom: 1px solid var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.08));',
      '  }',
      '  .' + SETTINGS_BAR_CLASS + '-title {',
      '    flex: 1 1 auto; min-width: 0; text-align: center;',
      '    font-size: 16px; font-weight: 600; line-height: 22px;',
      '    color: var(--dsw-alias-label-primary, #e6e6e6);',
      '    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;',
      '  }',
      '  .' + SETTINGS_BAR_CLASS + '-button {',
      '    flex: none; width: 40px; height: 40px; padding: 0; margin: 0;',
      '    display: inline-flex; align-items: center; justify-content: center;',
      '    border: 0; border-radius: 10px; background: transparent;',
      '    color: var(--dsw-alias-label-primary, #e6e6e6); cursor: pointer;',
      '    -webkit-tap-highlight-color: transparent;',
      '  }',
      '  .' + SETTINGS_BAR_CLASS + '-button:active { background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.08)); }',
      '  .' + SETTINGS_BAR_CLASS + '-button svg { width: 22px; height: 22px; display: block; }',
      '}',
    ].join('\n');
    document.head.appendChild(style);

    // 锁定的 viewport 内容。注意：iOS WebKit 在 <meta name=viewport> 的内容被重新
    // 赋值时会重新计算 viewport（可能触发一次整页重排 / 滚动位置归位），所以这里
    // *只在内容确实不同时才写*，避免“加载后再写 2 次”造成可见的跳动。
    var VIEWPORT_CONTENT = 'width=device-width, initial-scale=1, maximum-scale=1, minimum-scale=1, user-scalable=no, viewport-fit=cover';
    var viewportMeta = null;
    function enforceViewport() {
      if (!document.head) return;
      if (!viewportMeta || !viewportMeta.isConnected) {
        viewportMeta = document.head.querySelector('meta[name="viewport"]');
        if (!viewportMeta) {
          viewportMeta = document.createElement('meta');
          viewportMeta.setAttribute('name', 'viewport');
          document.head.appendChild(viewportMeta);
        }
      }
      if (viewportMeta.getAttribute('content') === VIEWPORT_CONTENT) return; // 相同就不写
      viewportMeta.setAttribute('content', VIEWPORT_CONTENT);
    }
    enforceViewport();
    // DSH 可能在水合后重建 <meta>：保留两次延迟兜底检查（内容相同时是纯读取，无副作用）。
    setTimeout(enforceViewport, 500);
    setTimeout(enforceViewport, 1500);

    var backdrop = document.createElement('div');
    backdrop.className = 'dsh-mobile-backdrop';
    var fab = document.createElement('button');
    fab.className = 'dsh-mobile-native-trigger';
    fab.type = 'button';
    fab.setAttribute('aria-label', '打开侧栏');
    document.body.appendChild(backdrop);
    document.body.appendChild(fab);

    // 使用 DSH 自己的鲸鱼 logo 作为抽屉入口（不另造悬浮汉堡）。
    // 只扫描一次；失败后按 1s 节流重试（之前每次 DOM 变更都会全量查 3 个选择器，
    // token 流式渲染时这个开销会明显增加主线程压力，造成画面卡顿/“跳”）。
    var markScannedAt = 0;
    function installNativeMark() {
      if (fab.dataset.nativeMark === '1') return;
      var now = Date.now();
      if (now - markScannedAt < 1000) return;
      markScannedAt = now;
      var source = document.querySelector('[class*="_railMark"]')
        || document.querySelector('[class*="_brandMark"]')
        || document.querySelector('[class*="_logoRow"] svg');
      if (!source) return;
      var node = source.tagName && source.tagName.toLowerCase() === 'svg'
        ? source.cloneNode(true)
        : source.querySelector('svg') && source.querySelector('svg').cloneNode(true);
      if (!node) return;
      fab.textContent = '';
      fab.appendChild(node);
      fab.dataset.nativeMark = '1';
    }
    installNativeMark();

    // 把鲸鱼入口放进 DSH 原生 header leading 槽，跟随原生标题栏布局，避免悬浮/重叠。
    // 槽位元素会被 DSH 在重渲染时替换，所以缓存引用 + isConnected 检查（O(1)），
    // 只有真的被移除时才重新查询 / 补挂，避免每个 mutation 都全量 querySelector。
    var leadingSlot = null;
    var leadingMissingSince = 0;
    var headerSlotSelector = '[data-slot="conversation.header.leading"]';

    function resolveLeadingSlot() {
      if (leadingSlot && leadingSlot.isConnected) return leadingSlot;
      leadingSlot = document.querySelector(headerSlotSelector);
      return leadingSlot;
    }

    function placeTrigger() {
      var slot = resolveLeadingSlot();
      if (!slot) {
        // 槽位暂时不存在（首屏 / 路由切换 / DSH 正在重建 header）：先不要立刻把按钮
        // 甩到 fixed 悬浮位置，否则槽位回来时按钮会在“头部内”和“左上角悬浮”之间来回跳。
        if (!leadingMissingSince) leadingMissingSince = Date.now();
        if (Date.now() - leadingMissingSince < 800) return;
        if (fab.parentElement !== document.body) document.body.appendChild(fab);
        fab.classList.add('dsh-mobile-native-trigger-fallback');
        return;
      }
      leadingMissingSince = 0;
      if (fab.classList.contains('dsh-mobile-native-trigger-fallback')) {
        fab.classList.remove('dsh-mobile-native-trigger-fallback');
      }
      // parentElement 判断是 O(1)：按钮已经在槽位里就什么都不做（不搬动 DOM → 不触发重排）。
      if (fab.parentElement !== slot) slot.appendChild(fab);
      installNativeMark();
    }
    placeTrigger();
    setTimeout(placeTrigger, 300);
    setTimeout(placeTrigger, 1200);
    // 低频兜底：MutationObserver 已经覆盖正常路径，这里 3s 一次只做 O(1) 检查，
    // 防止极端情况（observer 被 body 替换打断 / 脚本异常）下按钮永久丢失。
    window.setInterval(function () { installNativeMark(); placeTrigger(); }, 3000);

    function isMobile() { return window.innerWidth <= 760; }
    function sidebar() { return document.querySelector('[class*="_sidebarCol"]'); }
    function isOpen() { return document.documentElement.classList.contains(DRAWER_CLASS); }
    function closeDrawer() { document.documentElement.classList.remove(DRAWER_CLASS); }
    function openDrawer() {
      var bar = sidebar();
      if (bar) {
        var collapsed = bar.querySelector('[class*="_collapsed"]');
        var toggle = bar.querySelector('[class*="_toggle"]');
        if (collapsed && toggle) { try { toggle.click(); } catch (e) {} }
      }
      document.documentElement.classList.add(DRAWER_CLASS);
    }

    // ── 设置弹窗手机壳（窄屏全屏 + 分区菜单抽屉） ──────────────────────
    // 设置弹窗根节点带 data-shortcut-modal="settings"（DSH 稳定属性）。
    // DOM 契约（@deepseek-ai/dsh-client-ui-settings-general，0.2.1-rc.3）：
    //   [data-shortcut-modal=settings] > nav           分区菜单（_nav/_navTitle/_navList）
    //                                  > div           内容列（_header/_options）
    // 注入内容：content 最前面插一条手机栏（返回 + 标题 + 菜单），panel 末尾插抽屉遮罩。

    var ICON_BACK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>';
    var ICON_MENU = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>';

    var settingsPanel = null;
    var settingsNav = null;
    var settingsBar = null;
    var settingsBackdrop = null;
    var settingsMenuButton = null;
    var settingsCloseButton = null;

    function isSettingsNavOpen() {
      return document.documentElement.classList.contains(SETTINGS_NAV_CLASS);
    }
    // 抽屉收起时给 nav 加 inert：DSH useModalLayer 的焦点陷阱只过滤 [inert]/[hidden]，
    // 不过滤 visibility:hidden；iPad 外接键盘 Tab 不应落进看不见的分区按钮。
    // 旧 WebView 不支持 inert 时该属性被忽略，退回原行为。
    function setSettingsNavInert(inert) {
      if (!settingsNav || !settingsNav.isConnected) return;
      if (inert) settingsNav.setAttribute('inert', '');
      else settingsNav.removeAttribute('inert');
    }
    function closeSettingsNav() {
      if (!isSettingsNavOpen()) return;
      document.documentElement.classList.remove(SETTINGS_NAV_CLASS);
      setSettingsNavInert(true);
      if (settingsMenuButton) settingsMenuButton.setAttribute('aria-expanded', 'false');
    }
    function openSettingsNav() {
      if (!isMobile() || !settingsPanel || !settingsPanel.isConnected) return;
      if (!settingsNav || !settingsNav.isConnected) settingsNav = directChild(settingsPanel, 'NAV');
      setSettingsNavInert(false);
      document.documentElement.classList.add(SETTINGS_NAV_CLASS);
      if (settingsMenuButton) settingsMenuButton.setAttribute('aria-expanded', 'true');
    }

    function directChild(parent, tagName) {
      for (var i = 0; i < parent.children.length; i += 1) {
        if (parent.children[i].tagName === tagName) return parent.children[i];
      }
      return null;
    }
    function directChildWithClass(parent, suffix) {
      for (var i = 0; i < parent.children.length; i += 1) {
        var child = parent.children[i];
        if (typeof child.className === 'string' && child.className.indexOf(suffix) !== -1) return child;
      }
      return null;
    }
    function childButton(parent) {
      if (!parent) return null;
      for (var i = 0; i < parent.children.length; i += 1) {
        if (parent.children[i].tagName === 'BUTTON') return parent.children[i];
      }
      return null;
    }
    // 只在安装/关闭这种低频路径用稳定类名后缀找按钮，取不到时退回「第一个 button」。
    function childButtonWithClass(parent, suffix) {
      if (!parent) return null;
      for (var i = 0; i < parent.children.length; i += 1) {
        var child = parent.children[i];
        if (child.tagName !== 'BUTTON') continue;
        if (typeof child.className === 'string' && child.className.indexOf(suffix) !== -1) return child;
      }
      return null;
    }
    // 设置面板的内容列（panel 直系 div._content）；不依赖「panel 第一个 div」的顺序。
    function settingsContentOf(panel) {
      return directChildWithClass(panel, '_content') || directChild(panel, 'DIV');
    }
    function settingsCloseButtonOf(panel) {
      var content = settingsContentOf(panel);
      var header = content ? directChildWithClass(content, '_header') : null;
      return childButtonWithClass(header, '_close') || childButton(header);
    }

    // 退出设置：优先点 DSH 原生 close（走它自己的 onClose/store），失败再点遮罩 /
    // 发 Escape（DSH 的 useModalLayer 监听 Escape）。注入失败的兜底路径也靠这些。
    function closeSettingsDialog() {
      // DSH 重渲染可能整个换掉 _header：缓存失效时按稳定类名后缀重新解析一次。
      if ((!settingsCloseButton || !settingsCloseButton.isConnected) && settingsPanel && settingsPanel.isConnected) {
        settingsCloseButton = settingsCloseButtonOf(settingsPanel);
      }
      if (settingsCloseButton && settingsCloseButton.isConnected) {
        try { settingsCloseButton.click(); return; } catch (error) { /* 继续兜底 */ }
      }
      if (settingsPanel && settingsPanel.parentElement) {
        var mask = directChildWithClass(settingsPanel.parentElement, '_mask');
        if (mask) { try { mask.click(); return; } catch (error) { /* 继续兜底 */ } }
      }
      try {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      } catch (error) { /* 旧 WebView 不支持构造 KeyboardEvent */ }
    }

    function teardownSettingsShell() {
      closeSettingsNav();
      // 恢复 DSH 原状（inert 是注入壳加的）。
      if (settingsNav && settingsNav.isConnected) settingsNav.removeAttribute('inert');
      if (settingsBar && settingsBar.parentElement) settingsBar.parentElement.removeChild(settingsBar);
      if (settingsBackdrop && settingsBackdrop.parentElement) settingsBackdrop.parentElement.removeChild(settingsBackdrop);
      document.documentElement.classList.remove(SETTINGS_MOBILE_CLASS);
      settingsPanel = null;
      settingsNav = null;
      settingsBar = null;
      settingsBackdrop = null;
      settingsMenuButton = null;
      settingsCloseButton = null;
    }

    /**
     * 给 DSH 设置弹窗装手机壳：内容区顶部插入手机栏，nav 靠 CSS 变抽屉。
     * 只在窄屏且能识别出 nav/content 时生效；识别不了就保持 DSH 原生布局（可退）。
     */
    function installSettingsShell(panel) {
      if (!isMobile() || !panel || !panel.isConnected) return;
      var nav = directChild(panel, 'NAV');
      var content = settingsContentOf(panel);
      if (!nav || !content) return;
      // 设置已经盖住整屏，会话侧栏抽屉不应再叠一层。
      closeDrawer();
      teardownSettingsShell();
      settingsPanel = panel;
      settingsNav = nav;
      setSettingsNavInert(true);

      var navTitle = directChildWithClass(nav, '_navTitle');
      var titleText = navTitle && navTitle.textContent
        ? navTitle.textContent.replace(/\s+/g, ' ').trim()
        : '';
      settingsCloseButton = settingsCloseButtonOf(panel);

      var bar = document.createElement('div');
      bar.className = SETTINGS_BAR_CLASS;

      var back = document.createElement('button');
      back.type = 'button';
      back.className = SETTINGS_BAR_CLASS + '-button dsh-mobile-settings-back';
      back.setAttribute('aria-label', '返回');
      back.innerHTML = ICON_BACK;
      back.addEventListener('click', function (event) {
        event.preventDefault(); event.stopPropagation();
        closeSettingsDialog();
      });

      var title = document.createElement('span');
      title.className = SETTINGS_BAR_CLASS + '-title';
      title.textContent = titleText || '设置';

      var menu = document.createElement('button');
      menu.type = 'button';
      menu.className = SETTINGS_BAR_CLASS + '-button dsh-mobile-settings-menu';
      menu.setAttribute('aria-label', '设置菜单');
      menu.setAttribute('aria-expanded', 'false');
      menu.innerHTML = ICON_MENU;
      menu.addEventListener('click', function (event) {
        event.preventDefault(); event.stopPropagation();
        if (isSettingsNavOpen()) closeSettingsNav(); else openSettingsNav();
      });

      bar.appendChild(back);
      bar.appendChild(title);
      bar.appendChild(menu);

      var backdropEl = document.createElement('div');
      backdropEl.className = SETTINGS_BACKDROP_CLASS;
      backdropEl.addEventListener('click', function (event) {
        event.preventDefault(); event.stopPropagation();
        closeSettingsNav();
      });

      // bar 插到 content 最前面（content 是纵向 flex：bar / header(隐藏) / options），
      // 这样 options 的高度/滚动仍由 DSH 自己管理，不用覆盖它的 overflow/padding。
      content.insertBefore(bar, content.firstChild);
      panel.appendChild(backdropEl);

      settingsBar = bar;
      settingsBackdrop = backdropEl;
      settingsMenuButton = menu;
      document.documentElement.classList.add(SETTINGS_MOBILE_CLASS);
      closeSettingsNav();
    }

    /**
     * 手机壳是否完整：mobile 状态类 + 手机栏 + 遮罩都在。
     * DSH 重渲染理论上可能单独换掉其中某个节点；这里全是 O(1) 检查，
     * 高频 mutation 路径上也能安全调用（不 querySelector）。
     */
    function settingsShellIntact() {
      return Boolean(
        settingsBar && settingsBar.isConnected
        && settingsBackdrop && settingsBackdrop.isConnected
        && document.documentElement.classList.contains(SETTINGS_MOBILE_CLASS)
      );
    }

    /**
     * 设置弹窗的增删同步（MutationObserver 高频路径）。
     * - 已装（panel 已缓存）：只做 O(1) isConnected 检查，绝不 querySelector
     *   （token 流式渲染时每批 mutation 都会进来，必须保持零查询）；
     * - 未装：只在「直接加到 document.body 的节点」里找设置 portal，命中才安装。
     */
    function syncSettingsFromMutations(records) {
      if (settingsPanel) {
        if (!settingsPanel.isConnected || !isMobile()) {
          // 同一个 mutation 批次里可能「旧 panel 移除 + 新 panel 加上」，清理后继续往下找。
          teardownSettingsShell();
        } else {
          if (!settingsShellIntact()) installSettingsShell(settingsPanel);
          return;
        }
      }
      if (!isMobile()) return;
      for (var i = 0; i < records.length; i += 1) {
        var record = records[i];
        if (record.target !== document.body) continue;
        var added = record.addedNodes;
        for (var j = 0; j < added.length; j += 1) {
          var node = added[j];
          if (!node || node.nodeType !== 1) continue;
          var panel = null;
          if (node.getAttribute && node.getAttribute('data-shortcut-modal') === 'settings') panel = node;
          else if (node.querySelector) panel = node.querySelector(SETTINGS_PANEL_SELECTOR);
          if (panel) { installSettingsShell(panel); return; }
        }
      }
    }

    /** 低频路径（init / resize / pageshow）：设置已经开着时补装一次。 */
    function syncSettingsPresent() {
      if (!isMobile()) {
        if (settingsPanel) teardownSettingsShell();
        return;
      }
      if (settingsPanel && settingsPanel.isConnected) {
        if (!settingsShellIntact()) installSettingsShell(settingsPanel);
        return;
      }
      if (settingsPanel) teardownSettingsShell();
      var panel = document.querySelector(SETTINGS_PANEL_SELECTOR);
      if (panel) installSettingsShell(panel);
    }

    function refresh() {
      if (!isMobile()) {
        closeDrawer();
        teardownSettingsShell();
      } else {
        syncSettingsPresent();
      }
      if (fab.dataset.ready !== '1') fab.dataset.ready = '1';
    }

    fab.addEventListener('click', function (event) {
      event.preventDefault(); event.stopPropagation(); openDrawer();
    });
    backdrop.addEventListener('click', function () { closeDrawer(); });

    // 侧栏内点击后收起抽屉；工作区/文件夹行保持打开以展开列表。
    // 注意：会话行不做任何额外的自动点击 / React handler 调用，保持 DSH 原生行为。
    document.addEventListener('click', function (event) {
      var target = event.target;
      if (!target) return;
      // 设置页的分区抽屉优先：点抽屉项 → 收起并放行（让 DSH 切分区）；
      // 点抽屉外 → 收起并吞掉这次点击，避免误触下面的设置项。
      if (settingsPanel && settingsPanel.isConnected && isSettingsNavOpen()) {
        // DSH 重渲染可能换掉 nav 节点：缓存失效时按直系子节点重新解析（点击时才做，O(1)）。
        if (!settingsNav || !settingsNav.isConnected) settingsNav = directChild(settingsPanel, 'NAV');
        if (settingsNav && settingsNav.contains(target)) {
          if (target.closest && target.closest('button')) closeSettingsNav();
          return;
        }
        if (target.closest && target.closest('.' + SETTINGS_BAR_CLASS)) return;
        closeSettingsNav();
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (!isOpen()) return;
      var bar = sidebar();
      if (bar && bar.contains(target)) {
        // 侧栏内「展开类」控件不收起抽屉：工作区行（展开/收起会话列表）以及
        // 「展开其余 N 个会话 / 收起」按钮（data-row-key="overflow:<group>"）。
        // 它们只是展开侧栏内容，不是导航；点一下就把抽屉关掉会看不到展开结果。
        if (target.closest('[data-row-key^="workspace:"]')
          || target.closest('[data-row-key^="overflow:"]')) return;
        closeDrawer();
        return;
      }
      if (target.closest('.dsh-mobile-native-trigger') || target.closest('.dsh-mobile-backdrop')) return;
      closeDrawer();
    }, true);

    // ── 外链交给系统浏览器 ──────────────────────────────────────────────
    // DSH 里不少入口是 <a target="_blank"> 或 window.open(...)（设置 → 账号与余额的
    // 查询用量 / 充值 / 更多账号信息，账号菜单的意见反馈等）。原生 WKWebView/WebView
    // 没有新窗口能力（iOS 没有 WKUIDelegate，Android setSupportMultipleWindows(false)），
    // 点击会被 WebKit 直接丢弃，表现为「完全没反应」。这里把 http(s) 外链通过桥交给
    // App，用系统浏览器打开；隧道主机自身的链接保持原样（外部浏览器没有设备证书）。
    function externalHttpUrlOf(rawHref) {
      if (typeof rawHref !== 'string' || rawHref === '') return '';
      var url = null;
      try { url = new URL(rawHref, window.location.href); } catch (error) { return ''; }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
      // 同主机名（含不同端口）都算隧道内地址，不交给系统浏览器。
      if (window.location.hostname && url.hostname === window.location.hostname) return '';
      if (window.location.origin && window.location.origin !== 'null'
        && url.origin === window.location.origin) return '';
      return url.href;
    }
    function reportExternalUrl(url) {
      notifyMtlsBridge({ type: 'dsh-remote/open-external', url: url });
    }
    document.addEventListener('click', function (event) {
      var target = event.target;
      if (!target || !target.closest) return;
      var anchor = null;
      try { anchor = target.closest('a[href]'); } catch (error) { anchor = null; }
      if (!anchor || anchor.hasAttribute('download')) return;
      var url = externalHttpUrlOf(anchor.getAttribute('href') || anchor.href || '');
      if (!url) return;
      event.preventDefault();
      event.stopPropagation();
      reportExternalUrl(url);
    }, true);
    // window.open 的外链（如账号菜单「意见反馈」）：原生 WebView 同样打不开新窗口。
    var nativeWindowOpen = window.open;
    window.open = function (url) {
      var raw = typeof url === 'string' ? url : '';
      var external = externalHttpUrlOf(raw);
      if (external) {
        reportExternalUrl(external);
        return null;
      }
      try {
        return nativeWindowOpen ? nativeWindowOpen.apply(window, arguments) : null;
      } catch (error) {
        return null;
      }
    };

    // 左边缘右滑打开 / 抽屉上左滑关闭（设置页的分区抽屉沿用同一手势）。
    var touchStartX = 0;
    var touchStartY = 0;
    document.addEventListener('touchstart', function (event) {
      var touch = event.touches && event.touches[0];
      if (!touch) return;
      touchStartX = touch.clientX;
      touchStartY = touch.clientY;
    }, { passive: true });
    document.addEventListener('touchend', function (event) {
      var touch = event.changedTouches && event.changedTouches[0];
      if (!touch || !isMobile()) return;
      var dx = touch.clientX - touchStartX;
      var dy = touch.clientY - touchStartY;
      if (Math.abs(dx) < 60 || Math.abs(dy) > 80) return;
      if (settingsPanel && settingsPanel.isConnected) {
        if (!isSettingsNavOpen() && touchStartX < 24 && dx > 0) openSettingsNav();
        else if (isSettingsNavOpen() && dx < 0) closeSettingsNav();
        return;
      }
      if (!isOpen() && touchStartX < 24 && dx > 0) openDrawer();
      else if (isOpen() && dx < 0) closeDrawer();
    }, { passive: true });

    window.addEventListener('resize', refresh);
    // iOS 后台会暂停定时器；回到前台 / bfcache 恢复后补一次，避免按钮或状态“丢一次”。
    window.addEventListener('pageshow', function () { installNativeMark(); placeTrigger(); refresh(); });
    refresh();

    // SPA 重渲染时保持注入节点存在。
    // 高频路径（DSH 流式输出 token / 渲染会话历史时）走 O(1) 快路径：按钮仍在缓存的
    // 槽位里就直接返回——不 querySelector、不写 DOM，避免每个 mutation 批次都触发重排。
    // 只有在按钮/背景层真的被 DSH 移除后才补挂（同步执行，赶在下一帧绘制前修好）。
    var observer = new MutationObserver(function (records) {
      // 设置弹窗先同步：已装时只有 O(1) 检查；未装时只扫 body 的 addedNodes。
      syncSettingsFromMutations(records);
      if (
        backdrop.isConnected
        && fab.dataset.nativeMark === '1'
        && leadingSlot
        && leadingSlot.isConnected
        && fab.parentElement === leadingSlot
      ) {
        return;
      }
      if (!backdrop.isConnected && document.body) document.body.appendChild(backdrop);
      placeTrigger();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
`;
