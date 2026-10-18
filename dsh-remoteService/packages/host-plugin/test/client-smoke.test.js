/**
 * dsh-remote-service —— Web Client 半冒烟测试
 * ============================================================================
 * 不装 React、不起浏览器：用 vm 跑一遍 client.js（它只注册 __ModuleLoader__ 工厂），
 * 再用最小 fake React + fake ctx/slots/locale 调 factory 与 apply，断言：
 *   1. 工厂执行不抛错，返回 { inject, apply }；
 *   2. apply 通过 ctx.slots.inject 注册 sidebar.footer.action 与 settings.section；
 *   3. 加载/注册阶段没有任何网络请求（组件 useEffect 才拉数据）；
 *   4. 样式只注入一次、locale 字典 zh/en 键集合一致；
 *   5. 各页面组件顶层渲染不抛错（hooks 用 no-op stub）。
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

function createFakeReact() {
  const noop = () => {};
  const fakeReact = {
    createElement(type, props, ...children) {
      // 贴近 React：children 也挂到 props.children（Section/Btn 这类靠它渲染）。
      const nextProps = { ...(props || {}) };
      if (children.length === 1) nextProps.children = children[0];
      else if (children.length > 1) nextProps.children = children;
      return { type, props: nextProps, children };
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
  return fakeReact;
}

/* ────────────────────────── fake 浏览器/模块环境 ────────────────────────── */

function loadBundle() {
  const fetchCalls = [];
  const appendedStyles = [];
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
    addEventListener() {},
    removeEventListener() {},
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
    document: documentStub,
    fetch(...args) {
      fetchCalls.push(args);
      return Promise.reject(new Error('network access is not allowed at load time'));
    },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  vm.runInNewContext(CLIENT_SOURCE, sandbox, { filename: CLIENT_PATH });

  assert.ok(captured, 'client.js 必须通过 window.__ModuleLoader__.load 注册工厂');
  return { captured, fetchCalls, appendedStyles };
}

/* ────────────────────────── fake ctx / slots / locale ────────────────────────── */

function createFakeCtx(options = {}) {
  const injected = [];
  const registered = [];
  const effects = [];
  const localeRegistrations = [];

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
      const disposer = callback();
      return typeof disposer === 'function' ? disposer : () => {};
    },
    get(name) {
      return name === 'slots' ? slots : undefined;
    },
    slots,
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
          let text = dictionaries.zh && dictionaries.zh[key] !== undefined
            ? dictionaries.zh[key]
            : (dictionaries.en && dictionaries.en[key] !== undefined ? dictionaries.en[key] : key);
          if (params) {
            for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, String(value));
          }
          return text;
        };
      },
    };
    ctx.locale = locale;
  }

  return { ctx, injected, registered, effects, localeRegistrations };
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
  const { captured } = loadBundle();
  const clientModule = captured.factory(() => createFakeReact());
  const { ctx, registered, localeRegistrations } = createFakeCtx();
  clientModule.apply(ctx);

  const dictionaries = localeRegistrations[0].dictionaries;
  const t = (key, params) => {
    let text = dictionaries.zh[key] !== undefined ? dictionaries.zh[key] : key;
    if (params) {
      for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, String(value));
    }
    return text;
  };

  // 浅渲染：把元素树里的函数组件继续调用下去，覆盖各组件顶层逻辑。
  function renderTree(node, depth = 0) {
    if (depth > 40) throw new Error('render tree too deep (possible render loop)');
    if (node === null || node === undefined || node === false || node === true) return null;
    if (Array.isArray(node)) return node.map((child) => renderTree(child, depth + 1));
    if (typeof node === 'string' || typeof node === 'number') return node;
    if (typeof node.type === 'function') return renderTree(node.type(node.props), depth + 1);
    return (node.children || []).map((child) => renderTree(child, depth + 1));
  }

  const entry = registered[0].component;
  const settings = registered[1].component;
  assert.ok(entry({ t, wide: true }), '侧栏入口（宽）应返回元素');
  assert.doesNotThrow(() => renderTree(entry({ t, wide: true })), '侧栏入口（宽）渲染树');
  assert.doesNotThrow(() => renderTree(entry({ t, wide: false })), '侧栏入口（窄）渲染树');
  assert.doesNotThrow(() => renderTree(settings({ t })), '设置页渲染树');
});
