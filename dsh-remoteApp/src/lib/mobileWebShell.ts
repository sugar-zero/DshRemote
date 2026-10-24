/**
 * mobileWebShell — 注入 DSH Web UI 的手机端外壳（iOS WKWebView / Android WebView）。
 *
 * 目标（用户反馈）：
 *  1. 桌面侧栏在手机上变成「负一屏」抽屉：默认隐藏，左侧悬浮按钮/边缘滑动打开；
 *  2. 点击会话、功能、设置等任意侧栏项后自动收起抽屉，避免"点两次"；
 *  3. 抽屉以覆盖层出现，不挤压内容区宽度。
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

  var DRAWER_CLASS = 'dsh-mobile-drawer-open';
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
      '  [class*="_frame"] { display: block !important; }',
      '  [class*="_centerCol"] { width: 100% !important; height: 100% !important; }',
      '  [class*="_rightbarCol"] { display: none !important; }',
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
      // 原生 DSH 的侧栏 toggle 会和鲸鱼入口重叠；保留我们的鲸鱼入口，隐藏同槽位的其它按钮。
      '  [data-slot="conversation.header.leading"] > :not(.dsh-mobile-native-trigger) { display: none !important; }',
      '}',
    ].join('\n');
    document.head.appendChild(style);

    function enforceViewport() {
      var meta = document.querySelector('meta[name="viewport"]');
      if (!meta) {
        meta = document.createElement('meta');
        meta.setAttribute('name', 'viewport');
        document.head.appendChild(meta);
      }
      meta.setAttribute(
        'content',
        'width=device-width, initial-scale=1, maximum-scale=1, minimum-scale=1, user-scalable=no, viewport-fit=cover'
      );
    }
    enforceViewport();
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
    function installNativeMark() {
      if (fab.dataset.nativeMark === '1') return;
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
    setTimeout(installNativeMark, 300);
    setTimeout(installNativeMark, 1200);

    // 把鲸鱼入口放进 DSH 原生 header leading 槽，跟随原生标题栏布局，避免悬浮/重叠。
    function placeTrigger() {
      var leading = document.querySelector('[data-slot="conversation.header.leading"]');
      if (!leading) {
        if (fab.parentElement !== document.body) document.body.appendChild(fab);
        fab.classList.add('dsh-mobile-native-trigger-fallback');
        return;
      }
      fab.classList.remove('dsh-mobile-native-trigger-fallback');
      if (fab.parentElement !== leading) leading.appendChild(fab);
      installNativeMark();
    }
    placeTrigger();
    setTimeout(placeTrigger, 300);
    setTimeout(placeTrigger, 1200);
    window.setInterval(placeTrigger, 1000);

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
    function refresh() {
      if (!isMobile()) { closeDrawer(); }
      if (fab.dataset.ready !== '1') fab.dataset.ready = '1';
    }

    fab.addEventListener('click', function (event) {
      event.preventDefault(); event.stopPropagation(); openDrawer();
    });
    backdrop.addEventListener('click', function () { closeDrawer(); });

    // 侧栏内点击后收起抽屉；工作区/文件夹行保持打开以展开列表。
    // 注意：会话行不做任何额外的自动点击 / React handler 调用，保持 DSH 原生行为。
    document.addEventListener('click', function (event) {
      if (!isOpen()) return;
      var target = event.target;
      if (!target) return;
      var bar = sidebar();
      if (bar && bar.contains(target)) {
        if (target.closest('[data-row-key^="workspace:"]')) return;
        closeDrawer();
        return;
      }
      if (target.closest('.dsh-mobile-native-trigger') || target.closest('.dsh-mobile-backdrop')) return;
      closeDrawer();
    }, true);

    // 左边缘右滑打开 / 抽屉上左滑关闭。
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
      if (!isOpen() && touchStartX < 24 && dx > 0) openDrawer();
      else if (isOpen() && dx < 0) closeDrawer();
    }, { passive: true });

    window.addEventListener('resize', refresh);
    refresh();

    // SPA 重渲染时保持注入节点存在。
    var observer = new MutationObserver(function () {
      if (!backdrop.isConnected) document.body.appendChild(backdrop);
      placeTrigger();
      refresh();
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
