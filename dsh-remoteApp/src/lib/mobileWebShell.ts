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
      '@media (max-width: 760px) {',
      '  [class*="_sidebarCol"] {',
      '    position: fixed !important; left: 0 !important; top: 0 !important; bottom: 0 !important;',
      '    width: min(84vw, 340px) !important; max-width: 340px !important;',
      '    z-index: 9000 !important; transform: translateX(-102%);',
      '    transition: transform 220ms ease;',
      '    box-shadow: 24px 0 48px rgba(0,0,0,0.35);',
      '    background: #0b1220 !important; overflow: visible !important;',
      '  }',
      '  html.' + DRAWER_CLASS + ' [class*="_sidebarCol"] { transform: translateX(0) !important; }',
      // DSH 用 CSS grid（sidebar, center, rightbar）。sidebar 改为 fixed 后会脱离 grid，
      // 导致 center 落到 56px 的第一列（内容被挤成竖排）。手机端直接改成单列布局。
      '  [class*="_frame"] { display: block !important; }',
      '  [class*="_centerCol"] { width: 100% !important; height: 100% !important; }',
      '  [class*="_rightbarCol"] { display: none !important; }',
      '  html.' + DRAWER_CLASS + ' [class*="_centerCol"] { filter: brightness(0.72); }',
      '  .dsh-mobile-backdrop {',
      '    position: fixed; inset: 0; z-index: 8999; background: rgba(0,0,0,0.38);',
      '    opacity: 0; pointer-events: none; transition: opacity 200ms ease;',
      '  }',
      '  html.' + DRAWER_CLASS + ' .dsh-mobile-backdrop { opacity: 1; pointer-events: auto; }',
      '  .dsh-mobile-fab {',
      '    position: fixed; left: 12px; top: 12px; z-index: 9001;',
      '    width: 40px; height: 40px; border-radius: 12px;',
      '    border: 1px solid rgba(255,255,255,0.12);',
      '    background: rgba(17,26,44,0.94); color: #e6edf7;',
      '    font-size: 19px; line-height: 1;',
      '    display: flex; align-items: center; justify-content: center;',
      '    box-shadow: 0 4px 16px rgba(0,0,0,0.35);',
      '  }',
      '  html.' + DRAWER_CLASS + ' .dsh-mobile-fab { display: none !important; }',
      '}',
    ].join('\n');
    document.head.appendChild(style);

    var backdrop = document.createElement('div');
    backdrop.className = 'dsh-mobile-backdrop';
    var fab = document.createElement('button');
    fab.className = 'dsh-mobile-fab';
    fab.type = 'button';
    fab.setAttribute('aria-label', '打开侧栏');
    fab.textContent = '☰';
    fab.style.display = 'none';
    document.body.appendChild(backdrop);
    document.body.appendChild(fab);

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
      if (!isMobile()) { closeDrawer(); fab.style.display = 'none'; return; }
      fab.style.display = isOpen() ? 'none' : 'flex';
    }

    fab.addEventListener('click', function (event) {
      event.preventDefault(); event.stopPropagation(); openDrawer();
    });
    backdrop.addEventListener('click', function () { closeDrawer(); });

    // 侧栏内任意可交互项：导航/打开后自动收起抽屉。
    document.addEventListener('click', function (event) {
      if (!isOpen()) return;
      var target = event.target;
      if (!target) return;
      var bar = sidebar();
      if (!bar || !bar.contains(target)) return;
      if (target.closest('[class*="_toggle"]')) return;
      window.setTimeout(closeDrawer, 120);
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
      if (!document.body.contains(fab)) document.body.appendChild(fab);
      if (!document.body.contains(backdrop)) document.body.appendChild(backdrop);
      refresh();
    });
    observer.observe(document.body, { childList: true, subtree: false });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
`;
