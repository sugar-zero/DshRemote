/**
 * dsh-remote-service —— Web Client 半
 * ============================================================================
 * 两个挂载点（与 push-notify / ui-cordis 同一套 __ModuleLoader__ 约定）：
 *   1. sidebar.footer.action —— 侧栏底部、账号行正上方的「远程访问」入口；
 *   2. settings.section      —— 设置里的「远程访问」页（连接配置/配对/设备/审计）。
 * 数据全部走本机管理 API（同源 /api/remote-access/*，契约见 docs/ADMIN-API.md），
 * fetch 一律带 credentials: 'include'；hostToken 只上行不下行，DOM 里永远不回显。
 * 纯前端单文件，无构建步骤：只 require('react')（手机 WebView 下额外按需 require DSH 的
 * session 控制器 Client 模块做历史分片，见 installMobileHistory）；没有 Node 内置模块。
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
    /** 远程/手机 WebView 下保留的「最近会话」数量（超过按 LRU 释放额外 retain）。 */
    const DEFAULT_SESSION_CACHE_SIZE = 3;
    /** 手机 WebView 从后台恢复超过该时长后，主动重连以刷新会话状态（可用 globalThis 覆盖）。 */
    const RESUME_RECONNECT_AFTER_MS = 10_000;
    /**
     * 手机远程 WebView 的会话历史分片预算（T1）：首屏窗口 + 每次「加载更早」的翻页窗口。
     *
     * DSH 客户端打开会话时请求 `session/follow` 的历史窗口固定为
     * `{ maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } }`，大会话一帧可达
     * 数 MB（本机实测 3.5–4.5MB，更极端的大会话十几 MB），手机弱网下打开要等数秒。
     * 这里只在 `?dsh_mobile=1` 下把发往 Host 的**请求窗口参数**压小（`session/follow` 的首屏/
     * 重连 tail，以及 `session/page` 的翻页/跳转），随后由 DSH 既有分页（「加载更早」按钮、
     * `loadThrough`）按需补齐——不是代理层改帧，请求与响应两侧语义一致，符合 Host 的
     * `maxMessages`/`turnWindow` 校验与客户端的 `assertPageThrough`。
     *
     * 覆盖方式（调试用，改完刷新页面即可）：
     *   globalThis.__DSH_REMOTE_MOBILE_HISTORY__ = {
     *     open: { maxMessages: 6, minMessages: 3, minTurns: 1 },    // 首屏/重连
     *     page: { maxMessages: 10, minMessages: 5, minTurns: 1 },   // 向上翻历史（「加载更早」）
     *     jump: { maxMessages: 30, minMessages: 15, minTurns: 2 },  // 右侧 turn rail 跳转回填
     *     enabled: false,                                            // 关掉分片，恢复 DSH 默认窗口
     *   };
     * 省略字段 = 用默认值；非法值忽略；`minMessages` 自动收敛到 ≤ `maxMessages`。
     */
    const MOBILE_HISTORY_DEFAULTS = Object.freeze({
      open: Object.freeze({ maxMessages: 6, minMessages: 3, minTurns: 1 }),
      page: Object.freeze({ maxMessages: 10, minMessages: 5, minTurns: 1 }),
      // 跳转是「连续回填」：总字节不变，页越大轮次越少、单帧越大。30 条 ≈ 1.8–2.4MB 上限。
      jump: Object.freeze({ maxMessages: 30, minMessages: 15, minTurns: 2 }),
    });
    /**
     * 识别「跳转请求」（右侧 turn rail 点未加载的 turn → `Session.loadThrough`）：
     * DSH 的 `JUMP_PAGE_OPTIONS` 把 `turnWindow.minMessages` 提到 200（普通翻页是 50），
     * 这里用 100 做分界。识别不出来时退化为普通翻页窗口（仍能跳，只是轮次多些）。
     */
    const MOBILE_HISTORY_JUMP_MIN_MESSAGES = 100;
    /** globalThis 覆盖键：{ open?, page?, jump?, enabled? }。 */
    const MOBILE_HISTORY_OVERRIDE_KEY = '__DSH_REMOTE_MOBILE_HISTORY__';
    /** 诊断用：安装成功后把生效窗口挂到这里（globalThis.__DSH_REMOTE_MOBILE_HISTORY_ACTIVE__）。 */
    const MOBILE_HISTORY_ACTIVE_KEY = '__DSH_REMOTE_MOBILE_HISTORY_ACTIVE__';
    /** 诊断用：置 true 后把最近 100 次分页请求/响应记到 __DSH_REMOTE_MOBILE_HISTORY_LOG__。 */
    const MOBILE_HISTORY_STATS_KEY = '__DSH_REMOTE_MOBILE_HISTORY_STATS__';
    /** DSH Session 控制器 Client 半在浏览器模块表里的 id（`SessionEventStream` 由它导出）。 */
    const SESSION_CONTROLLER_MODULE = '@deepseek-ai/dsh-api-session-controller';
    /** 已安装标记（挂在 SessionEventStream.prototype 上；跨模块实例/重复 apply 幂等）。 */
    const MOBILE_HISTORY_INSTALLED = '__dshRemoteMobileHistoryWindow';
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
      'section.group': '群体服务（实验）',
      'group.note': '群体服务版（A 模式）：relay 终止手机 TLS，主机只做出站隧道；注册后无需本地证书/令牌/APNs 配置。',
      'group.tlsNote': '此模式下「TLS 证书路径」与「自托管 APNs」不生效；推送由服务部署方统一提供。',
      'sw.groupEnabled': '启用群体模式',
      'sw.groupEnabledNote': '开启后主机不监听 TLS、不持有证书；改为向服务端注册并走隧道。',
      'field.groupServiceUrl': '服务地址',
      'field.groupServiceUrlHint': 'https://relay.example.com:8443',
      'field.groupInviteCode': '邀请码',
      'field.groupInviteCodeHint': '一次性邀请码（仅首次注册需要）',
      'field.groupInviteCodeRegistered': '已注册，如需换服务请先「重置注册」',
      'group.registered': '已注册',
      'group.notRegistered': '未注册',
      'group.hostId': '服务端分配的主机 ID',
      'group.fqdn': '手机访问域名',
      'group.connected': '隧道连接',
      'group.lastError': '最近错误',
      'action.registerGroup': '注册并连接',
      'action.resetGroup': '重置注册',
      'msg.groupRegistered': '群体服务已注册并连接',
      'msg.groupRegisterFailed': '注册失败：{message}',
      'msg.groupReset': '已清除本机注册',
      'msg.groupMissing': '请填写服务地址与邀请码',
      'section.components': '组件',
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
      'msg.deleted': '设备记录已删除',
      'msg.deleteFailed': '删除失败：{message}',
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
      'btn.delete': '删除',
      'btn.deleteConfirm': '确认删除？',

      'sw.enabled': '启用远程访问',
      'sw.enabledNote': '关闭后中继断开，手机将无法访问这台电脑。',
      'sw.requireApproval': '新设备配对需要本机确认',
      'sw.requireApprovalNote': '开启后，手机扫码后还需要在这台电脑上确认一次。',
      'sw.restartHost': '允许手机重启主机 DSH',
      'sw.restartHostNote': '开启后 App 顶栏显示 ⏻：装了插件/改完功能后可在手机上直接重启主机（会短暂断开连接，随后自动恢复）。关闭后 App 不显示该按钮，重启接口也会拒绝请求；仍可在本机手动重启。',
      'sw.pushEnabled': '推送提醒',
      'sw.pushEnabledNote': '一轮任务结束/出错时发提醒：标题取会话标题、正文取本轮助手回复摘要（截断）；默认由主机直连 APNs（不经 relay、不用 Expo 账号）。锁屏会显示摘要。',
      'sw.pushSelfHosted': '自托管直连 APNs',
      'sw.pushSelfHostedNote': '开启：主机用 APNs 私钥直接发到 Apple；关闭：回退到旧版经 relay 的 Expo 推送。key 的 Environment 建议选 Sandbox & Production（只选 Sandbox 只能发开发包）。',
      'field.pushCooldown': '同会话推送冷却（秒）',
      'field.pushCooldownHint': '默认 30 秒，避免连续轮次刷屏',
      'field.apnsKeyFile': 'APNs 私钥路径',
      'field.apnsKeyFileHint': '/path/AuthKey_<KEY_ID>.p8（0600，勿放仓库）',
      'field.apnsKeyId': 'APNs Key ID',
      'field.apnsTeamId': 'Apple Team ID',
      'field.apnsTopic': 'APNs Topic（bundle ID）',
      'field.apnsTopicHint': 'com.example.app',
      'push.warnings': 'APNs 配置未完成：{errors}',

      'field.relayUrl': '中继地址',
      'field.relayUrlHint': 'wss://relay.example.com:8443',
      'field.relayDomain': '中继域名',
      'field.relayDomainHint': 'relay.example.com',
      'field.relayDomainNote': '主机域名为 <hostId>.<中继域名>。',
      'field.hostId': '主机 ID',
      'field.hostIdHint': 'h_ab12cd34',
      'field.publicPort': '手机访问端口',
      'field.publicPortHint': '443 或留空 = 默认 443；直连模式填 1443',
      'field.publicPortNote': '二维码会把该端口告诉 App。用 nginx 443 模式时留空/443；直连 relay 数据面时填公网端口，例如 1443。',
      'host.address': '手机访问地址',
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
      'section.group': 'Group service (experimental)',
      'group.note': 'Group mode (A): the relay terminates mobile TLS and the host only makes outbound tunnels. No local certs, tokens or APNs config needed after registration.',
      'group.tlsNote': 'TLS certificate paths and self-hosted APNs do not apply in group mode; push is provided by the service operator.',
      'sw.groupEnabled': 'Enable group mode',
      'sw.groupEnabledNote': 'The host stops listening on TLS and connects to the service relay via an outbound tunnel.',
      'field.groupServiceUrl': 'Service URL',
      'field.groupServiceUrlHint': 'https://relay.example.com:8443',
      'field.groupInviteCode': 'Invite code',
      'field.groupInviteCodeHint': 'One-time invite code (first registration only)',
      'field.groupInviteCodeRegistered': 'Registered — reset before switching service',
      'group.registered': 'Registered',
      'group.notRegistered': 'Not registered',
      'group.hostId': 'Server-assigned host ID',
      'group.fqdn': 'Mobile access domain',
      'group.connected': 'Tunnel',
      'group.lastError': 'Last error',
      'action.registerGroup': 'Register & connect',
      'action.resetGroup': 'Reset registration',
      'msg.groupRegistered': 'Group service registered and connected',
      'msg.groupRegisterFailed': 'Registration failed: {message}',
      'msg.groupReset': 'Local registration cleared',
      'msg.groupMissing': 'Enter service URL and invite code',
      'section.components': 'Components',
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
      'msg.deleted': 'Device record deleted',
      'msg.deleteFailed': 'Delete failed: {message}',
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
      'btn.delete': 'Delete',
      'btn.deleteConfirm': 'Confirm delete?',

      'sw.enabled': 'Enable remote access',
      'sw.enabledNote': 'Disabling disconnects the relay; the phone can no longer reach this computer.',
      'sw.requireApproval': 'Require confirmation on this computer for new pairings',
      'sw.requireApprovalNote': 'When on, a scanned phone must also be approved on this computer.',
      'sw.restartHost': 'Allow the phone to restart host DSH',
      'sw.restartHostNote': 'When on, the app top bar shows ⏻ so you can restart the host from the phone after installing plugins or changing features (the connection briefly drops and recovers). When off, the button is hidden and restart requests are rejected; manual restarts on this computer still work.',
      'sw.pushEnabled': 'Push notifications',
      'sw.pushEnabledNote': 'Notify when a turn completes or fails: the title is the session title and the body is a truncated summary of the turn\'s final assistant reply. The host talks to APNs directly (no relay, no Expo account). Summaries may appear on the lock screen.',
      'sw.pushSelfHosted': 'Self-hosted direct APNs',
      'sw.pushSelfHostedNote': 'On: the host signs and sends to Apple with its APNs key. Off: fall back to the legacy Expo push via the relay. Prefer an APNs key scoped to Sandbox & Production (a Sandbox-only key cannot reach release builds).',
      'field.pushCooldown': 'Per-session push cooldown (seconds)',
      'field.pushCooldownHint': 'Default 30s, to avoid notification spam across turns',
      'field.apnsKeyFile': 'APNs private key path',
      'field.apnsKeyFileHint': '/path/AuthKey_<KEY_ID>.p8 (0600, keep outside the repo)',
      'field.apnsKeyId': 'APNs Key ID',
      'field.apnsTeamId': 'Apple Team ID',
      'field.apnsTopic': 'APNs topic (bundle ID)',
      'field.apnsTopicHint': 'com.example.app',
      'push.warnings': 'APNs is not configured yet: {errors}',

      'field.relayUrl': 'Relay URL',
      'field.relayUrlHint': 'wss://relay.example.com:8443',
      'field.relayDomain': 'Relay domain',
      'field.relayDomainHint': 'relay.example.com',
      'field.relayDomainNote': 'Host domain is <hostId>.<relay domain>.',
      'field.hostId': 'Host ID',
      'field.hostIdHint': 'h_ab12cd34',
      'field.publicPort': 'Mobile access port',
      'field.publicPortHint': '443 or empty = default 443; direct mode: 1443',
      'field.publicPortNote': 'The QR code tells the app which port to use. Leave empty/443 behind nginx:443; set the public relay data port (e.g. 1443) for direct mode.',
      'host.address': 'Mobile address',
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
        publicPort: stringOrPrevious(firstDefined(config.publicPort, prev.publicPort), prev.publicPort !== undefined ? String(prev.publicPort) : '0'),
        relayDomain: stringOrPrevious(deriveRelayDomain(status), prev.relayDomain || ''),
        hostToken: '',
        hostName: stringOrPrevious(firstDefined(config.hostName, host.name), prev.hostName || ''),
        tlsCertFile: stringOrPrevious(certValue, prev.tlsCertFile || ''),
        tlsKeyFile: stringOrPrevious(firstDefined(config.tlsKeyFile, tls.keyFile), prev.tlsKeyFile || ''),
        requireApproval: pickRequireApproval(status),
        restartHostEnabled: config.restartHostEnabled !== undefined
          ? config.restartHostEnabled === true
          : (status && status.restart && typeof status.restart.enabled === 'boolean'
            ? status.restart.enabled
            : (prev.restartHostEnabled === true)),
        pushEnabled: config.pushEnabled !== undefined ? config.pushEnabled !== false : (prev.pushEnabled !== undefined ? prev.pushEnabled : true),
        pushCooldownSeconds: stringOrPrevious(config.pushCooldownSeconds, prev.pushCooldownSeconds !== undefined ? String(prev.pushCooldownSeconds) : '30'),
        pushProvider: config.pushProvider === 'expo' ? 'expo' : (config.pushProvider === 'apns' ? 'apns' : (prev.pushProvider === 'expo' ? 'expo' : 'apns')),
        apnsKeyFile: stringOrPrevious(config.apnsKeyFile, prev.apnsKeyFile || ''),
        apnsKeyId: stringOrPrevious(config.apnsKeyId, prev.apnsKeyId || ''),
        apnsTeamId: stringOrPrevious(config.apnsTeamId, prev.apnsTeamId || ''),
        apnsTopic: stringOrPrevious(config.apnsTopic, prev.apnsTopic || ''),
        apnsEnvironment: stringOrPrevious(config.apnsEnvironment, prev.apnsEnvironment || 'auto'),
        groupEnabled: config.groupEnabled !== undefined ? config.groupEnabled === true : prev.groupEnabled === true,
        groupServiceUrl: stringOrPrevious(config.groupServiceUrl, prev.groupServiceUrl || ''),
        groupInviteCode: '',
        groupPlainPort: stringOrPrevious(config.groupPlainPort, prev.groupPlainPort !== undefined ? String(prev.groupPlainPort) : '0'),
        groupInsecure: config.groupInsecure !== undefined ? config.groupInsecure === true : prev.groupInsecure === true,
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
      // 测试专用：直接注入一份已加载的 status，跳过 effect 里的网络请求。
      const seedStatus = props.initialStatus ?? null;
      const seedDraft = seedStatus ? draftFromStatus(seedStatus, null) : null;
      const [status, setStatus] = useState(seedStatus);
      const [audit, setAudit] = useState(null);
      const [auditError, setAuditError] = useState('');
      const [loadError, setLoadError] = useState('');
      const [draft, setDraft] = useState(seedDraft);
      const [baseline, setBaseline] = useState(seedDraft);
      const [busy, setBusy] = useState('');
      const [revokeId, setRevokeId] = useState(null);
      const [deleteId, setDeleteId] = useState(null);
      const [pairingOpen, setPairingOpen] = useState(false);
      const [flash, showFlash, dismissFlash] = useFlash();
      const now = useNow(1000);
      const aliveRef = useRef(true);
      const revokeTimerRef = useRef(null);
      const deleteTimerRef = useRef(null);

      useEffect(() => {
        aliveRef.current = true;
        return () => {
          aliveRef.current = false;
          if (revokeTimerRef.current !== null) globalThis.clearTimeout(revokeTimerRef.current);
          if (deleteTimerRef.current !== null) globalThis.clearTimeout(deleteTimerRef.current);
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
        const publicPortRaw = String(draft.publicPort ?? '').trim();
        const publicPort = publicPortRaw === '' ? 0 : Number.parseInt(publicPortRaw, 10);
        if (Number.isFinite(publicPort) && publicPort >= 0 && publicPort <= 65535
          && String(publicPort) !== String(baseline.publicPort)) {
          patch.publicPort = publicPort;
        }
        const hostName = draft.hostName.trim();
        if (hostName !== baseline.hostName) patch.hostName = hostName;
        if (draft.groupEnabled !== baseline.groupEnabled) patch.groupEnabled = draft.groupEnabled === true;
        const groupServiceUrl = draft.groupServiceUrl.trim();
        if (groupServiceUrl !== baseline.groupServiceUrl) patch.groupServiceUrl = groupServiceUrl;
        const groupPlainPortRaw = String(draft.groupPlainPort ?? '').trim();
        const groupPlainPort = groupPlainPortRaw === '' ? 0 : Number.parseInt(groupPlainPortRaw, 10);
        if (Number.isFinite(groupPlainPort) && groupPlainPort >= 0 && groupPlainPort <= 65535
          && String(groupPlainPort) !== String(baseline.groupPlainPort)) {
          patch.groupPlainPort = groupPlainPort;
        }
        if (draft.groupInsecure !== baseline.groupInsecure) patch.groupInsecure = draft.groupInsecure === true;
        const tlsCertFile = draft.tlsCertFile.trim();
        if (tlsCertFile !== baseline.tlsCertFile) patch.tlsCertFile = tlsCertFile;
        const tlsKeyFile = draft.tlsKeyFile.trim();
        if (tlsKeyFile !== '' && tlsKeyFile !== baseline.tlsKeyFile) patch.tlsKeyFile = tlsKeyFile;
        const hostToken = draft.hostToken.trim();
        if (hostToken !== '') patch.hostToken = hostToken;
        if (draft.requireApproval !== baseline.requireApproval) patch.requireApproval = draft.requireApproval;
        if (draft.restartHostEnabled !== baseline.restartHostEnabled) patch.restartHostEnabled = draft.restartHostEnabled === true;
        if (draft.pushEnabled !== baseline.pushEnabled) patch.pushEnabled = draft.pushEnabled === true;
        const pushProvider = draft.pushProvider === 'expo' ? 'expo' : 'apns';
        if (pushProvider !== baseline.pushProvider) patch.pushProvider = pushProvider;
        const apnsKeyFile = draft.apnsKeyFile.trim();
        if (apnsKeyFile !== baseline.apnsKeyFile) patch.apnsKeyFile = apnsKeyFile;
        const apnsKeyId = draft.apnsKeyId.trim();
        if (apnsKeyId !== baseline.apnsKeyId) patch.apnsKeyId = apnsKeyId;
        const apnsTeamId = draft.apnsTeamId.trim();
        if (apnsTeamId !== baseline.apnsTeamId) patch.apnsTeamId = apnsTeamId;
        const apnsTopic = draft.apnsTopic.trim();
        if (apnsTopic !== baseline.apnsTopic) patch.apnsTopic = apnsTopic;
        const cooldown = Number.parseInt(String(draft.pushCooldownSeconds), 10);
        if (Number.isFinite(cooldown) && cooldown >= 0 && String(cooldown) !== String(baseline.pushCooldownSeconds)) {
          patch.pushCooldownSeconds = cooldown;
        }
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

      const registerGroup = async () => {
        if (busy === 'group') return;
        const groupServiceUrl = draft.groupServiceUrl.trim();
        const groupInviteCode = draft.groupInviteCode.trim();
        if (groupServiceUrl === '' || groupInviteCode === '') {
          showFlash('warn', t('msg.groupMissing'));
          return;
        }
        setBusy('group');
        try {
          const response = await jpost('/group/register', {
            serviceUrl: groupServiceUrl,
            inviteCode: groupInviteCode,
            ...(draft.hostName.trim() !== '' ? { hostName: draft.hostName.trim() } : {}),
          });
          if (!aliveRef.current) return;
          const next = response && typeof response === 'object' ? response : status;
          const fresh = draftFromStatus(next, draft);
          setStatus(next);
          setDraft(fresh);
          setBaseline(fresh);
          showFlash('good', t('msg.groupRegistered'));
        } catch (error) {
          if (aliveRef.current) showFlash('warn', t('msg.groupRegisterFailed', { message: formatError(error) }));
        } finally {
          if (aliveRef.current) setBusy('');
        }
      };

      const resetGroup = async () => {
        if (busy === 'group') return;
        setBusy('group');
        try {
          const response = await jpost('/group/reset', {});
          if (!aliveRef.current) return;
          const next = response && typeof response === 'object' ? response : status;
          const fresh = draftFromStatus(next, draft);
          setStatus(next);
          setDraft(fresh);
          setBaseline(fresh);
          showFlash('good', t('msg.groupReset'));
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

      const deleteDevice = async (device) => {
        if (!device || !device.id) return;
        if (deleteId !== device.id) {
          setDeleteId(device.id);
          if (deleteTimerRef.current !== null) globalThis.clearTimeout(deleteTimerRef.current);
          deleteTimerRef.current = globalThis.setTimeout(() => {
            deleteTimerRef.current = null;
            setDeleteId(null);
          }, 4000);
          return;
        }
        if (deleteTimerRef.current !== null) {
          globalThis.clearTimeout(deleteTimerRef.current);
          deleteTimerRef.current = null;
        }
        setDeleteId(null);
        setBusy(`delete:${device.id}`);
        try {
          await jpost(`/devices/${encodeURIComponent(device.id)}/delete`, {});
          if (aliveRef.current) showFlash('good', t('msg.deleted'));
          try {
            const next = await jget('/status');
            if (aliveRef.current) setStatus(next);
          } catch {
            /* ignore */
          }
          void loadAudit();
        } catch (error) {
          if (aliveRef.current) showFlash('warn', t('msg.deleteFailed', { message: formatError(error) }));
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

      const group = status.group || {};
      const groupRegistered = group.registered === true;
      const groupSection = h(Section, { title: t('section.group') },
        h(Row, {
          label: t('sw.groupEnabled'),
          note: t('sw.groupEnabledNote'),
        }, h(Toggle, {
          checked: draft.groupEnabled === true,
          disabled,
          label: t('sw.groupEnabled'),
          onChange: (value) => setDraft({ ...draft, groupEnabled: value }),
        })),
        h('div', { 'data-ra-note': '' }, t('group.note')),
        draft.groupEnabled
          ? h('div', { 'data-ra-grid': '' },
            h(Field, {
              label: t('field.groupServiceUrl'),
              value: draft.groupServiceUrl,
              placeholder: t('field.groupServiceUrlHint'),
              onChange: (value) => setDraft({ ...draft, groupServiceUrl: value }),
            }),
            h(Field, {
              label: t('field.groupInviteCode'),
              type: 'password',
              value: draft.groupInviteCode,
              placeholder: groupRegistered ? t('field.groupInviteCodeRegistered') : t('field.groupInviteCodeHint'),
              autoComplete: 'new-password',
              onChange: (value) => setDraft({ ...draft, groupInviteCode: value }),
            }))
          : null,
        draft.groupEnabled
          ? h('div', null,
            h(InfoRow, { label: t('group.registered'), value: groupRegistered ? t('group.registered') : t('group.notRegistered') }),
            h(InfoRow, { label: t('group.hostId'), value: group.hostId || '—' }),
            h(InfoRow, { label: t('group.fqdn'), value: group.fqdn || '—' }),
            h(InfoRow, {
              label: t('group.connected'),
              value: h('span', { 'data-ra-inline': '' },
                h(Dot, { tone: group.connected ? 'good' : 'bad' }),
                group.connected ? t('relay.connected') : t('relay.disconnected')),
            }),
            group.lastError
              ? h(InfoRow, { label: t('group.lastError'), value: h('span', { style: { color: '#ef4444' } }, String(group.lastError)) })
              : null)
          : null,
        draft.groupEnabled
          ? h('div', { 'data-ra-actions': '' },
            h(Btn, { onClick: () => { void registerGroup(); }, disabled: busy === 'group' || groupRegistered }, t('action.registerGroup')),
            h(Btn, { onClick: () => { void resetGroup(); }, disabled: busy === 'group' || !groupRegistered }, t('action.resetGroup')))
          : null,
        draft.groupEnabled ? h('div', { 'data-ra-note': '' }, t('group.tlsNote')) : null);

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
        h(InfoRow, { label: t('host.address'), value: host.address || host.domain || '—' }),
        h(InfoRow, { label: t('host.fingerprint'), value: fingerprint || '—' }),
        h(InfoRow, {
          label: t('host.cert'),
          value: h('span', { 'data-ra-inline': '' },
            h('span', null, tls.certFile || '—'),
            enabled && tls.valid === false ? h('span', { 'data-ra-badge': '', 'data-tone': 'warn' }, t('host.certInvalid')) : null,
            tls.dev ? h('span', { 'data-ra-badge': '', 'data-tone': '' }, t('host.certDev')) : null),
        }),
        h(InfoRow, { label: t('host.version'), value: status.version || '—' }));

      const pushWarnings = status && status.push && Array.isArray(status.push.warnings) ? status.push.warnings : [];
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
          }),
          h(Field, {
            label: t('field.publicPort'),
            value: draft.publicPort,
            placeholder: t('field.publicPortHint'),
            onChange: (value) => setDraft({ ...draft, publicPort: value }),
          })),
        h('div', { 'data-ra-note': '' }, t('field.publicPortNote')),
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
        h(Row, { label: t('sw.pushEnabled'), note: t('sw.pushEnabledNote') },
          h(Toggle, {
            checked: draft.pushEnabled,
            disabled,
            label: t('sw.pushEnabled'),
            onChange: (value) => setDraft({ ...draft, pushEnabled: value }),
          })),
        h(Row, { label: t('sw.pushSelfHosted'), note: t('sw.pushSelfHostedNote') },
          h(Toggle, {
            checked: draft.pushProvider === 'apns',
            disabled,
            label: t('sw.pushSelfHosted'),
            onChange: (value) => setDraft({ ...draft, pushProvider: value ? 'apns' : 'expo' }),
          })),
        pushWarnings.length > 0 && draft.pushEnabled && draft.pushProvider === 'apns'
          ? h('div', { 'data-ra-note': '' }, t('push.warnings', { errors: pushWarnings.join('；') }))
          : null,
        h('div', { 'data-ra-grid': '' },
          h(Field, {
            label: t('field.apnsKeyFile'),
            value: draft.apnsKeyFile,
            placeholder: t('field.apnsKeyFileHint'),
            onChange: (value) => setDraft({ ...draft, apnsKeyFile: value }),
          }),
          h(Field, {
            label: t('field.apnsKeyId'),
            value: draft.apnsKeyId,
            placeholder: 'ABC123DEF4',
            onChange: (value) => setDraft({ ...draft, apnsKeyId: value }),
          }),
          h(Field, {
            label: t('field.apnsTeamId'),
            value: draft.apnsTeamId,
            placeholder: 'TEAM123456',
            onChange: (value) => setDraft({ ...draft, apnsTeamId: value }),
          }),
          h(Field, {
            label: t('field.apnsTopic'),
            value: draft.apnsTopic,
            placeholder: t('field.apnsTopicHint'),
            onChange: (value) => setDraft({ ...draft, apnsTopic: value }),
          })),
        h('div', { 'data-ra-grid': '' },
          h(Field, {
            label: t('field.pushCooldown'),
            value: draft.pushCooldownSeconds,
            placeholder: t('field.pushCooldownHint'),
            onChange: (value) => setDraft({ ...draft, pushCooldownSeconds: value }),
          })),
        h('div', { 'data-ra-actions': '' },
          h(Btn, { primary: true, disabled, onClick: () => { void save(); } },
            busy === 'save' ? t('btn.saving') : t('btn.save'))));

      const componentsSection = h(Section, { title: t('section.components') },
        h(Row, { label: t('sw.restartHost'), note: t('sw.restartHostNote') },
          h(Toggle, {
            checked: draft.restartHostEnabled,
            disabled,
            label: t('sw.restartHost'),
            onChange: (value) => setDraft({ ...draft, restartHostEnabled: value }),
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
          h(Btn, {
            danger: true,
            action: revoked ? 'device-delete' : 'device-revoke',
            disabled: busy === `${revoked ? 'delete' : 'revoke'}:${device.id}`,
            onClick: () => { void (revoked ? deleteDevice(device) : revoke(device)); },
          }, revoked
            ? (deleteId === device.id ? t('btn.deleteConfirm') : t('btn.delete'))
            : (revokeId === device.id ? t('btn.revokeConfirm') : t('btn.revoke'))));
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
        groupSection,
        connectionSection,
        componentsSection,
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

    /* ────────────────────── 会话热缓存（远程 / 手机 WebView） ────────────────────── */

    /**
     * 把最近看过的几个 Session 以「额外 retain」的方式钉在客户端内存里。
     *
     * 为什么需要：DSH Web Client 用引用计数式 retention —— 主视图只对「当前会话」
     * 持有 source="mainView" 的 retain，切换会话时旧 retain 立刻释放，Session 实例
     * （含已加载历史 + 正在跟进的 event stream）随即被 dispose；再切回来要新建实例
     * 并重新拉 `session/follow` 的整段历史快照。本机局域网很快，但经 relay 的远程/
     * 手机访问时一个大会话快照可达数 MB，就表现为「每次切会话都要重新同步」。
     *
     * 这里为最近 max 个「用户真正打开过」的会话额外 retain（source="dsh-remote-cache"）：
     *   - 切走时实例不销毁，历史与 event stream 留在内存；
     *   - event stream 在连接断开/重连时按 cursor 续传（只补差异，不重拉快照）；
     *   - 切回时 `Session.open()` 已是 open 状态，直接复用，瞬间完成；
     *   - 超过 max 个按 LRU 释放我们这一份 retain（只撤缓存；当前正被查看的会话
     *     仍由 mainView 持有，不会被误销毁）；
     *   - 连接断开/重连期间主动释放「非当前查看」的缓存：mux 恢复后 DSH 会为每个
     *     仍打开的 event stream 重发一次 tail 快照，若缓存太多会在弱网重连时放大
     *     流量；这里只保留当前会话（它的流本来就要恢复），恢复后随用户切换重新填充。
     *
     * 只在 `?dsh_mobile=1`（手机远程 WebView）下启用，避免影响桌面本机内存占用；
     * 可通过 `globalThis.__DSH_REMOTE_SESSION_CACHE__ = { max }` 调整数量（调试用）。
     *
     * @param {{ sessions?: any, effect?: Function }} scope 已 inject "sessions" 的上下文
     * @param {{ max?: number, source?: string }} [options]
     * @returns {{ pin: Function, sync: Function, size: Function, pinnedIds: Function, dispose: Function } | null}
     */
    function installSessionWarmCache(scope, options) {
      const sessions = scope && scope.sessions;
      if (!sessions
        || typeof sessions.retain !== 'function'
        || typeof sessions.retainInfo !== 'function'
        || typeof scope.effect !== 'function') return null;
      const opts = options && typeof options === 'object' ? options : {};
      const max = Number.isInteger(opts.max) && opts.max > 0
        ? Math.min(opts.max, 10)
        : DEFAULT_SESSION_CACHE_SIZE;
      const source = typeof opts.source === 'string' && opts.source !== '' ? opts.source : 'dsh-remote-cache';
      const connection = opts.connection;
      /** @type {Map<string, { release: () => void, usedAt: number }>} */
      const pinned = new Map();
      /** @type {Map<string, () => void>} */
      const watchers = new Map();
      /** 上一次 list 快照里出现过的会话（用于识别被删除的会话并释放缓存）。 */
      const knownIds = new Set();
      let listUnsubscribe = null;
      let disposed = false;

      const retentionOf = (id) => {
        try {
          const snapshot = sessions.retainInfo(id)?.getSnapshot?.();
          return snapshot && typeof snapshot === 'object' ? snapshot : null;
        } catch { return null; }
      };
      const isActivelyViewed = (id) => {
        const retainedBy = retentionOf(id)?.retainedBy;
        if (!retainedBy || typeof retainedBy !== 'object') return false;
        return (retainedBy.mainView || 0) > 0 || (retainedBy.sidebarView || 0) > 0;
      };
      const evictOverflow = () => {
        while (pinned.size > max) {
          // 只淘汰当前没在看的会话：淘汰 viewed 会话会立刻触发 retention 变化 → 又被 pin
          // 回来（抖动/递归），而它释放与否本来也不影响 UI 持有的实例。
          let oldestId = null;
          let oldestUsedAt = Infinity;
          for (const [id, entry] of pinned) {
            if (isActivelyViewed(id)) continue;
            if (entry.usedAt < oldestUsedAt) { oldestId = id; oldestUsedAt = entry.usedAt; }
          }
          if (oldestId === null) return;
          const entry = pinned.get(oldestId);
          pinned.delete(oldestId);
          try { entry.release(); } catch { /* ignore */ }
        }
      };
      /** 正在 pin 中的会话 id（防重入：sessions.retain 会同步发布 retention 变化）。 */
      const pinning = new Set();
      const pin = (id) => {
        if (disposed || typeof id !== 'string' || id === '') return;
        const existing = pinned.get(id);
        if (existing !== undefined) { existing.usedAt = Date.now(); return; }
        if (pinning.has(id)) return;
        pinning.add(id);
        // 关键：先占位再 retain。`sessions.retain()` 会**同步**发布 retention 变化，
        // 订阅回调会再次进入 pin；如果这时 pinned 里还没有这条记录，就会无限递归
        // （真机/浏览器表现为 RangeError: Maximum call stack size exceeded，会话打不开）。
        const entry = { usedAt: Date.now(), release: () => {} };
        pinned.set(id, entry);
        let reference = null;
        try {
          reference = sessions.retain(id, { source });
        } catch {
          pinned.delete(id);
          pinning.delete(id);
          return; /* 会话已删除 / 不可打开 */
        }
        if (reference && reference.ready && typeof reference.ready.catch === 'function') reference.ready.catch(() => {});
        entry.release = () => { try { reference?.release?.(); } catch { /* ignore */ } };
        pinning.delete(id);
        evictOverflow();
      };
      const unwatch = (id) => {
        const dispose = watchers.get(id);
        watchers.delete(id);
        if (typeof dispose === 'function') { try { dispose(); } catch { /* ignore */ } }
      };
      const watch = (id) => {
        if (disposed || watchers.has(id)) return;
        let unsubscribe = null;
        try {
          const info = sessions.retainInfo(id);
          if (info && typeof info.subscribe === 'function') {
            unsubscribe = info.subscribe(() => { if (isActivelyViewed(id)) pin(id); });
          }
        } catch { /* ignore */ }
        watchers.set(id, () => { try { unsubscribe?.(); } catch { /* ignore */ } });
        // 插件可能晚于当前会话挂载：此时不会再有 retention 变化事件，直接检查一次。
        if (isActivelyViewed(id)) pin(id);
      };
      const sync = () => {
        if (disposed) return;
        let snapshot = null;
        try { snapshot = sessions.list?.getSnapshot?.(); } catch { snapshot = null; }
        if (!snapshot || typeof snapshot !== 'object') return;
        const ids = Array.isArray(snapshot.ids)
          ? snapshot.ids.filter((id) => typeof id === 'string')
          : Object.keys(snapshot.byId || {});
        const seen = new Set(ids);
        for (const id of ids) watch(id);
        for (const id of [...watchers.keys()]) if (!seen.has(id)) unwatch(id);
        // 已从会话列表消失（删除/归档不可见）的会话：释放缓存，避免泄漏与误保留。
        for (const id of [...pinned.keys()]) {
          if (seen.has(id) || !knownIds.has(id)) continue;
          const entry = pinned.get(id);
          pinned.delete(id);
          try { entry.release(); } catch { /* ignore */ }
        }
        knownIds.clear();
        for (const id of ids) knownIds.add(id);
      };
      /** 连接断开/重连时只保留当前正在查看的会话，避免恢复时放大 tail 快照流量。 */
      const releaseInactivePins = () => {
        for (const [id, entry] of [...pinned.entries()]) {
          if (isActivelyViewed(id)) continue;
          pinned.delete(id);
          try { entry.release(); } catch { /* ignore */ }
        }
      };
      let connectionUnsubscribe = null;
      try {
        const state = connection && connection.state;
        if (state && typeof state.subscribe === 'function') {
          connectionUnsubscribe = state.subscribe(() => {
            let current = null;
            try { current = state.getSnapshot?.(); } catch { current = null; }
            if (current !== 'connected') releaseInactivePins();
          });
        }
      } catch { connectionUnsubscribe = null; }
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        if (typeof listUnsubscribe === 'function') { try { listUnsubscribe(); } catch { /* ignore */ } }
        listUnsubscribe = null;
        if (typeof connectionUnsubscribe === 'function') { try { connectionUnsubscribe(); } catch { /* ignore */ } }
        connectionUnsubscribe = null;
        for (const id of [...watchers.keys()]) unwatch(id);
        for (const entry of pinned.values()) { try { entry.release(); } catch { /* ignore */ } }
        pinned.clear();
      };
      try {
        listUnsubscribe = sessions.list?.subscribe?.(sync) ?? null;
      } catch { listUnsubscribe = null; }
      scope.effect(() => {
        sync();
        return dispose;
      }, 'remote-access: session warm cache');
      return {
        pin,
        sync,
        size: () => pinned.size,
        pinnedIds: () => [...pinned.keys()],
        dispose,
      };
    }

    /**
     * 手机 WebView 从后台恢复时主动重建 DSH 连接，让 session follow / 投影重新对齐。
     *
     * 为什么需要：iOS 后台会挂起 WKWebView 的 JS 和定时器；如果原 WebSocket 看上去还
     * 活着，DSH 客户端不会重连，恢复后 UI 可能先显示后台前的旧状态（例如运行中计时
     * 停在“4 分钟”），随后又被一次重连刷新成真实值（“20 分钟”），表现为闪烁/信息不对等。
     * 这里在页面隐藏 ≥ 阈值后再次可见时调用 connection.reconnect()，强制重建 generation
     * 并让 gateway 重新下发 tail 快照。
     *
     * 阈值可通过 `globalThis.__DSH_REMOTE_RESUME_RECONNECT_MS__` 覆盖（调试用）。
     *
     * @param {{connection?: any, effect?: Function}} scope 已 inject "connection" 的上下文
     */
    function installResumeReconnect(scope) {
      if (!scope || typeof scope.effect !== 'function') return;
      const connection = scope.connection;
      if (!connection || typeof connection.reconnect !== 'function') return;
      if (typeof document === 'undefined'
        || typeof document.addEventListener !== 'function'
        || typeof document.visibilityState !== 'string') return;
      const override = Number(globalThis.__DSH_REMOTE_RESUME_RECONNECT_MS__);
      const thresholdMs = Number.isFinite(override) && override >= 0 ? override : RESUME_RECONNECT_AFTER_MS;
      let hiddenAt = 0;
      const onVisibilityChange = () => {
        try {
          if (document.visibilityState === 'hidden') {
            hiddenAt = Date.now();
            return;
          }
          if (document.visibilityState !== 'visible') return;
          const previous = hiddenAt;
          hiddenAt = 0;
          if (previous === 0 || Date.now() - previous < thresholdMs) return;
          connection.reconnect();
          if (typeof console !== 'undefined' && typeof console.info === 'function') {
            console.info('[dsh-remote] resumed after', Math.round((Date.now() - previous) / 1000), 's; reconnecting to reconcile session state');
          }
        } catch { /* 恢复失败不影响页面 */ }
      };
      document.addEventListener('visibilitychange', onVisibilityChange);
      scope.effect(() => () => {
        try { document.removeEventListener('visibilitychange', onVisibilityChange); } catch { /* ignore */ }
      }, 'remote-access: resume reconnect');
    }

    /* ────────────────── 手机端会话历史分片（首屏窗口 + 翻页窗口） ────────────────── */

    /**
     * 读 globalThis 覆盖并规整成生效窗口；`enabled:false` 返回 null（= 不分片）。
     *
     * @param {*} [raw] 覆盖对象；缺省读 `globalThis.__DSH_REMOTE_MOBILE_HISTORY__`（测试可传）。
     * @returns {{open: {maxMessages:number,minMessages:number,minTurns:number},
     *            page: {maxMessages:number,minMessages:number,minTurns:number}} | null}
     */
    function resolveMobileHistoryWindows(raw) {
      let source = raw;
      if (source === undefined) {
        try { source = typeof globalThis === 'object' && globalThis ? globalThis[MOBILE_HISTORY_OVERRIDE_KEY] : undefined; } catch { source = undefined; }
      }
      if (source && typeof source === 'object' && source.enabled === false) return null;
      const pick = (name) => {
        const defaults = MOBILE_HISTORY_DEFAULTS[name];
        const window = { maxMessages: defaults.maxMessages, minMessages: defaults.minMessages, minTurns: defaults.minTurns };
        const candidate = source && typeof source === 'object' && source[name] && typeof source[name] === 'object' ? source[name] : null;
        if (candidate !== null) {
          for (const key of ['maxMessages', 'minMessages', 'minTurns']) {
            const value = Number(candidate[key]);
            if (Number.isSafeInteger(value) && value > 0) window[key] = value;
          }
        }
        // Host 校验：minMessages 必须是 ≤ maxMessages 的正整数；minTurns 至少 1。
        window.minMessages = Math.min(window.minMessages, window.maxMessages);
        window.minTurns = Math.max(1, window.minTurns);
        return window;
      };
      return { open: pick('open'), page: pick('page'), jump: pick('jump') };
    }

    /**
     * 把一条分页/跟进请求的窗口参数压到手机预算；其余字段原样保留。
     *
     * 只收紧、不放大：请求本来就更小（例如未来 UI 自己传了更小的窗口）时保留请求值。
     * 请求没有 `turnWindow`（Host 的 message-aligned 模式）时不凭空添加，只压 `maxMessages`。
     *
     * @param {*} request `session/follow` / `session/page` 的请求对象。
     * @param {{maxMessages:number,minMessages:number,minTurns:number}} window 目标窗口。
     * @returns {*} 新请求对象；输入不是对象时原样返回。
     */
    function applyMobileHistoryWindow(request, window) {
      if (!request || typeof request !== 'object' || !window) return request;
      const next = { ...request };
      const requestedMax = Number.isSafeInteger(request.maxMessages) && request.maxMessages > 0 ? request.maxMessages : null;
      next.maxMessages = requestedMax === null ? window.maxMessages : Math.min(requestedMax, window.maxMessages);
      const turnWindow = request.turnWindow && typeof request.turnWindow === 'object' ? request.turnWindow : null;
      if (turnWindow !== null) {
        const requestedMinMessages = Number.isSafeInteger(turnWindow.minMessages) && turnWindow.minMessages > 0 ? turnWindow.minMessages : window.minMessages;
        const requestedMinTurns = Number.isSafeInteger(turnWindow.minTurns) && turnWindow.minTurns > 0 ? turnWindow.minTurns : window.minTurns;
        next.turnWindow = {
          minMessages: Math.min(requestedMinMessages, window.minMessages, next.maxMessages),
          minTurns: Math.max(1, Math.min(requestedMinTurns, window.minTurns)),
        };
      }
      return next;
    }

    /**
     * 是否是一次 turn 跳转请求（`Session.loadThrough` 用的 `JUMP_PAGE_OPTIONS`）。
     *
     * @param {*} request `session/page` 请求对象。
     * @returns {boolean} true = 用 `jump` 窗口，false = 用普通翻页窗口。
     */
    function isMobileHistoryJumpRequest(request) {
      const minMessages = request && typeof request === 'object' && request.turnWindow && typeof request.turnWindow === 'object'
        ? request.turnWindow.minMessages
        : undefined;
      return Number.isSafeInteger(minMessages) && minMessages >= MOBILE_HISTORY_JUMP_MIN_MESSAGES;
    }

    /** 诊断日志（仅 `globalThis.__DSH_REMOTE_MOBILE_HISTORY_STATS__ === true` 时记录，最多 100 条）。 */
    function recordMobileHistoryStat(entry) {
      try {
        if (typeof globalThis !== 'object' || globalThis === null) return;
        if (globalThis[MOBILE_HISTORY_STATS_KEY] !== true) return;
        let log = globalThis.__DSH_REMOTE_MOBILE_HISTORY_LOG__;
        if (!Array.isArray(log)) {
          log = [];
          globalThis.__DSH_REMOTE_MOBILE_HISTORY_LOG__ = log;
        }
        log.push({ at: Date.now(), ...entry });
        if (log.length > 100) log.splice(0, log.length - 100);
      } catch { /* 诊断失败不影响分页 */ }
    }

    /** 只在手机预算统计开启时返回 performance.now() 基线。 */
    function mobileHistoryClock() {
      try {
        if (typeof globalThis !== 'object' || globalThis === null || globalThis[MOBILE_HISTORY_STATS_KEY] !== true) return null;
        return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
      } catch { return null; }
    }

    /**
     * 安装「手机端历史窗口」：包装 DSH Client 的 `SessionEventStream.prototype.repairRequest`
     * （`session/follow` 首屏 + 重连 tail 的窗口来源）与 `.readPage`（`session/page` 翻页/跳转），
     * 把请求窗口压到 {@link MOBILE_HISTORY_DEFAULTS} 或 `globalThis.__DSH_REMOTE_MOBILE_HISTORY__`。
     *
     * 任何一步拿不到（模块不在浏览器模块表、DSH 版本改了类/方法名）都只返回 null 静默降级，
     * 主 UI 行为与桌面完全不受影响；重复安装（HMR / 二次 apply）复用同一份包装。
     *
     * @param {{effect?: Function}} scope 已 inject "sessions" 的 Client 上下文。
     * @param {{loadModule?: Function, windows?: object|null}} options loadModule = 模块表 require。
     * @returns {{windows: object, reused: boolean, dispose: Function} | null}
     */
    function installMobileHistoryWindow(scope, options) {
      const opts = options && typeof options === 'object' ? options : {};
      const loadModule = typeof opts.loadModule === 'function' ? opts.loadModule : null;
      if (loadModule === null) return null;
      const windows = opts.windows === undefined ? resolveMobileHistoryWindows() : opts.windows;
      if (windows === null) return null;
      let controller = null;
      try {
        controller = loadModule(SESSION_CONTROLLER_MODULE);
      } catch (error) {
        if (typeof console !== 'undefined' && typeof console.warn === 'function') {
          console.warn('[dsh-remote] mobile session history unavailable:', error);
        }
        return null;
      }
      const StreamClass = controller && controller.SessionEventStream;
      const proto = StreamClass && StreamClass.prototype;
      if (!proto || typeof proto.repairRequest !== 'function' || typeof proto.readPage !== 'function') return null;

      // 幂等：同一页面重复安装不叠加包装，只把窗口更新为最新配置。
      const existing = proto[MOBILE_HISTORY_INSTALLED];
      if (existing !== undefined && existing !== null && typeof existing.update === 'function') {
        existing.update(windows);
        return { windows: existing.windows, reused: true, dispose() {} };
      }

      const current = {
        open: { ...windows.open },
        page: { ...windows.page },
        // 显式传入 windows 的调用方（测试/未来复用）可以不带 jump：退化为普通翻页窗口。
        jump: { ...(windows.jump || windows.page) },
      };
      const original = { repairRequest: proto.repairRequest, readPage: proto.readPage };
      let publishedActive = null;
      const publishActive = () => {
        try {
          if (typeof globalThis !== 'object' || globalThis === null) return;
          publishedActive = { open: { ...current.open }, page: { ...current.page }, jump: { ...current.jump } };
          globalThis[MOBILE_HISTORY_ACTIVE_KEY] = publishedActive;
        } catch { /* ignore */ }
      };

      function patchedRepairRequest(request) {
        recordMobileHistoryStat({ kind: 'follow', window: { ...current.open } });
        const repaired = original.repairRequest.call(this, request);
        return applyMobileHistoryWindow(repaired, current.open);
      }

      function patchedReadPage(request, throughSeq, signal) {
        const jump = isMobileHistoryJumpRequest(request);
        const window = jump ? current.jump : current.page;
        const next = applyMobileHistoryWindow(request, window);
        recordMobileHistoryStat({
          kind: jump ? 'jump' : 'page',
          window: { ...window },
          beforeSeq: typeof next?.beforeSeq === 'number' ? next.beforeSeq : undefined,
        });
        const startedAt = mobileHistoryClock();
        const result = original.readPage.call(this, next, throughSeq, signal);
        if (startedAt !== null && result && typeof result.then === 'function') {
          result.then((page) => {
            const endedAt = mobileHistoryClock();
            recordMobileHistoryStat({
              kind: 'page-result',
              records: Array.isArray(page?.records) ? page.records.length : 0,
              hasMore: page?.hasMore === true,
              ...endedAt === null ? {} : { ms: Math.round(endedAt - startedAt) },
            });
          }, () => {});
        }
        return result;
      }

      const handle = {
        windows: current,
        reused: false,
        update(next) {
          if (!next || typeof next !== 'object') return;
          current.open = { ...next.open };
          current.page = { ...next.page };
          if (next.jump && typeof next.jump === 'object') current.jump = { ...next.jump };
          publishActive();
        },
        dispose() {
          try {
            if (proto.repairRequest === patchedRepairRequest) proto.repairRequest = original.repairRequest;
            if (proto.readPage === patchedReadPage) proto.readPage = original.readPage;
            if (proto[MOBILE_HISTORY_INSTALLED] === handle) delete proto[MOBILE_HISTORY_INSTALLED];
            if (typeof globalThis === 'object' && globalThis !== null
              && globalThis[MOBILE_HISTORY_ACTIVE_KEY] === publishedActive) {
              delete globalThis[MOBILE_HISTORY_ACTIVE_KEY];
            }
          } catch { /* 恢复失败不影响页面 */ }
        },
      };
      try {
        Object.defineProperty(proto, MOBILE_HISTORY_INSTALLED, { value: handle, configurable: true, writable: true });
      } catch {
        proto[MOBILE_HISTORY_INSTALLED] = handle;
      }
      proto.repairRequest = patchedRepairRequest;
      proto.readPage = patchedReadPage;
      publishActive();
      if (typeof console !== 'undefined' && typeof console.info === 'function') {
        console.info('[dsh-remote] mobile session history window:', JSON.stringify(current));
      }
      if (scope && typeof scope.effect === 'function') {
        scope.effect(() => () => handle.dispose(), 'remote-access: mobile session history window');
      }
      return handle;
    }

    /** 手机 WebView 下安装历史分片（等 sessions 服务就绪 = Session 控制器 Client 模块已加载）。 */
    function installMobileHistory(ctx, loadModule) {
      if (!ctx || typeof ctx.inject !== 'function') return;
      try {
        ctx.inject(['sessions'], (scope) => {
          try {
            installMobileHistoryWindow(scope, { loadModule });
          } catch (error) {
            if (typeof console !== 'undefined' && typeof console.warn === 'function') {
              console.warn('[dsh-remote] mobile session history unavailable:', error);
            }
          }
        });
      } catch (error) {
        if (typeof console !== 'undefined' && typeof console.warn === 'function') {
          console.warn('[dsh-remote] mobile session history unavailable:', error);
        }
      }
    }

    /**
     * 手机 WebView 的会话桥：
     *  - 订阅 `uiWorkspace.selection`，把当前会话（host + sessionId）通过原生 WebView 桥
     *    报给 App（App 用于「当前会话不弹应用内通知」）；
     *  - 暴露 `window.__DSH_REMOTE_OPEN_SESSION__(id)` 与 `dsh-remote:open-session` 事件，
     *    内部调用 `uiWorkspace.openSession(id)`，供 App 在点击推送后跳到对应会话；
     *  - 插件加载前收到的打开请求会暂存在 `__DSH_REMOTE_OPEN_SESSION_PENDING__`，
     *    安装完成后消费。
     *
     * `uiWorkspace` 是 DSH 内部 service（提供 selection/openSession）；拿不到时静默降级，
     * 通知仍可正常显示/打开主机，只是不会自动跳会话。
     *
     * @param {{inject?: Function}} ctx Client 上下文
     */
    function installSessionBridge(ctx) {
      if (!ctx || typeof ctx.inject !== 'function') return;
      try {
        ctx.inject(['uiWorkspace'], (scope) => {
          const workspace = scope && scope.uiWorkspace;
          if (!workspace) return;
          const locationHost = (() => {
            try { return String(globalThis.location?.host ?? ''); } catch { return ''; }
          })();

          const postNative = (payload) => {
            try {
              const text = JSON.stringify(payload);
              const webkitHandlers = globalThis.webkit && globalThis.webkit.messageHandlers;
              if (webkitHandlers && webkitHandlers.dshMtlsBridge
                && typeof webkitHandlers.dshMtlsBridge.postMessage === 'function') {
                webkitHandlers.dshMtlsBridge.postMessage(text);
                return true;
              }
              if (globalThis.dshMtlsBridge && typeof globalThis.dshMtlsBridge.postMessage === 'function') {
                globalThis.dshMtlsBridge.postMessage(text);
                return true;
              }
              if (globalThis.ReactNativeWebView && typeof globalThis.ReactNativeWebView.postMessage === 'function') {
                globalThis.ReactNativeWebView.postMessage(text);
                return true;
              }
            } catch { /* 原生桥不可用时忽略 */ }
            return false;
          };

          const selection = workspace.selection;
          if (selection && typeof selection.getSnapshot === 'function' && typeof selection.subscribe === 'function') {
            const publishCurrentSession = () => {
              try {
                // 空 selection（离开/归档当前会话）也要上报空 sessionId，让 App 清掉
                // 过期的“当前会话”，否则会误抑制那个会话的应用内通知。
                const raw = selection.getSnapshot()?.sessionId;
                const sessionId = typeof raw === 'string' ? raw : '';
                globalThis.__DSH_REMOTE_CURRENT_SESSION__ = { host: locationHost, sessionId };
                postNative({ type: 'dsh-remote/current-session', host: locationHost, sessionId });
              } catch { /* ignore */ }
            };
            publishCurrentSession();
            const unsubscribe = selection.subscribe(publishCurrentSession);
            scope.effect?.(() => () => {
              try { unsubscribe?.(); } catch { /* ignore */ }
            }, 'remote-access: current session bridge');
          }

          if (typeof workspace.openSession === 'function') {
            const open = (sessionId) => {
              if (typeof sessionId !== 'string' || sessionId === '') return false;
              try {
                workspace.openSession(sessionId);
                return true;
              } catch {
                return false;
              }
            };
            globalThis.__DSH_REMOTE_OPEN_SESSION__ = open;
            const onOpenEvent = (event) => {
              const detail = event && typeof event === 'object' ? event.detail : undefined;
              const sessionId = typeof detail === 'string'
                ? detail
                : detail && typeof detail === 'object'
                  ? detail.sessionId
                  : undefined;
              if (typeof sessionId === 'string') open(sessionId);
            };
            try { globalThis.addEventListener?.('dsh-remote:open-session', onOpenEvent); } catch { /* ignore */ }
            try {
              const pending = globalThis.__DSH_REMOTE_OPEN_SESSION_PENDING__;
              if (typeof pending === 'string' && pending !== '') {
                try { delete globalThis.__DSH_REMOTE_OPEN_SESSION_PENDING__; } catch { /* ignore */ }
                open(pending);
              }
            } catch { /* ignore */ }
            scope.effect?.(() => () => {
              try { globalThis.removeEventListener?.('dsh-remote:open-session', onOpenEvent); } catch { /* ignore */ }
              try {
                if (globalThis.__DSH_REMOTE_OPEN_SESSION__ === open) delete globalThis.__DSH_REMOTE_OPEN_SESSION__;
              } catch { /* ignore */ }
            }, 'remote-access: session navigation');
          }
        });
      } catch (error) {
        if (typeof console !== 'undefined' && typeof console.warn === 'function') {
          console.warn('[dsh-remote] session bridge unavailable:', error);
        }
      }
    }

    /** 远程/手机 WebView 下安装会话热缓存；任何失败都只降级，不影响主 UI。 */
    function installRemoteSessionCache(ctx) {
      if (!ctx || typeof ctx.inject !== 'function') return;
      try {
        ctx.inject(['sessions', 'connection'], (scope) => {
          try {
            const overrides = globalThis.__DSH_REMOTE_SESSION_CACHE__;
            installSessionWarmCache(scope, { ...(overrides && typeof overrides === 'object' ? overrides : {}), connection: scope.connection });
          } catch (error) {
            if (typeof console !== 'undefined' && typeof console.warn === 'function') {
              console.warn('[dsh-remote] session warm cache unavailable:', error);
            }
          }
          try {
            installResumeReconnect(scope);
          } catch (error) {
            if (typeof console !== 'undefined' && typeof console.warn === 'function') {
              console.warn('[dsh-remote] resume reconnect unavailable:', error);
            }
          }
        });
      } catch (error) {
        if (typeof console !== 'undefined' && typeof console.warn === 'function') {
          console.warn('[dsh-remote] sessions service unavailable:', error);
        }
      }
    }

    return {
      inject: ['slots', 'locale'],
      // 仅供 packages/host-plugin/test/client-smoke.test.js 使用；DSH 运行时只消费 inject/apply。
      __test: {
        RemoteEntry,
        PairingDialog,
        SettingsPage,
        draftFromStatus,
        installSessionWarmCache,
        installResumeReconnect,
        installSessionBridge,
        installMobileHistory,
        installMobileHistoryWindow,
        resolveMobileHistoryWindows,
        applyMobileHistoryWindow,
        isMobileHistoryJumpRequest,
        MOBILE_HISTORY_DEFAULTS,
        MOBILE_HISTORY_JUMP_MIN_MESSAGES,
        DEFAULT_SESSION_CACHE_SIZE,
      },
      apply(ctx) {
        ctx.effect(injectStyles, 'remote-access: 样式');

        let translate = null;
        const locale = ctx.locale;
        if (locale && typeof locale.register === 'function' && typeof locale.bind === 'function') {
          ctx.effect(() => locale.register(NS, { zh, en }), 'remote-access: 字典');
          translate = locale.bind(NS);
        }
        if (typeof translate !== 'function') translate = makeTranslator({ zh, en });

        // 手机远程 WebView（host 反代注入 ?dsh_mobile=1）：本机管理页不应出现；
        // 同时也只有这个场景需要「会话热缓存」来避免每次切会话重新同步整段历史。
        const isRemoteWebView = typeof globalThis === 'object'
          && globalThis.location
          && typeof globalThis.location.search === 'string'
          && /(?:^|[?&])dsh_mobile=1(?:&|$)/.test(globalThis.location.search);
        if (isRemoteWebView) {
          installRemoteSessionCache(ctx);
          installSessionBridge(ctx);
          // T1：只收紧手机 WebView 的历史窗口（首屏 + 翻页）；桌面本机完全不装。
          installMobileHistory(ctx, require);
        }

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

        // /api/remote-access/* 被代理 deny（403）正是安全边界；若显示入口，DSH 设置页
        // 拉不到 status 会误导为「403 中继离线」。远程管理请用 App 自己的设备页。
        if (!isRemoteWebView) {
          slots.inject('sidebar.footer.action', () => slots.register(entryOptions, EntrySeat));
          slots.inject('settings.section', () => slots.register(settingsOptions, SettingsSeat));
        }
      },
    };
  },
});
