/**
 * WebViewScreen — 群体服务版主界面：通过 relay 隧道加载 DSH Web UI。
 *
 * Loads `https://<hostId>.<relayDomain>:<port>/?dsh_mobile=1`：host 端 client plugin
 * 注入手机布局（mobileWebShell 也会注入，见 src/lib/mobileWebShell.ts）。
 *
 * 认证（群体服务版 / A 模式）：
 *   1. challenge → 原生用 P-256 设备密钥签名 → 短时 token（15–30 分钟）；
 *   2. token 由原生模块写成 `__Host-dsh_session` cookie（host-only / Secure /
 *      SameSite=Strict），WebView 请求自动携带；
 *   3. 进入主机 / 回前台 / 每 30s 续期；缓存有效时只重放 cookie，不重复请求。
 *
 * 本屏只包含群体版能力（无原生 mTLS WebView / 设备证书 / 推送跳会话）。
 *
 * 「重启主机 DSH」：进入主机后经原生 `groupHttpFetch` 拉 `GET /__dsh_remote/status`
 * （带 `__Host-dsh_session` cookie，relay 边缘按 cookie 放行），`restart.enabled === true`
 * 时顶栏显示 ⏻；点击二次确认 → `POST /__dsh_remote/restart` → 202 后轮询 status 探活
 * （每 1.5s、单次 3s、最多 30s）→ 主机恢复后自动 reload。全程不使用设备证书 / mTLS。
 *
 * WebSocket 断线自动恢复：`mobileWebShell` 对每个 WebSocket 各上报 `dsh-ws-close`，
 * host 保存设置/短暂断开 Upgrade 时同一瞬间可能来多个 close —— 必须去抖（同一波只算
 * 一次恢复尝试，预算只在自动 reload 后仍未恢复时累加），否则会被多个 close 一次性
 * 耗尽预算而不再自动重连。见下方 `WsRecoveryState` / `WS_*` 常量。
 */

import { useCallback, useEffect, useRef, useState, type ComponentType, type Ref } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  KeyboardAvoidingView,
  Linking,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { WebView, type WebViewNavigation, type WebViewProps } from 'react-native-webview';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { groupOrigin, groupRestartUrl, groupStatusUrl, groupWebUiUrl } from '../lib/protocol';
import { MOBILE_WEB_SHELL_JS } from '../lib/mobileWebShell';
import type { StoredConnection } from '../lib/store';
import {
  ensureGroupSessionIfNeeded,
  GroupPairingError,
  groupAuthorizedFetch,
  hasValidGroupSession,
} from '../lib/group';
import { isBottomEdgeGestureDeferralEnabled } from '../lib/settings';
import { setBottomEdgeGestureDeferral } from '../../modules/dsh-mtls/src';
import { colors, radii, spacing, typography } from '../theme';

interface WebViewScreenProps {
  connection: StoredConnection;
  onClose: () => void;
  /**
   * 打开**这台主机**的连接设置（App 的「设备与安全」页：主机信息 / 打开此连接时要求
   * 面容 / 解除本机配对）。返回时回到当前主机页面，不是 App 的「系统设置」。
   */
  onOpenConnectionSettings: () => void;
  /** 设置页清理缓存后递增，触发 WebView 重新加载。 */
  reloadToken?: number;
  /** 当前 WebView 是否在屏幕上可见（隐藏时常驻，用于判断何时重连）。 */
  isVisible?: boolean;
  /**
   * DSH 页面里的外链（target=_blank / window.open）：由 App 决定打开方式。
   * 传入时用 App 内嵌浏览器打开；不传时退回系统浏览器（Linking.openURL）。
   */
  onOpenExternal?: (url: string) => void;
  /**
   * 通知点击后要打开的会话（self 模式 APNs payload 的 sessionId）。
   * 页面加载完成后注入 `window.__DSH_REMOTE_OPEN_SESSION__(sessionId)`；
   * 插件还没就绪时先写 `__DSH_REMOTE_OPEN_SESSION_PENDING__`，由插件安装时消费。
   */
  openSessionRequest?: { sessionId: string; nonce: number } | null;
  /** 注入成功后回调（App 清空请求，避免重进/重载时重复注入）。 */
  onOpenSessionHandled?: (nonce: number) => void;
}

type ConnectionStatus = 'connecting' | 'online' | 'error';

const STATUS_LABELS: Record<ConnectionStatus, string> = {
  connecting: '连接中',
  online: '已连接',
  error: '连接异常',
};

const STATUS_COLORS: Record<ConnectionStatus, string> = {
  connecting: colors.warning,
  online: colors.success,
  error: colors.danger,
};

// ---------------------------------------------------------------------------
// 「重启主机 DSH」：请求 + 等待恢复（群体版：带 cookie 的原生请求，不用 mTLS）
// ---------------------------------------------------------------------------

/** 重启请求被接受后，轮询状态探活的节奏：每 1.5s 一次、单次 3s 超时、最多等 30s。 */
const HOST_RESTART_POLL_INTERVAL_MS = 1500;
const HOST_RESTART_PROBE_TIMEOUT_MS = 3000;
const HOST_RESTART_POLL_TIMEOUT_MS = 30_000;
/** 组件开关动态刷新：进入主机后每 10s 拉一次 status（Host 设置变化无需退出重进）。 */
const HOST_STATUS_REFRESH_INTERVAL_MS = 10_000;
/** 发起重启请求本身的最长等待（主机应尽快回 202；等不到就按失败提示）。 */
const HOST_RESTART_REQUEST_TIMEOUT_MS = 10_000;
/** 读取「重启主机」组件开关的 status 请求超时（进入主机时探一次，失败保持隐藏）。 */
const HOST_STATUS_REQUEST_TIMEOUT_MS = 4000;

// ---------------------------------------------------------------------------
// WebSocket 断开后的自动恢复（去抖 + 预算）
// ---------------------------------------------------------------------------

/**
 * 同一波 close 去抖：host 保存设置/短暂断开 Upgrade 时可能在同一瞬间断开多个
 * WebSocket（mobileWebShell 对每个 socket 各上报一次 `dsh-ws-close`），
 * 2s 内的多个 close 只算一次恢复尝试（配合 `pending` 忽略排队期间的后续 close）。
 */
const WS_CLOSE_DEBOUNCE_MS = 2000;
/** 自动恢复预算：60s 窗口内最多自动 reload 2 次；只有 reload 后仍未恢复才累加。 */
const WS_RECOVERY_WINDOW_MS = 60_000;
const WS_RECOVERY_MAX_RELOADS = 2;
/** 收到 close 后先等一小段让 DSH 自己重连；仍未恢复再 reload 页面。 */
const WS_RECOVERY_DELAY_MS = 600;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * WebSocket 自动恢复的预算状态（用 ref 保存，close 事件可能同一 tick 连续到达，
 * 只看 React state 会读到旧值）。
 */
interface WsRecoveryState {
  /** 已排队的恢复 reload（true 时忽略同一波后续 close）。 */
  pending: boolean;
  /** 当前这次 reload 是否由自动恢复触发（loadEnd 据此决定是否保留预算）。 */
  recoveryReload: boolean;
  /** 自上次 close 之后已经自动 reload 过：下一次 close = reload 后仍未恢复。 */
  reloadedSinceClose: boolean;
  /** 60s 窗口内已消耗的自动 reload 次数。 */
  reloads: number;
  /** 预算窗口起点（0 = 未开始）。 */
  windowStart: number;
  /** 上一次处理 close 的时间（同一波去抖）。 */
  lastCloseAt: number;
}

/**
 * `/__dsh_remote/status` 的 `data.restart.enabled`：只有明确返回 `true` 才显示顶栏 ⏻。
 * （Host 设置 → 远程访问 → 组件 → 允许手机重启主机 DSH，默认关闭。）
 */
function restartEnabledFromStatusBody(body: unknown): boolean {
  const envelope = isRecordValue(body) ? body : null;
  const data = envelope && envelope.ok === true && isRecordValue(envelope.data) ? envelope.data : null;
  const restart = data && isRecordValue(data.restart) ? data.restart : null;
  return restart !== null && restart.enabled === true;
}

/** 从重启失败的响应体里取主机返回的错误信息（`{ok:false,error:{code,message}}`）。 */
function restartFailureError(body: unknown): { code: string; message: string } {
  if (!isRecordValue(body)) return { code: '', message: '' };
  const error = isRecordValue(body.error) ? body.error : null;
  return {
    code: error && typeof error.code === 'string' ? error.code : '',
    message: error && typeof error.message === 'string' ? error.message : '',
  };
}

/**
 * 把重启请求的非 2xx 响应翻译成用户可读的失败原因。
 * 群体版不再出现「设备证书 / mTLS / 证书已失效」措辞。
 */
function describeRestartFailure(status: number, body: unknown): string {
  const error = restartFailureError(body);
  if (__DEV__) {
    const suffix = error.message ? `\n\n${error.message}` : '';
    if (status === 401 || status === 403) {
      return `主机拒绝了请求（HTTP ${status}）：访问令牌可能已失效，请点右上角刷新重试。${suffix}`;
    }
    if (status === 405) {
      return `主机不支持该重启请求（HTTP 405）：主机端插件可能版本过旧，没有提供重启接口。${suffix}`;
    }
    if (status === 501) {
      if (error.code === 'host-restart-disabled') {
        return '主机未允许手机重启 DSH：请先在主机「设置 → 远程访问 → 组件」里打开「允许手机重启主机 DSH」。'
          + suffix;
      }
      if (error.code === 'host-restart-unavailable') {
        return `主机当前环境不支持重启 DSH（HTTP 501）。${suffix}`;
      }
      return `主机不支持重启 DSH（HTTP 501）：重启入口可能被禁用，或当前环境不支持。${suffix}`;
    }
    if (status === 502 || status === 503) {
      return `主机暂时不可达（HTTP ${status}），可能正在重启或离线，请稍后重试。${suffix}`;
    }
    return `重启请求失败（HTTP ${status}）。${suffix}`;
  }
  if (status === 501 && error.code === 'host-restart-disabled') {
    return '主机未开启远程重启功能，请在主机设置中开启后再试。';
  }
  return '重启请求失败，请稍后重试。';
}

/** 请求没有拿到响应（原生请求失败 / 网络错误 / 超时）时的用户提示。 */
function describeRestartError(error: unknown): string {
  if (error instanceof GroupPairingError) {
    if (error.code === 'native_unavailable') return '当前版本暂不支持该操作。';
    return __DEV__ ? error.message : '重启请求失败，请稍后重试。';
  }
  if (error instanceof Error && error.message) {
    return __DEV__ ? error.message : '重启请求失败，请稍后重试。';
  }
  return '重启请求失败，请稍后重试。';
}

/**
 * 顶栏副标题只展示「主机 ID」：从 connection.host（<hostId>.<relayDomain>）
 * 里取第一段；直连 IP/自定义地址保留原值。
 */
function hostIdOf(host: string): string {
  let hostname = host;
  try {
    hostname = new URL(`https://${host}`).hostname;
  } catch {
    const [withoutPort] = host.split(':');
    hostname = withoutPort ?? host;
  }
  const [firstLabel] = hostname.split('.');
  return firstLabel || hostname;
}

/** The host's tunnel hostname is the only origin this WebView may navigate to. */
function isTunnelUrl(url: string, host: string): boolean {
  try {
    const target = new URL(url);
    if (target.protocol !== 'https:' && target.protocol !== 'http:') return false;
    const wanted = host.trim().toLowerCase();
    const wantedHost = wanted.includes(':') && !wanted.startsWith('[')
      ? wanted.slice(0, wanted.indexOf(':'))
      : wanted;
    return target.hostname.toLowerCase() === wantedHost;
  } catch {
    return false;
  }
}

/**
 * react-native-webview exports a generic class component (`WebView<P = undefined>`).
 * Under React 19 types that makes JSX props collapse to `never`, so cast it once
 * to a plain component type that keeps the WebViewProps contract and the
 * imperative ref (reload()).
 */
const DshWebView = WebView as unknown as ComponentType<
  WebViewProps & { ref?: Ref<WebView> }
>;

export function WebViewScreen({
  connection,
  onClose,
  onOpenConnectionSettings,
  reloadToken = 0,
  isVisible = true,
  onOpenExternal,
  openSessionRequest = null,
  onOpenSessionHandled,
}: WebViewScreenProps) {
  const insets = useSafeAreaInsets();
  const tunnelPort = connection.port;
  const pageUrl = groupWebUiUrl(connection.host, tunnelPort);
  const pageOrigin = groupOrigin(connection.host, tunnelPort);
  const webViewRef = useRef<WebView | null>(null);
  /** 推送点击后的待注入会话：页面未就绪时先记下，页面加载完成后注入。 */
  const pendingOpenSessionRef = useRef<{ sessionId: string; nonce: number } | null>(null);
  const lastOpenSessionNonceRef = useRef<number | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [pageTitle, setPageTitle] = useState<string>('DSH');
  const [currentUrl, setCurrentUrl] = useState(() => pageUrl);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // 群体版会话：token 只在内存 + 注入 __Host- cookie（不持久化、不打印）。
  const [groupSessionReady, setGroupSessionReady] = useState(false);
  const [groupSessionError, setGroupSessionError] = useState<string | null>(null);
  const groupSessionRef = useRef<{ token: string; expiresAt: number } | null>(null);

  // 「重启主机」进行中：从发请求到等待主机恢复为止，按钮禁用并显示 spinner。
  const [restarting, setRestarting] = useState(false);
  /**
   * 「重启主机」组件是否启用（Host 设置 → 远程访问 → 组件，默认关闭）。
   * 只有 `GET /__dsh_remote/status` 明确返回 `restart.enabled === true` 才显示顶栏 ⏻；
   * 默认 false，避免主机没开组件时出现一个必然失败的按钮。
   */
  const [restartAvailable, setRestartAvailable] = useState(false);
  const restartInFlightRef = useRef(false);
  // 当前等待主机恢复的轮询会话（卸载/切主机时置 cancelled，轮询下一拍退出）。
  const restartSessionRef = useRef<{ cancelled: boolean } | null>(null);
  const restartAvailabilitySeq = useRef(0);
  // refreshRestartAvailability 在 reload / onLoadEnd / WS 桥消息之后才定义；
  // 用 ref 让这些早定义的回调也能在「刷新 / 重连 / 页面加载完成」时刷新组件状态。
  const refreshRestartAvailabilityRef = useRef<() => void>(() => {});

  // WebSocket 断开后的自动恢复；隐藏时先记下，等页面重新可见再 reload。
  const [wsRecoveryPending, setWsRecoveryPending] = useState(false);
  /**
   * WS 自动恢复预算（60s 内最多自动 reload 2 次）。
   *
   * 注意：不能按「收到的 close 事件数」累加——host 保存设置时会同时断开多个
   * Upgrade/WebSocket，mobileWebShell 对每个 socket 各上报一次 close，
   * 同一瞬间的多个 close 必须去抖成一次尝试；预算只在「自动 reload 后仍未恢复
   * （再次 close）」时累加，ws-open / 普通页面加载成功时清零。
   */
  const wsRecoveryRef = useRef<WsRecoveryState>({
    pending: false,
    recoveryReload: false,
    reloadedSinceClose: false,
    reloads: 0,
    windowStart: 0,
    lastCloseAt: 0,
  });
  /** 是否正在显示「正在自动重连…」提示（close 回调里即时判断用；ws-open 时恢复页面状态）。 */
  const wsRecoveryNoticeRef = useRef(false);
  const statusRef = useRef<ConnectionStatus>('connecting');
  // 页面重新加载期间忽略旧页面 WebSocket 的 close 事件，避免“reload → 旧 socket close
  // → 又排队 reload”的循环。
  const loadingRef = useRef(false);
  /** 群体版：页面首次加载偶发 401（主机重连、relay 设备表瞬时为空）时自动重试一次。 */
  const groupHttpAuthRetryRef = useRef<{ count: number; since: number }>({ count: 0, since: 0 });

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const performReload = useCallback(() => {
    // 「刷新」也是重新读取 Host 组件开关的时机：改了设置后不用退出主机再进。
    refreshRestartAvailabilityRef.current();
    // 重新加载期间旧文档即将被替换。
    loadingRef.current = true;
    statusRef.current = 'connecting';
    setErrorMessage(null);
    setStatus('connecting');
    wsRecoveryRef.current.pending = false;
    wsRecoveryNoticeRef.current = false;
    setWsRecoveryPending(false);
    webViewRef.current?.reload();
  }, []);

  /**
   * 群体版会话保活：challenge → 原生签名 → 短时 token → `__Host-dsh_session` cookie。
   * 进入主机/回前台/每 30s 调一次；缓存有效时只重放 cookie，不重复请求。
   */
  const ensureGroupSessionForConnection = useCallback(async (forceRefresh = false): Promise<boolean> => {
    try {
      const session = await ensureGroupSessionIfNeeded(
        {
          host: connection.host,
          port: tunnelPort,
          hostId: connection.hostId,
          deviceId: connection.deviceId,
          label: connection.deviceKeyLabel,
        },
        { forceRefresh },
      );
      groupSessionRef.current = session;
      setGroupSessionReady(true);
      setGroupSessionError(null);
      return true;
    } catch (error) {
      const pairingError = error instanceof GroupPairingError ? error : undefined;
      const rawMessage = error instanceof Error ? error.message : '无法获取访问令牌。';
      // relay 明确返回 unknown_device：这台设备已在主机侧被撤销/重置（通常是主机删了旧设备、
      // 手机上还留着旧连接），继续重试无意义，直接引导重新配对。
      const deviceGone = pairingError?.code === 'http'
        && (pairingError.status === 404 || /not registered|unknown device/i.test(rawMessage));
      const message = deviceGone
        ? '这台设备已在主机侧失效（被删除或重置）。\n请返回主机列表删除该主机，然后重新扫码配对。'
        : rawMessage;
      setGroupSessionError(__DEV__ ? `无法获取访问令牌：${message}` : (deviceGone ? message : '无法连接到主机，请检查网络后重试。'));
      setGroupSessionReady(false);
      return false;
    }
  }, [connection.deviceId, connection.deviceKeyLabel, connection.host, connection.hostId, tunnelPort]);

  /**
   * 刷新前先确保群体版 token 有效，再重新加载页面。
   */
  const reload = useCallback(() => {
    const valid = hasValidGroupSession({
      host: connection.host,
      port: tunnelPort,
      deviceId: connection.deviceId,
    });
    if (valid && groupSessionRef.current) {
      performReload();
      return;
    }
    void ensureGroupSessionForConnection().then((ok) => {
      if (ok) performReload();
    });
  }, [
    connection.deviceId,
    connection.host,
    ensureGroupSessionForConnection,
    performReload,
    tunnelPort,
  ]);

  /** 重置 WS 自动恢复预算（普通页面加载成功 / ws-open / 用户手动刷新时调用）。 */
  const resetWsRecovery = useCallback(() => {
    const ws = wsRecoveryRef.current;
    ws.pending = false;
    ws.recoveryReload = false;
    ws.reloadedSinceClose = false;
    ws.reloads = 0;
    ws.windowStart = 0;
    ws.lastCloseAt = 0;
    wsRecoveryNoticeRef.current = false;
    setWsRecoveryPending(false);
  }, []);

  /**
   * 用户主动刷新/重试：重置自动恢复预算后再 reload（手动操作重新给足预算）。
   * 自动恢复本身走 `reload()`，不经过这里。
   */
  const handleManualReload = useCallback(() => {
    resetWsRecovery();
    reload();
  }, [reload, resetWsRecovery]);

  /**
   * 读取「重启主机」组件状态：`GET /__dsh_remote/status`（带 `__Host-dsh_session` cookie
   * 的原生请求，relay 边缘按 cookie 放行）。
   *
   * - 只有 `data.restart.enabled === true` 才显示顶栏 ⏻（组件默认关闭）；
   * - 请求失败 / 未就绪（主机重启中、网络抖动）：保持上一次已知状态，不误显示/误隐藏；
   * - 401/403 已由 groupAuthorizedFetch 强制续期 token 重试过一次。
   */
  const refreshRestartAvailability = useCallback(async () => {
    // 请求序号：并发触发（进入主机 + 加载完成 + 回前台）时只认最后一次结果。
    const seq = ++restartAvailabilitySeq.current;
    try {
      const response = await groupAuthorizedFetch({
        host: connection.host,
        port: tunnelPort,
        hostId: connection.hostId,
        deviceId: connection.deviceId,
        label: connection.deviceKeyLabel,
        method: 'GET',
        url: groupStatusUrl(connection.host, tunnelPort),
        timeoutMs: HOST_STATUS_REQUEST_TIMEOUT_MS,
      });
      if (seq !== restartAvailabilitySeq.current) return;
      if (response.status !== 200) return; // 异常状态交给页面错误态；组件状态保持上一次值
      setRestartAvailable(restartEnabledFromStatusBody(response.body));
    } catch {
      // 网络抖动 / 主机重启中：保持上一次已知状态；页面加载完成 / WS 重连后会再刷新。
    }
  }, [
    connection.deviceId,
    connection.deviceKeyLabel,
    connection.host,
    connection.hostId,
    tunnelPort,
  ]);

  refreshRestartAvailabilityRef.current = refreshRestartAvailability;

  // 群体版：首次进入 / 重新可见 / 回前台 / 定时续期前确保 token 有效。
  useEffect(() => {
    void ensureGroupSessionForConnection();
    const timer = setInterval(() => {
      void ensureGroupSessionForConnection();
    }, 30_000);
    return () => clearInterval(timer);
  }, [ensureGroupSessionForConnection]);

  useEffect(() => {
    if (!isVisible) return undefined;
    void ensureGroupSessionForConnection();
    // 重新进入主机时刷新组件开关：Host 侧刚改设置不用退到主机列表再进。
    refreshRestartAvailabilityRef.current();
    return undefined;
  }, [ensureGroupSessionForConnection, isVisible]);

  /**
   * 底部边缘系统手势 defer（仅 iOS 生效，Android 为 no-op）。
   *
   * DSH 页面里有可自由拖动的悬浮挂件；挂件贴到屏幕最底边（Home 指示条区域）后，
   * 从最底边起手拖动会被 iOS 的「上滑回主屏」手势抢走——页面收不到拖动，App 直接被
   * 切到后台。App 设置 →「主机页面手势 → 挂件贴底拖动」（默认开启）决定是否在
   * **主机页面可见**时 defer 底部边缘手势；关闭后恢复系统默认（一次上滑回主屏）。
   * 离开主机/锁屏时都会恢复系统默认，主页与设置页不受影响。
   */
  useEffect(() => {
    let cancelled = false;
    if (!isVisible) {
      void setBottomEdgeGestureDeferral(false).catch(() => {});
      return undefined;
    }
    // 每次进入主机页面都重新读取设置：在设置页改完开关后回来即生效。
    void isBottomEdgeGestureDeferralEnabled()
      .then((enabled) => {
        if (!cancelled) void setBottomEdgeGestureDeferral(enabled).catch(() => {});
      })
      .catch(() => {
        if (!cancelled) void setBottomEdgeGestureDeferral(true).catch(() => {});
      });
    return () => {
      cancelled = true;
      void setBottomEdgeGestureDeferral(false).catch(() => {});
    };
  }, [isVisible]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'active') return;
      void ensureGroupSessionForConnection();
      // 后台期间 Host 可能改过组件开关：回前台且页面可见时刷新一次。
      if (isVisible) refreshRestartAvailabilityRef.current();
    });
    return () => subscription.remove();
  }, [ensureGroupSessionForConnection, isVisible]);

  // 组件开关动态刷新：单机版可在主机改设置后 App 动态出现/消失 ⏻；群体版补充定时刷新，
  // 这样 Host 侧保存「允许手机重启主机」后，App 无需手动点刷新或退出重进即可生效。
  useEffect(() => {
    if (!isVisible) return undefined;
    const timer = setInterval(() => {
      if (restartInFlightRef.current) return;
      refreshRestartAvailabilityRef.current();
    }, HOST_STATUS_REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [isVisible]);

  const openExternal = useCallback(async (url: string) => {
    try {
      const supported = await Linking.canOpenURL(url);
      if (supported) await Linking.openURL(url);
    } catch {
      // Ignore: the user tapped a link the OS cannot open.
    }
  }, []);

  /** 外链统一入口：优先交给 App 内嵌浏览器；没有该 prop 时退回系统浏览器。 */
  const openLink = useCallback((url: string) => {
    if (onOpenExternal) {
      onOpenExternal(url);
      return;
    }
    void openExternal(url);
  }, [onOpenExternal, openExternal]);

  const handleShouldStartLoad = useCallback(
    (request: { url: string }): boolean => {
      const { url } = request;
      if (url === 'about:blank' || url.startsWith('about:blank#')) return true;
      if (isTunnelUrl(url, connection.host)) return true;
      // Everything outside the tunnel: open in the App's embedded page (or system browser).
      if (url.startsWith('https://') || url.startsWith('http://')) {
        openLink(url);
        return false;
      }
      // Custom schemes (mailto:, tel:, dshremote:) also go to the OS.
      void openExternal(url);
      return false;
    },
    [connection.host, openLink, openExternal],
  );

  // 设置页「清理缓存」后递增 reloadToken：缓存清理会一并清掉 `__Host-` cookie，
  // 所以先强制续期一次 token（重新注入 cookie），再重新加载页面。
  useEffect(() => {
    if (reloadToken <= 0) return;
    void ensureGroupSessionForConnection(true).then((ok) => {
      if (ok) performReload();
    });
  }, [ensureGroupSessionForConnection, performReload, reloadToken]);

  const handleNavigationStateChange = useCallback((navigation: WebViewNavigation) => {
    // 底部连接信息只在 Debug 构建显示（Release 下这块空间留给主界面）。
    if (!__DEV__) return;
    setCurrentUrl(navigation.url);
    if (navigation.title) setPageTitle(navigation.title);
  }, []);

  /**
   * 执行「打开推送对应会话」的注入脚本（self 模式 payload 带 sessionId）。
   *
   * 优先调用 host 插件暴露的 `window.__DSH_REMOTE_OPEN_SESSION__`；插件尚未加载时
   * 把 id 暂存到 `__DSH_REMOTE_OPEN_SESSION_PENDING__`，插件安装时自行消费。
   * 必须等页面加载完成（statusRef === 'online'）后再注入，否则脚本会落到即将被
   * 导航替换的旧文档上，而 App 会误以为已处理并清空请求。
   */
  const flushOpenSession = useCallback(() => {
    const request = pendingOpenSessionRef.current;
    if (!request || lastOpenSessionNonceRef.current === request.nonce) return;
    if (statusRef.current !== 'online') return;
    const sessionIdLiteral = JSON.stringify(request.sessionId);
    const script =
      `(function(){try{var id=${sessionIdLiteral};` +
      'window.__DSH_REMOTE_OPEN_SESSION_PENDING__=id;' +
      'var f=window.__DSH_REMOTE_OPEN_SESSION__;' +
      'if(typeof f==="function"){f(id);window.__DSH_REMOTE_OPEN_SESSION_PENDING__=null;}' +
      '}catch(e){}})();void 0;';
    try {
      webViewRef.current?.injectJavaScript(script);
      pendingOpenSessionRef.current = null;
      lastOpenSessionNonceRef.current = request.nonce;
      onOpenSessionHandled?.(request.nonce);
    } catch {
      // 注入失败：保留 pending，等下一次页面加载完成时重试。
    }
  }, [onOpenSessionHandled]);

  // 通知点击后 App 传入 openSessionRequest：先记录，等页面就绪后注入。
  useEffect(() => {
    if (!openSessionRequest) return;
    pendingOpenSessionRef.current = openSessionRequest;
    if (statusRef.current === 'online') flushOpenSession();
  }, [openSessionRequest, flushOpenSession]);

  const handleLoadStart = useCallback(() => {
    loadingRef.current = true;
    statusRef.current = 'connecting';
    setStatus('connecting');
  }, []);

  const handleLoadEnd = useCallback(() => {
    loadingRef.current = false;
    statusRef.current = 'online';
    groupHttpAuthRetryRef.current = { count: 0, since: 0 };
    setStatus('online');
    setErrorMessage(null);
    const ws = wsRecoveryRef.current;
    if (ws.recoveryReload) {
      // 这次加载来自自动恢复 reload：预算保留，等 ws-open 或下一次 close 判断是否真恢复。
      ws.recoveryReload = false;
      ws.reloadedSinceClose = true;
      ws.pending = false;
      ws.lastCloseAt = 0;
      setWsRecoveryPending(false);
    } else {
      // 普通加载（首次进入 / 用户刷新 / 清理缓存 / 重启恢复）：重置自动恢复预算。
      resetWsRecovery();
    }
    // 页面加载完成 = 主机可达：顺带刷新「重启主机」组件状态（刷新/重连后按钮跟着变）。
    refreshRestartAvailabilityRef.current();
    // 通知点击后待打开的会话：页面就绪了才能安全注入（脚本落在新文档上）。
    flushOpenSession();
  }, [flushOpenSession, resetWsRecovery]);

  const handleError = useCallback((description?: string) => {
    loadingRef.current = false;
    statusRef.current = 'error';
    setStatus('error');
    setErrorMessage(description ?? '无法加载 DSH 页面。');
  }, []);

  const handleHttpError = useCallback((statusCode: number) => {
    loadingRef.current = false;
    statusRef.current = 'error';
    if (statusCode === 401 || statusCode === 403) {
      // 首次进入/主机重连时偶发：token 刚签发但 relay 设备表/隧道还在恢复，页面请求 401。
      // 自动刷新一次会话再 reload，避免用户必须「返回再进」。
      const now = Date.now();
      const state = groupHttpAuthRetryRef.current;
      if (now - state.since > 60_000) {
        state.count = 0;
        state.since = now;
      }
      if (state.count < 1) {
        state.count += 1;
        setStatus('connecting');
        setErrorMessage('会话正在刷新，正在自动重试…');
        globalThis.setTimeout(() => {
          void ensureGroupSessionForConnection(true).then((ok) => {
            if (ok) performReload();
          });
        }, 800);
        return;
      }
      setStatus('error');
      setErrorMessage(
        `主机拒绝了连接（HTTP ${statusCode}）。会话可能已失效，请点「重试」重新获取访问令牌。`,
      );
      return;
    }
    setStatus('error');
    setErrorMessage(`主机返回 HTTP ${statusCode}。`);
  }, [ensureGroupSessionForConnection, performReload]);

  /**
   * 收到注入层 / host 插件的桥消息：
   *  - dsh-ws-open/close：WebSocket 状态，主机重连时触发自动 reload；
   *  - dsh-remote/open-external：DSH 页面里的外链（target=_blank / window.open），
   *    原生 WebView 打不开新窗口，交给 App 内嵌浏览器/系统浏览器。
   */
  const handleBridgeMessage = useCallback((raw: string) => {
    let payload: { type?: unknown; url?: unknown } | null = null;
    try {
      payload = JSON.parse(raw) as { type?: unknown; url?: unknown } | null;
    } catch {
      return;
    }
    if (!payload || typeof payload.type !== 'string') return;
    if (payload.type === 'dsh-remote/open-external') {
      const externalUrl = typeof payload.url === 'string' ? payload.url : '';
      // 只允许 http(s)；隧道主机不能交给外部浏览器（否则只会打不开）。
      if (!/^https?:\/\//i.test(externalUrl)) return;
      let externalHost = '';
      let tunnelHost = '';
      try {
        externalHost = new URL(externalUrl).hostname.toLowerCase();
        tunnelHost = new URL(`https://${connection.host}`).hostname.toLowerCase();
      } catch {
        return;
      }
      if (tunnelHost && externalHost === tunnelHost) return;
      openLink(externalUrl);
      return;
    }
    const url = typeof payload.url === 'string' ? payload.url : '';
    if (url && !url.includes('remote.mux')) return;
    const ws = wsRecoveryRef.current;
    if (payload.type === 'dsh-ws-open') {
      // 实时连接恢复：预算清零、取消排队中的恢复，并刷新组件状态
      // （Host 侧刚改开关时无需重进主机；断线自动恢复成功后也在这里立即刷新）。
      // 注意：ws-open 不受 loadingRef 限制——加载期间恢复的实时连接也应该算恢复。
      ws.pending = false;
      ws.recoveryReload = false;
      ws.reloadedSinceClose = false;
      ws.reloads = 0;
      ws.windowStart = 0;
      ws.lastCloseAt = 0;
      setWsRecoveryPending(false);
      if (wsRecoveryNoticeRef.current) {
        // DSH 在自动 reload 之前自己重连成功：撤掉「正在自动重连…」提示并回到已连接。
        wsRecoveryNoticeRef.current = false;
        statusRef.current = 'online';
        setStatus('online');
        setErrorMessage(null);
      }
      refreshRestartAvailabilityRef.current();
      return;
    }
    // 页面重新加载期间旧页面的 close 事件不算数（避免「reload → 旧 socket close → 又 reload」）。
    if (loadingRef.current) return;
    if (payload.type === 'dsh-ws-close' && statusRef.current === 'online') {
      // 重启流程自己会等主机恢复并 reload；不要让 WS close 的自动恢复插一脚。
      if (restartInFlightRef.current) return;
      // 同一波 close：已排队恢复时忽略后续 close（host 保存设置可能同时断多个 socket）。
      if (ws.pending) return;
      const now = Date.now();
      // 短时去抖：2s 内的多个 close 只算一次恢复尝试。
      if (ws.lastCloseAt !== 0 && now - ws.lastCloseAt < WS_CLOSE_DEBOUNCE_MS) return;
      ws.lastCloseAt = now;
      if (ws.windowStart === 0 || now - ws.windowStart > WS_RECOVERY_WINDOW_MS) {
        ws.reloads = 0;
        ws.windowStart = now;
      }
      // 预算只在「自动 reload 后仍未恢复（再次 close）」时累加；首次 close 先尝试恢复。
      if (ws.reloadedSinceClose) {
        ws.reloads += 1;
        ws.reloadedSinceClose = false;
      }
      if (ws.reloads >= WS_RECOVERY_MAX_RELOADS) {
        // 自动恢复确实连续失败：显示错误 + 重试按钮，不再无限 reload。
        wsRecoveryNoticeRef.current = false;
        setWsRecoveryPending(false);
        setStatus('error');
        setErrorMessage('与主机的实时连接已断开，自动重连未恢复，请点击刷新重试。');
        return;
      }
      // 预算未耗尽：显示「正在自动重连…」，600ms 后自动 reload（走 reload() 会先续期 token）。
      ws.pending = true;
      wsRecoveryNoticeRef.current = true;
      setWsRecoveryPending(true);
      setStatus('connecting');
      setErrorMessage('与主机的实时连接已断开，正在自动重连…');
    }
  }, [connection.host, openLink]);

  // 页面可见且检测到 WebSocket 已断开：稍等一小段时间让 DSH 自己重连；
  // 若仍未恢复（主机重连通常如此），重新加载页面并走缓存加载。
  useEffect(() => {
    if (!isVisible || !wsRecoveryPending) return undefined;
    const timer = setTimeout(() => {
      const ws = wsRecoveryRef.current;
      // loadEnd 据此判断「这次加载来自自动恢复 reload」→ 保留预算、等 ws-open 或下一次 close。
      ws.recoveryReload = true;
      ws.pending = false;
      setWsRecoveryPending(false);
      reload();
    }, WS_RECOVERY_DELAY_MS);
    return () => clearTimeout(timer);
  }, [isVisible, wsRecoveryPending, reload]);

  /**
   * 重启请求被接受后等待主机恢复：轮询 `GET /__dsh_remote/status`
   * （原生请求自带 `__Host-dsh_session` cookie；主机重启期间 relay/host 不可达是预期）。
   *
   * - 每 1.5s 探一次、单次 3s 超时、总时长最多 30s；
   * - 只有 200 才算恢复；`session.cancelled` 由调用方在卸载/切主机时置位，
   *   轮询下一拍立即退出。
   */
  const waitForHostRecovery = useCallback(
    async (session: { cancelled: boolean }): Promise<boolean> => {
      const deadline = Date.now() + HOST_RESTART_POLL_TIMEOUT_MS;
      while (!session.cancelled) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return false;
        await sleep(Math.min(HOST_RESTART_POLL_INTERVAL_MS, remaining));
        if (session.cancelled) return false;
        try {
          const response = await groupAuthorizedFetch({
            host: connection.host,
            port: tunnelPort,
            hostId: connection.hostId,
            deviceId: connection.deviceId,
            label: connection.deviceKeyLabel,
            method: 'GET',
            url: groupStatusUrl(connection.host, tunnelPort),
            timeoutMs: HOST_RESTART_PROBE_TIMEOUT_MS,
          });
          if (session.cancelled) return false;
          if (response.status === 200) {
            // 探活顺便刷新组件状态（Host 设置可能在重启后被改过）。
            setRestartAvailable(restartEnabledFromStatusBody(response.body));
            return true;
          }
        } catch {
          // 主机还在重启（连接被拒/超时/502/503）：继续下一轮。
        }
      }
      return false;
    },
    [
      connection.deviceId,
      connection.deviceKeyLabel,
      connection.host,
      connection.hostId,
      tunnelPort,
    ],
  );

  /**
   * 重启主机 DSH：`POST /__dsh_remote/restart`（原生请求带 cookie）→
   * 轮询 status 等待恢复 → reload。
   *
   * 主机接受重启后可能先返回 202 再断开 WebSocket；这里先把 status 切到 connecting
   * 并清掉 wsRecoveryPending，同时用 restartInFlightRef 拦掉 WS 自动恢复的多余 reload。
   */
  const restartHost = useCallback(async () => {
    if (restartInFlightRef.current) return;
    restartInFlightRef.current = true;
    const session = { cancelled: false };
    restartSessionRef.current = session;
    setRestarting(true);
    // 显式重启是用户主动恢复：清掉 WS 自动恢复的排队与预算，避免两套恢复互相打架。
    resetWsRecovery();
    try {
      const response = await groupAuthorizedFetch({
        host: connection.host,
        port: tunnelPort,
        hostId: connection.hostId,
        deviceId: connection.deviceId,
        label: connection.deviceKeyLabel,
        method: 'POST',
        url: groupRestartUrl(connection.host, tunnelPort),
        body: {},
        timeoutMs: HOST_RESTART_REQUEST_TIMEOUT_MS,
      });
      if (session.cancelled) return;
      if (response.status !== 200 && response.status !== 202) {
        Alert.alert('重启主机失败', describeRestartFailure(response.status, response.body));
        return;
      }
      // 主机已接受重启：先进入「连接中」，让进度条显示并拦掉 WS 自动恢复。
      statusRef.current = 'connecting';
      setStatus('connecting');
      setErrorMessage(null);
      resetWsRecovery();
      Alert.alert('已请求重启', '等待主机恢复中，恢复后会自动重新加载页面。', [{ text: '好' }]);
      const recovered = await waitForHostRecovery(session);
      if (session.cancelled) return;
      if (recovered) {
        reload();
        return;
      }
      Alert.alert(
        '主机重启超时',
        `等待主机恢复超过 ${Math.round(HOST_RESTART_POLL_TIMEOUT_MS / 1000)} 秒。`
          + '主机可能仍在重启，请稍后点击右上角刷新重试。',
      );
    } catch (error) {
      if (session.cancelled) return;
      Alert.alert('重启主机失败', describeRestartError(error));
    } finally {
      restartInFlightRef.current = false;
      if (restartSessionRef.current === session) restartSessionRef.current = null;
      if (!session.cancelled) setRestarting(false);
    }
  }, [
    connection.deviceId,
    connection.deviceKeyLabel,
    connection.host,
    connection.hostId,
    reload,
    resetWsRecovery,
    tunnelPort,
    waitForHostRecovery,
  ]);

  /** 「重启主机」按钮：先二次确认（会短暂断开），确认后才发重启请求。 */
  const confirmRestartHost = useCallback(() => {
    if (restarting) return;
    Alert.alert(
      '重启主机 DSH',
      '将重启主机，连接会短暂中断，恢复后页面自动重新加载。',
      [
        { text: '取消', style: 'cancel' },
        { text: '重启', style: 'destructive', onPress: () => { void restartHost(); } },
      ],
    );
  }, [restartHost, restarting]);

  // 组件卸载/切主机（App 用 key={host} 重建本屏）时停止等待恢复：避免残留轮询
  // 把 reload 打到已经销毁的 WebView 上（轮询循环每 1.5s 检查一次 cancelled）。
  useEffect(() => () => {
    if (restartSessionRef.current) restartSessionRef.current.cancelled = true;
    restartSessionRef.current = null;
  }, []);

  const topInset = insets.top;

  return (
    <View style={styles.screen}>
      <View style={[styles.topBar, { paddingTop: topInset + spacing.sm }]}>
        <View style={styles.topRow}>
          <TouchableOpacity accessibilityLabel="返回" onPress={onClose} style={styles.iconButton}>
            <Text style={styles.iconGlyph}>‹</Text>
          </TouchableOpacity>
          <View style={styles.titleWrap}>
            <Text style={styles.hostText} numberOfLines={1}>
              {connection.hostName ?? connection.host}
            </Text>
            <View style={styles.statusRow}>
              {/* 重启流程期间状态文案优先显示「重启中」，避免和普通连接中混淆。 */}
              <View
                style={[styles.statusDot, { backgroundColor: STATUS_COLORS[restarting ? 'connecting' : status] }]}
              />
              <Text style={styles.statusText} numberOfLines={1}>
                {restarting ? '重启中' : STATUS_LABELS[status]}{__DEV__ ? ` · ${hostIdOf(connection.host)}` : ''}
              </Text>
            </View>
          </View>
          <TouchableOpacity
            accessibilityLabel="连接设置"
            accessibilityHint="打开这台主机的设备与安全设置，返回时回到主机页面"
            onPress={onOpenConnectionSettings}
            style={styles.iconButton}
          >
            <Text style={styles.iconGlyphSmall}>⚙︎</Text>
          </TouchableOpacity>
          {/*
            * 重启主机 DSH：只在主机组件启用（status.restart.enabled === true）时显示。
            * 请求经群体版隧道（原生请求带 __Host-dsh_session cookie）发给主机插件，
            * 主机重启 DSH 客户端；App 等到 /__dsh_remote/status 恢复后自动 reload。
            * 进行中禁用按钮并显示 spinner，避免重复点出多轮轮询。
            */}
          {restartAvailable ? (
            <TouchableOpacity
              accessibilityLabel="重启主机"
              accessibilityHint="向主机发送重启请求，主机恢复后自动重新加载页面"
              accessibilityState={{ disabled: restarting, busy: restarting }}
              disabled={restarting}
              onPress={confirmRestartHost}
              style={[styles.iconButton, restarting ? styles.iconButtonBusy : null]}
            >
              {restarting ? (
                <ActivityIndicator color={colors.text} size="small" />
              ) : (
                <Text style={styles.iconGlyphSmall}>⏻</Text>
              )}
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity accessibilityLabel="刷新" onPress={handleManualReload} style={styles.iconButton}>
            <Text style={styles.iconGlyphSmall}>↻</Text>
          </TouchableOpacity>
        </View>

        {/*
          * 进度条槽位常驻（只改 opacity）：条件渲染会让 topBar 高度变化，WebView 上下跳。
          */}
        <View style={[styles.progressTrack, { opacity: status === 'connecting' ? 1 : 0 }]}>
          <View style={[styles.progressFill, { width: '45%' }]} />
        </View>
      </View>

      {/*
        * 键盘避让：iOS WKWebView 默认不会缩小自身 frame，键盘弹出时它会用
        * scrollView.contentInset 把整页滚上去「露出光标」；DSH 页面按 100% 高度布局、
        * composer 在页面底部，于是每次输入/删除都触发一次「滚到光标」→ 页面在两个
        * scrollOffset 之间来回跳（现象：删字时聊天区/输入框上下跳）。
        * KeyboardAvoidingView 在键盘出现时把 WebView 缩到键盘上方：页面布局本身就在
        * 可见区里，WKWebView 不再需要滚页面，composer 也一直可见。
        * Android 由系统 adjustResize 处理（behavior=undefined，不重复缩）。
        */}
      <KeyboardAvoidingView
        style={styles.webviewWrap}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {!groupSessionReady ? (
          <View style={styles.loadingOverlay}>
            <ActivityIndicator color={colors.accent} size="large" />
            <Text style={styles.loadingText}>{groupSessionError ?? '正在获取访问令牌…'}</Text>
            {groupSessionError ? (
              <TouchableOpacity
                style={styles.retryButton}
                onPress={() => { void ensureGroupSessionForConnection(true); }}
              >
                <Text style={styles.retryText}>重试</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : (
          <DshWebView
            ref={webViewRef}
            source={{ uri: pageUrl }}
            injectedJavaScript={MOBILE_WEB_SHELL_JS}
            style={styles.webview}
            // 群体版：必须共享 cookie，WebView 请求才会带上 __Host-dsh_session token。
            sharedCookiesEnabled
            thirdPartyCookiesEnabled={false}
            javaScriptEnabled
            domStorageEnabled
            allowsBackForwardNavigationGestures
            pullToRefreshEnabled // Android only; iOS uses the refresh button.
            startInLoadingState
            onLoadStart={handleLoadStart}
            onLoadEnd={handleLoadEnd}
            onNavigationStateChange={handleNavigationStateChange}
            onShouldStartLoadWithRequest={handleShouldStartLoad}
            onError={(event) => handleError(event.nativeEvent.description)}
            onHttpError={(event) => handleHttpError(event.nativeEvent.statusCode)}
            renderLoading={() => (
              <View style={styles.loadingOverlay}>
                <ActivityIndicator color={colors.accent} size="large" />
                <Text style={styles.loadingText}>正在连接主机…</Text>
              </View>
            )}
            // Never allow http:// downgrades or arbitrary origins inside the shell.
            originWhitelist={[pageOrigin]}
            mixedContentMode="never"
            setSupportMultipleWindows={false}
            onMessage={(event) => handleBridgeMessage(event.nativeEvent.data)}
            applicationNameForUserAgent="DSHRemote/0.1.5 (Expo)"
          />
        )}

        {/*
          * 错误条做成 WebView 上方的覆盖层（absolute，且在 WebView 之后渲染以盖住它），
          * 避免出现/消失时把 WebView 高度挤掉让整屏“跳一下”。
          * 自动恢复进行中（wsRecoveryPending）不是错误：用警告色 + spinner，
          * 且不显示「重试」按钮，避免用户误以为需要手动操作。
          */}
        {errorMessage ? (
          <View style={[styles.errorBarOverlay, wsRecoveryPending ? styles.errorBarOverlayRecovering : null]}>
            <Text style={[styles.errorText, wsRecoveryPending ? styles.errorTextRecovering : null]}>
              {errorMessage}
            </Text>
            {wsRecoveryPending ? (
              <ActivityIndicator color={colors.warning} size="small" />
            ) : (
              <TouchableOpacity style={styles.retryButton} onPress={handleManualReload}>
                <Text style={styles.retryText}>重试</Text>
              </TouchableOpacity>
            )}
          </View>
        ) : null}

        {groupSessionError && groupSessionReady ? (
          <View style={styles.errorBarOverlay}>
            <Text style={styles.errorText}>{groupSessionError}</Text>
            <TouchableOpacity
              style={styles.retryButton}
              onPress={() => { void ensureGroupSessionForConnection(true); }}
            >
              <Text style={styles.retryText}>重试</Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </KeyboardAvoidingView>

      {/*
        * 底部连接信息（页面标题 + 当前 URL）只在 Debug 构建显示，方便排查
        * 导航/加载问题；Release 构建去掉这条，把高度让给主界面 WebView。
        */}
      {__DEV__ ? (
        <View style={[styles.bottomBar, { paddingBottom: insets.bottom + spacing.xs }]}>
          <Text style={styles.bottomText} numberOfLines={1}>
            {pageTitle} · {currentUrl}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  topBar: {
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceRaised,
  },
  /** 「重启主机」进行中：按钮禁用，降低存在感并显示 spinner。 */
  iconButtonBusy: {
    opacity: 0.55,
  },
  iconGlyph: {
    color: colors.text,
    fontSize: 26,
    lineHeight: 28,
    marginTop: -2,
  },
  iconGlyphSmall: {
    color: colors.text,
    fontSize: 18,
  },
  titleWrap: {
    flex: 1,
    minWidth: 0,
  },
  hostText: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '700',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: 2,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: radii.pill,
  },
  statusText: {
    color: colors.textMuted,
    fontSize: 11,
    flex: 1,
  },
  progressTrack: {
    height: 2,
    backgroundColor: colors.border,
    marginTop: spacing.sm,
    borderRadius: radii.pill,
    overflow: 'hidden',
  },
  progressFill: {
    height: 2,
    backgroundColor: colors.accent,
  },
  errorBarOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    // 覆盖层需要实色背景，否则叠在网页内容上读不清。
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.danger,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  errorText: {
    flex: 1,
    color: colors.danger,
    fontSize: 12,
    lineHeight: 17,
  },
  /** 自动恢复进行中：警告色（不是错误），配合 spinner 提示「正在自动重连…」。 */
  errorBarOverlayRecovering: {
    borderBottomColor: colors.warning,
  },
  errorTextRecovering: {
    color: colors.warning,
  },
  retryButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.danger,
  },
  retryText: {
    color: colors.danger,
    fontSize: 12,
    fontWeight: '700',
  },
  webviewWrap: {
    flex: 1,
    backgroundColor: colors.background,
  },
  webview: {
    flex: 1,
    backgroundColor: colors.background,
  },
  loadingOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    backgroundColor: colors.background,
  },
  loadingText: {
    ...typography.subtitle,
    textAlign: 'center',
    paddingHorizontal: spacing.xl,
  },
  bottomBar: {
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  bottomText: {
    fontSize: 10,
    color: colors.textFaint,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
  },
});
