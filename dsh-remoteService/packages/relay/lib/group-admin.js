/**
 * 群体服务版部署方后台（/__admin，P1 切片 7）。
 *
 * 挂在 relay 控制面（生产即 https://<relayDomain>:<controlPort>），提供：
 *   - 一个纯静态 HTML 管理页（无构建、无外链资源）；
 *   - 一组 JSON API：状态、邀请码创建/列出/撤销、主机列出/撤销。
 *
 * 鉴权：部署方 **admin token**（显式配置 group.adminToken，或首次启动自动生成到
 * `<group.json 目录>/admin-token`，0600）。请求头 `Authorization: Bearer <token>`，
 * 常量时间比较；**不使用查询参数 token / 来源 IP 作为身份**（AGENTS 五.1）。
 * token 只存本机/服务端，不打印到日志；页面里由部署方手动粘贴一次（存 localStorage）。
 */

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { safeEqualStrings } from 'dsh-remote-protocol';
import { createInvite, listHosts, listInvites, revokeHost, revokeInvite } from './group.js';

export const GROUP_ADMIN_BASE = '/__admin';
export const GROUP_ADMIN_API_BASE = '/__admin/api';
const ADMIN_TOKEN_MODE = 0o600;
const ADMIN_TOKEN_DIR_MODE = 0o700;

/**
 * 取 admin token：显式 token > token 文件 > 首次生成（写 0600）。
 * @param {{token?: string, tokenFile?: string, logger?: any}} [options]
 * @returns {{token: string, file?: string, generated: boolean}}
 */
export function ensureAdminToken(options = {}) {
  const explicit = typeof options.token === 'string' ? options.token.trim() : '';
  if (explicit !== '') return { token: explicit, generated: false };
  const file = resolve(options.tokenFile ?? join(process.cwd(), 'admin-token'));
  if (existsSync(file)) {
    const stored = readFileSync(file, 'utf8').trim();
    if (stored !== '') return { token: stored, file, generated: false };
  }
  const token = randomBytes(32).toString('base64url');
  mkdirSync(dirname(file), { recursive: true, mode: ADMIN_TOKEN_DIR_MODE });
  writeFileSync(file, `${token}\n`, { mode: ADMIN_TOKEN_MODE });
  try {
    chmodSync(file, ADMIN_TOKEN_MODE);
  } catch {
    /* ignore */
  }
  return { token, file, generated: true };
}

/** 简单失败限速：同 IP 5 分钟 10 次鉴权失败后 429。 */
class AdminFailureLimiter {
  constructor({ maxFailures = 10, windowMs = 5 * 60 * 1000 } = {}) {
    this.maxFailures = maxFailures;
    this.windowMs = windowMs;
    /** @type {Map<string, number[]>} */
    this.failures = new Map();
  }

  /** @param {string} key */
  hit(key) {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const entries = (this.failures.get(key) ?? []).filter((ts) => ts > cutoff);
    entries.push(now);
    this.failures.set(key, entries);
    return entries.length >= this.maxFailures;
  }

  reset(key) {
    this.failures.delete(key);
  }
}

/**
 * @param {object} options
 * @param {string} options.groupFile group.json 路径
 * @param {string} options.domain relay 域名
 * @param {number} options.mobilePort 下发给主机的手机访问端口
 * @param {string} options.adminToken 部署方 admin token
 * @param {() => string[]} [options.onlineHostIds]
 * @param {any} [options.logger]
 */
export function createGroupAdminHandler(options) {
  const { groupFile, domain, mobilePort, adminToken } = options;
  const onlineHostIds = typeof options.onlineHostIds === 'function' ? options.onlineHostIds : () => [];
  const logger = options.logger ?? { info() {}, warn() {}, error() {}, debug() {} };
  const limiter = new AdminFailureLimiter();

  /** @param {import('node:http').IncomingMessage} req @param {number} status @param {any} body @param {Record<string,string>} [headers] */
  function sendJson(res, status, body, headers) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-length': Buffer.byteLength(payload),
      ...(headers ?? {}),
    });
    res.end(payload);
  }

  /** @param {import('node:http').IncomingMessage} req */
  function bearerToken(req) {
    const header = req.headers.authorization;
    if (typeof header !== 'string') return '';
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    return match ? match[1].trim() : '';
  }

  /** @param {import('node:http').IncomingMessage} req */
  async function readBody(req, limit = 16 * 1024) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > limit) throw Object.assign(new Error('request body too large'), { status: 413 });
      chunks.push(chunk);
    }
    if (chunks.length === 0) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw Object.assign(new Error('request body must be valid JSON'), { status: 400 });
    }
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  return async function handleGroupAdminRequest(req, res) {
    let pathname = '/';
    try {
      pathname = new URL(req.url ?? '/', 'http://relay.invalid').pathname;
    } catch {
      pathname = req.url ?? '/';
    }

    // 管理页本身不含数据（token 由部署方手动粘贴）；仍加 no-store。
    if (pathname === GROUP_ADMIN_BASE || pathname === `${GROUP_ADMIN_BASE}/`) {
      const html = renderAdminPage({ domain });
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
        'content-length': Buffer.byteLength(html),
      });
      res.end(html);
      return;
    }

    if (!pathname.startsWith(GROUP_ADMIN_API_BASE)) {
      sendJson(res, 404, { ok: false, error: { code: 'not_found' } });
      return;
    }

    const remote = req.socket?.remoteAddress ?? 'unknown';
    const provided = bearerToken(req);
    if (provided === '' || !safeEqualStrings(provided, adminToken)) {
      const blocked = limiter.hit(remote);
      logger.warn(`admin: rejected request from ${remote} (${pathname})`);
      sendJson(res, blocked ? 429 : 401, { ok: false, error: { code: blocked ? 'rate_limited' : 'unauthorized' } });
      return;
    }
    limiter.reset(remote);

    const sub = pathname.slice(GROUP_ADMIN_API_BASE.length) || '/';
    const method = req.method ?? 'GET';
    try {
      if (sub === '/state' && method === 'GET') {
        const online = new Set(onlineHostIds());
        const hosts = listHosts(groupFile).map((host) => ({ ...host, online: online.has(host.hostId) }));
        sendJson(res, 200, {
          ok: true,
          data: {
            domain,
            mobilePort,
            registrationEnabled: true,
            hosts,
            invites: listInvites(groupFile),
          },
        });
        return;
      }
      if (sub === '/invites' && method === 'POST') {
        const body = await readBody(req);
        try {
          const maxUses = body.maxUses === undefined ? undefined : Number(body.maxUses);
          const expiresInHours = body.expiresInHours === undefined ? undefined : Number(body.expiresInHours);
          const expiresInMs = expiresInHours === undefined || expiresInHours === 0
            ? (expiresInHours === 0 ? 0 : undefined)
            : expiresInHours * 60 * 60 * 1000;
          const invite = createInvite(groupFile, {
            note: body.note,
            maxUses,
            ...(expiresInMs === undefined ? {} : { expiresInMs }),
          });
          logger.info(`admin: created invite ${invite.inviteId} (maxUses=${invite.maxUses})`);
          sendJson(res, 200, { ok: true, data: invite });
        } catch (error) {
          sendJson(res, 400, { ok: false, error: { code: 'invalid_request', message: error?.message } });
        }
        return;
      }
      const inviteRevoke = /^\/invites\/([^/]+)\/revoke$/.exec(sub);
      if (inviteRevoke && method === 'POST') {
        const revoked = revokeInvite(groupFile, decodeURIComponent(inviteRevoke[1]));
        logger.info(`admin: revoke invite ${inviteRevoke[1]}: ${revoked}`);
        sendJson(res, revoked ? 200 : 404, revoked
          ? { ok: true, data: { revoked: true } }
          : { ok: false, error: { code: 'invite_not_found' } });
        return;
      }
      const hostRevoke = /^\/hosts\/([^/]+)\/revoke$/.exec(sub);
      if (hostRevoke && method === 'POST') {
        const hostId = decodeURIComponent(hostRevoke[1]).toLowerCase();
        const revoked = revokeHost(groupFile, hostId);
        logger.info(`admin: revoke host ${hostId}: ${revoked}`);
        sendJson(res, revoked ? 200 : 404, revoked
          ? { ok: true, data: { revoked: true, hostId } }
          : { ok: false, error: { code: 'host_not_found' } });
        return;
      }
      sendJson(res, 404, { ok: false, error: { code: 'not_found' } });
    } catch (error) {
      const status = error && error.status ? error.status : 500;
      if (status >= 500) logger.error(`admin: ${pathname} failed: ${error && error.message ? error.message : String(error)}`);
      sendJson(res, status, { ok: false, error: { code: status >= 500 ? 'internal' : 'invalid_request', message: error?.message } });
    }
  };
}

/**
 * 后台页面（纯静态、无外部资源；token 仅保存在浏览器 localStorage）。
 * @param {{domain: string}} options
 */
export function renderAdminPage(options = {}) {
  const domain = String(options.domain ?? '');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DSH Remote · 群体服务后台</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.5 -apple-system, "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif;
  background: #0b1220; color: #e7ecf5; }
header { padding: 18px 22px; border-bottom: 1px solid #1e2a3f; display: flex; gap: 14px; align-items: baseline; flex-wrap: wrap; }
h1 { font-size: 18px; margin: 0; }
.sub { color: #8f9bb3; font-size: 12px; }
main { padding: 20px 22px; max-width: 1080px; display: grid; gap: 18px; }
.card { background: #111a29; border: 1px solid #1e2a3f; border-radius: 12px; padding: 16px; }
.card h2 { font-size: 14px; margin: 0 0 12px; color: #b7c3d8; font-weight: 600; }
.row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
input { background: #0b1220; border: 1px solid #2a3b57; color: #e7ecf5; border-radius: 8px; padding: 8px 10px; font: inherit; }
input[type=number] { width: 120px; }
button { background: #2563eb; border: 0; color: #fff; border-radius: 8px; padding: 8px 14px; font: inherit; cursor: pointer; }
button.secondary { background: #22314b; }
button.danger { background: #b91c1c; }
button:disabled { opacity: .5; cursor: default; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #1b2740; font-size: 13px; }
th { color: #8f9bb3; font-weight: 500; }
code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px; }
.tag { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px; border: 1px solid #2a3b57; color: #b7c3d8; }
.tag.good { border-color: #14532d; color: #4ade80; }
.tag.warn { border-color: #78350f; color: #fbbf24; }
.tag.bad { border-color: #7f1d1d; color: #f87171; }
.stats { display: flex; gap: 18px; flex-wrap: wrap; color: #b7c3d8; }
.stats b { color: #e7ecf5; }
.flash { min-height: 20px; color: #fbbf24; font-size: 13px; }
.muted { color: #8f9bb3; font-size: 12px; }
.tokenbox { display: flex; gap: 8px; flex-wrap: wrap; }
</style></head>
<body>
<header><h1>DSH Remote · 群体服务后台</h1><span class="sub">${domain ? `relay: ${domain}` : 'self-hosted group service'}</span></header>
<main>
  <section class="card" id="auth-card">
    <h2>部署方访问令牌</h2>
    <p class="muted">令牌在服务端 <code>admin-token</code> 文件或 <code>group.adminToken</code> 里；只保存在本浏览器 localStorage，不会外发。</p>
    <div class="tokenbox">
      <input id="token" type="password" placeholder="粘贴 admin token" style="flex:1;min-width:260px">
      <button id="save-token">保存</button>
      <button id="clear-token" class="secondary">清除</button>
    </div>
  </section>

  <section class="card">
    <h2>概览</h2>
    <div class="stats" id="stats">加载中…</div>
    <div class="flash" id="flash"></div>
  </section>

  <section class="card">
    <h2>生成邀请码</h2>
    <div class="row">
      <input id="invite-note" placeholder="备注（朋友名）" style="flex:1;min-width:180px">
      <label class="muted">可用次数 <input id="invite-uses" type="number" min="1" max="1000" value="1"></label>
      <label class="muted">有效期(小时) <input id="invite-hours" type="number" min="0" max="8760" value="168"></label>
      <button id="create-invite">生成</button>
    </div>
    <p class="muted">邀请码只在生成时显示一次，请立即发给对方；0 小时 = 永不过期。</p>
    <div id="new-invite"></div>
  </section>

  <section class="card">
    <h2>邀请码</h2>
    <table><thead><tr><th>备注</th><th>邀请码</th><th>已用/上限</th><th>过期</th><th>状态</th><th></th></tr></thead><tbody id="invites"></tbody></table>
    <p class="muted">邀请码保存在服务器 group.json（0600），后台只显示复制按钮、不展示明文；列表里的 <code>inv_…</code> 只是内部 ID，不能用于注册。</p>
  </section>

  <section class="card">
    <h2>主机</h2>
    <table><thead><tr><th>主机 ID</th><th>名称</th><th>端口</th><th>隧道</th><th>状态</th><th></th></tr></thead><tbody id="hosts"></tbody></table>
  </section>
</main>
<script>
(function () {
  var TOKEN_KEY = 'dsh.group.admin.token';
  var token = '';
  var state = null;
  var flashTimer = null;
  function $(id) { return document.getElementById(id); }
  function flash(msg) {
    var el = $('flash');
    el.textContent = msg || '';
    if (flashTimer) clearTimeout(flashTimer);
    if (msg) flashTimer = setTimeout(function () { el.textContent = ''; }, 6000);
  }
  function loadToken() {
    try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { token = ''; }
    $('token').value = token ? '••••••••' : '';
  }
  function authHeaders() {
    return token ? { authorization: 'Bearer ' + token } : {};
  }
  function api(path, options) {
    options = options || {};
    options.headers = Object.assign({}, options.headers || {}, authHeaders());
    return fetch('/__admin/api' + path, options).then(function (res) {
      return res.text().then(function (text) {
        var json = null;
        try { json = JSON.parse(text); } catch (e) { /* ignore */ }
        if (!res.ok) {
          var code = json && json.error ? json.error.code : ('http_' + res.status);
          var err = new Error(code);
          err.status = res.status;
          throw err;
        }
        return json && json.data ? json.data : json;
      });
    });
  }
  function fmtTime(ms) {
    if (!ms) return '—';
    var d = new Date(ms);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
      + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  function el(tag, text, className) {
    var node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  }
  function tag(text, cls) { return el('span', text, 'tag' + (cls ? ' ' + cls : '')); }
  function copyText(text) {
    if (!navigator.clipboard) { flash('浏览器不支持自动复制，请手动选择复制'); return; }
    navigator.clipboard.writeText(text).then(function () { flash('邀请码已复制'); }, function () { flash('复制失败，请手动选择复制'); });
  }
  function render() {
    if (!state) return;
    var hosts = state.hosts || [];
    var invites = state.invites || [];
    var online = hosts.filter(function (h) { return h.online; }).length;
    var active = hosts.filter(function (h) { return !h.revoked; }).length;
    $('stats').innerHTML = '';
    var parts = [
      ['域名', state.domain || '—'],
      ['手机端口', state.mobilePort || '—'],
      ['主机', active + ' 台有效 / ' + hosts.length + ' 台'],
      ['在线隧道', online + ' 台'],
      ['邀请码', invites.filter(function (i) { return !i.revoked && !i.expired && i.remaining > 0; }).length + ' 个可用']
    ];
    parts.forEach(function (pair) {
      var box = el('span');
      box.appendChild(el('span', pair[0] + '：', 'muted'));
      box.appendChild(el('b', pair[1]));
      $('stats').appendChild(box);
    });
    var invBody = $('invites');
    invBody.innerHTML = '';
    if (invites.length === 0) {
      var tr = el('tr'); var td = el('td', '暂无邀请码', 'muted'); td.colSpan = 6; tr.appendChild(td); invBody.appendChild(tr);
    }
    invites.forEach(function (invite) {
      var tr = el('tr');
      var noteCell = el('td', invite.note || '—');
      var idHint = el('div', invite.inviteId, 'muted');
      noteCell.appendChild(idHint);
      tr.appendChild(noteCell);

      var codeCell = el('td');
      if (invite.code) {
        codeCell.appendChild(el('span', '••••••••', 'muted'));
        var copyBtn = el('button', '复制', 'secondary');
        copyBtn.style.marginLeft = '6px';
        copyBtn.style.padding = '4px 10px';
        copyBtn.addEventListener('click', function () { copyText(invite.code); });
        codeCell.appendChild(copyBtn);
      } else {
        codeCell.appendChild(el('span', '旧邀请码（仅哈希，不可显示；请重新生成）', 'muted'));
      }
      tr.appendChild(codeCell);

      tr.appendChild(el('td', invite.used + ' / ' + invite.maxUses));
      tr.appendChild(el('td', invite.expiresAt ? fmtTime(invite.expiresAt) : '永不过期'));
      var statusCell = el('td');
      if (invite.revoked) statusCell.appendChild(tag('已撤销', 'bad'));
      else if (invite.expired) statusCell.appendChild(tag('已过期', 'warn'));
      else if (invite.remaining <= 0) statusCell.appendChild(tag('已用尽', 'warn'));
      else statusCell.appendChild(tag('可用', 'good'));
      tr.appendChild(statusCell);
      var action = el('td');
      if (!invite.revoked) {
        var btn = el('button', '撤销', 'danger');
        btn.addEventListener('click', function () { revokeInvite(invite.inviteId); });
        action.appendChild(btn);
      }
      tr.appendChild(action);
      invBody.appendChild(tr);
    });
    var hostBody = $('hosts');
    hostBody.innerHTML = '';
    if (hosts.length === 0) {
      var tr2 = el('tr'); var td2 = el('td', '暂无已注册主机', 'muted'); td2.colSpan = 6; tr2.appendChild(td2); hostBody.appendChild(tr2);
    }
    hosts.forEach(function (host) {
      var tr = el('tr');
      tr.appendChild(el('td', host.hostId));
      tr.appendChild(el('td', host.hostName || '—'));
      tr.appendChild(el('td', host.mobilePort));
      var tunnel = el('td'); tunnel.appendChild(host.online ? tag('在线', 'good') : tag('离线', 'warn')); tr.appendChild(tunnel);
      var st = el('td'); st.appendChild(host.revoked ? tag('已撤销', 'bad') : tag('正常')); tr.appendChild(st);
      var action2 = el('td');
      if (!host.revoked) {
        var btn2 = el('button', '撤销', 'danger');
        btn2.addEventListener('click', function () { revokeHost(host.hostId); });
        action2.appendChild(btn2);
      }
      tr.appendChild(action2);
      hostBody.appendChild(tr);
    });
  }
  function refresh() {
    if (!token) { state = null; $('stats').textContent = '请先填写部署方访问令牌'; return; }
    return api('/state').then(function (data) { state = data; render(); flash(''); })
      .catch(function (err) {
        if (err.status === 401 || err.status === 429) flash(err.status === 429 ? '尝试过于频繁，请稍后再试' : '令牌不正确或已失效');
        else flash('加载失败：' + (err.message || err));
      });
  }
  function revokeInvite(id) {
    if (!confirm('撤销邀请码 ' + id + '？')) return;
    api('/invites/' + encodeURIComponent(id) + '/revoke', { method: 'POST' })
      .then(function () { flash('已撤销 ' + id); return refresh(); })
      .catch(function (err) { flash('撤销失败：' + err.message); });
  }
  function revokeHost(hostId) {
    if (!confirm('撤销主机 ' + hostId + '？该主机设备需要重新配对。')) return;
    api('/hosts/' + encodeURIComponent(hostId) + '/revoke', { method: 'POST' })
      .then(function () { flash('已撤销主机 ' + hostId); return refresh(); })
      .catch(function (err) { flash('撤销失败：' + err.message); });
  }
  $('save-token').addEventListener('click', function () {
    var value = $('token').value.trim();
    if (/^•+$/.test(value)) { refresh(); return; }
    if (!value) { flash('请粘贴 admin token'); return; }
    token = value;
    try { localStorage.setItem(TOKEN_KEY, token); } catch (e) { /* ignore */ }
    $('token').value = '••••••••';
    refresh();
  });
  $('clear-token').addEventListener('click', function () {
    token = '';
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
    $('token').value = '';
    state = null;
    flash('已清除本地令牌');
  });
  $('create-invite').addEventListener('click', function () {
    var body = {
      note: $('invite-note').value.trim(),
      maxUses: Number($('invite-uses').value) || 1,
      expiresInHours: Number($('invite-hours').value) || 0
    };
    api('/invites', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (data) {
        $('new-invite').innerHTML = '';
        var box = el('div');
        box.appendChild(el('span', '邀请码已生成（已隐藏，点击复制后发给对方）：', 'muted'));
        var copy = el('button', '复制邀请码', 'secondary');
        copy.addEventListener('click', function () { copyText(data.code); });
        box.appendChild(copy);
        $('new-invite').appendChild(box);
        $('invite-note').value = '';
        return refresh();
      })
      .catch(function (err) { flash('生成失败：' + err.message); });
  });
  loadToken();
  refresh();
  setInterval(function () { if (token) refresh(); }, 10000);
})();
</script>
</body></html>`;
}
