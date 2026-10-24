/**
 * mobileSessionBridge — 供原生会话列表使用的页面内桥。
 *
 * 职责：
 *  1. 在 DSH 侧栏里读取工作区/会话条目，postMessage 给原生（iOS WKWebView
 *     window.webkit.messageHandlers.dshMtlsBridge / Android dshMtlsBridge）；
 *  2. 接收原生命令：openSession / newSession / openSidebar；
 *  3. 会话行直接调用 DSH React 自己的 onClick（__reactProps$*），不依赖
 *     WKWebView 对合成 click 的信任判断。
 *
 * 这段脚本只在 ?dsh_mobile=1 的 WebView 里运行；DSH 本体文件不改。
 */

export const MOBILE_SESSION_BRIDGE_JS = String.raw`
(function () {
  if (window.__dshSessionBridgeInstalled) return;
  window.__dshSessionBridgeInstalled = true;

  var lastSignature = '';
  var sendTimer = null;
  var wideClickAt = 0;

  function bridgePost(payload) {
    var text = JSON.stringify(payload);
    try {
      if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.dshMtlsBridge) {
        window.webkit.messageHandlers.dshMtlsBridge.postMessage(text);
        return;
      }
    } catch (e) {}
    try {
      if (window.dshMtlsBridge && typeof window.dshMtlsBridge.postMessage === 'function') {
        window.dshMtlsBridge.postMessage(text);
        return;
      }
    } catch (e) {}
    try {
      if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(text);
    } catch (e) {}
  }

  function cleanText(el) {
    return (el && el.textContent ? el.textContent : '').replace(/\s+/g, ' ').trim();
  }

  function firstLine(el) {
    return cleanText(el);
  }

  function titleOf(el) {
    var titleNode = el.querySelector('[class*="_title"]');
    var title = cleanText(titleNode);
    if (title) return title;
    return cleanText(el).slice(0, 120);
  }

  function collectSessions() {
    var rows = Array.prototype.slice.call(document.querySelectorAll('[data-row-key]'));
    var workspace = '';
    var sessions = [];
    rows.forEach(function (el) {
      var key = el.getAttribute('data-row-key') || '';
      if (key.indexOf('workspace:') === 0) {
        workspace = firstLine(el);
        return;
      }
      if (key.indexOf('session:') !== 0) return;
      var timeNode = el.querySelector('[class*="_time"]');
      sessions.push({
        id: key.slice('session:'.length),
        title: titleOf(el) || '未命名会话',
        time: cleanText(timeNode),
        workspace: workspace,
        selected: el.getAttribute('aria-selected') === 'true'
      });
    });
    return sessions;
  }

  function sendSessions() {
    var sessions = collectSessions();
    var signature = JSON.stringify(sessions.map(function (s) {
      return [s.id, s.title, s.time, s.workspace, s.selected].join('|');
    }));
    if (signature === lastSignature) return;
    lastSignature = signature;
    bridgePost({ type: 'sessions', sessions: sessions });
  }

  // DSH 折叠时不会渲染“宽版”会话列表；自动展开一次（CSS 已把侧栏移出屏幕）。
  function ensureWideSidebar() {
    var bar = document.querySelector('[class*="_sidebarCol"]');
    if (!bar) return;
    var collapsed = bar.querySelector('[class*="_collapsed"]');
    if (!collapsed) return;
    if (Date.now() - wideClickAt < 2500) return;
    var toggle = bar.querySelector('[class*="_toggle"]');
    if (!toggle) return;
    wideClickAt = Date.now();
    try { toggle.click(); } catch (e) {}
  }

  function tick() {
    ensureWideSidebar();
    sendSessions();
  }

  function sessionRow(id) {
    var exact = document.querySelector('[data-row-key="session:' + id + '"]');
    if (exact) return exact;
    var rows = document.querySelectorAll('[data-row-key^="session:"]');
    for (var i = 0; i < rows.length; i += 1) {
      if ((rows[i].getAttribute('data-row-key') || '').slice('session:'.length) === id) return rows[i];
    }
    return null;
  }

  function callReactHandler(el) {
    try {
      var key = Object.keys(el).filter(function (k) { return k.indexOf('__reactProps$') === 0; })[0];
      if (key && el[key] && typeof el[key].onClick === 'function') {
        el[key].onClick({});
        return true;
      }
    } catch (e) {}
    return false;
  }

  function openSession(id) {
    var row = sessionRow(id);
    if (!row) { bridgePost({ type: 'error', action: 'openSession', message: 'session row not found' }); return false; }
    var ok = callReactHandler(row);
    if (!ok) {
      try { row.click(); ok = true; } catch (e) { ok = false; }
    }
    bridgePost({ type: 'opened', id: id, ok: ok });
    return ok;
  }

  function newSession() {
    var btn = document.querySelector('[class*="_newSession"]');
    if (!btn) { bridgePost({ type: 'error', action: 'newSession', message: 'new session button not found' }); return false; }
    var ok = callReactHandler(btn);
    if (!ok) { try { btn.click(); ok = true; } catch (e) { ok = false; } }
    bridgePost({ type: 'new-session', ok: ok });
    return ok;
  }

  function openSidebar() {
    if (window.__dshMobileShell && typeof window.__dshMobileShell.openDrawer === 'function') {
      window.__dshMobileShell.openDrawer();
      bridgePost({ type: 'sidebar-opened' });
      return true;
    }
    var toggle = document.querySelector('[class*="_sidebarCol"] [class*="_toggle"]');
    if (toggle) { try { toggle.click(); } catch (e) {} }
    bridgePost({ type: 'sidebar-opened', fallback: true });
    return Boolean(toggle);
  }

  window.__dshMobileBridge = {
    refresh: sendSessions,
    openSession: openSession,
    newSession: newSession,
    openSidebar: openSidebar
  };

  function scheduleSend() {
    if (sendTimer !== null) clearTimeout(sendTimer);
    sendTimer = setTimeout(function () { sendTimer = null; sendSessions(); }, 250);
  }

  function start() {
    if (!document.body) { setTimeout(start, 50); return; }
    tick();
    setTimeout(tick, 500);
    setTimeout(tick, 1200);
    setTimeout(tick, 2500);
    setInterval(sendSessions, 1800);
    try {
      var observer = new MutationObserver(scheduleSend);
      observer.observe(document.body, { childList: true, subtree: true });
    } catch (e) {}
    bridgePost({ type: 'ready' });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
`;
