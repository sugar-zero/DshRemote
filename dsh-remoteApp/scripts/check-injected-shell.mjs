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
 *   5. 抽屉能开、能关；全程没有 JS 异常。
 *
 * 用法：node scripts/check-injected-shell.mjs   （本机没有 Chrome 时自动跳过，退出码 0）
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
</style></head>
<body>
<div class="PIRFFq_frame">
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
    <div id="stream"></div>
  </div>
</div>
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

const shellPath = fileURLToPath(new URL('../src/lib/mobileWebShell.ts', import.meta.url));

function extractShellJs() {
  const source = readFileSync(shellPath, 'utf8');
  const marker = 'String.raw`';
  const start = source.indexOf(marker) + marker.length;
  const end = source.lastIndexOf('`');
  if (start < marker.length || end <= start) throw new Error(`无法从 ${shellPath} 提取注入脚本`);
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

async function runChecks(chromePath) {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'dsh-shell-check-'));
  const fixtureFile = join(fixtureDir, 'fixture.html');
  writeFileSync(fixtureFile, FIXTURE_HTML, 'utf8');
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
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: extractShellJs() });
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
      const fab = document.querySelector('.dsh-mobile-native-trigger');
      fab.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
      const opened = document.documentElement.classList.contains('dsh-mobile-drawer-open');
      document.querySelector('.dsh-mobile-backdrop').click();
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { opened, closed: !document.documentElement.classList.contains('dsh-mobile-drawer-open') };
    })()`);

    const exceptions = cdp.events
      .filter((event) => event.method === 'Runtime.exceptionThrown')
      .map((event) => event.params?.exceptionDetails?.text ?? 'unknown exception');
    cdp.close();
    await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`);
    return { initial, reRender, churn, drawer, exceptions };
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

const chromePath = findChrome();
if (!chromePath) {
  console.log('⚠️  未找到 Chrome/Chromium，跳过注入脚本行为检查（不算失败）。');
  process.exit(0);
}
if (typeof WebSocket === 'undefined' || typeof fetch === 'undefined') {
  console.log('⚠️  当前 Node 缺少 fetch/WebSocket（需要 Node 22+），跳过注入脚本行为检查。');
  process.exit(0);
}

console.log(`== 注入手机壳行为检查（fixture: 无头 Chrome） ==`);
let result;
try {
  result = await runChecks(chromePath);
} catch (error) {
  console.error(`❌ 无法运行检查：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const { initial, reRender, churn, drawer, exceptions } = result;
check('注入脚本已初始化', initial.installed);
check('鲸鱼入口在 conversation.header.leading 槽位内', initial.fabInSlot);
check('鲸鱼入口使用 DSH 原生 logo', initial.fabHasWhaleSvg);
check('viewport 被锁定（user-scalable=no）', String(initial.viewport ?? '').includes('user-scalable=no'), initial.viewport);
check('加载阶段只写一次 viewport（无重复重排）', initial.viewportWrites === 1, `writes=${initial.viewportWrites}`);
check('DSH 重建 header 时标题不横移（槽位预留宽度）', Math.abs(reRender.titleShiftImmediatePx) < 0.5, `shift=${reRender.titleShiftImmediatePx}px`);
check('鲸鱼入口在槽位重建后补挂回去', reRender.fabRepairedIntoSameSlot);
check('流式 DOM 变更不触发全量 querySelector（O(1) 快路径）', churn.querySelectorDelta === 0, `querySelector×${churn.querySelectorDelta} / ${churn.batches} batches`);
check('流式渲染后不再改写 viewport', churn.viewportWritesAfterLoad === 1, `writes=${churn.viewportWritesAfterLoad}`);
check('抽屉可打开', drawer.opened);
check('抽屉可关闭', drawer.closed);
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
