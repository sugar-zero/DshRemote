/**
 * mobileWebShell — 注入 DSH Web UI 的手机端外壳（iOS WKWebView / Android WebView）。
 *
 * 适配的 DSH 版本：**0.2.2 及以上**（真机验证基线 0.2.2-rc.2，2026-11-16）。
 * 0.2.1 及更早没有原生窄屏侧栏/设置布局，不在本壳支持范围内。
 *
 * 目标（用户反馈）：
 *  1. 窄屏侧栏抽屉交给 DSH 原生实现：DSH 0.2.2 起 frame 会带 `data-sidebar-drawer`，
 *     `_sidebarCol` 由 DSH 自己改成绝对定位 + 遮罩，左上角也有原生入口
 *     `[data-sidebar-opener]`。本壳**不再自绘抽屉**，也不要覆盖它的 position /
 *     transform / visibility / opacity / pointer-events —— 一旦覆盖，原生入口打开
 *     抽屉时就会变成「画面变暗、抽屉透明、点不动」。
 *  2. 右侧栏（DSH sidebar-right 插件）在窄屏下由 DSH 自动以全屏呈现：打开时覆盖
 *     整个 WebView 视口，收起时不可见且不拦截聊天手势（之前整列 display:none，
 *     header 角落的展开按钮点了没反应）；
 *  3. 设置弹窗也交给 DSH 原生布局：DSH 0.2.2 起 settings-general 自带窄屏全屏布局
 *     （`@media (width<=767px)`：整屏 panel + 顶部标题/关闭 + 横向分区条）。本壳
 *     **不再注入手机栏/分区抽屉**，也就不会和原生返回/关闭按钮抢位置、把分区挤成
 *     一排（2026-11-16 真机回归）。
 *  4. 外链（`<a target="_blank">` / `window.open` 的 http(s) 地址，如设置 → 账号与
 *     余额的「查询用量 / 充值 / 更多账号信息」、账号菜单「意见反馈」）通过桥交给
 *     App 打开（默认在 App 内嵌浏览器打开，等价桌面 DSH 的内嵌平台页；内嵌页里可
 *     一键切系统浏览器）。原生 WebView 没有新窗口能力，不拦截的话点击无反应。
 *  5. 隐藏「在主机本机打开」类入口：DSH `open-in-app` 的打开工作区/显示文件位置控件
 *     （按稳定 data-* 属性），以及工作区分区的「添加工作区」＋按钮（原生目录选择会在
 *     主机上弹文件夹对话框）。都只隐藏控件本身，不隐藏容器/插槽。
 *
 * 关键：脚本通过 WKUserScript `.atDocumentStart` 注入，执行时 document.body 还不存在，
 * 因此必须等 DOMContentLoaded / body 可用后再初始化（之前版本在这里静默失败）。
 *
 * 选择器只用 DSH CSS Modules 类名的稳定后缀（如 _frame / _rightbarCol），不依赖哈希前缀。
 * 若 DSH 改版选择器失效，最坏退化为 DSH 原生桌面布局，不影响页面加载。
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

  var STYLE_ID = 'dsh-mobile-shell-style';
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
      // 窄屏抽屉交给 DSH 原生实现（0.2.2 起）：frame 带 data-sidebar-drawer，
      // _sidebarCol 由 DSH 自己改成绝对定位并配遮罩。这里**不要**再给它设
      // position / transform / visibility / opacity / pointer-events：
      // 那会让原生入口打开抽屉时变成「画面变暗、抽屉透明、点不动」。
      // Release 构建的 App 会把这个 WebView 铺到屏幕底部（含 home indicator 区域）：
      // 在 DSH 页面容器里预留 safe-area 底部（背景用 DSH 主题色），输入框/正文就不会
      // 被 home indicator 压住，也不会出现 App 背景色的底部黑边。Debug 构建有底部
      // 信息条，WebView 不贴底，env() 自然为 0，不影响调试布局。
      '  [class*="_frame"] {',
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
      '}',
      // ── 隐藏「在主机本机打开」控件（@deepseek-ai/dsh-client-ui-open-in-app） ──
      // 该插件在会话 header utilities、右栏文件 tab 等位置渲染「打开 / 在文件夹中显示」
      // 的 split 控件，点击会在**主机**的 Finder / 默认应用里打开——对 App 来说既无意义
      // 又占位，还可能误触后长时间无反馈。规则**不放进窄屏 @media**：手机和 iPad 上这个
      // 动作都发生在主机本机，所有 App WebView 宽度都应隐藏（桌面 DSH 浏览器不受影响，
      // 因为本壳只注入 App 的 WebView）。
      // 属性来自已安装 DSH（0.2.1-rc.3）OpenTargetButton.js 的稳定 data-* 契约：
      //   [data-open-target="directory"|"file"]    split 控件根（带边框与菜单锚点）
      //   [data-open-path-open] / [data-open-path-more] / [data-open-path-unpreviewable]
      //                                           主按钮 / 下拉箭头
      //   [data-open-target-skeleton]              加载骨架
      // 只隐藏命中这些属性的元素，不隐藏整个 [data-slot]：同一槽位还挂着其它插件按钮。
      '[data-open-target],',
      '[data-open-path-open],',
      '[data-open-path-more],',
      '[data-open-path-unpreviewable],',
      '[data-open-target-skeleton] { display: none !important; }',
      // ── 隐藏「添加工作区」（@deepseek-ai/dsh-client-ui-workspace 的 workspace.add） ──
      // 这个 ＋ 按钮走「原生目录选择」流程（dsh-client-ui-directory-picker-native），
      // 点下去是在**主机**弹 Finder/文件夹对话框、由主机端选目录；手机上看不到也选不了，
      // 属于「在主机本机打开」同类的无效入口，隐藏。按钮本身没有 data-*，用它的
      // aria-label（zh/en 两套内置文案）精确命中；不隐藏任何容器/整段工作区列表。
      '[aria-label="添加工作区"],',
      '[aria-label="Add workspace"] { display: none !important; }',
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

  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
`;
