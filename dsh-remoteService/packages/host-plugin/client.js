/**
 * dsh-remote-service —— Web Client 半
 * ============================================================================
 * 两个挂载点（与 push-notify / ui-cordis 同一套 __ModuleLoader__ 约定）：
 *   1. sidebar.footer.action —— 侧栏底部、账号行正上方的「远程访问」入口；
 *   2. settings.section      —— 设置里的「远程访问」页（连接配置/配对/设备/审计）。
 * 数据全部走本机管理 API（同源 /api/remote-access/*，契约见 docs/ADMIN-API.md），
 * fetch 一律带 credentials: 'include'；hostToken 只上行不下行，DOM 里永远不回显。
 * 纯前端单文件，无构建步骤：只 require('react')，没有 Node 内置模块。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-remote-service',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    const NS = 'remote-access';
    const API = '/api/remote-access';
    const POLL_MS = 2000;
    const FLASH_GOOD_MS = 2600;
    const FLASH_WARN_MS = 5200;

    /* ────────────────────────── 文案 ────────────────────────── */

    const zh = {
      'page.nav': '远程访问',
      'page.title': '远程访问',
      'page.subtitle': '从手机 App 安全地访问这台电脑上的 DSH。',
      'entry.label': '远程访问',
      'entry.devices': '{count} 台设备',
      'entry.devicesOne': '{count} 台设备',

      'status.loading': '读取中…',
      'status.unknown': '状态未知',
      'status.disabled': '未启用',
      'status.online': '中继在线',
      'status.offline': '中继离线',
      'status.waiting': '等待配对',

      'section.status': '连接状态',
      'section.connection': '连接配置',
      'section.pairing': '设备配对',
      'section.devices': '已配对设备',
      'section.audit': '最近审计',

      'msg.loading': '加载中…',
      'msg.retry': '重试',
      'msg.saved': '已保存',
      'msg.noChanges': '没有需要保存的修改',
      'msg.saveFailed': '保存失败：{message}',
      'msg.loadFailed': '读取失败：{message}',
      'msg.revoked': '设备已撤销',
      'msg.revokeFailed': '撤销失败：{message}',
      'msg.pairCanceled': '已取消配对',
      'msg.pairFailed': '配对操作失败：{message}',
      'msg.paired': '设备已加入',
      'msg.pairDenied': '已拒绝',
      'msg.approveFailed': '确认失败：{message}',

      'btn.save': '保存',
      'btn.saving': '保存中…',
      'btn.cancel': '取消',
      'btn.close': '关闭',
      'btn.regenerate': '重新生成',
      'btn.openPairing': '配对新设备',
      'btn.approvePairing': '允许配对',
      'btn.denyPairing': '拒绝',
      'btn.revoke': '撤销',
      'btn.revokeConfirm': '确认撤销？',

      'sw.enabled': '启用远程访问',
      'sw.enabledNote': '关闭后中继断开，手机将无法访问这台电脑。',
      'sw.requireApproval': '新设备配对需要本机确认',
      'sw.requireApprovalNote': '开启后，手机扫码后还需要在这台电脑上确认一次。',

      'field.relayUrl': '中继地址',
      'field.relayUrlHint': 'wss://relay.example.com:8443',
      'field.relayDomain': '中继域名',
      'field.relayDomainHint': 'relay.example.com',
      'field.relayDomainNote': '主机域名为 <hostId>.<中继域名>。',
      'field.hostId': '主机 ID',
      'field.hostIdHint': 'h_ab12cd34',
      'field.hostToken': '中继主机令牌',
      'field.hostTokenPlaceholder': '已配置，留空保持不变',
      'field.hostName': '主机名称',
      'field.hostNameHint': '手机上显示的名字',
      'field.tlsCertFile': 'TLS 证书路径',
      'field.tlsKeyFile': 'TLS 私钥路径',
      'field.configuredPlaceholder': '已配置，留空保持不变',
      'field.hostTokenEmpty': '未配置，请输入',

      'relay.status': '中继连接',
      'relay.connected': '已连接',
      'relay.disconnected': '未连接',
      'relay.lastError': '最近错误',
      'host.id': '主机 ID',
      'host.name': '主机名称',
      'host.domain': '访问域名',
      'host.fingerprint': '主机指纹',
      'host.cert': 'TLS 证书',
      'host.certInvalid': '证书无效',
      'host.certDev': '开发证书',
      'host.version': '插件版本',

      'pairing.title': '配对新设备',
      'pairing.started': '配对码已生成',
      'pairing.pendingTitle': '待确认的配对请求',
      'pairing.pendingPill': '待确认',
      'pairing.pendingDevice': '设备',
      'pairing.pendingHint': '请确认手机上显示的短码与此处一致，再允许配对。',
      'pairing.newDevice': '新设备',
      'pairing.noSas': '等待手机提交配对信息…',
      'pairing.note': '手机安装 DSH Remote App 扫码',
      'pairing.qrAlt': '配对二维码',
      'pairing.qrFailed': '二维码加载失败，请点击「重新生成」',
      'pairing.noQr': '暂无二维码，正在生成…',
      'pairing.step1': '手机安装 DSH Remote App，用 App 扫描左侧二维码。',
      'pairing.step2': '或手动输入 12 位备用码',
      'pairing.step3': '在手机上核对主机指纹与短码',
      'pairing.step4': '确认后手机将获得设备证书，可随时在设置中撤销。',
      'pairing.step4Note': '证书保存在手机的安全区。',
      'pairing.hostFingerprint': '主机指纹',
      'pairing.sas': '短码 SAS',
      'pairing.expires': '二维码有效期 {time}',
      'pairing.expired': '配对码已过期',
      'pairing.autoRefresh': '过期后自动刷新',
      'pairing.disabledHint': '远程访问未启用。请先在「设置 → 远程访问」中启用。',
      'pairing.disabledShort': '先启用远程访问',
      'pairing.active': '配对进行中',
      'pairing.inactive': '没有进行中的配对',
      'pairing.settingsNote': '点击「配对新设备」生成一次性二维码，2 分钟内有效。',
      'pairing.settingsPendingNote': '有设备正在等待本机确认，点击「配对新设备」完成确认。',
      'pairing.requiresApproval': '本次配对需要在这台电脑上确认。',

      'devices.empty': '还没有配对设备。',
      'devices.revoked': '已撤销',
      'devices.active': '已授权',
      'devices.lastSeen': '最近活跃',
      'devices.never': '从未连接',

      'audit.empty': '还没有审计记录。',
      'audit.ok': '成功',
      'audit.fail': '失败',
      'audit.created': '已创建',
      'audit.paired': '已配对',
      'audit.pending': '待确认',
      'audit.cancelled': '已取消',
      'audit.expired': '已过期',
      'audit.denied': '已拒绝',

      'relative.justNow': '刚刚',
      'relative.minutes': '{count} 分钟前',
      'relative.hours': '{count} 小时前',
      'relative.days': '{count} 天前',

      'action.pairing': '设备配对',
      'action.pairRequest': '配对请求',
      'action.deviceAuth': '设备认证',
      'action.wsAuth': 'WebSocket 认证',
      'action.deviceRevoke': '撤销设备',
      'action.relayDisconnect': '中继断开',
      'action.proxyDeny': '拒绝远程请求',
      'action.wsUpgrade': 'WebSocket 升级',
      'action.pairStart': '开始配对',
      'action.pairCancel': '取消配对',
      'action.pairApprove': '确认配对',
      'action.pairDeny': '拒绝配对',
      'action.devicePair': '设备配对',
      'action.relayConnect': '连接中继',
      'action.tunnelRequest': '远程请求',
      'action.configUpdate': '修改配置',
    };

    const en = {
      'page.nav': 'Remote access',
      'page.title': 'Remote access',
      'page.subtitle': 'Access DSH on this computer safely from the mobile app.',
      'entry.label': 'Remote access',
      'entry.devices': '{count} devices',
      'entry.devicesOne': '{count} device',

      'status.loading': 'Loading…',
      'status.unknown': 'Status unknown',
      'status.disabled': 'Disabled',
      'status.online': 'Relay online',
      'status.offline': 'Relay offline',
      'status.waiting': 'Waiting for pairing',

      'section.status': 'Connection status',
      'section.connection': 'Connection settings',
      'section.pairing': 'Device pairing',
      'section.devices': 'Paired devices',
      'section.audit': 'Recent audit',

      'msg.loading': 'Loading…',
      'msg.retry': 'Retry',
      'msg.saved': 'Saved',
      'msg.noChanges': 'Nothing to save',
      'msg.saveFailed': 'Save failed: {message}',
      'msg.loadFailed': 'Load failed: {message}',
      'msg.revoked': 'Device revoked',
      'msg.revokeFailed': 'Revoke failed: {message}',
      'msg.pairCanceled': 'Pairing canceled',
      'msg.pairFailed': 'Pairing action failed: {message}',
      'msg.paired': 'Device added',
      'msg.pairDenied': 'Pairing denied',
      'msg.approveFailed': 'Approval failed: {message}',

      'btn.save': 'Save',
      'btn.saving': 'Saving…',
      'btn.cancel': 'Cancel',
      'btn.close': 'Close',
      'btn.regenerate': 'Regenerate',
      'btn.openPairing': 'Pair new device',
      'btn.approvePairing': 'Allow pairing',
      'btn.denyPairing': 'Deny',
      'btn.revoke': 'Revoke',
      'btn.revokeConfirm': 'Confirm revoke?',

      'sw.enabled': 'Enable remote access',
      'sw.enabledNote': 'Disabling disconnects the relay; the phone can no longer reach this computer.',
      'sw.requireApproval': 'Require confirmation on this computer for new pairings',
      'sw.requireApprovalNote': 'When on, a scanned phone must also be approved on this computer.',

      'field.relayUrl': 'Relay URL',
      'field.relayUrlHint': 'wss://relay.example.com:8443',
      'field.relayDomain': 'Relay domain',
      'field.relayDomainHint': 'relay.example.com',
      'field.relayDomainNote': 'Host domain is <hostId>.<relay domain>.',
      'field.hostId': 'Host ID',
      'field.hostIdHint': 'h_ab12cd34',
      'field.hostToken': 'Relay host token',
      'field.hostTokenPlaceholder': 'Configured — leave empty to keep',
      'field.hostName': 'Host name',
      'field.hostNameHint': 'Shown on the phone',
      'field.tlsCertFile': 'TLS certificate path',
      'field.tlsKeyFile': 'TLS private key path',
      'field.configuredPlaceholder': 'Configured — leave empty to keep',
      'field.hostTokenEmpty': 'Not configured — enter it',

      'relay.status': 'Relay connection',
      'relay.connected': 'Connected',
      'relay.disconnected': 'Disconnected',
      'relay.lastError': 'Last error',
      'host.id': 'Host ID',
      'host.name': 'Host name',
      'host.domain': 'Domain',
      'host.fingerprint': 'Host fingerprint',
      'host.cert': 'TLS certificate',
      'host.certInvalid': 'Invalid certificate',
      'host.certDev': 'Development certificate',
      'host.version': 'Plugin version',

      'pairing.title': 'Pair a new device',
      'pairing.started': 'Pairing code generated',
      'pairing.pendingTitle': 'Pending pairing request',
      'pairing.pendingPill': 'Pending approval',
      'pairing.pendingDevice': 'Device',
      'pairing.pendingHint': 'Confirm the short code shown on the phone matches this one before allowing.',
      'pairing.newDevice': 'New device',
      'pairing.noSas': 'Waiting for the phone to submit pairing details…',
      'pairing.note': 'Install DSH Remote App on the phone and scan the code',
      'pairing.qrAlt': 'Pairing QR code',
      'pairing.qrFailed': 'Failed to load the QR code — click Regenerate',
      'pairing.noQr': 'No QR code yet — generating…',
      'pairing.step1': 'Install DSH Remote App on the phone and scan the QR code on the left.',
      'pairing.step2': 'Or enter the 12-character backup code manually',
      'pairing.step3': 'Verify the host fingerprint and short code on the phone',
      'pairing.step4': 'The phone then gets a device certificate; revoke it here at any time.',
      'pairing.step4Note': 'The certificate is stored in the phone secure enclave / keystore.',
      'pairing.hostFingerprint': 'Host fingerprint',
      'pairing.sas': 'Short code (SAS)',
      'pairing.expires': 'QR code expires in {time}',
      'pairing.expired': 'Pairing code expired',
      'pairing.autoRefresh': 'Refreshes automatically on expiry',
      'pairing.disabledHint': 'Remote access is disabled. Enable it in Settings → Remote access first.',
      'pairing.disabledShort': 'Enable remote access first',
      'pairing.active': 'Pairing in progress',
      'pairing.inactive': 'No active pairing',
      'pairing.settingsNote': 'Click Pair new device to generate a one-time QR code valid for 2 minutes.',
      'pairing.settingsPendingNote': 'A device is waiting for confirmation here; click Pair new device to approve or deny it.',
      'pairing.requiresApproval': 'This pairing requires confirmation on this computer.',

      'devices.empty': 'No paired devices yet.',
      'devices.revoked': 'Revoked',
      'devices.active': 'Active',
      'devices.lastSeen': 'Last seen',
      'devices.never': 'Never connected',

      'audit.empty': 'No audit entries yet.',
      'audit.ok': 'OK',
      'audit.fail': 'Failed',
      'audit.created': 'Created',
      'audit.paired': 'Paired',
      'audit.pending': 'Pending',
      'audit.cancelled': 'Cancelled',
      'audit.expired': 'Expired',
      'audit.denied': 'Denied',

      'relative.justNow': 'just now',
      'relative.minutes': '{count} min ago',
      'relative.hours': '{count} h ago',
      'relative.days': '{count} d ago',

      'action.pairing': 'Device pairing',
      'action.pairRequest': 'Pairing request',
      'action.deviceAuth': 'Device auth',
      'action.wsAuth': 'WebSocket auth',
      'action.deviceRevoke': 'Device revoked',
      'action.relayDisconnect': 'Relay disconnected',
      'action.proxyDeny': 'Remote request denied',
      'action.wsUpgrade': 'WebSocket upgrade',
      'action.pairStart': 'Pairing started',
      'action.pairCancel': 'Pairing canceled',
      'action.pairApprove': 'Pairing approved',
      'action.pairDeny': 'Pairing denied',
      'action.devicePair': 'Device paired',
      'action.relayConnect': 'Relay connected',
      'action.tunnelRequest': 'Remote request',
      'action.configUpdate': 'Config updated',
    };

    function makeTranslator(dicts) {
      return (key, params) => {
        let text = dicts.zh[key] !== undefined ? dicts.zh[key] : (dicts.en[key] !== undefined ? dicts.en[key] : key);
        if (params) {
          for (const [name, value] of Object.entries(params)) {
            text = text.replaceAll(`{${name}}`, String(value));
          }
        }
        return text;
      };
    }

    /* ────────────────────────── HTTP ────────────────────────── */

    async function requestJson(path, options) {
      const response = await fetch(API + path, {
        credentials: 'include',
        cache: 'no-store',
        ...options,
      });
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (body && body.ok === false) {
        const detail = body.error || {};
        const error = new Error(detail.message || detail.code || `HTTP ${response.status}`);
        error.code = detail.code;
        throw error;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, 'data')) return body.data;
      return body;
    }

    const jget = (path) => requestJson(path);
    const jpost = (path, body) => requestJson(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body === undefined ? {} : body),
    });

    /* ────────────────────────── 数据小工具 ────────────────────────── */

    function formatError(error) {
      if (!error) return 'unknown error';
      if (error.message) return String(error.message);
      if (error.code) return String(error.code);
      return String(error);
    }

    function asTimestamp(value) {
      const number = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(number) || number <= 0) return 0;
      return number < 1e12 ? Math.round(number * 1000) : Math.round(number);
    }

    function fmtTime(value) {
      const ts = asTimestamp(value);
      if (ts === 0) return '';
      const date = new Date(ts);
      if (Number.isNaN(date.getTime())) return '';
      return date.toLocaleString(undefined, { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    }

    function fmtRelative(value, t) {
      const ts = asTimestamp(value);
      if (ts === 0) return t('relative.justNow');
      const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
      if (seconds < 60) return t('relative.justNow');
      if (seconds < 3600) return t('relative.minutes', { count: Math.floor(seconds / 60) });
      if (seconds < 86400) return t('relative.hours', { count: Math.floor(seconds / 3600) });
      if (seconds < 86400 * 30) return t('relative.days', { count: Math.floor(seconds / 86400) });
      return fmtTime(ts);
    }

    /** 与 @dsh-remote-protocol shortFingerprint 相同的分组算法（仅供屏幕人工核对）。 */
    function shortFingerprint(fingerprint) {
      const clean = String(fingerprint || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      const groups = [];
      for (let index = 0; index < 4 && index * 4 < clean.length; index += 1) {
        groups.push(clean.slice(index * 4, (index + 1) * 4));
      }
      return groups.join(' · ');
    }

    /** Crockford base32 备用码按 4 位分组，便于人眼输入。 */
    function groupCode(code) {
      const clean = String(code || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      if (clean === '') return '';
      const parts = [];
      for (let index = 0; index < clean.length; index += 4) parts.push(clean.slice(index, index + 4));
      return parts.join('-');
    }

    function formatCountdown(ms) {
      const total = Math.max(0, Math.ceil(ms / 1000));
      const minutes = Math.floor(total / 60);
      const seconds = total % 60;
      return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }

    function platformLabel(platform) {
      const value = String(platform || '');
      if (value === '') return '';
      if (value === 'ios') return 'iOS';
      if (value === 'android') return 'Android';
      if (value === 'macos') return 'macOS';
      if (value === 'windows') return 'Windows';
      if (value === 'web') return 'Web';
      return value;
    }

    function activeDevices(status) {
      const list = status && Array.isArray(status.devices) ? status.devices : [];
      return list.filter((device) => device && !(device.revokedAt !== null && device.revokedAt !== undefined && Number(device.revokedAt) > 0));
    }

    function pickRequireApproval(status) {
      if (!status) return false;
      if (status.config && typeof status.config.requireApproval === 'boolean') return status.config.requireApproval;
      if (status.pairing && typeof status.pairing.requiresApproval === 'boolean') return status.pairing.requiresApproval;
      return false;
    }

    /** status 里没有 config.relayDomain 时，从 <hostId>.<relayDomain> 反推。 */
    function deriveRelayDomain(status) {
      const host = status && status.host ? status.host : {};
      const config = status && status.config ? status.config : {};
      if (config.relayDomain !== undefined && config.relayDomain !== null) return String(config.relayDomain);
      const domain = String(host.domain || '');
      const hostId = String(host.id || '');
      if (domain !== '' && hostId !== '' && domain.startsWith(`${hostId}.`)) return domain.slice(hostId.length + 1);
      return '';
    }

    function draftFromStatus(status, previous) {
      const prev = previous || {};
      const host = status && status.host ? status.host : {};
      const relay = status && status.relay ? status.relay : {};
      const tls = host.tls ? host.tls : {};
      const config = status && status.config ? status.config : {};
      const stringOrPrevious = (value, fallback) => (value === undefined || value === null ? fallback : String(value));
      const firstDefined = (first, second) => (first !== undefined && first !== null ? first : second);
      // 密钥类字段 host 只回 'configured' / configured 布尔，不回明文：编辑框留空 + 占位提示。
      const tlsCertFileConfigured = config.tlsCertFile === 'configured'
        || config.tlsCertFileConfigured === true
        || prev.tlsCertFileConfigured === true;
      const tlsKeyFileConfigured = config.tlsKeyFileConfigured === true || prev.tlsKeyFileConfigured === true;
      const hostTokenConfigured = config.hostTokenConfigured === true || prev.hostTokenConfigured === true;
      const certValue = tlsCertFileConfigured ? '' : firstDefined(config.tlsCertFile, tls.certFile);
      return {
        enabled: config.enabled !== undefined ? config.enabled === true : (status ? status.enabled === true : false),
        relayUrl: stringOrPrevious(firstDefined(config.relayUrl, relay.url), prev.relayUrl || ''),
        hostId: stringOrPrevious(firstDefined(config.hostId, host.id), prev.hostId || ''),
        relayDomain: stringOrPrevious(deriveRelayDomain(status), prev.relayDomain || ''),
        hostToken: '',
        hostName: stringOrPrevious(firstDefined(config.hostName, host.name), prev.hostName || ''),
        tlsCertFile: stringOrPrevious(certValue, prev.tlsCertFile || ''),
        tlsKeyFile: stringOrPrevious(firstDefined(config.tlsKeyFile, tls.keyFile), prev.tlsKeyFile || ''),
        requireApproval: pickRequireApproval(status),
        tlsCertFileConfigured,
        tlsKeyFileConfigured,
        hostTokenConfigured,
      };
    }

    function normalizeAudit(data) {
      if (Array.isArray(data)) return data;
      if (data && Array.isArray(data.entries)) return data.entries;
      if (data && Array.isArray(data.audit)) return data.audit;
      if (data && Array.isArray(data.rows)) return data.rows;
      return [];
    }

    const ACTION_KEYS = {
      pairing: 'action.pairing',
      'pair-request': 'action.pairRequest',
      'device-auth': 'action.deviceAuth',
      'ws-auth': 'action.wsAuth',
      'device-revoke': 'action.deviceRevoke',
      'relay-disconnect': 'action.relayDisconnect',
      'proxy-deny': 'action.proxyDeny',
      'ws-upgrade': 'action.wsUpgrade',
      'pair.start': 'action.pairStart',
      'pair.cancel': 'action.pairCancel',
      'pair.approve': 'action.pairApprove',
      'pair.deny': 'action.pairDeny',
      'device.pair': 'action.devicePair',
      'device.revoke': 'action.deviceRevoke',
      'relay.connect': 'action.relayConnect',
      'tunnel.request': 'action.tunnelRequest',
      'config.update': 'action.configUpdate',
    };

    function actionLabel(action, t) {
      const raw = String(action || '');
      const key = ACTION_KEYS[raw];
      return key ? t(key) : raw;
    }

    const RESULT_KEYS = {
      ok: 'audit.ok',
      created: 'audit.created',
      paired: 'audit.paired',
      'pending-approval': 'audit.pending',
      pending: 'audit.pending',
      cancelled: 'audit.cancelled',
      canceled: 'audit.cancelled',
      expired: 'audit.expired',
      denied: 'audit.denied',
      rejected: 'audit.denied',
      'bad-secret': 'audit.fail',
      failed: 'audit.fail',
      'relay-disconnected': 'audit.fail',
    };

    /** 审计结果 → 徽标文案与颜色；未知结果原样展示。 */
    function auditResultBadge(result, t) {
      const raw = String(result === undefined || result === null ? '' : result);
      const key = RESULT_KEYS[raw.toLowerCase()];
      if (!key) return { label: raw === '' ? '—' : raw, tone: '' };
      let tone = 'warn';
      if (key === 'audit.ok' || key === 'audit.created' || key === 'audit.paired') tone = 'good';
      if (key === 'audit.cancelled' || key === 'audit.expired') tone = 'off';
      return { label: t(key), tone };
    }

    /** 入口/状态点的语义色：off=灰、good=绿、warn=琥珀、bad=红、muted=未知。 */
    function statusTone(status) {
      if (!status) return 'muted';
      if (status.enabled !== true) return 'off';
      const relayConnected = !!(status.relay && status.relay.connected === true);
      const pairingActive = !!(status.pairing && status.pairing.active === true);
      if (relayConnected && pairingActive) return 'warn';
      if (relayConnected) return 'good';
      return 'bad';
    }

    function toneKey(tone) {
      if (tone === 'good') return 'status.online';
      if (tone === 'warn') return 'status.waiting';
      if (tone === 'bad') return 'status.offline';
      if (tone === 'off') return 'status.disabled';
      return 'status.loading';
    }

    function deviceCountText(t, count) {
      return count === 1 ? t('entry.devicesOne', { count }) : t('entry.devices', { count });
    }

    /* ────────────────────────── 样式（只注入一次） ────────────────────────── */

    const CSS = `
/* dsh-remote-service · sidebar entry */
[data-ra-entry-wrap]{display:flex;flex:1 1 140px;min-width:0}
[data-ra-entry-wrap][data-wide="0"]{flex:none;width:36px;height:36px;justify-content:center;align-items:center}
[data-ra-entry]{display:flex;align-items:center;gap:9px;flex:1;min-width:0;height:42px;padding:0 10px 0 8px;
  border:0;border-radius:12px;background:transparent;color:var(--dsw-alias-label-primary,#e6e6e6);
  cursor:pointer;font-family:inherit;font-size:13px;text-align:left;overflow:hidden}
[data-ra-entry]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16))}
[data-ra-entry]:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#3b82f6));outline-offset:-2px}
[data-ra-entry-wrap][data-wide="0"] [data-ra-entry]{flex:none;width:36px;height:36px;justify-content:center;padding:0;border-radius:50%}
[data-ra-entry-glyph]{position:relative;flex:none;display:inline-flex;align-items:center;justify-content:center;
  width:26px;height:26px;border-radius:8px;color:var(--dsw-alias-label-secondary,#c9ccd1);
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.08))}
[data-ra-entry-glyph] svg{display:block}
[data-ra-entry-wrap][data-wide="0"] [data-ra-entry-glyph]{width:36px;height:36px;border:0;border-radius:50%;background:transparent}
[data-ra-entry-wrap][data-wide="0"] [data-ra-entry-glyph] [data-ra-dot]{position:absolute;right:2px;bottom:2px;width:8px;height:8px;
  box-shadow:0 0 0 2px var(--dsw-specific-sidebar-fill,rgba(20,20,22,.9))}
[data-ra-entry-main]{display:flex;flex-direction:column;min-width:0;flex:1;gap:1px}
[data-ra-entry-label]{font-size:13px;font-weight:500;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  color:var(--dsw-alias-label-primary,#e6e6e6)}
[data-ra-entry-status]{display:flex;align-items:center;gap:5px;min-width:0;font-size:10px;line-height:13px;
  color:var(--dsw-alias-label-tertiary,#9aa0a6);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
[data-ra-dot]{flex:none;display:block;width:6px;height:6px;border-radius:50%;background:#8a8f98}
[data-ra-dot][data-tone=good]{background:#22c55e;box-shadow:0 0 0 2px rgba(34,197,94,.18)}
[data-ra-dot][data-tone=warn]{background:#f59e0b;box-shadow:0 0 0 2px rgba(245,158,11,.16)}
[data-ra-dot][data-tone=bad]{background:#ef4444;box-shadow:0 0 0 2px rgba(239,68,68,.16)}
[data-ra-dot][data-tone=off]{background:#8a8f98}
[data-ra-dot][data-tone=muted]{background:#8a8f98;opacity:.55}

/* dialog */
[data-ra-overlay]{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px}
[data-ra-mask]{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.5));
  backdrop-filter:var(--dsw-mask-blur,blur(3px));-webkit-backdrop-filter:var(--dsw-mask-blur,blur(3px))}
[data-ra-dialog]{position:relative;z-index:1;display:flex;flex-direction:column;width:min(760px,calc(100vw - 32px));
  max-height:min(86vh,760px);border-radius:16px;overflow:hidden;color:var(--dsw-alias-label-primary,#e6e6e6);
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.22));
  background:var(--dsw-alias-bg-layer-2,#1e1f22);
  box-shadow:var(--dsw-elevation-prominent,0 24px 64px rgba(0,0,0,.5));font-size:13px}
[data-ra-dialog-head]{display:flex;align-items:center;gap:10px;padding:14px 16px;flex:none;
  border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.16))}
[data-ra-dialog-glyph]{flex:none;display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;
  border-radius:9px;color:#3b82f6;background:rgba(59,130,246,.14)}
[data-ra-dialog-title]{flex:1;min-width:0;font-size:15px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
[data-ra-x]{flex:none;width:28px;height:28px;border:0;border-radius:8px;background:transparent;cursor:pointer;
  color:var(--dsw-alias-label-tertiary,#9aa0a6);font-family:inherit;font-size:18px;line-height:1;
  display:inline-flex;align-items:center;justify-content:center}
[data-ra-x]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16))}
[data-ra-dialog-body]{display:flex;gap:20px;padding:18px 20px;overflow:auto;flex:1;min-height:0;flex-wrap:wrap}
[data-ra-qr-col]{flex:none;width:232px;display:flex;flex-direction:column;align-items:center;gap:8px}
[data-ra-qr-card]{box-sizing:border-box;width:232px;height:232px;border-radius:12px;background:#fff;
  display:flex;align-items:center;justify-content:center;overflow:hidden;padding:10px;color:#6b7280}
[data-ra-qr-card] img{display:block;width:100%;height:100%;object-fit:contain}
[data-ra-qr-empty]{font-size:11px;line-height:16px;text-align:center}
[data-ra-qr-note]{font-size:11px;line-height:16px;text-align:center;color:var(--dsw-alias-label-tertiary,#9aa0a6)}
[data-ra-pair-col]{flex:1;min-width:240px;display:flex;flex-direction:column;gap:14px}
[data-ra-steps]{display:flex;flex-direction:column;gap:14px}
[data-ra-step]{display:flex;gap:10px;align-items:flex-start}
[data-ra-step-n]{flex:none;width:20px;height:20px;border-radius:50%;font-size:11px;font-weight:600;
  display:inline-flex;align-items:center;justify-content:center;
  color:var(--dsw-alias-label-secondary,#c9ccd1);background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14))}
[data-ra-step-body]{display:flex;flex-direction:column;gap:6px;min-width:0}
[data-ra-step-title]{font-size:13px;line-height:20px}
[data-ra-step-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6)}
[data-ra-kv]{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
[data-ra-kv-label]{flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6)}
[data-ra-code]{display:inline-block;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  font-size:15px;letter-spacing:.12em;padding:5px 10px;border-radius:8px;user-select:all;color:var(--dsw-alias-label-primary,#e6e6e6);
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));border:1px dashed var(--dsw-alias-border-l2,rgba(128,128,128,.3))}
[data-ra-mono]{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;
  line-height:16px;color:var(--dsw-alias-label-secondary,#c9ccd1);word-break:break-all;user-select:all}
[data-ra-dialog-foot]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 16px;flex:none;
  border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.16))}
[data-ra-foot-note]{flex:1;min-width:160px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6)}
[data-ra-pill]{display:inline-flex;align-items:center;gap:5px;font-size:11px;line-height:18px;padding:1px 9px;
  border-radius:999px;white-space:nowrap;color:var(--dsw-alias-label-secondary,#c9ccd1);
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2))}
[data-ra-pill][data-tone=good]{color:#22c55e;border-color:rgba(34,197,94,.35);background:rgba(34,197,94,.1)}
[data-ra-pill][data-tone=warn]{color:#f59e0b;border-color:rgba(245,158,11,.35);background:rgba(245,158,11,.1)}
[data-ra-pill][data-tone=bad]{color:#ef4444;border-color:rgba(239,68,68,.35);background:rgba(239,68,68,.1)}
[data-ra-pill][data-tone=off]{color:var(--dsw-alias-label-tertiary,#9aa0a6)}

/* buttons */
[data-ra-btn]{padding:6px 11px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit;
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.22));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:inherit}
[data-ra-btn]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.22))}
[data-ra-btn][data-primary]{background:var(--dsw-alias-state-business-primary,#3b82f6);border-color:transparent;color:#fff}
[data-ra-btn][data-danger]{color:#ef4444}
[data-ra-btn]:disabled{opacity:.5;cursor:default}

/* settings page */
[data-ra-page]{display:flex;flex-direction:column;gap:16px;padding:2px 2px 16px;max-width:760px}
[data-ra-title]{display:flex;flex-direction:column;gap:4px}
[data-ra-title-row]{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
[data-ra-title-main]{display:flex;flex-direction:column;gap:3px;flex:1;min-width:0}
[data-ra-title-text]{font-size:16px;font-weight:600;line-height:22px}
[data-ra-sub]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6)}
[data-ra-sec]{display:flex;flex-direction:column;gap:9px;padding:14px 16px;border-radius:12px;
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.16));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.06))}
[data-ra-h]{display:flex;align-items:center;gap:8px;font-size:11px;font-weight:600;letter-spacing:.04em;
  color:var(--dsw-alias-label-tertiary,#9aa0a6)}
[data-ra-row]{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
[data-ra-grow]{flex:1;min-width:0}
[data-ra-label]{font-size:13px;line-height:18px}
[data-ra-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6)}
[data-ra-note][data-tone=warn]{color:#ef4444}
[data-ra-info]{display:flex;gap:10px;align-items:flex-start;font-size:12px;line-height:18px}
[data-ra-info-label]{flex:none;width:96px;color:var(--dsw-alias-label-tertiary,#9aa0a6)}
[data-ra-info-value]{flex:1;min-width:0;word-break:break-all;color:var(--dsw-alias-label-secondary,#c9ccd1)}
[data-ra-inline]{display:inline-flex;align-items:center;gap:7px;flex-wrap:wrap}
[data-ra-grid]{display:flex;gap:10px;flex-wrap:wrap}
[data-ra-field]{display:flex;flex-direction:column;gap:4px;flex:1;min-width:180px}
[data-ra-field-label]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#c9ccd1)}
[data-ra-input]{box-sizing:border-box;width:100%;padding:6px 9px;border-radius:8px;font-size:12px;font-family:inherit;
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.1));color:inherit}
[data-ra-input]:focus{outline:none;border-color:var(--dsw-alias-state-business-primary,#3b82f6)}
[data-ra-sw]{position:relative;flex:none;width:38px;height:22px;border-radius:11px;border:0;padding:0;cursor:pointer;
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.35));transition:background .15s}
[data-ra-sw][data-on]{background:var(--dsw-alias-state-business-primary,#3b82f6)}
[data-ra-sw] i{position:absolute;top:3px;left:3px;display:block;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .15s}
[data-ra-sw][data-on] i{left:19px}
[data-ra-actions]{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap}
[data-ra-card]{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border-radius:10px;
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.14));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.05))}
[data-ra-card-main]{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
[data-ra-card-title]{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:500;line-height:18px;
  word-break:break-all}
[data-ra-card-sub]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);word-break:break-all}
[data-ra-badge]{font-size:10px;line-height:16px;padding:0 7px;border-radius:999px;font-weight:500;white-space:nowrap;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.16));color:var(--dsw-alias-label-secondary,#c9ccd1)}
[data-ra-badge][data-tone=good]{background:rgba(34,197,94,.16);color:#22c55e}
[data-ra-badge][data-tone=warn]{background:rgba(245,158,11,.16);color:#f59e0b}
[data-ra-audit]{display:flex;flex-direction:column;gap:6px}
[data-ra-audit-row]{display:flex;align-items:center;gap:7px;font-size:11px;line-height:16px;flex-wrap:wrap;
  color:var(--dsw-alias-label-tertiary,#9aa0a6);word-break:break-all}
[data-ra-audit-time]{margin-left:auto;white-space:nowrap;opacity:.85}

/* toast */
[data-ra-toast]{position:fixed;right:20px;bottom:20px;z-index:1200;display:flex;align-items:flex-start;gap:8px;
  max-width:min(360px,calc(100vw - 32px));padding:9px 12px;border-radius:10px;font-size:12px;line-height:18px;
  color:var(--dsw-alias-label-primary,#e6e6e6);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.24));
  background:var(--dsw-alias-bg-layer-2,#1e1f22);
  box-shadow:var(--dsw-elevation-prominent,0 10px 28px rgba(0,0,0,.35));cursor:pointer}
[data-ra-toast][data-tone=good]{border-color:rgba(34,197,94,.4)}
[data-ra-toast][data-tone=warn]{border-color:rgba(239,68,68,.4)}
[data-ra-toast] [data-ra-dot]{margin-top:6px}

@media (max-width: 720px){
  [data-ra-overlay]{padding:8px}
  [data-ra-dialog]{width:calc(100vw - 16px);max-height:calc(100vh - 16px)}
  [data-ra-qr-col]{width:100%}
  [data-ra-qr-card]{width:212px;height:212px}
}
`;

    /* ────────────────────────── 基础小组件 ────────────────────────── */

    function PhoneGlyph(props) {
      const size = props.size || 16;
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': 1.7,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'aria-hidden': true,
        focusable: 'false',
        style: { display: 'block' },
      },
        h('rect', { x: 6.4, y: 2.4, width: 11.2, height: 19.2, rx: 2.6 }),
        h('path', { d: 'M10.2 5.4h3.6' }),
        h('circle', { cx: 12, cy: 18.1, r: 0.9, fill: 'currentColor', stroke: 'none' }),
        h('path', { d: 'M3.1 7.6c-1.1 1.4-1.7 2.8-1.7 4.4s.6 3 1.7 4.4', opacity: 0.5 }),
        h('path', { d: 'M20.9 7.6c1.1 1.4 1.7 2.8 1.7 4.4s-.6 3-1.7 4.4', opacity: 0.5 }));
    }

    function Dot(props) {
      return h('i', { 'data-ra-dot': '', 'data-tone': props.tone || 'muted' });
    }

    function StatusPill(props) {
      return h('span', { 'data-ra-pill': '', 'data-tone': props.tone || 'muted' },
        h(Dot, { tone: props.tone }),
        h('span', null, props.label));
    }

    function Toast(props) {
      if (!props.flash) return null;
      const tone = props.flash.tone === 'good' ? 'good' : 'warn';
      return h('div', {
        'data-ra-toast': '',
        'data-tone': tone,
        role: 'status',
        'aria-live': 'polite',
        onClick: props.onDismiss,
        title: props.onDismiss ? 'dismiss' : undefined,
      }, h(Dot, { tone: tone === 'good' ? 'good' : 'bad' }), h('span', null, props.flash.text));
    }

    function Section(props) {
      return h('section', { 'data-ra-sec': '' },
        h('div', { 'data-ra-h': '' }, props.title),
        props.children);
    }

    function Row(props) {
      return h('div', { 'data-ra-row': '' },
        h('div', { 'data-ra-grow': '' },
          h('div', { 'data-ra-label': '' }, props.label),
          props.note ? h('div', { 'data-ra-note': '' }, props.note) : null),
        props.children);
    }

    function InfoRow(props) {
      return h('div', { 'data-ra-info': '' },
        h('span', { 'data-ra-info-label': '' }, props.label),
        h('span', { 'data-ra-info-value': '' }, props.value));
    }

    function Toggle(props) {
      return h('button', {
        type: 'button',
        'data-ra-sw': '',
        'data-on': props.checked ? '1' : undefined,
        role: 'switch',
        'aria-checked': props.checked === true,
        'aria-label': props.label || (props.checked ? 'on' : 'off'),
        title: props.label || (props.checked ? 'on' : 'off'),
        disabled: props.disabled,
        onClick: () => props.onChange(!props.checked),
      }, h('i', null));
    }

    function Btn(props) {
      return h('button', {
        type: 'button',
        'data-ra-btn': '',
        'data-primary': props.primary ? '1' : undefined,
        'data-danger': props.danger ? '1' : undefined,
        'data-ra-action': props.action,
        disabled: props.disabled,
        title: props.title,
        onClick: props.onClick,
      }, props.children);
    }

    function Field(props) {
      return h('label', { 'data-ra-field': '' },
        h('span', { 'data-ra-field-label': '' }, props.label),
        h('input', {
          'data-ra-input': '',
          type: props.type || 'text',
          value: props.value,
          placeholder: props.placeholder,
          autoComplete: props.autoComplete || 'off',
          spellCheck: false,
          onChange: (event) => props.onChange(event.target.value),
        }));
    }

    function useFlash() {
      const [flash, setFlash] = useState(null);
      const timerRef = useRef(null);
      const clearTimer = useCallback(() => {
        if (timerRef.current !== null) {
          globalThis.clearTimeout(timerRef.current);
          timerRef.current = null;
        }
      }, []);
      useEffect(() => clearTimer, [clearTimer]);
      const showFlash = useCallback((tone, text) => {
        clearTimer();
        setFlash({ tone, text });
        timerRef.current = globalThis.setTimeout(() => {
          timerRef.current = null;
          setFlash(null);
        }, tone === 'good' ? FLASH_GOOD_MS : FLASH_WARN_MS);
      }, [clearTimer]);
      const dismiss = useCallback(() => {
        clearTimer();
        setFlash(null);
      }, [clearTimer]);
      return [flash, showFlash, dismiss];
    }

    function useNow(intervalMs) {
      const [now, setNow] = useState(() => Date.now());
      useEffect(() => {
        const timer = globalThis.setInterval(() => setNow(Date.now()), intervalMs);
        return () => globalThis.clearInterval(timer);
      }, [intervalMs]);
      return now;
    }

    /* ────────────────────────── 侧栏入口 + 配对弹窗 ────────────────────────── */

    function RemoteEntry(props) {
      const t = props.t || ((key) => key);
      const wide = props.wide !== false;
      const [status, setStatus] = useState(null);
      const [loadError, setLoadError] = useState('');
      const [open, setOpen] = useState(false);
      const [flash, showFlash, dismissFlash] = useFlash();
      const aliveRef = useRef(true);

      useEffect(() => {
        aliveRef.current = true;
        return () => { aliveRef.current = false; };
      }, []);

      const load = useCallback(async () => {
        try {
          const next = await jget('/status');
          if (aliveRef.current) {
            setStatus(next);
            setLoadError('');
          }
        } catch (error) {
          if (aliveRef.current) setLoadError(formatError(error));
        }
      }, []);

      useEffect(() => { void load(); }, [load]);

      useEffect(() => {
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined;
        const onVisibility = () => {
          if (document.visibilityState === 'visible') void load();
        };
        document.addEventListener('visibilitychange', onVisibility);
        return () => document.removeEventListener('visibilitychange', onVisibility);
      }, [load]);

      const tone = status === null ? (loadError === '' ? 'muted' : 'bad') : statusTone(status);
      let statusText;
      if (status === null) statusText = loadError === '' ? t('status.loading') : t('status.unknown');
      else if (tone === 'good') statusText = `${t('status.online')} · ${deviceCountText(t, activeDevices(status).length)}`;
      else statusText = t(toneKey(tone));
      const title = `${t('entry.label')} · ${statusText}`;

      return h('div', { 'data-ra-entry-wrap': '', 'data-wide': wide ? '1' : '0' },
        h('button', {
          type: 'button',
          'data-ra-entry': '',
          'data-tone': tone,
          title,
          'aria-label': title,
          'aria-haspopup': 'dialog',
          onClick: () => setOpen(true),
        },
          h('span', { 'data-ra-entry-glyph': '' },
            h(PhoneGlyph, { size: wide ? 16 : 18 }),
            wide ? null : h(Dot, { tone })),
          wide
            ? h('span', { 'data-ra-entry-main': '' },
              h('span', { 'data-ra-entry-label': '' }, t('entry.label')),
              h('span', { 'data-ra-entry-status': '' }, h(Dot, { tone }), statusText))
            : null),
        open
          ? h(PairingDialog, {
            t,
            initialStatus: status,
            onStatus: (next) => {
              if (!aliveRef.current) return;
              setStatus(next);
              setLoadError('');
            },
            onClose: () => {
              setOpen(false);
              void load();
            },
          })
          : null,
        h(Toast, { flash, onDismiss: dismissFlash }));
    }

    function PairingDialog(props) {
      const t = props.t || ((key) => key);
      const onClose = typeof props.onClose === 'function' ? props.onClose : () => {};
      const onStatus = typeof props.onStatus === 'function' ? props.onStatus : null;
      const [status, setStatus] = useState(props.initialStatus || null);
      const [loadError, setLoadError] = useState('');
      const [busy, setBusy] = useState('');
      const [qrTs, setQrTs] = useState(() => Date.now());
      const [qrFailed, setQrFailed] = useState(false);
      const [flash, showFlash, dismissFlash] = useFlash();
      const now = useNow(1000);
      const aliveRef = useRef(true);
      const canceledRef = useRef(false);
      const startingRef = useRef(false);
      const autoTriesRef = useRef(0);
      const handledRef = useRef(false);

      useEffect(() => {
        aliveRef.current = true;
        return () => { aliveRef.current = false; };
      }, []);

      const applyStatus = useCallback((next) => {
        setStatus(next);
        setLoadError('');
        if (next && next.pairing && next.pairing.active) {
          autoTriesRef.current = 0;
          canceledRef.current = false;
        }
        if (onStatus) onStatus(next);
      }, [onStatus]);

      const refresh = useCallback(async () => {
        try {
          const next = await jget('/status');
          if (aliveRef.current) applyStatus(next);
        } catch (error) {
          if (aliveRef.current) setLoadError(formatError(error));
        }
      }, [applyStatus]);

      useEffect(() => {
        void refresh();
        const timer = globalThis.setInterval(() => { void refresh(); }, POLL_MS);
        return () => globalThis.clearInterval(timer);
      }, [refresh]);

      const startPairing = useCallback(async (auto) => {
        if (startingRef.current) return;
        startingRef.current = true;
        if (!auto) setBusy('start');
        try {
          await jpost('/pairing/start', {});
          canceledRef.current = false;
          if (aliveRef.current) {
            setQrFailed(false);
            setQrTs(Date.now());
          }
          await refresh();
          if (!auto && aliveRef.current) showFlash('good', t('pairing.started'));
        } catch (error) {
          if (aliveRef.current) setLoadError(formatError(error));
          if (!auto && aliveRef.current) showFlash('warn', t('msg.pairFailed', { message: formatError(error) }));
        } finally {
          startingRef.current = false;
          if (!auto && aliveRef.current) setBusy('');
        }
      }, [refresh, showFlash, t]);

      const close = useCallback(() => {
        canceledRef.current = true;
        void jpost('/pairing/cancel', {}).catch(() => {});
        onClose();
      }, [onClose]);

      useEffect(() => {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined;
        const onKeyDown = (event) => {
          if (event.key === 'Escape') close();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
      }, [close]);

      const enabled = !!(status && status.enabled === true);
      const pairing = status && status.pairing && status.pairing.active ? status.pairing : null;
      const active = pairing !== null;

      // 打开弹窗时若没有活跃配对 → 自动创建；过期后也自动续一张（最多连续两次）。
      // pending（等待桌面确认）/ 已确认 / 已拒绝时绝不自动续期。
      useEffect(() => {
        if (status === null || !enabled || active) return;
        if (handledRef.current || canceledRef.current || startingRef.current) return;
        if (autoTriesRef.current >= 2) return;
        autoTriesRef.current += 1;
        void startPairing(true);
      }, [status, enabled, active, startPairing]);

      const tone = status === null ? (loadError === '' ? 'muted' : 'bad') : statusTone(status);
      const expiresAt = pairing && Number.isFinite(Number(pairing.expiresAt)) ? Number(pairing.expiresAt) : 0;
      const remaining = expiresAt > 0 ? Math.max(0, expiresAt - now) : 0;
      const codeText = pairing && pairing.code ? groupCode(pairing.code) : '';
      const fingerprint = status && status.host && status.host.fingerprint ? shortFingerprint(status.host.fingerprint) : '';
      const qrSrc = `${API}/pairing/qr.svg?ts=${qrTs}`;
      const rawPairing = status && status.pairing ? status.pairing : null;
      const pending = !!(rawPairing && rawPairing.active === true && rawPairing.status === 'pending');
      const pendingDevice = rawPairing && rawPairing.pendingDevice ? rawPairing.pendingDevice : null;
      const pendingDeviceName = pendingDevice && pendingDevice.name ? String(pendingDevice.name) : t('pairing.newDevice');
      const pendingPlatform = pendingDevice && pendingDevice.platform ? platformLabel(pendingDevice.platform) : '';
      const pendingSas = rawPairing && rawPairing.sas ? String(rawPairing.sas) : '';

      const approve = useCallback(async (allow) => {
        if (busy !== '' || !rawPairing || !rawPairing.pairingId) return;
        setBusy('approve');
        try {
          await jpost('/pairing/approve', { pairingId: rawPairing.pairingId, approve: allow === true });
          handledRef.current = true;
          canceledRef.current = true;
          await refresh();
          if (aliveRef.current) showFlash('good', allow === true ? t('msg.paired') : t('msg.pairDenied'));
        } catch (error) {
          if (aliveRef.current) showFlash('warn', t('msg.approveFailed', { message: formatError(error) }));
        } finally {
          if (aliveRef.current) setBusy('');
        }
      }, [busy, rawPairing, refresh, showFlash, t]);

      return h('div', { 'data-ra-overlay': '', role: 'presentation' },
        h('div', { 'data-ra-mask': '', onClick: close }),
        h('div', {
          'data-ra-dialog': '',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': t('pairing.title'),
        },
          h('div', { 'data-ra-dialog-head': '' },
            h('span', { 'data-ra-dialog-glyph': '' }, h(PhoneGlyph, { size: 17 })),
            h('div', { 'data-ra-dialog-title': '' }, t('pairing.title')),
            h(StatusPill, { tone, label: pending ? t('pairing.pendingPill') : t(toneKey(tone)) }),
            h('button', {
              type: 'button',
              'data-ra-x': '',
              title: t('btn.close'),
              'aria-label': t('btn.close'),
              onClick: close,
            }, '×')),
          h('div', { 'data-ra-dialog-body': '' },
            status === null
              ? h('div', { 'data-ra-note': '' },
                loadError === '' ? t('msg.loading') : t('msg.loadFailed', { message: loadError }))
              : null,
            status !== null && !enabled
              ? h('div', { 'data-ra-disabled': '' },
                h('div', { 'data-ra-step-title': '' }, t('pairing.disabledHint')))
              : null,
            status !== null && enabled && pending
              ? h('div', { 'data-ra-pending': '' },
                h('div', { 'data-ra-pending-head': '' },
                  h('span', { 'data-ra-pending-glyph': '' }, h(PhoneGlyph, { size: 20 })),
                  h('div', { 'data-ra-pending-main': '' },
                    h('div', { 'data-ra-step-title': '' }, t('pairing.pendingTitle')),
                    h('div', { 'data-ra-step-note': '' },
                      `${t('pairing.pendingDevice')}：${pendingDeviceName}${pendingPlatform !== '' ? ` · ${pendingPlatform}` : ''}`))),
                h('div', { 'data-ra-pending-sas': '' },
                  h('span', { 'data-ra-kv-label': '' }, t('pairing.sas')),
                  pendingSas !== ''
                    ? h('span', { 'data-ra-code': '' }, pendingSas)
                    : h('span', { 'data-ra-note': '' }, t('pairing.noSas'))),
                fingerprint
                  ? h('div', { 'data-ra-kv': '' },
                    h('span', { 'data-ra-kv-label': '' }, t('pairing.hostFingerprint')),
                    h('span', { 'data-ra-mono': '' }, fingerprint))
                  : null,
                h('div', { 'data-ra-note': '' }, t('pairing.pendingHint')),
                h('div', { 'data-ra-pending-actions': '' },
                  h(Btn, {
                    danger: true,
                    disabled: busy !== '',
                    action: 'pair-deny',
                    onClick: () => { void approve(false); },
                  }, t('btn.denyPairing')),
                  h(Btn, {
                    primary: true,
                    disabled: busy !== '',
                    action: 'pair-allow',
                    onClick: () => { void approve(true); },
                  }, busy === 'approve' ? t('msg.loading') : t('btn.approvePairing'))))
              : null,
            status !== null && enabled && !pending
              ? h('div', { 'data-ra-qr-col': '' },
                h('div', { 'data-ra-qr-card': '' },
                  active && !qrFailed
                    ? h('img', {
                      src: qrSrc,
                      alt: t('pairing.qrAlt'),
                      width: 212,
                      height: 212,
                      onError: () => setQrFailed(true),
                    })
                    : h('span', { 'data-ra-qr-empty': '' },
                      qrFailed ? t('pairing.qrFailed') : t('pairing.noQr'))),
                h('div', { 'data-ra-qr-note': '' },
                  active && expiresAt > 0 && remaining > 0
                    ? t('pairing.expires', { time: formatCountdown(remaining) })
                    : (active && expiresAt > 0 ? t('pairing.expired') : t('pairing.inactive'))),
                active ? h('div', { 'data-ra-qr-note': '' }, t('pairing.autoRefresh')) : null)
              : null,
            status !== null && enabled && !pending
              ? h('div', { 'data-ra-pair-col': '' },
                h('div', { 'data-ra-steps': '' },
                  h('div', { 'data-ra-step': '' },
                    h('span', { 'data-ra-step-n': '' }, '1'),
                    h('div', { 'data-ra-step-body': '' },
                      h('div', { 'data-ra-step-title': '' }, t('pairing.step1')))),
                  h('div', { 'data-ra-step': '' },
                    h('span', { 'data-ra-step-n': '' }, '2'),
                    h('div', { 'data-ra-step-body': '' },
                      h('div', { 'data-ra-step-title': '' }, t('pairing.step2')),
                      codeText ? h('div', { 'data-ra-code': '' }, codeText) : null)),
                  h('div', { 'data-ra-step': '' },
                    h('span', { 'data-ra-step-n': '' }, '3'),
                    h('div', { 'data-ra-step-body': '' },
                      h('div', { 'data-ra-step-title': '' }, t('pairing.step3')),
                      fingerprint
                        ? h('div', { 'data-ra-kv': '' },
                          h('span', { 'data-ra-kv-label': '' }, t('pairing.hostFingerprint')),
                          h('span', { 'data-ra-mono': '' }, fingerprint))
                        : null,
                      pairing && pairing.sas
                        ? h('div', { 'data-ra-kv': '' },
                          h('span', { 'data-ra-kv-label': '' }, t('pairing.sas')),
                          h('span', { 'data-ra-mono': '' }, pairing.sas))
                        : null)),
                  h('div', { 'data-ra-step': '' },
                    h('span', { 'data-ra-step-n': '' }, '4'),
                    h('div', { 'data-ra-step-body': '' },
                      h('div', { 'data-ra-step-title': '' }, t('pairing.step4')),
                      h('div', { 'data-ra-step-note': '' },
                        pairing && pairing.requiresApproval ? t('pairing.requiresApproval') : t('pairing.step4Note'))))),
                loadError !== ''
                  ? h('div', { 'data-ra-note': '', 'data-tone': 'warn' }, t('msg.loadFailed', { message: loadError }))
                  : null)
              : null),
          h('div', { 'data-ra-dialog-foot': '' },
            h('div', { 'data-ra-foot-note': '' }, t('pairing.note')),
            h(Btn, { onClick: close, disabled: busy !== '' }, t('btn.cancel')),
            pending
              ? null
              : h(Btn, {
                primary: true,
                disabled: !enabled || busy !== '',
                action: 'pair-regenerate',
                onClick: () => {
                  setQrFailed(false);
                  void startPairing(false);
                },
              }, busy === 'start' ? t('msg.loading') : t('btn.regenerate')))),
        h(Toast, { flash, onDismiss: dismissFlash }));
    }

    /* ────────────────────────── 设置页 ────────────────────────── */

    function SettingsPage(props) {
      const t = props.t || ((key) => key);
      const [status, setStatus] = useState(null);
      const [audit, setAudit] = useState(null);
      const [auditError, setAuditError] = useState('');
      const [loadError, setLoadError] = useState('');
      const [draft, setDraft] = useState(null);
      const [baseline, setBaseline] = useState(null);
      const [busy, setBusy] = useState('');
      const [revokeId, setRevokeId] = useState(null);
      const [pairingOpen, setPairingOpen] = useState(false);
      const [flash, showFlash, dismissFlash] = useFlash();
      const now = useNow(1000);
      const aliveRef = useRef(true);
      const revokeTimerRef = useRef(null);

      useEffect(() => {
        aliveRef.current = true;
        return () => {
          aliveRef.current = false;
          if (revokeTimerRef.current !== null) globalThis.clearTimeout(revokeTimerRef.current);
        };
      }, []);

      const loadAudit = useCallback(async () => {
        try {
          const data = await jget('/audit?limit=20');
          if (!aliveRef.current) return;
          setAudit(normalizeAudit(data));
          setAuditError('');
        } catch (error) {
          if (!aliveRef.current) return;
          setAudit([]);
          setAuditError(formatError(error));
        }
      }, []);

      const reload = useCallback(async () => {
        try {
          const next = await jget('/status');
          if (!aliveRef.current) return;
          setStatus(next);
          setLoadError('');
          const fresh = draftFromStatus(next);
          setDraft(fresh);
          setBaseline(fresh);
        } catch (error) {
          if (aliveRef.current) setLoadError(formatError(error));
        }
      }, []);

      useEffect(() => {
        let canceled = false;
        const bootstrap = async () => {
          try {
            const next = await jget('/status');
            if (canceled) return;
            setStatus(next);
            setLoadError('');
            const fresh = draftFromStatus(next);
            setDraft(fresh);
            setBaseline(fresh);
          } catch (error) {
            if (!canceled) setLoadError(formatError(error));
          }
        };
        void bootstrap();
        void loadAudit();
        const timer = globalThis.setInterval(async () => {
          try {
            const next = await jget('/status');
            if (canceled) return;
            setStatus(next);
            setLoadError('');
          } catch (error) {
            if (!canceled) setLoadError(formatError(error));
          }
        }, POLL_MS);
        return () => {
          canceled = true;
          globalThis.clearInterval(timer);
        };
      }, [loadAudit]);

      const save = async () => {
        if (!draft || !baseline || busy === 'save') return;
        const patch = {};
        if (draft.enabled !== baseline.enabled) patch.enabled = draft.enabled;
        const relayUrl = draft.relayUrl.trim();
        if (relayUrl !== baseline.relayUrl) patch.relayUrl = relayUrl;
        const relayDomain = draft.relayDomain.trim();
        if (relayDomain !== baseline.relayDomain) patch.relayDomain = relayDomain;
        const hostId = draft.hostId.trim();
        if (hostId !== '' && hostId !== baseline.hostId) patch.hostId = hostId;
        const hostName = draft.hostName.trim();
        if (hostName !== baseline.hostName) patch.hostName = hostName;
        const tlsCertFile = draft.tlsCertFile.trim();
        if (tlsCertFile !== baseline.tlsCertFile) patch.tlsCertFile = tlsCertFile;
        const tlsKeyFile = draft.tlsKeyFile.trim();
        if (tlsKeyFile !== '' && tlsKeyFile !== baseline.tlsKeyFile) patch.tlsKeyFile = tlsKeyFile;
        const hostToken = draft.hostToken.trim();
        if (hostToken !== '') patch.hostToken = hostToken;
        if (draft.requireApproval !== baseline.requireApproval) patch.requireApproval = draft.requireApproval;
        if (Object.keys(patch).length === 0) {
          showFlash('good', t('msg.noChanges'));
          return;
        }
        setBusy('save');
        try {
          const response = await jpost('/config', patch);
          if (!aliveRef.current) return;
          const next = response && typeof response === 'object' ? response : status;
          const fresh = draftFromStatus(next, draft);
          if (hostToken !== '') fresh.hostTokenConfigured = true;
          if (tlsCertFile !== '') fresh.tlsCertFileConfigured = true;
          if (tlsKeyFile !== '') fresh.tlsKeyFileConfigured = true;
          setStatus(next);
          setDraft(fresh);
          setBaseline(fresh);
          showFlash('good', t('msg.saved'));
        } catch (error) {
          if (aliveRef.current) showFlash('warn', t('msg.saveFailed', { message: formatError(error) }));
        } finally {
          if (aliveRef.current) setBusy('');
        }
      };

      const cancelPairing = async () => {
        if (busy === 'cancel') return;
        setBusy('cancel');
        try {
          await jpost('/pairing/cancel', {});
          if (aliveRef.current) showFlash('good', t('msg.pairCanceled'));
          try {
            const next = await jget('/status');
            if (aliveRef.current) setStatus(next);
          } catch {
            /* 状态轮询会补上 */
          }
        } catch (error) {
          if (aliveRef.current) showFlash('warn', t('msg.pairFailed', { message: formatError(error) }));
        } finally {
          if (aliveRef.current) setBusy('');
        }
      };

      const revoke = async (device) => {
        if (!device || !device.id) return;
        if (revokeId !== device.id) {
          setRevokeId(device.id);
          if (revokeTimerRef.current !== null) globalThis.clearTimeout(revokeTimerRef.current);
          revokeTimerRef.current = globalThis.setTimeout(() => {
            revokeTimerRef.current = null;
            setRevokeId(null);
          }, 4000);
          return;
        }
        if (revokeTimerRef.current !== null) {
          globalThis.clearTimeout(revokeTimerRef.current);
          revokeTimerRef.current = null;
        }
        setRevokeId(null);
        setBusy(`revoke:${device.id}`);
        try {
          await jpost(`/devices/${encodeURIComponent(device.id)}/revoke`, {});
          if (aliveRef.current) showFlash('good', t('msg.revoked'));
          try {
            const next = await jget('/status');
            if (aliveRef.current) setStatus(next);
          } catch {
            /* ignore */
          }
          void loadAudit();
        } catch (error) {
          if (aliveRef.current) showFlash('warn', t('msg.revokeFailed', { message: formatError(error) }));
        } finally {
          if (aliveRef.current) setBusy('');
        }
      };

      if (status === null && loadError !== '') {
        return h('div', { 'data-ra-page': '' },
          h('div', { 'data-ra-title': '' }, h('div', { 'data-ra-title-text': '' }, t('page.title'))),
          h('div', { 'data-ra-note': '', 'data-tone': 'warn' }, t('msg.loadFailed', { message: loadError })),
          h('div', { 'data-ra-actions': '' },
            h(Btn, { onClick: () => { void reload(); } }, t('msg.retry'))));
      }
      if (status === null || draft === null) {
        return h('div', { 'data-ra-page': '' }, h('div', { 'data-ra-note': '' }, t('msg.loading')));
      }

      const relay = status.relay || {};
      const host = status.host || {};
      const tls = host.tls || {};
      const pairing = status.pairing && status.pairing.active ? status.pairing : null;
      const pairingPending = Boolean(pairing && pairing.status === 'pending');
      const devices = Array.isArray(status.devices) ? status.devices : [];
      const enabled = status.enabled === true;
      const tone = statusTone(status);
      const expiresAt = pairing && Number.isFinite(Number(pairing.expiresAt)) ? Number(pairing.expiresAt) : 0;
      const remaining = expiresAt > 0 ? Math.max(0, expiresAt - now) : 0;
      const fingerprint = host.fingerprint ? shortFingerprint(host.fingerprint) : '';
      const disabled = busy === 'save';

      const statusSection = h(Section, { title: t('section.status') },
        loadError !== '' ? h('div', { 'data-ra-note': '', 'data-tone': 'warn' }, t('msg.loadFailed', { message: loadError })) : null,
        h(InfoRow, { label: t('field.relayUrl'), value: relay.url || '—' }),
        h(InfoRow, {
          label: t('relay.status'),
          value: h('span', { 'data-ra-inline': '' },
            h(Dot, { tone: relay.connected ? 'good' : 'bad' }),
            relay.connected ? t('relay.connected') : t('relay.disconnected')),
        }),
        relay.lastError
          ? h(InfoRow, { label: t('relay.lastError'), value: h('span', { style: { color: '#ef4444' } }, String(relay.lastError)) })
          : null,
        h(InfoRow, { label: t('host.id'), value: host.id || '—' }),
        h(InfoRow, { label: t('host.name'), value: host.name || '—' }),
        h(InfoRow, { label: t('host.domain'), value: host.domain || '—' }),
        h(InfoRow, { label: t('host.fingerprint'), value: fingerprint || '—' }),
        h(InfoRow, {
          label: t('host.cert'),
          value: h('span', { 'data-ra-inline': '' },
            h('span', null, tls.certFile || '—'),
            enabled && tls.valid === false ? h('span', { 'data-ra-badge': '', 'data-tone': 'warn' }, t('host.certInvalid')) : null,
            tls.dev ? h('span', { 'data-ra-badge': '', 'data-tone': '' }, t('host.certDev')) : null),
        }),
        h(InfoRow, { label: t('host.version'), value: status.version || '—' }));

      const connectionSection = h(Section, { title: t('section.connection') },
        h(Row, { label: t('sw.enabled'), note: t('sw.enabledNote') },
          h(Toggle, {
            checked: draft.enabled,
            disabled,
            label: t('sw.enabled'),
            onChange: (value) => setDraft({ ...draft, enabled: value }),
          })),
        h('div', { 'data-ra-grid': '' },
          h(Field, {
            label: t('field.relayUrl'),
            value: draft.relayUrl,
            placeholder: t('field.relayUrlHint'),
            onChange: (value) => setDraft({ ...draft, relayUrl: value }),
          }),
          h(Field, {
            label: t('field.relayDomain'),
            value: draft.relayDomain,
            placeholder: t('field.relayDomainHint'),
            onChange: (value) => setDraft({ ...draft, relayDomain: value }),
          })),
        h('div', { 'data-ra-note': '' }, t('field.relayDomainNote')),
        h('div', { 'data-ra-grid': '' },
          h(Field, {
            label: t('field.hostId'),
            value: draft.hostId,
            placeholder: t('field.hostIdHint'),
            onChange: (value) => setDraft({ ...draft, hostId: value }),
          }),
          h(Field, {
            label: t('field.hostName'),
            value: draft.hostName,
            placeholder: t('field.hostNameHint'),
            onChange: (value) => setDraft({ ...draft, hostName: value }),
          })),
        h('div', { 'data-ra-grid': '' },
          h(Field, {
            label: t('field.hostToken'),
            type: 'password',
            value: draft.hostToken,
            placeholder: draft.hostTokenConfigured ? t('field.configuredPlaceholder') : t('field.hostTokenEmpty'),
            autoComplete: 'new-password',
            onChange: (value) => setDraft({ ...draft, hostToken: value }),
          })),
        h('div', { 'data-ra-grid': '' },
          h(Field, {
            label: t('field.tlsCertFile'),
            value: draft.tlsCertFile,
            placeholder: draft.tlsCertFileConfigured ? t('field.configuredPlaceholder') : '/path/fullchain.pem',
            onChange: (value) => setDraft({ ...draft, tlsCertFile: value }),
          }),
          h(Field, {
            label: t('field.tlsKeyFile'),
            value: draft.tlsKeyFile,
            placeholder: draft.tlsKeyFileConfigured ? t('field.configuredPlaceholder') : '/path/privkey.pem',
            onChange: (value) => setDraft({ ...draft, tlsKeyFile: value }),
          })),
        h(Row, { label: t('sw.requireApproval'), note: t('sw.requireApprovalNote') },
          h(Toggle, {
            checked: draft.requireApproval,
            disabled,
            label: t('sw.requireApproval'),
            onChange: (value) => setDraft({ ...draft, requireApproval: value }),
          })),
        h('div', { 'data-ra-actions': '' },
          h(Btn, { primary: true, disabled, onClick: () => { void save(); } },
            busy === 'save' ? t('btn.saving') : t('btn.save'))));

      const pairingSection = h(Section, { title: t('section.pairing') },
        h(Row, {
          label: pairing ? (pairingPending ? t('pairing.pendingPill') : t('pairing.active')) : t('pairing.inactive'),
          note: enabled
            ? (pairingPending ? t('pairing.settingsPendingNote') : t('pairing.settingsNote'))
            : t('pairing.disabledHint'),
        },
          h(Btn, {
            primary: true,
            disabled: !enabled,
            title: enabled ? undefined : t('pairing.disabledShort'),
            onClick: () => setPairingOpen(true),
          }, t('btn.openPairing')),
          pairing
            ? h(Btn, { disabled: busy === 'cancel', onClick: () => { void cancelPairing(); } }, t('btn.cancel'))
            : null),
        pairing
          ? h('div', { 'data-ra-inline': '' },
            h('span', { 'data-ra-code': '' }, groupCode(pairing.code)),
            pairing.sas
              ? h('span', { 'data-ra-mono': '' }, `${t('pairing.sas')} ${pairing.sas}`)
              : null,
            expiresAt > 0
              ? h('span', { 'data-ra-note': '' }, t('pairing.expires', { time: formatCountdown(remaining) }))
              : null)
          : null);

      const renderDevice = (device) => {
        const revoked = device.revokedAt !== null && device.revokedAt !== undefined && Number(device.revokedAt) > 0;
        const meta = [
          platformLabel(device.platform),
          device.lastSeenAt ? `${t('devices.lastSeen')} ${fmtRelative(device.lastSeenAt, t)}` : t('devices.never'),
        ].filter((part) => part !== '').join(' · ');
        return h('div', { 'data-ra-card': '', key: device.id },
          h('div', { 'data-ra-card-main': '' },
            h('div', { 'data-ra-card-title': '' },
              device.name || device.id || '—',
              h('span', { 'data-ra-badge': '', 'data-tone': revoked ? 'warn' : 'good' },
                revoked ? t('devices.revoked') : t('devices.active'))),
            h('div', { 'data-ra-card-sub': '' }, meta)),
          revoked
            ? null
            : h(Btn, {
              danger: true,
              disabled: busy === `revoke:${device.id}`,
              onClick: () => { void revoke(device); },
            }, revokeId === device.id ? t('btn.revokeConfirm') : t('btn.revoke')));
      };

      const devicesSection = h(Section, { title: t('section.devices') },
        devices.length === 0
          ? h('div', { 'data-ra-note': '' }, t('devices.empty'))
          : h('div', { 'data-ra-audit': '' }, devices.map(renderDevice)));

      const auditSection = h(Section, { title: t('section.audit') },
        auditError !== ''
          ? h('div', { 'data-ra-note': '', 'data-tone': 'warn' }, t('msg.loadFailed', { message: auditError }))
          : null,
        audit === null
          ? h('div', { 'data-ra-note': '' }, t('msg.loading'))
          : audit.length === 0
            ? h('div', { 'data-ra-note': '' }, t('audit.empty'))
            : h('div', { 'data-ra-audit': '' }, audit.slice(0, 20).map((entry, index) => {
              const badge = auditResultBadge(entry.result, t);
              return h('div', { 'data-ra-audit-row': '', key: `${String(entry.ts || '')}-${String(index)}` },
                h('span', { 'data-ra-badge': '', 'data-tone': badge.tone || undefined }, badge.label),
                h('span', null, actionLabel(entry.action, t)),
                entry.resource ? h('span', { 'data-ra-mono': '' }, String(entry.resource)) : null,
                h('span', { 'data-ra-audit-time': '' }, fmtTime(entry.ts)));
            })));

      return h('div', { 'data-ra-page': '' },
        h('div', { 'data-ra-title': '' },
          h('div', { 'data-ra-title-row': '' },
            h('div', { 'data-ra-title-main': '' },
              h('div', { 'data-ra-title-text': '' }, t('page.title')),
              h('div', { 'data-ra-sub': '' }, t('page.subtitle'))),
            h(StatusPill, { tone, label: t(toneKey(tone)) }))),
        pairingOpen ? null : h(Toast, { flash, onDismiss: dismissFlash }),
        statusSection,
        connectionSection,
        pairingSection,
        devicesSection,
        auditSection,
        pairingOpen
          ? h(PairingDialog, {
            t,
            initialStatus: status,
            onStatus: (next) => {
              if (!aliveRef.current) return;
              setStatus(next);
              setLoadError('');
            },
            onClose: () => setPairingOpen(false),
          })
          : null);
    }

    /* ────────────────────────── 插件入口 ────────────────────────── */

    function injectStyles() {
      if (typeof document === 'undefined' || typeof document.createElement !== 'function') return () => {};
      const tagId = 'dsh-remote-service';
      if (typeof document.querySelector === 'function') {
        const existing = document.querySelector(`style[data-plugin-css="${tagId}"]`);
        if (existing !== null && existing !== undefined) return () => {};
      }
      const style = document.createElement('style');
      style.setAttribute('data-plugin-css', tagId);
      style.textContent = CSS;
      if (document.head && typeof document.head.appendChild === 'function') document.head.appendChild(style);
      return () => {
        if (style && typeof style.remove === 'function') style.remove();
      };
    }

    return {
      inject: ['slots', 'locale'],
      // 仅供 packages/host-plugin/test/client-smoke.test.js 使用；DSH 运行时只消费 inject/apply。
      __test: { RemoteEntry, PairingDialog, SettingsPage, draftFromStatus },
      apply(ctx) {
        ctx.effect(injectStyles, 'remote-access: 样式');

        let translate = null;
        const locale = ctx.locale;
        if (locale && typeof locale.register === 'function' && typeof locale.bind === 'function') {
          ctx.effect(() => locale.register(NS, { zh, en }), 'remote-access: 字典');
          translate = locale.bind(NS);
        }
        if (typeof translate !== 'function') translate = makeTranslator({ zh, en });

        const hasLocale = !!(locale && typeof locale.register === 'function');
        const slots = typeof ctx.get === 'function'
          ? (ctx.get('slots') || ctx.slots)
          : ctx.slots;
        if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return;

        const entryOptions = { name: 'sidebar.footer.action', id: 'remote-access', order: 10 };
        const settingsOptions = {
          name: 'settings.section',
          id: 'remote-access',
          order: 50,
          label: () => translate('page.nav'),
        };
        if (hasLocale) {
          entryOptions.locale = NS;
          settingsOptions.locale = NS;
        }

        function EntrySeat(positionProps) {
          return h(RemoteEntry, { ...positionProps, t: positionProps && positionProps.t ? positionProps.t : translate });
        }

        function SettingsSeat(positionProps) {
          return h(SettingsPage, { ...positionProps, t: positionProps && positionProps.t ? positionProps.t : translate });
        }

        slots.inject('sidebar.footer.action', () => slots.register(entryOptions, EntrySeat));
        slots.inject('settings.section', () => slots.register(settingsOptions, SettingsSeat));
      },
    };
  },
});
