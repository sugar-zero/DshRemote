/**
 * dsh-remote-service —— Web Client 半冒烟测试
 * ============================================================================
 * 不装 React、不起浏览器：用 vm 跑一遍 client.js（它只注册 __ModuleLoader__ 工厂），
 * 再用最小 fake React + fake ctx/slots/locale 调 factory 与 apply，断言：
 *   1. 工厂执行不抛错，返回 { inject, apply }；
 *   2. apply 通过 ctx.slots.inject 注册 sidebar.footer.action 与 settings.section；
 *   3. 加载/注册阶段没有任何网络请求（组件 useEffect 才拉数据）；
 *   4. 样式只注入一次、locale 字典 zh/en 键集合一致；
 *   5. 各页面组件顶层渲染不抛错（hooks 用 no-op stub）；
 *   6. pending 配对（requireApproval）渲染 + 允许/拒绝按钮 POST 的 URL/body 正确，
 *      确认后刷新 /status 并显示 toast；
 *   7. 设置页初值优先读 status.config.*，密钥字段只拿到 configured 布尔。
 * 另跑 `node --check client.js` 保证浏览器直载的语法有效。
 * ============================================================================
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const CLIENT_PATH = fileURLToPath(new URL('../client.js', import.meta.url));
const CLIENT_SOURCE = readFileSync(CLIENT_PATH, 'utf8');

/* ────────────────────────── fake React ────────────────────────── */

function withChildrenProps(props, children) {
  const nextProps = { ...(props || {}) };
  if (children.length === 1) nextProps.children = children[0];
  else if (children.length > 1) nextProps.children = children;
  return nextProps;
}

function createFakeReact() {
  const noop = () => {};
  return {
    createElement(type, props, ...children) {
      // 贴近 React：children 也挂到 props.children（Section/Btn 这类靠它渲染）。
      return { type, props: withChildrenProps(props, children), children };
    },
    Fragment: Symbol('react.fragment'),
    useState(initial) {
      const value = typeof initial === 'function' ? initial() : initial;
      return [value, noop];
    },
    useEffect: noop,
    useLayoutEffect: noop,
    useMemo: (factory) => factory(),
    useCallback: (callback) => callback,
    useRef(initial) {
      return { current: initial };
    },
  };
}

/**
 * 有状态 fake React：只保留 hooks 状态、不执行 effect（避免测试里自动轮询/自动配对）。
 * 用于直接 mount PairingDialog，点击按钮后手动 re-render 校验 toast/状态切换。
 */
function createStatefulRenderer() {
  const slots = [];
  let cursor = 0;
  let Component = null;
  let componentProps = null;
  const react = {
    createElement(type, props, ...children) {
      return { type, props: withChildrenProps(props, children), children };
    },
    Fragment: Symbol('react.fragment'),
    useState(initial) {
      const index = cursor;
      cursor += 1;
      if (!(index in slots)) slots[index] = { value: typeof initial === 'function' ? initial() : initial };
      const slot = slots[index];
      return [slot.value, (next) => {
        slot.value = typeof next === 'function' ? next(slot.value) : next;
      }];
    },
    useRef(initial) {
      const index = cursor;
      cursor += 1;
      if (!(index in slots)) slots[index] = { value: { current: initial } };
      return slots[index].value;
    },
    useMemo(factory) {
      cursor += 1;
      return factory();
    },
    useCallback(callback) {
      cursor += 1;
      return callback;
    },
    useEffect() {
      cursor += 1;
    },
    useLayoutEffect() {
      cursor += 1;
    },
  };
  return {
    react,
    mount(component, props) {
      Component = component;
      componentProps = props;
      return this.render();
    },
    render() {
      cursor = 0;
      return Component(componentProps);
    },
  };
}

/* ────────────────────────── 元素树工具 ────────────────────────── */

function walkTree(node, visit, depth = 0) {
  if (depth > 80) throw new Error('render tree too deep (possible render loop)');
  if (node === null || node === undefined || node === true || node === false) return;
  if (Array.isArray(node)) {
    for (const child of node) walkTree(child, visit, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;
  visit(node);
  if (typeof node.type === 'function') {
    walkTree(node.type(node.props), visit, depth + 1);
    return;
  }
  for (const child of node.children || []) walkTree(child, visit, depth + 1);
}

function collectText(node) {
  const parts = [];
  walkTree(node, (element) => {
    for (const child of element.children || []) {
      if (typeof child === 'string' || typeof child === 'number') parts.push(String(child));
    }
  });
  return parts.join(' | ');
}

function findAll(node, predicate) {
  const found = [];
  walkTree(node, (element) => {
    if (predicate(element)) found.push(element);
  });
  return found;
}

async function flushAsync() {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

function createFakeTimers() {
  let nextId = 1;
  const scheduled = [];
  return {
    scheduled,
    setTimeout(callback, ms) {
      const id = nextId;
      nextId += 1;
      scheduled.push({ id, callback, ms, kind: 'timeout' });
      return id;
    },
    clearTimeout() {},
    setInterval(callback, ms) {
      const id = nextId;
      nextId += 1;
      scheduled.push({ id, callback, ms, kind: 'interval' });
      return id;
    },
    clearInterval() {},
  };
}

function makeT(dictionaries) {
  return (key, params) => {
    let text = dictionaries.zh[key] !== undefined
      ? dictionaries.zh[key]
      : (dictionaries.en[key] !== undefined ? dictionaries.en[key] : key);
    if (params) {
      for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, String(value));
    }
    return text;
  };
}

/* ────────────────────────── fake 浏览器/模块环境 ────────────────────────── */

function loadBundle(options = {}) {
  const fetchCalls = [];
  const appendedStyles = [];
  const defaultFetch = (...args) => {
    fetchCalls.push(args);
    return Promise.reject(new Error('network access is not allowed at load time'));
  };
  const timers = options.timers || createFakeTimers();
  const documentStub = {
    head: {
      appendChild(element) {
        appendedStyles.push(element);
      },
    },
    createElement(tagName) {
      const element = {
        tagName: String(tagName).toUpperCase(),
        attrs: {},
        textContent: '',
        removed: false,
        setAttribute(name, value) {
          element.attrs[name] = String(value);
        },
        remove() {
          element.removed = true;
        },
      };
      return element;
    },
    querySelector() {
      return null;
    },
    listeners: new Map(),
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(listener);
    },
    removeEventListener(type, listener) {
      const entries = this.listeners.get(type);
      if (!entries) return;
      this.listeners.set(type, entries.filter((entry) => entry !== listener));
    },
    dispatch(type) {
      for (const listener of [...(this.listeners.get(type) || [])]) listener({ type });
    },
    visibilityState: 'visible',
  };

  let captured;
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(registration) {
          captured = registration;
        },
      },
    },
    ...options.location === undefined ? {} : { location: options.location },
    document: documentStub,
    fetch: options.fetchImpl || defaultFetch,
    console,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    ...options.globals,
  };
  vm.runInNewContext(CLIENT_SOURCE, sandbox, { filename: CLIENT_PATH });

  assert.ok(captured, 'client.js 必须通过 window.__ModuleLoader__.load 注册工厂');
  return { captured, fetchCalls, appendedStyles, timers, sandbox, documentStub };
}

/* ────────────────────────── fake ctx / slots / locale ────────────────────────── */

function createFakeCtx(options = {}) {
  const injected = [];
  const registered = [];
  const effects = [];
  const localeRegistrations = [];
  const injectedServices = [];
  const disposers = [];

  const slots = {
    inject(name, callback) {
      injected.push(name);
      return callback();
    },
    register(registerOptions, component) {
      registered.push({ options: registerOptions, component });
      return () => {};
    },
  };

  const ctx = {
    effect(callback, label) {
      effects.push(label || '');
      const result = callback();
      const disposer = typeof result === 'function' ? result : () => {};
      disposers.push(disposer);
      return disposer;
    },
    get(name) {
      return name === 'slots' ? slots : undefined;
    },
    slots,
  };
  ctx.inject = (dependencies, callback) => {
    injectedServices.push([...dependencies]);
    const scope = Object.create(ctx);
    if (options.sessions !== undefined) scope.sessions = options.sessions;
    if (options.uiWorkspace !== undefined) scope.uiWorkspace = options.uiWorkspace;
    return callback(scope);
  };

  if (options.locale !== false) {
    const locale = {
      register(namespace, dictionaries) {
        localeRegistrations.push({ namespace, dictionaries });
        return () => {};
      },
      bind() {
        return (key, params) => {
          const dictionaries = localeRegistrations.length > 0 ? localeRegistrations[0].dictionaries : { zh: {}, en: {} };
          return makeT(dictionaries)(key, params);
        };
      },
    };
    ctx.locale = locale;
  }

  return { ctx, injected, registered, effects, localeRegistrations, injectedServices, disposers };
}

/** factory + apply + t 一次性准备好；reactImpl 可换成有状态 hooks（见 createStatefulRenderer）。 */
function setupClientWithReact(reactImpl, options = {}) {
  const bundle = loadBundle(options);
  const clientModule = bundle.captured.factory(() => reactImpl);
  const context = createFakeCtx();
  clientModule.apply(context.ctx);
  const dictionaries = context.localeRegistrations[0].dictionaries;
  return { ...bundle, clientModule, context, dictionaries, t: makeT(dictionaries) };
}

function setupClient(options = {}) {
  return setupClientWithReact(createFakeReact(), options);
}

/* ────────────────────────── tests ────────────────────────── */

test('client.js 语法可被浏览器直载（node --check）', () => {
  const result = spawnSync(process.execPath, ['--check', CLIENT_PATH], { encoding: 'utf8' });
  assert.equal(result.status, 0, `node --check 失败：${result.stderr || ''}`);
});

test('工厂执行不抛错，只 require react，不发起网络请求', () => {
  const { captured, fetchCalls, appendedStyles } = loadBundle();
  assert.equal(captured.id, 'dsh-remote-service');

  const requireCalls = [];
  const fakeRequire = (name) => {
    requireCalls.push(name);
    if (name === 'react') return createFakeReact();
    throw new Error(`unexpected require in host-plugin client: ${name}`);
  };

  const clientModule = captured.factory(fakeRequire);
  assert.equal(typeof clientModule.apply, 'function', 'client 工厂应返回 apply(ctx)');
  assert.ok(Array.isArray(clientModule.inject), 'client 工厂应声明 inject 依赖');
  assert.equal(typeof clientModule.__test, 'object', '应暴露 __test 供 smoke 测试直接渲染组件');
  assert.deepEqual(requireCalls, ['react'], 'client.js 只允许 require("react")');
  assert.equal(fetchCalls.length, 0, '注册阶段不应发起任何 fetch');
  assert.equal(appendedStyles.length, 0, '样式应在 apply 里注入，而不是工厂顶层');
});

test('apply 注册 sidebar.footer.action 与 settings.section，且不触发网络', () => {
  const { captured, fetchCalls, appendedStyles } = loadBundle();
  const clientModule = captured.factory(() => createFakeReact());
  const { ctx, injected, registered, effects, localeRegistrations } = createFakeCtx();

  assert.doesNotThrow(() => clientModule.apply(ctx));

  assert.deepEqual(injected, ['sidebar.footer.action', 'settings.section'], 'slot 注入顺序/名称');
  assert.deepEqual(registered.map((entry) => entry.options.name), ['sidebar.footer.action', 'settings.section']);
  registered.forEach((entry) => {
    assert.equal(entry.options.id, 'remote-access');
    assert.equal(entry.options.locale, 'remote-access', '声明 locale 命名空间以便 t() 注入');
    assert.equal(typeof entry.component, 'function', 'slot 组件必须是函数组件');
  });

  const footer = registered[0].options;
  const settings = registered[1].options;
  assert.equal(typeof footer.order, 'number');
  assert.equal(typeof settings.order, 'number');
  assert.ok(settings.order > 0, '设置页 order 应在 general(0) 之后');
  assert.equal(typeof settings.label, 'function');
  assert.equal(settings.label(), '远程访问');

  assert.equal(effects.length, 2, 'apply 应注册样式与字典两个 effect');
  assert.equal(appendedStyles.length, 1, '样式只注入一次');
  assert.equal(appendedStyles[0].attrs['data-plugin-css'], 'dsh-remote-service');
  assert.equal(localeRegistrations.length, 1);
  assert.equal(localeRegistrations[0].namespace, 'remote-access');

  const zhKeys = Object.keys(localeRegistrations[0].dictionaries.zh).sort();
  const enKeys = Object.keys(localeRegistrations[0].dictionaries.en).sort();
  assert.ok(zhKeys.length > 50, 'zh 字典应有完整文案');
  assert.deepEqual(zhKeys, enKeys, 'zh/en 字典键集合必须一致');

  assert.equal(fetchCalls.length, 0, 'apply 不应发起网络请求');
});

test('ctx.locale 缺失时回退内置字典，仍能完成注册', () => {
  const { captured } = loadBundle();
  const clientModule = captured.factory(() => createFakeReact());
  const { ctx, injected, registered } = createFakeCtx({ locale: false });

  assert.doesNotThrow(() => clientModule.apply(ctx));
  assert.deepEqual(injected, ['sidebar.footer.action', 'settings.section']);
  assert.deepEqual(registered.map((entry) => entry.options.name), ['sidebar.footer.action', 'settings.section']);
  assert.equal(registered[0].options.locale, undefined, '没有 locale 服务时不能声明 locale');
  assert.equal(registered[1].options.label(), '远程访问');
});

test('各页面组件顶层渲染不抛错（hook stub）', () => {
  const { context, t, clientModule } = setupClient();
  const registered = context.registered;

  const entry = registered[0].component;
  const settings = registered[1].component;
  assert.ok(entry({ t, wide: true }), '侧栏入口（宽）应返回元素');
  assert.doesNotThrow(() => walkTree(entry({ t, wide: true }), () => {}), '侧栏入口（宽）渲染树');
  assert.doesNotThrow(() => walkTree(entry({ t, wide: false }), () => {}), '侧栏入口（窄）渲染树');
  assert.doesNotThrow(() => walkTree(settings({ t }), () => {}), '设置页渲染树');
  assert.doesNotThrow(() => walkTree(clientModule.__test.draftFromStatus(null), () => {}));
});

test('pending 配对：渲染设备/SAS/允许拒绝，允许后 POST 正确 body 并刷新状态', async () => {
  const calls = [];
  const inactiveStatus = {
    enabled: true,
    relay: { url: 'wss://relay.example.com:8443', connected: true },
    host: { id: 'h_ab12cd34', name: 'Example Mac', fingerprint: 'FpAbCdEfGhIjKlMnOpQrSt', domain: 'h_ab12cd34.relay.example.com' },
    pairing: { active: false },
    devices: [{ id: 'd_1', name: 'iPhone 15 Pro', platform: 'ios', lastSeenAt: Date.now(), revokedAt: null }],
  };
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/pairing/approve')) {
      return { ok: true, status: 200, async json() { return { ok: true, data: { status: 'paired' } }; } };
    }
    if (String(url).includes('/status')) {
      return { ok: true, status: 200, async json() { return { ok: true, data: inactiveStatus }; } };
    }
    return { ok: true, status: 200, async json() { return { ok: true, data: {} }; } };
  };
  const renderer = createStatefulRenderer();
  const { clientModule, t } = setupClientWithReact(renderer.react, { fetchImpl });
  const pendingStatus = {
    enabled: true,
    group: { registered: true, connected: true },
    host: { id: 'h_ab12cd34', name: 'Example Mac', fingerprint: 'FpAbCdEfGhIjKlMnOpQrSt' },
    pairing: {
      active: true,
      status: 'pending',
      pairingId: 'p_pending01',
      expiresAt: Date.now() + 90_000,
      requiresApproval: true,
      sas: 'K7QM-3F9D',
      code: 'K7QM3F9DT2XA',
      pendingDevice: { name: 'iPhone 15 Pro', platform: 'ios' },
    },
    devices: [],
  };

  const tree = renderer.mount(clientModule.__test.PairingDialog, {
    t,
    initialStatus: pendingStatus,
    onClose() {},
    onStatus() {},
  });
  const text = collectText(tree);
  assert.match(text, /待确认的配对请求/);
  assert.match(text, /iPhone 15 Pro/);
  assert.match(text, /iOS/);
  assert.match(text, /K7QM-3F9D/);
  assert.match(text, /允许配对/);
  assert.match(text, /拒绝/);
  assert.equal(
    findAll(tree, (element) => typeof element.props.src === 'string' && element.props.src.includes('qr.svg')).length,
    0,
    'pending 状态不应再显示二维码',
  );

  const allowButton = findAll(tree, (element) => element.props['data-ra-action'] === 'pair-allow');
  assert.equal(allowButton.length, 1, '应有「允许配对」按钮');
  allowButton[0].props.onClick();
  await flushAsync();

  const approveCall = calls.find((call) => call.url.includes('/pairing/approve'));
  assert.ok(approveCall, '允许后应 POST /pairing/approve');
  assert.equal(approveCall.url, '/api/remote-access/pairing/approve');
  assert.equal(approveCall.options.method, 'POST');
  assert.equal(approveCall.options.credentials, 'include');
  assert.deepEqual(JSON.parse(approveCall.options.body), { pairingId: 'p_pending01', approve: true });
  assert.ok(calls.some((call) => call.url.includes('/status')), '确认后应刷新 status/设备列表');

  const refreshed = renderer.render();
  assert.match(collectText(refreshed), /设备已加入/, '允许后应显示成功 toast（并刷新为无活跃配对）');
});

test('pending 配对：拒绝后 POST approve:false 并显示已拒绝', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/pairing/approve')) {
      return { ok: true, status: 200, async json() { return { ok: true, data: { status: 'denied' } }; } };
    }
    if (String(url).includes('/status')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, data: { enabled: true, group: { registered: true, connected: true }, pairing: { active: false }, devices: [] } };
        },
      };
    }
    return { ok: true, status: 200, async json() { return { ok: true, data: {} }; } };
  };
  const renderer = createStatefulRenderer();
  const { clientModule, t } = setupClientWithReact(renderer.react, { fetchImpl });
  const pendingStatus = {
    enabled: true,
    group: { registered: true, connected: true },
    host: { id: 'h_ab12cd34', fingerprint: 'FpAbCdEfGhIjKlMnOpQrSt' },
    pairing: {
      active: true,
      status: 'pending',
      pairingId: 'p_pending02',
      expiresAt: Date.now() + 90_000,
      requiresApproval: true,
      sas: 'Q7XM-9F2D',
      pendingDevice: { name: 'Pixel 9', platform: 'android' },
    },
    devices: [],
  };
  const tree = renderer.mount(clientModule.__test.PairingDialog, {
    t,
    initialStatus: pendingStatus,
    onClose() {},
    onStatus() {},
  });
  assert.match(collectText(tree), /Pixel 9/);
  assert.match(collectText(tree), /Android/);

  const denyButton = findAll(tree, (element) => element.props['data-ra-action'] === 'pair-deny');
  assert.equal(denyButton.length, 1, '应有「拒绝」按钮');
  denyButton[0].props.onClick();
  await flushAsync();

  const approveCall = calls.find((call) => call.url.includes('/pairing/approve'));
  assert.ok(approveCall, '拒绝后应 POST /pairing/approve');
  assert.deepEqual(JSON.parse(approveCall.options.body), { pairingId: 'p_pending02', approve: false });
  assert.match(collectText(renderer.render()), /已拒绝/);
});

test('设置页初值优先读 status.config（群体版字段，无 classic 密钥字段）', () => {
  const { clientModule } = setupClient();
  const draft = clientModule.__test.draftFromStatus({
    enabled: true, // 生效状态
    host: { id: 'h_effective', name: 'Effective Name', fingerprint: 'FpAbCdEfGhIjKlMnOpQrSt' },
    group: { registered: true, connected: true, serviceUrl: 'https://effective.example:19443' },
    pairing: { active: true, requiresApproval: false },
    devices: [],
    config: {
      enabled: false,
      hostName: 'Cfg Name',
      requireApproval: true,
      groupServiceUrl: 'https://cfg.example:19443',
      groupPlainPort: 34567,
      groupInsecure: false,
    },
  });

  assert.equal(draft.enabled, false, 'enabled 以 config.enabled 为准');
  assert.equal(draft.hostName, 'Cfg Name');
  assert.equal(draft.requireApproval, true);
  assert.equal(draft.groupServiceUrl, 'https://cfg.example:19443');
  assert.equal(draft.groupPlainPort, '34567');
  assert.equal(draft.groupInsecure, false);
  assert.equal(draft.groupInviteCode, '', '邀请码永远不进入 draft 初始值');
  assert.equal(draft.restartHostEnabled, false, '「重启主机」组件默认关闭');
  // classic 字段已从草稿中删除（「推送提醒」是群体版正式开关，单独断言）
  for (const key of ['relayUrl', 'relayDomain', 'hostId', 'publicPort', 'hostToken', 'tlsCertFile', 'tlsKeyFile', 'apnsKeyFile', 'groupEnabled']) {
    assert.equal(key in draft, false, `draft 不应再有 ${key}`);
  }

  // 「重启主机」组件：优先读 config.restartHostEnabled，其次兼容 status.restart.enabled
  assert.equal(clientModule.__test.draftFromStatus({ config: { restartHostEnabled: true } }).restartHostEnabled, true);
  assert.equal(clientModule.__test.draftFromStatus({ restart: { enabled: true } }).restartHostEnabled, true);
  assert.equal(clientModule.__test.draftFromStatus({ restart: { enabled: false } }, { restartHostEnabled: true }).restartHostEnabled, false);

  // 「推送提醒」：默认开启；优先读 config.pushEnabled，其次兼容 status.push.enabled
  assert.equal(draft.pushEnabled, true, '「推送提醒」默认开启');
  assert.equal(clientModule.__test.draftFromStatus({ config: { pushEnabled: false } }).pushEnabled, false);
  assert.equal(clientModule.__test.draftFromStatus({ push: { enabled: false } }).pushEnabled, false);
  assert.equal(clientModule.__test.draftFromStatus({ push: { enabled: true } }).pushEnabled, true);

  const legacy = clientModule.__test.draftFromStatus(null, { groupServiceUrl: 'https://typed.example', hostName: 'Typed' });
  assert.equal(legacy.groupServiceUrl, 'https://typed.example', '无 status 时保留上次编辑值');
  assert.equal(legacy.hostName, 'Typed');
});

function createFakeConnection() {
  const listeners = new Set();
  let state = 'connected';
  return {
    state: {
      getSnapshot: () => state,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    },
    set(next) {
      state = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

/* ────────────────────── 远程会话热缓存（warm cache） ────────────────────── */

function createFakeSessions(ids) {
  const records = new Map();
  const retained = [];
  const released = [];
  const listListeners = new Set();
  let order = [...ids];
  for (const id of ids) records.set(id, { retainedBy: {}, listeners: new Set() });
  const update = (id, mutate) => {
    const record = records.get(id);
    mutate(record);
    for (const listener of [...record.listeners]) listener();
  };
  const sessions = {
    list: {
      getSnapshot: () => ({ ids: [...order], byId: {} }),
      subscribe: (listener) => {
        listListeners.add(listener);
        return () => { listListeners.delete(listener); };
      },
    },
    retainInfo(id) {
      const record = records.get(id);
      if (!record) throw new Error(`unknown session ${id}`);
      return {
        getSnapshot: () => ({ retainedBy: { ...record.retainedBy } }),
        subscribe: (listener) => {
          record.listeners.add(listener);
          return () => record.listeners.delete(listener);
        },
      };
    },
    retain(id, retentionOptions) {
      const token = { id, source: retentionOptions && retentionOptions.source, active: true };
      retained.push(token);
      // 真实 DSH 的 `sessions.retain()` 会同步发布 retention 变化；这里同样通知，
      // 用于覆盖「pin → retain → 订阅回调 → pin」的重入递归回归。
      const record = records.get(id);
      if (record) for (const listener of [...record.listeners]) listener();
      return {
        sessionId: id,
        ready: Promise.resolve(),
        release() {
          if (!token.active) return;
          token.active = false;
          released.push(id);
          const current = records.get(id);
          if (current) for (const listener of [...current.listeners]) listener();
        },
      };
    },
  };
  return {
    sessions,
    retained,
    released,
    activeIds: () => retained.filter((token) => token.active).map((token) => token.id),
    view: (id) => update(id, (record) => { record.retainedBy = { ...record.retainedBy, mainView: 1 }; }),
    drop: (id) => {
      order = order.filter((candidate) => candidate !== id);
      for (const listener of listListeners) listener();
    },
    leave: (id) => update(id, (record) => {
      record.retainedBy = { ...record.retainedBy };
      delete record.retainedBy.mainView;
    }),
  };
}

test('远程会话热缓存：最近会话按 LRU 保留，切回时复用（不重新打开）', () => {
  const { captured } = loadBundle();
  const clientModule = captured.factory(() => createFakeReact());
  const fake = createFakeSessions(['s1', 's2', 's3', 's4']);
  const connection = createFakeConnection();
  const disposers = [];
  const scope = {
    sessions: fake.sessions,
    effect(callback) {
      const disposer = callback();
      disposers.push(disposer);
      return disposer;
    },
  };
  const cache = clientModule.__test.installSessionWarmCache(scope, { max: 3, connection });
  assert.ok(cache, '应安装会话热缓存');
  assert.deepEqual(fake.activeIds(), [], '没有打开过会话时不应 retain');

  fake.view('s1');
  assert.deepEqual(fake.activeIds(), ['s1'], '打开会话时钉住');
  fake.leave('s1');
  fake.view('s2');
  assert.deepEqual(fake.activeIds(), ['s1', 's2'], '切走 s1 后缓存保留，s2 进入缓存');
  fake.leave('s2');
  fake.view('s3');
  assert.deepEqual(fake.activeIds(), ['s1', 's2', 's3'], '最多保留 3 个');

  fake.leave('s3');
  fake.view('s4');
  assert.deepEqual(fake.activeIds(), ['s2', 's3', 's4'], '超过上限时淘汰最久未用的 s1');
  assert.ok(fake.released.includes('s1'), '被淘汰的会话应释放额外 retain');

  // 连接断开：释放「非当前查看」的缓存，避免重连时放大 tail 快照流量
  connection.set('connecting');
  assert.deepEqual(fake.activeIds(), ['s4'], '断线时只保留当前查看的会话');
  assert.ok(fake.released.includes('s2') && fake.released.includes('s3'));
  connection.set('connected');

  // 恢复后切到 s2：重新钉住；缓存命中不重复 retain
  fake.leave('s4');
  fake.view('s2');
  assert.deepEqual(fake.activeIds().sort(), ['s2', 's4'].sort());
  assert.equal(fake.retained.filter((token) => token.id === 's2' && token.active).length, 1, '缓存命中不应重复 retain');

  // 会话从列表消失（删除/归档）：释放对应缓存
  fake.drop('s2');
  assert.deepEqual(fake.activeIds(), ['s4'], '列表里消失的会话应释放缓存 retain');
  assert.ok(fake.released.includes('s2'));

  assert.doesNotThrow(() => cache.pin('unknown-session'), '未知/已删除会话不应抛错');

  // 插件卸载时释放所有缓存 retain
  cache.dispose();
  assert.deepEqual(fake.activeIds(), [], 'dispose 后应释放全部缓存 retain');
  disposers.forEach((dispose) => { if (typeof dispose === 'function') dispose(); });
});

test('会话热缓存：retain 同步发布 retention 时不会重入递归（回归 Max call stack）', () => {
  const { captured } = loadBundle();
  const clientModule = captured.factory(() => createFakeReact());
  const fake = createFakeSessions(['s1']);
  // 安装前 UI 已经 retain 了 s1（真实场景：插件晚于当前会话挂载）
  fake.view('s1');
  const scope = {
    sessions: fake.sessions,
    effect(callback) {
      const disposer = callback();
      return disposer;
    },
  };
  let cache = null;
  assert.doesNotThrow(() => {
    cache = clientModule.__test.installSessionWarmCache(scope, { max: 3 });
  }, '安装缓存不应抛 RangeError（重入递归）');
  assert.ok(cache, '应安装成功');
  assert.equal(fake.retained.filter((token) => token.id === 's1').length, 1, 'sync retention 通知下也只 retain 一次');
  assert.deepEqual(fake.activeIds(), ['s1']);
  cache.dispose();
});

test('会话热缓存只在远程 WebView（?dsh_mobile=1）安装，桌面本机不启用', () => {
  const fake = createFakeSessions(['s1']);
  const uiWorkspace = {
    openSession: () => {},
    selection: { getSnapshot: () => ({ sessionId: 's_mobile' }), subscribe: () => () => {} },
  };

  const mobileBundle = loadBundle({ location: { search: '?dsh_mobile=1' } });
  const mobileModule = mobileBundle.captured.factory(() => createFakeReact());
  const mobileCtx = createFakeCtx({ sessions: fake.sessions, uiWorkspace });
  mobileModule.apply(mobileCtx.ctx);
  assert.deepEqual(mobileCtx.injectedServices, [['sessions', 'connection'], ['uiWorkspace'], ['sessions']], '远程 WebView 应注入 sessions/connection、会话桥 uiWorkspace 与服务就绪后的历史分片');
  assert.equal(typeof mobileBundle.sandbox.__DSH_REMOTE_OPEN_SESSION__, 'function', '手机 WebView 暴露打开会话入口');
  assert.equal(mobileBundle.sandbox.__DSH_REMOTE_CURRENT_SESSION__?.sessionId, 's_mobile', '手机 WebView 上报当前会话');

  const localBundle = loadBundle();
  const localModule = localBundle.captured.factory(() => createFakeReact());
  const localCtx = createFakeCtx({ sessions: fake.sessions, uiWorkspace });
  localModule.apply(localCtx.ctx);
  assert.deepEqual(localCtx.injectedServices, [], '桌面本机不启用会话热缓存');
  assert.equal(localBundle.sandbox.__DSH_REMOTE_OPEN_SESSION__, undefined, '桌面本机不暴露会话桥');
  assert.equal(localBundle.sandbox.__DSH_REMOTE_CURRENT_SESSION__, undefined, '桌面本机不上报当前会话');
});

test('手机 WebView 后台恢复：隐藏超过阈值后让 DSH 连接重建（刷新会话状态）', () => {
  const bundle = loadBundle();
  const clientModule = bundle.captured.factory(() => createFakeReact());
  const reconnects = [];
  let dispose = null;
  const makeScope = () => ({
    connection: { reconnect: () => reconnects.push(Date.now()) },
    effect: (callback, label) => {
      assert.equal(typeof label, 'string');
      dispose = callback();
      return dispose;
    },
  });

  // 阈值 0：隐藏后再可见 → 重连一次
  bundle.sandbox.__DSH_REMOTE_RESUME_RECONNECT_MS__ = 0;
  clientModule.__test.installResumeReconnect(makeScope());
  bundle.documentStub.visibilityState = 'visible';
  bundle.documentStub.dispatch('visibilitychange'); // 无隐藏记录
  assert.equal(reconnects.length, 0);
  bundle.documentStub.visibilityState = 'hidden';
  bundle.documentStub.dispatch('visibilitychange');
  bundle.documentStub.visibilityState = 'visible';
  bundle.documentStub.dispatch('visibilitychange');
  assert.equal(reconnects.length, 1);

  // 卸载旧监听；改成 10s 阈值：短暂隐藏不触发
  if (typeof dispose === 'function') dispose();
  bundle.sandbox.__DSH_REMOTE_RESUME_RECONNECT_MS__ = 10_000;
  clientModule.__test.installResumeReconnect(makeScope());
  bundle.documentStub.visibilityState = 'hidden';
  bundle.documentStub.dispatch('visibilitychange');
  bundle.documentStub.visibilityState = 'visible';
  bundle.documentStub.dispatch('visibilitychange');
  assert.equal(reconnects.length, 1);

  // 没有 connection 服务时静默跳过
  clientModule.__test.installResumeReconnect({ effect: () => {} });
});

test('手机 WebView 会话桥：上报当前会话 / 清空会话 + 打开会话 + 消费 pending', () => {
  const bundle = loadBundle();
  const clientModule = bundle.captured.factory(() => createFakeReact());
  const opened = [];
  const messages = [];
  let selectionListener = null;
  let currentSessionId = 's_current';
  const uiWorkspace = {
    openSession: (sessionId) => { opened.push(sessionId); },
    selection: {
      getSnapshot: () => (currentSessionId === '' ? {} : { sessionId: currentSessionId }),
      subscribe: (listener) => { selectionListener = listener; return () => {}; },
    },
  };
  const makeInject = () => ({
    inject: (dependencies, callback) => {
      assert.deepEqual([...dependencies], ['uiWorkspace']);
      return callback({ uiWorkspace, effect: (fn) => fn() });
    },
  });

  bundle.sandbox.dshMtlsBridge = { postMessage: (text) => messages.push(JSON.parse(text)) };
  clientModule.__test.installSessionBridge(makeInject());
  assert.equal(typeof bundle.sandbox.__DSH_REMOTE_OPEN_SESSION__, 'function');
  const current = bundle.sandbox.__DSH_REMOTE_CURRENT_SESSION__;
  assert.equal(current.host, '');
  assert.equal(current.sessionId, 's_current');
  assert.deepEqual(messages[0], { type: 'dsh-remote/current-session', host: '', sessionId: 's_current' });

  // 点击通知后 App 调用的打开入口
  bundle.sandbox.__DSH_REMOTE_OPEN_SESSION__('s_target');
  assert.deepEqual(opened, ['s_target']);

  // 插件加载前注入的 pending 请求在安装时消费
  bundle.sandbox.__DSH_REMOTE_OPEN_SESSION_PENDING__ = 's_pending';
  clientModule.__test.installSessionBridge(makeInject());
  assert.ok(opened.includes('s_pending'));

  // selection 变化 → 再次上报
  currentSessionId = 's_next';
  selectionListener?.();
  assert.deepEqual(messages.at(-1), { type: 'dsh-remote/current-session', host: '', sessionId: 's_next' });

  // selection 被清空（离开/归档当前会话）→ 必须上报空 sessionId，让 App 清掉过期的“当前会话”
  currentSessionId = '';
  selectionListener?.();
  assert.deepEqual(messages.at(-1), { type: 'dsh-remote/current-session', host: '', sessionId: '' }, '清空 selection 也要上报');
  assert.equal(bundle.sandbox.__DSH_REMOTE_CURRENT_SESSION__.sessionId, '', '全局当前会话同步清空');

  // 没有 openSession 的兼容环境静默跳过
  clientModule.__test.installSessionBridge({
    inject: (dependencies, callback) => callback({ uiWorkspace: { selection: uiWorkspace.selection }, effect: (fn) => fn() }),
  });
});

test('设备列表：已撤销设备提供「删除」（二次确认）并 POST /devices/:id/delete', async () => {
  const revokedAt = Date.now() - 60_000;
  const baseStatus = {
    enabled: true,
    relay: { url: 'wss://relay.example.com:8443', connected: true },
    host: { id: 'h_ab12cd34', name: 'Example Mac', fingerprint: 'FpAbCdEfGhIjKlMnOpQrSt' },
    pairing: { active: false },
    devices: [
      { id: 'd_revoked', name: 'Old iPhone', platform: 'ios', lastSeenAt: revokedAt, revokedAt },
      { id: 'd_active', name: 'New iPhone', platform: 'ios', lastSeenAt: Date.now(), revokedAt: null },
    ],
    config: {},
  };
  const afterDelete = { ...baseStatus, devices: [baseStatus.devices[1]] };
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/devices/d_revoked/delete')) {
      return { ok: true, status: 200, async json() { return { ok: true, data: { device: { id: 'd_revoked' } } }; } };
    }
    if (String(url).includes('/status')) {
      return { ok: true, status: 200, async json() { return { ok: true, data: afterDelete }; } };
    }
    if (String(url).includes('/audit')) {
      return { ok: true, status: 200, async json() { return { ok: true, data: { entries: [] } }; } };
    }
    return { ok: true, status: 200, async json() { return { ok: true, data: {} }; } };
  };
  const renderer = createStatefulRenderer();
  const { clientModule, t } = setupClientWithReact(renderer.react, { fetchImpl });
  let tree = renderer.mount(clientModule.__test.SettingsPage, { t, initialStatus: baseStatus });

  assert.equal(findAll(tree, (el) => el.props['data-ra-action'] === 'device-delete').length, 1, '已撤销设备应有删除按钮');
  assert.equal(findAll(tree, (el) => el.props['data-ra-action'] === 'device-revoke').length, 1, '有效设备仍是撤销按钮');
  assert.match(collectText(tree), /旧设备|Old iPhone/);

  // 第一次点击只进入确认态，不发请求
  findAll(tree, (el) => el.props['data-ra-action'] === 'device-delete')[0].props.onClick();
  tree = renderer.render();
  const confirmButtons = findAll(tree, (el) => el.props['data-ra-action'] === 'device-delete');
  assert.equal(confirmButtons.length, 1);
  assert.match(collectText(confirmButtons[0]), /确认删除|Confirm delete/);
  assert.equal(calls.filter((call) => call.url.includes('/delete')).length, 0, '首次点击不应发请求');

  // 第二次点击真正删除
  confirmButtons[0].props.onClick();
  await flushAsync();
  const deleteCall = calls.find((call) => call.url.includes('/devices/d_revoked/delete'));
  assert.ok(deleteCall, '应 POST /devices/:id/delete');
  assert.equal(deleteCall.options.method, 'POST');
  assert.ok(calls.some((call) => call.url.includes('/status')), '删除后应刷新 status');
  tree = renderer.render();
  assert.equal(findAll(tree, (el) => el.props['data-ra-action'] === 'device-delete').length, 0, '删除后该设备不再出现');
});

/* ────────────────────── 手机端会话历史分片（首屏 + 翻页窗口） ────────────────────── */

/** 形状与 DSH Client 的 SessionEventStream 一致的最小 fake（本插件只包装 repairRequest/readPage）。 */
function createFakeSessionEventStream() {
  return class FakeSessionEventStream {
    constructor() {
      this.pages = [];
    }

    repairRequest(request) {
      return {
        ...request.maxMessages === undefined ? {} : { maxMessages: request.maxMessages },
        ...request.turnWindow === undefined ? {} : { turnWindow: request.turnWindow },
      };
    }

    async readPage(request, throughSeq, signal) {
      this.pages.push({ request, throughSeq, signal });
      return { records: [{ type: 'event', event: { seq: throughSeq } }], hasMore: true };
    }
  };
}

function createFakeModuleTable(modules) {
  const calls = [];
  const require = (spec) => {
    calls.push(spec);
    if (spec === 'react') return createFakeReact();
    if (Object.prototype.hasOwnProperty.call(modules, spec)) {
      const value = modules[spec];
      if (value instanceof Error) throw value;
      return value;
    }
    throw new Error(`module table missed ${spec}`);
  };
  require.calls = calls;
  return require;
}

const DSH_SESSION_CONTROLLER = '@deepseek-ai/dsh-api-session-controller';

/** VM 沙箱里创建的对象属于另一个 realm；deepStrictEqual 前先转成本 realm 的纯 JSON。 */
function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

test('手机端历史分片：首屏与翻页窗口压到手机预算（follow + page + 跳转）', async () => {
  const FakeStream = createFakeSessionEventStream();
  const bundle = loadBundle({
    location: { search: '?dsh_mobile=1' },
    globals: { __DSH_REMOTE_MOBILE_HISTORY_STATS__: true },
  });
  const clientModule = bundle.captured.factory(createFakeModuleTable({
    [DSH_SESSION_CONTROLLER]: { SessionEventStream: FakeStream },
  }));
  const context = createFakeCtx({ sessions: {} });
  clientModule.apply(context.ctx);

  // 生效窗口挂到 globalThis，便于在手机 Web Inspector 里确认
  assert.deepEqual(plain(bundle.sandbox.__DSH_REMOTE_MOBILE_HISTORY_ACTIVE__), {
    open: { maxMessages: 6, minMessages: 3, minTurns: 1 },
    page: { maxMessages: 10, minMessages: 5, minTurns: 1 },
    jump: { maxMessages: 30, minMessages: 15, minTurns: 2 },
  }, '安装后应暴露生效窗口');

  const stream = new FakeStream();
  // 首屏/重连 tail：DSH 默认 500 / 50 / 2 → 压到手机预算
  assert.deepEqual(
    plain(stream.repairRequest({ maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } })),
    { maxMessages: 6, turnWindow: { minMessages: 3, minTurns: 1 } },
    'session/follow 首屏窗口应压到 6/3/1',
  );

  // 向上翻历史（loadOlder）：500 / 50 / 2 → 10 / 5 / 1
  await stream.readPage({ beforeSeq: 420, maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } }, 500, undefined);
  assert.deepEqual(plain(stream.pages[0].request), {
    beforeSeq: 420,
    maxMessages: 10,
    turnWindow: { minMessages: 5, minTurns: 1 },
  }, 'session/page 翻页窗口应压到 10/5/1 且保留 beforeSeq');
  assert.equal(stream.pages[0].throughSeq, 500, 'throughSeq 必须原样传给原方法');

  // 跳转（右侧 turn rail → loadThrough，JUMP_PAGE_OPTIONS minMessages 200）：
  // 用单独的 jump 窗口（30/15/2），比普通翻页大以少发轮次，但仍小于原版 500/200/2。
  await stream.readPage({ beforeSeq: 900, maxMessages: 500, turnWindow: { minMessages: 200, minTurns: 2 } }, 950, undefined);
  assert.deepEqual(plain(stream.pages[1].request), {
    beforeSeq: 900,
    maxMessages: 30,
    turnWindow: { minMessages: 15, minTurns: 2 },
  }, '跳转请求应使用 jump 窗口 30/15/2');

  // message-aligned 模式（无 turnWindow）：只压 maxMessages，不凭空添加 turnWindow
  await stream.readPage({ beforeSeq: 3, maxMessages: 500 }, 10, undefined);
  assert.deepEqual(plain(stream.pages[2].request), { beforeSeq: 3, maxMessages: 10 }, '不得凭空添加 turnWindow');

  // 只收紧不放大：请求本来更小时保留请求值
  await stream.readPage({ beforeSeq: 1, maxMessages: 3, turnWindow: { minMessages: 1, minTurns: 1 } }, 5, undefined);
  assert.deepEqual(plain(stream.pages[3].request), {
    beforeSeq: 1,
    maxMessages: 3,
    turnWindow: { minMessages: 1, minTurns: 1 },
  }, '不得放大调用方更小的窗口');

  // 诊断：记录请求窗口与响应规模
  const log = bundle.sandbox.__DSH_REMOTE_MOBILE_HISTORY_LOG__;
  assert.ok(Array.isArray(log) && log.length >= 4, '开启统计后应记录分页请求');
  assert.equal(log[0].kind, 'follow');
  assert.ok(log.some((entry) => entry.kind === 'page' && entry.window.maxMessages === 10 && entry.beforeSeq === 420));
  assert.ok(log.some((entry) => entry.kind === 'jump' && entry.window.maxMessages === 30 && entry.beforeSeq === 900), '跳转请求应标记 kind=jump');
  await flushAsync();
  assert.ok(bundle.sandbox.__DSH_REMOTE_MOBILE_HISTORY_LOG__.some((entry) => entry.kind === 'page-result' && entry.records === 1), '应记录翻页响应规模');

  // 插件卸载后恢复 DSH 原方法
  for (const dispose of [...context.disposers].reverse()) dispose();
  assert.equal(bundle.sandbox.__DSH_REMOTE_MOBILE_HISTORY_ACTIVE__, undefined, '卸载后应清理生效窗口');
});

test('手机端历史分片：桌面本机不装、模块缺失/关闭时静默降级', () => {
  // 桌面本机：不 require session 控制器，prototype 保持原样
  const DesktopStream = createFakeSessionEventStream();
  const desktopRequire = createFakeModuleTable({});
  const desktopBundle = loadBundle();
  const desktopModule = desktopBundle.captured.factory(desktopRequire);
  const desktopCtx = createFakeCtx({ sessions: {} });
  desktopModule.apply(desktopCtx.ctx);
  assert.deepEqual(desktopCtx.injectedServices, [], '桌面本机不安装历史分片');
  assert.deepEqual(desktopRequire.calls, ['react'], '桌面本机只 require react');
  assert.deepEqual(plain(DesktopStream.prototype.repairRequest({ maxMessages: 500 })), { maxMessages: 500 }, '桌面本机窗口不变');

  // 手机 WebView 但浏览器模块表里没有 session 控制器：只告警，不抛错
  const MobileStream = createFakeSessionEventStream();
  const originalRepair = MobileStream.prototype.repairRequest;
  const warnings = [];
  const mobileBundle = loadBundle({
    location: { search: '?dsh_mobile=1' },
    globals: {
      console: {
        info() {},
        log() {},
        warn(...args) { warnings.push(args.map(String).join(' ')); },
        error() {},
      },
    },
  });
  const mobileModule = mobileBundle.captured.factory(createFakeModuleTable({}));
  const mobileCtx = createFakeCtx({ sessions: {} });
  assert.doesNotThrow(() => mobileModule.apply(mobileCtx.ctx), '模块缺失不得影响主 UI');
  assert.equal(MobileStream.prototype.repairRequest, originalRepair, '模块缺失时不包装');
  assert.ok(warnings.some((message) => message.includes('mobile session history')), '应留下降级告警');

  // enabled:false：不安装
  const DisabledStream = createFakeSessionEventStream();
  const disabledBundle = loadBundle({
    location: { search: '?dsh_mobile=1' },
    globals: { __DSH_REMOTE_MOBILE_HISTORY__: { enabled: false } },
  });
  const disabledModule = disabledBundle.captured.factory(createFakeModuleTable({
    [DSH_SESSION_CONTROLLER]: { SessionEventStream: DisabledStream },
  }));
  disabledModule.apply(createFakeCtx({ sessions: {} }).ctx);
  assert.equal(disabledBundle.sandbox.__DSH_REMOTE_MOBILE_HISTORY_ACTIVE__, undefined, 'enabled:false 时不安装');
});

test('手机端历史分片：globalThis 覆盖窗口（调试用）', () => {
  const FakeStream = createFakeSessionEventStream();
  const bundle = loadBundle({
    location: { search: '?dsh_mobile=1' },
    globals: {
      __DSH_REMOTE_MOBILE_HISTORY__: {
        open: { maxMessages: 12 },
        page: { maxMessages: 20, minMessages: 8, minTurns: 2 },
        jump: { maxMessages: 60, minMessages: 30, minTurns: 2 },
      },
    },
  });
  const clientModule = bundle.captured.factory(createFakeModuleTable({
    [DSH_SESSION_CONTROLLER]: { SessionEventStream: FakeStream },
  }));
  clientModule.apply(createFakeCtx({ sessions: {} }).ctx);
  assert.deepEqual(plain(bundle.sandbox.__DSH_REMOTE_MOBILE_HISTORY_ACTIVE__), {
    open: { maxMessages: 12, minMessages: 3, minTurns: 1 },
    page: { maxMessages: 20, minMessages: 8, minTurns: 2 },
    jump: { maxMessages: 60, minMessages: 30, minTurns: 2 },
  }, '覆盖值应与默认值合并');
  const stream = new FakeStream();
  assert.deepEqual(
    plain(stream.repairRequest({ maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } })),
    { maxMessages: 12, turnWindow: { minMessages: 3, minTurns: 1 } },
    '首屏应使用覆盖后的窗口',
  );
});

test('手机端历史分片：重复安装幂等、配置解析兜底', () => {
  const FakeStream = createFakeSessionEventStream();
  const proto = FakeStream.prototype;
  const originalRepair = proto.repairRequest;
  const originalReadPage = proto.readPage;
  const bundle = loadBundle({ location: { search: '?dsh_mobile=1' } });
  const clientModule = bundle.captured.factory(createFakeModuleTable({
    [DSH_SESSION_CONTROLLER]: { SessionEventStream: FakeStream },
  }));
  const context = createFakeCtx({ sessions: {} });
  clientModule.apply(context.ctx);
  const installedRepair = proto.repairRequest;
  assert.notEqual(installedRepair, originalRepair, '应安装包装');
  clientModule.apply(context.ctx);
  assert.equal(proto.repairRequest, installedRepair, '重复 apply 不应叠加包装');
  assert.deepEqual(plain(new FakeStream().repairRequest({ maxMessages: 500 })), { maxMessages: 6 }, '重复安装后仍只压一次');

  for (const dispose of [...context.disposers].reverse()) dispose();
  assert.equal(proto.repairRequest, originalRepair, 'dispose 后恢复原 repairRequest');
  assert.equal(proto.readPage, originalReadPage, 'dispose 后恢复原 readPage');

  const { __test } = clientModule;
  assert.deepEqual(plain(__test.resolveMobileHistoryWindows(undefined)), {
    open: { maxMessages: 6, minMessages: 3, minTurns: 1 },
    page: { maxMessages: 10, minMessages: 5, minTurns: 1 },
    jump: { maxMessages: 30, minMessages: 15, minTurns: 2 },
  }, '默认窗口');
  assert.equal(__test.resolveMobileHistoryWindows({ enabled: false }), null, 'enabled:false 返回 null');
  assert.deepEqual(plain(__test.resolveMobileHistoryWindows({ open: { maxMessages: 0, minMessages: -2, minTurns: 'x' } })), {
    open: { maxMessages: 6, minMessages: 3, minTurns: 1 },
    page: { maxMessages: 10, minMessages: 5, minTurns: 1 },
    jump: { maxMessages: 30, minMessages: 15, minTurns: 2 },
  }, '非法值应回退默认');
  assert.deepEqual(plain(__test.resolveMobileHistoryWindows({ page: { maxMessages: 3, minMessages: 9 } })), {
    open: { maxMessages: 6, minMessages: 3, minTurns: 1 },
    page: { maxMessages: 3, minMessages: 3, minTurns: 1 },
    jump: { maxMessages: 30, minMessages: 15, minTurns: 2 },
  }, 'minMessages 应收敛到 ≤ maxMessages');
  assert.equal(__test.applyMobileHistoryWindow(undefined, __test.MOBILE_HISTORY_DEFAULTS.page), undefined, '非对象请求原样返回');
  assert.deepEqual(plain(__test.applyMobileHistoryWindow({ beforeSeq: 7 }, __test.MOBILE_HISTORY_DEFAULTS.page)), {
    beforeSeq: 7,
    maxMessages: 10,
  }, '无窗口字段的请求只补 maxMessages');

  // 跳转识别：JUMP_PAGE_OPTIONS（minMessages 200）算跳转，普通翻页（50）/无 turnWindow 不算
  assert.equal(__test.isMobileHistoryJumpRequest({ turnWindow: { minMessages: 200, minTurns: 2 } }), true, '200 应识别为跳转');
  assert.equal(__test.isMobileHistoryJumpRequest({ turnWindow: { minMessages: 100, minTurns: 2 } }), true, '阈值 100 也算跳转');
  assert.equal(__test.isMobileHistoryJumpRequest({ turnWindow: { minMessages: 50, minTurns: 2 } }), false, '普通翻页不算跳转');
  assert.equal(__test.isMobileHistoryJumpRequest({ maxMessages: 500 }), false, '无 turnWindow 不算跳转');
  assert.equal(__test.isMobileHistoryJumpRequest(undefined), false, '非对象不算跳转');
});

test('设置页：只展示群体服务字段，切换到启用后保存提交 enabled', async () => {
  const baseStatus = {
    enabled: false,
    group: { registered: false, connected: false, serviceUrl: '', hostId: '', fqdn: '', mobilePort: 0, plainPort: 0, controlUrl: '', lastError: null },
    host: { id: '', name: 'Example Mac', fingerprint: 'FpAbCdEfGhIjKlMnOpQrSt' },
    pairing: { active: false },
    devices: [],
    config: { enabled: false, hostName: 'Example Mac', requireApproval: true, groupServiceUrl: '', groupPlainPort: 0, groupInsecure: false },
  };
  let enabled = false;
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const data = { ...baseStatus, enabled, config: { ...baseStatus.config, enabled } };
    if (String(url).includes('/config') && options.method === 'POST') {
      const patch = JSON.parse(String(options.body ?? '{}'));
      if (patch.enabled !== undefined) enabled = patch.enabled === true;
      return { ok: true, status: 200, async json() { return { ok: true, data }; } };
    }
    if (String(url).includes('/audit')) {
      return { ok: true, status: 200, async json() { return { ok: true, data: { entries: [] } }; } };
    }
    return { ok: true, status: 200, async json() { return { ok: true, data }; } };
  };
  const renderer = createStatefulRenderer();
  const { clientModule, t } = setupClientWithReact(renderer.react, { fetchImpl });
  let tree = renderer.mount(clientModule.__test.SettingsPage, { t, initialStatus: baseStatus });
  await flushAsync();
  tree = renderer.render();

  // 群体版设置页不出现 classic 字段（「推送提醒」是群体版正式开关，见下方断言）
  const pageText = collectText(tree);
  for (const banned of ['中继地址', '中继主机令牌', 'TLS 证书', 'APNs']) {
    assert.equal(pageText.includes(banned), false, `设置页不应再出现 classic 字段：${banned}`);
  }
  assert.match(pageText, /群体服务/);
  assert.match(pageText, /服务地址/);
  assert.match(pageText, /邀请码/);
  // 「组件」区（群体版也提供「允许手机重启主机 DSH」）
  assert.match(pageText, /组件/);
  assert.match(pageText, /允许手机重启主机 DSH/);
  // 「推送提醒」区（R2：self 经 relay / official 直连官方 hub；主机不持有 Apple 凭据）
  assert.match(pageText, /推送提醒/);
  assert.match(pageText, /推送通道/);
  assert.match(pageText, /私有推送/);
  assert.match(pageText, /官方推送/);

  // 打开「启用远程访问」开关后保存 → POST /config { enabled: true }
  const enableToggle = findAll(tree, (element) => element.props['data-ra-sw'] !== undefined
    && String(element.props['aria-label'] ?? '').includes('启用远程访问'))[0];
  assert.ok(enableToggle, '应有「启用远程访问」开关');
  assert.equal(enableToggle.props['aria-checked'], false, '初始应关闭');
  enableToggle.props.onClick();
  await flushAsync();
  tree = renderer.render();
  const saveButtons = findAll(tree, (element) => element.props['data-ra-btn'] !== undefined && collectText(element).includes('保存'));
  assert.ok(saveButtons.length >= 1, '应有保存按钮');
  saveButtons.at(-1).props.onClick();
  await flushAsync();
  const configCall = calls.filter((call) => call.url.includes('/config') && call.options.method === 'POST').at(-1);
  assert.ok(configCall, '保存应 POST /config');
  assert.deepEqual(JSON.parse(String(configCall.options.body)), { enabled: true });
});

test('设置页：组件区可开启「允许手机重启主机 DSH」并保存 restartHostEnabled', async () => {
  const baseStatus = {
    enabled: true,
    group: {
      registered: true, connected: true, serviceUrl: 'https://relay.example.com:19443',
      hostId: 'h_test1234', fqdn: 'h_test1234.relay.example.com', mobilePort: 11443, plainPort: 34567,
      controlUrl: '', lastError: null,
    },
    host: { id: 'h_test1234', name: 'Example Mac', fingerprint: 'FpAbCdEfGhIjKlMnOpQrSt' },
    pairing: { active: false },
    devices: [],
    restart: { enabled: false },
    config: {
      enabled: true, hostName: 'Example Mac', requireApproval: true, restartHostEnabled: false,
      groupServiceUrl: 'https://relay.example.com:19443', groupPlainPort: 34567, groupInsecure: false,
    },
  };
  let restartHostEnabled = false;
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/config') && options.method === 'POST') {
      const patch = JSON.parse(String(options.body ?? '{}'));
      if (patch.restartHostEnabled !== undefined) restartHostEnabled = patch.restartHostEnabled === true;
    }
    const data = {
      ...baseStatus,
      restart: { enabled: restartHostEnabled },
      config: { ...baseStatus.config, restartHostEnabled },
    };
    if (String(url).includes('/config') && options.method === 'POST') {
      return { ok: true, status: 200, async json() { return { ok: true, data }; } };
    }
    if (String(url).includes('/audit')) {
      return { ok: true, status: 200, async json() { return { ok: true, data: { entries: [] } }; } };
    }
    return { ok: true, status: 200, async json() { return { ok: true, data }; } };
  };
  const renderer = createStatefulRenderer();
  const { clientModule, t } = setupClientWithReact(renderer.react, { fetchImpl });
  let tree = renderer.mount(clientModule.__test.SettingsPage, { t, initialStatus: baseStatus });
  await flushAsync();
  tree = renderer.render();

  const findRestartToggle = (root) => findAll(root, (element) => element.props['data-ra-sw'] !== undefined
    && String(element.props['aria-label'] ?? '').includes('允许手机重启主机 DSH'))[0];

  const toggle = findRestartToggle(tree);
  assert.ok(toggle, '组件区应有「允许手机重启主机 DSH」开关');
  assert.equal(toggle.props['aria-checked'], false, '默认关闭');
  toggle.props.onClick();
  await flushAsync();
  tree = renderer.render();
  const saveButtons = findAll(tree, (element) => element.props['data-ra-btn'] !== undefined && collectText(element).includes('保存'));
  assert.ok(saveButtons.length >= 1, '组件区应有保存按钮');
  saveButtons.at(-1).props.onClick();
  await flushAsync();
  const configCall = calls.filter((call) => call.url.includes('/config') && call.options.method === 'POST').at(-1);
  assert.ok(configCall, '保存应 POST /config');
  assert.deepEqual(JSON.parse(String(configCall.options.body)), { restartHostEnabled: true });

  // 保存响应回来后开关态同步为开启
  const refreshed = findRestartToggle(renderer.render());
  assert.equal(refreshed.props['aria-checked'], true);
});

test('设置页：保存失败时 toast 带服务端 detail（invalid-config 文案 + code）', async () => {
  const baseStatus = {
    enabled: true,
    group: {
      registered: true, connected: true, serviceUrl: 'https://relay.example.com:19443',
      hostId: 'h_test1234', fqdn: 'h_test1234.relay.example.com', mobilePort: 11443, plainPort: 34567,
      controlUrl: '', lastError: null,
    },
    host: { id: 'h_test1234', name: 'Example Mac', fingerprint: 'FpAbCdEfGhIjKlMnOpQrSt' },
    pairing: { active: false },
    devices: [],
    restart: { enabled: false },
    config: {
      enabled: true, hostName: 'Example Mac', requireApproval: true, restartHostEnabled: false,
      groupServiceUrl: '', groupPlainPort: 34567, groupInsecure: false,
    },
  };
  const fetchImpl = async (url, options = {}) => {
    if (String(url).includes('/config') && options.method === 'POST') {
      return {
        ok: false,
        status: 400,
        async json() {
          return { ok: false, error: { code: 'invalid-config', message: 'groupServiceUrl（服务地址）未配置' } };
        },
      };
    }
    if (String(url).includes('/audit')) {
      return { ok: true, status: 200, async json() { return { ok: true, data: { entries: [] } }; } };
    }
    return { ok: true, status: 200, async json() { return { ok: true, data: baseStatus }; } };
  };
  const renderer = createStatefulRenderer();
  const { clientModule, t } = setupClientWithReact(renderer.react, { fetchImpl });
  let tree = renderer.mount(clientModule.__test.SettingsPage, { t, initialStatus: baseStatus });
  await flushAsync();
  tree = renderer.render();

  const toggle = findAll(tree, (element) => element.props['data-ra-sw'] !== undefined
    && String(element.props['aria-label'] ?? '').includes('允许手机重启主机 DSH'))[0];
  assert.ok(toggle, '组件区应有「允许手机重启主机 DSH」开关');
  toggle.props.onClick();
  await flushAsync();
  tree = renderer.render();
  const saveButtons = findAll(tree, (element) => element.props['data-ra-btn'] !== undefined && collectText(element).includes('保存'));
  saveButtons.at(-1).props.onClick();
  await flushAsync();

  const text = collectText(renderer.render());
  assert.match(text, /保存失败/, '失败时应显示保存失败 toast');
  assert.match(text, /groupServiceUrl（服务地址）未配置/, 'toast 应带服务端错误 detail');
  assert.match(text, /invalid-config/, 'toast 应带错误 code，便于用户反馈定位');
});

test('设置页：推送提醒区开关保存 pushEnabled，并展示 self/official 分流状态与 hub', async () => {
  const baseStatus = {
    enabled: true,
    group: {
      registered: true, connected: true, serviceUrl: 'https://relay.example.com:19443',
      hostId: 'h_test1234', fqdn: 'h_test1234.relay.example.com', mobilePort: 11443, plainPort: 34567,
      controlUrl: '', lastError: null,
    },
    host: { id: 'h_test1234', name: 'Example Mac', fingerprint: 'FpAbCdEfGhIjKlMnOpQrSt' },
    pairing: { active: false },
    devices: [],
    restart: { enabled: false },
    push: {
      enabled: true,
      detail: false,
      self: { devices: 1, lastError: null },
      official: { devices: 2, lastError: null, hub: 'https://push.example.com' },
      mode: 'mixed',
    },
    config: {
      enabled: true, hostName: 'Example Mac', requireApproval: true, restartHostEnabled: false,
      pushEnabled: true, groupServiceUrl: 'https://relay.example.com:19443', groupPlainPort: 34567, groupInsecure: false,
    },
  };
  let pushEnabled = true;
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/config') && options.method === 'POST') {
      const patch = JSON.parse(String(options.body ?? '{}'));
      if (patch.pushEnabled !== undefined) pushEnabled = patch.pushEnabled === true;
    }
    const data = {
      ...baseStatus,
      push: { ...baseStatus.push, enabled: pushEnabled },
      config: { ...baseStatus.config, pushEnabled },
    };
    if (String(url).includes('/audit')) {
      return { ok: true, status: 200, async json() { return { ok: true, data: { entries: [] } }; } };
    }
    return { ok: true, status: 200, async json() { return { ok: true, data }; } };
  };
  const renderer = createStatefulRenderer();
  const { clientModule, t } = setupClientWithReact(renderer.react, { fetchImpl });
  let tree = renderer.mount(clientModule.__test.SettingsPage, { t, initialStatus: baseStatus });
  await flushAsync();
  tree = renderer.render();

  // 状态行：通道（mixed → 混合自动分流）+ self/official 设备数；hub 地址不在界面展示。
  const pageText = collectText(tree);
  assert.match(pageText, /推送通道/);
  assert.match(pageText, /私有 \+ 官方（TestFlight）/);
  assert.match(pageText, /私有推送/);
  assert.match(pageText, /官方推送/);
  assert.doesNotMatch(pageText, /官方推送 hub/);
  assert.doesNotMatch(pageText, /https:\/\/push\.example\.com/);
  assert.match(pageText, /1 台/);
  assert.match(pageText, /2 台/);

  const findPushToggle = (root) => findAll(root, (element) => element.props['data-ra-sw'] !== undefined
    && String(element.props['aria-label'] ?? '').includes('推送提醒'))[0];
  const toggle = findPushToggle(tree);
  assert.ok(toggle, '推送提醒区应有开关');
  assert.equal(toggle.props['aria-checked'], true, '默认开启');
  toggle.props.onClick();
  await flushAsync();
  tree = renderer.render();
  const saveButtons = findAll(tree, (element) => element.props['data-ra-btn'] !== undefined && collectText(element).includes('保存'));
  assert.ok(saveButtons.length >= 1, '推送提醒区应有保存按钮');
  saveButtons.at(-1).props.onClick();
  await flushAsync();

  const configCall = calls.filter((call) => call.url.includes('/config') && call.options.method === 'POST').at(-1);
  assert.ok(configCall, '保存应 POST /config');
  assert.deepEqual(JSON.parse(String(configCall.options.body)), { pushEnabled: false }, '只提交 pushEnabled，不触发运行时重建字段');
  const refreshed = findPushToggle(renderer.render());
  assert.equal(refreshed.props['aria-checked'], false, '保存响应回来后开关态同步为关闭');
});

test('设置页：self/official 通道错误与隧道断开提示可读', async () => {
  const baseStatus = {
    enabled: true,
    group: { registered: true, connected: true, serviceUrl: 'https://relay.example.com:19443', hostId: 'h_1', fqdn: 'h_1.relay.example.com', mobilePort: 11443, plainPort: 34567, controlUrl: '', lastError: null },
    host: { id: 'h_1', name: 'Example Mac' },
    pairing: { active: false },
    devices: [],
    push: {
      enabled: true,
      detail: false,
      self: { devices: 1, lastError: '推送登记被拒绝：push_disabled' },
      official: { devices: 1, lastError: '官方推送失败：rate_limited（不重试）', hub: 'https://push.example.com' },
      mode: 'mixed',
    },
    config: { enabled: true, pushEnabled: true, groupServiceUrl: 'https://relay.example.com:19443', groupPlainPort: 34567 },
  };
  const renderer = createStatefulRenderer();
  const { clientModule, t } = setupClientWithReact(renderer.react, {
    fetchImpl: async (url) => ({
      ok: true,
      status: 200,
      async json() {
        if (String(url).includes('/audit')) return { ok: true, data: { entries: [] } };
        return { ok: true, data: baseStatus };
      },
    }),
  });
  renderer.mount(clientModule.__test.SettingsPage, { t, initialStatus: baseStatus });
  await flushAsync();
  const text = collectText(renderer.render());
  assert.match(text, /推送登记被拒绝/);
  assert.match(text, /官方推送失败：rate_limited/);

  // 隧道断开：只提示 self 设备暂不可用（official 直连不受影响）
  const offline = {
    ...baseStatus,
    group: { ...baseStatus.group, connected: false },
    push: { ...baseStatus.push, official: { ...baseStatus.push.official, lastError: null } },
  };
  const renderer2 = createStatefulRenderer();
  const setup2 = setupClientWithReact(renderer2.react, {
    fetchImpl: async (url) => ({
      ok: true,
      status: 200,
      async json() {
        if (String(url).includes('/audit')) return { ok: true, data: { entries: [] } };
        return { ok: true, data: offline };
      },
    }),
  });
  renderer2.mount(setup2.clientModule.__test.SettingsPage, { t: setup2.t, initialStatus: offline });
  await flushAsync();
  const text2 = collectText(renderer2.render());
  assert.match(text2, /隧道未连接：私有推送暂不可用；官方推送不受影响/);
});
