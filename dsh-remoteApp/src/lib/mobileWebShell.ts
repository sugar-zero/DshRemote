/**
 * mobileWebShell — 注入 DSH Web UI 的手机端外壳（iOS WKWebView / Android WebView）。
 *
 * 目标（用户反馈）：
 *  1. 桌面侧栏在手机上变成「负一屏」抽屉：默认隐藏，左侧悬浮按钮/边缘滑动打开；
 *  2. 点击会话、功能、设置等任意侧栏项后自动收起抽屉，避免"点两次"；
 *  3. 抽屉以覆盖层出现，不挤压内容区宽度。
 *
 * 实现方式：CSS 覆盖 + 轻量 DOM 脚本（不依赖 DSH 内部 React 状态/类名哈希，
 * 只用 CSS Modules 类名的稳定后缀匹配）。若 DSH 后续改版导致选择器失效，
 * 最坏退化为普通桌面侧栏，不会影响 WebView 正常加载。
 */

function mobileWebShellRuntime(): void {
  const html = document.documentElement;
  const DRAWER_CLASS = 'dsh-mobile-drawer-open';
  const STYLE_ID = 'dsh-mobile-shell-style';

  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    @media (max-width: 760px) {
      [class*="_sidebarCol"] {
        position: fixed !important;
        left: 0 !important;
        top: 0 !important;
        bottom: 0 !important;
        width: min(84vw, 340px) !important;
        max-width: 340px !important;
        z-index: 9000 !important;
        transform: translateX(-102%);
        transition: transform 220ms ease;
        box-shadow: 24px 0 48px rgba(0,0,0,0.35);
        background: #0b1220 !important;
        overflow: visible !important;
      }
      html.${DRAWER_CLASS} [class*="_sidebarCol"] {
        transform: translateX(0) !important;
      }
      html.${DRAWER_CLASS} [class*="_centerCol"] {
        filter: brightness(0.72);
      }
      .dsh-mobile-backdrop {
        position: fixed; inset: 0; z-index: 8999;
        background: rgba(0,0,0,0.38);
        opacity: 0; pointer-events: none;
        transition: opacity 200ms ease;
      }
      html.${DRAWER_CLASS} .dsh-mobile-backdrop { opacity: 1; pointer-events: auto; }
      .dsh-mobile-fab {
        position: fixed; left: 12px; top: 12px; z-index: 9001;
        width: 40px; height: 40px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.12);
        background: rgba(17,26,44,0.94); color: #e6edf7; font-size: 19px; line-height: 1;
        display: flex; align-items: center; justify-content: center;
        box-shadow: 0 4px 16px rgba(0,0,0,0.35);
      }
      html.${DRAWER_CLASS} .dsh-mobile-fab { display: none !important; }
    }
  `;
  document.head.appendChild(style);

  const backdrop = document.createElement('div');
  backdrop.className = 'dsh-mobile-backdrop';
  const fab = document.createElement('button');
  fab.className = 'dsh-mobile-fab';
  fab.type = 'button';
  fab.setAttribute('aria-label', '打开侧栏');
  fab.textContent = '☰';
  fab.style.display = 'none';
  document.body.appendChild(backdrop);
  document.body.appendChild(fab);

  const isMobile = () => window.innerWidth <= 760;
  const sidebar = () => document.querySelector('[class*="_sidebarCol"]') as HTMLElement | null;
  const isOpen = () => html.classList.contains(DRAWER_CLASS);

  function closeDrawer(): void {
    html.classList.remove(DRAWER_CLASS);
  }

  function openDrawer(): void {
    const bar = sidebar();
    if (bar) {
      // DSH 侧栏初始可能是折叠图标栏；打开抽屉时模拟点击它自己的展开按钮。
      const collapsed = bar.querySelector('[class*="_collapsed"]');
      const toggle = bar.querySelector('[class*="_toggle"]') as HTMLElement | null;
      if (collapsed && toggle) {
        try { toggle.click(); } catch { /* ignore */ }
      }
    }
    html.classList.add(DRAWER_CLASS);
  }

  function toggleDrawer(): void {
    if (isOpen()) closeDrawer();
    else openDrawer();
  }

  fab.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); openDrawer(); });
  backdrop.addEventListener('click', () => closeDrawer());

  // 侧栏内任意可交互项：跳转/打开后自动收起抽屉。
  document.addEventListener('click', (event) => {
    if (!isOpen()) return;
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const bar = sidebar();
    if (!bar || !bar.contains(target)) return;
    if (target.closest('[class*="_toggle"]')) return;
    window.setTimeout(closeDrawer, 120);
  }, true);

  // 左边缘右滑打开 / 抽屉上左滑关闭。
  let touchStartX = 0;
  let touchStartY = 0;
  document.addEventListener('touchstart', (event) => {
    const touch = event.touches[0];
    if (!touch) return;
    touchStartX = touch.clientX;
    touchStartY = touch.clientY;
  }, { passive: true });
  document.addEventListener('touchend', (event) => {
    const touch = event.changedTouches[0];
    if (!touch || !isMobile()) return;
    const dx = touch.clientX - touchStartX;
    const dy = touch.clientY - touchStartY;
    if (Math.abs(dx) < 60 || Math.abs(dy) > 80) return;
    if (!isOpen() && touchStartX < 24 && dx > 0) openDrawer();
    else if (isOpen() && dx < 0) closeDrawer();
  }, { passive: true });

  const refresh = () => {
    if (!isMobile()) { closeDrawer(); fab.style.display = 'none'; return; }
    fab.style.display = isOpen() ? 'none' : 'flex';
  };
  window.addEventListener('resize', refresh);
  refresh();

  // SPA 会重渲染 sidebar/body；确保注入节点仍在。
  const observer = new MutationObserver(() => {
    if (!document.body.contains(fab)) document.body.appendChild(fab);
    if (!document.body.contains(backdrop)) document.body.appendChild(backdrop);
    refresh();
  });
  observer.observe(document.body, { childList: true, subtree: false });
}

/** 传给 native/RN WebView 的 `injectedJavaScript`。 */
export const MOBILE_WEB_SHELL_JS = `(${mobileWebShellRuntime.toString()})();`;
