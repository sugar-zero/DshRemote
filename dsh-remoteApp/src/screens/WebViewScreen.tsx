/**
 * WebViewScreen — the main DSH UI surface over the relay tunnel.
 *
 * Loads `https://<host>/?dsh_mobile=1` (evaluation §4.6: the host's client
 * plugin injects the mobile layout; no app update needed).
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ TODO(mTLS): react-native-webview CANNOT present a TLS client certificate │
 * │ on iOS, and only rarely on Android. After pairing, the host requires mTLS │
 * │ on every path except /__dsh_remote/pair, so this WebView will receive 403 │
 * │ until it is replaced by the custom native view.                           │
 * │                                                                          │
 * │ Integration point (modules/dsh-mtls):                                    │
 * │   1. Side-effect-import the module and configure the identity label:     │
 * │        setClientIdentity(connection.certRef)                             │
 * │   2. Use the native view instead of react-native-webview:                │
 * │        const NativeView = getDshMtlsWebView()                            │
 * │        <NativeView url={webUiUrl(host)}                                  │
 * │                   clientIdentityLabel={connection.certRef} />            │
 * │   3. The Swift side implements                                     │
 * │        webView(_:didReceive:completionHandler:) for                  │
 * │        NSURLAuthenticationMethodClientCertificate and answers with  │
 * │        URLCredential(identity: certificates: persistence:).          │
 * │   4. The Kotlin side implements                                     │
 * │        WebViewClient.onReceivedClientCertRequest →                    │
 * │        request.proceed(privateKey, certChain) from the Keystore.      │
 * │                                                                          │
 * │ Until step 2 lands, this screen runs react-native-webview and shows a    │
 * │ warning banner so the POC failure mode is explicit.                      │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type Ref } from 'react';
import {
  ActivityIndicator,
  AppState,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { WebView, type WebViewNavigation, type WebViewProps } from 'react-native-webview';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { webUiUrl } from '../lib/protocol';
import { MOBILE_WEB_SHELL_JS } from '../lib/mobileWebShell';
import type { StoredConnection } from '../lib/store';
import {
  evaluateJavaScript,
  getDshMtlsWebView,
  requestWithClientCert,
  setClientIdentity,
  type DshMtlsWebViewErrorEvent,
  type DshMtlsWebViewLoadingEvent,
  type DshMtlsWebViewMessageEvent,
} from '../../modules/dsh-mtls/src';
import { colors, radii, sharedStyles, spacing, typography } from '../theme';

interface WebViewScreenProps {
  connection: StoredConnection;
  onClose: () => void;
  /** 打开 App 设置页（版本/通知/缓存/设备与安全入口）。 */
  onOpenSettings: () => void;
  /** 设置页清理缓存后递增，触发 WebView 重新加载。 */
  reloadToken?: number;
  /** 当前 WebView 是否在屏幕上可见（隐藏时常驻，用于判断何时重连）。 */
  isVisible?: boolean;
  /** 点击推送后要打开的会话（由 App 传入；WebView 加载完成后注入 JS 执行）。 */
  openSessionRequest?: { sessionId: string; nonce: number } | null;
  /** 已尝试注入打开会话脚本（App 用来清空请求，避免重复执行）。 */
  onOpenSessionHandled?: (nonce: number) => void;
  /** DSH 页面上报的当前会话（host + sessionId，用于前台通知的“当前会话抑制”）。 */
  onCurrentSession?: (info: { host: string; sessionId: string } | null) => void;
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

/** The host's relay domain is the only origin this WebView may navigate to. */
function isTunnelUrl(url: string, host: string): boolean {
  const httpsPrefix = `https://${host}/`;
  const bareHost = `https://${host}`;
  return url === bareHost || url.startsWith(httpsPrefix);
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
  onOpenSettings,
  reloadToken = 0,
  isVisible = true,
  openSessionRequest = null,
  onOpenSessionHandled,
  onCurrentSession,
}: WebViewScreenProps) {
  const insets = useSafeAreaInsets();
  const webViewRef = useRef<WebView | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [pageTitle, setPageTitle] = useState<string>('DSH');
  const [currentUrl, setCurrentUrl] = useState(() => webUiUrl(connection.host));
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // WebSocket 断开后的自动恢复；隐藏时先记下，等页面重新可见再 reload。
  const [wsRecoveryPending, setWsRecoveryPending] = useState(false);
  // 60s 内最多自动重连 2 次，避免「主机一直拒绝 WS → reload → 又断开」的死循环。
  const wsRecoveryRef = useRef({ count: 0, since: 0 });

  // 最近一次健康检查的序号 / 是否在途，避免 AppState + 可见性双触发时重复 reload。
  const healthCheckRef = useRef({ inFlight: false, lastStartedAt: 0 });
  const healthCheckSeq = useRef(0);
  const statusRef = useRef<ConnectionStatus>('connecting');
  const wasVisibleRef = useRef(false);
  // 页面重新加载期间忽略旧页面 WebSocket 的 close 事件，避免“reload → 旧 socket close
  // → 又排队 reload”的循环。
  const loadingRef = useRef(false);
  // 页面是否至少加载完成过一次（推送跳转要等页面 DOM 就绪再注入）。
  const loadedRef = useRef(false);
  // 待注入的打开会话请求；加载完成后再执行，避免在旧文档上注入后随导航丢失。
  const pendingOpenSessionRef = useRef<{ sessionId: string; nonce: number } | null>(null);
  const lastOpenSessionNonceRef = useRef(0);
  // 最近一次上报的当前会话：离开 WebView 后 App 会清空该状态，重新可见时用它补报。
  const currentSessionRef = useRef<{ host: string; sessionId: string } | null>(null);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // 原生 WebView 崩溃 / 被系统回收后的自动重建预算：60s 内最多 2 次，
  // 避免“重建 → 又崩溃 → 再重建”的死循环（超出后保留错误条，交给用户手动重试）。
  const nativeRecoveryRef = useRef<{ count: number; since: number }>({ count: 0, since: 0 });

  const NativeMtlsWebView = useMemo(() => getDshMtlsWebView(), []);
  /**
   * Use the native mTLS web view only when both the native module and a device
   * identity label exist. Without a cert the native view would behave like a
   * plain WebView; plain RN WebView is better for the POC until then.
   */
  const useNativeMtlsView = NativeMtlsWebView !== null && Boolean(connection.certRef);

  const reload = useCallback(() => {
    // 重新加载期间旧文档即将被替换：打开会话的注入必须等新页面加载完成。
    loadedRef.current = false;
    loadingRef.current = true;
    statusRef.current = 'connecting';
    setErrorMessage(null);
    setStatus('connecting');
    setWsRecoveryPending(false);
    healthCheckSeq.current += 1;
    // 用户主动重试时重新给自动恢复预算（否则 60s 内再被回收只能一直手点）。
    nativeRecoveryRef.current.count = 0;
    nativeRecoveryRef.current.since = 0;
    if (useNativeMtlsView) {
      // Native view has no ref API in the POC skeleton; remount to reload.
      setReloadKey((key) => key + 1);
      return;
    }
    webViewRef.current?.reload();
  }, [useNativeMtlsView]);

  /**
   * 执行「打开推送对应会话」的注入脚本。
   *
   * 优先直接调用 host 插件暴露的 window.__DSH_REMOTE_OPEN_SESSION__；插件还没加载时
   * 把 id 暂存到 __DSH_REMOTE_OPEN_SESSION_PENDING__，host 插件安装时会消费。
   * 必须等页面加载完成后再注入，否则脚本会落在即将被导航替换的旧文档上。
   */
  const flushOpenSession = useCallback(() => {
    const request = pendingOpenSessionRef.current;
    if (!request || lastOpenSessionNonceRef.current === request.nonce) return;
    // 页面尚未就绪（首次加载 / 正在 reload / 错误页）时不要注入：否则脚本会落到
    // 即将销毁的文档上，而 App 会误以为已处理并清空请求。
    if (!loadedRef.current) return;
    const sessionIdLiteral = JSON.stringify(request.sessionId);
    const script =
      `(function(){try{var id=${sessionIdLiteral};` +
      'window.__DSH_REMOTE_OPEN_SESSION_PENDING__=id;' +
      'var f=window.__DSH_REMOTE_OPEN_SESSION__;' +
      'if(typeof f==="function"){f(id);window.__DSH_REMOTE_OPEN_SESSION_PENDING__=null;}' +
      '}catch(e){}})();void 0;';
    if (useNativeMtlsView) {
      void evaluateJavaScript(script).then((ok) => {
        if (!ok) return; // 旧构建没有 evaluateJavaScript：保持 pending，等下次加载再试
        pendingOpenSessionRef.current = null;
        lastOpenSessionNonceRef.current = request.nonce;
        onOpenSessionHandled?.(request.nonce);
      }).catch(() => {});
      return;
    }
    try {
      webViewRef.current?.injectJavaScript(script);
      pendingOpenSessionRef.current = null;
      lastOpenSessionNonceRef.current = request.nonce;
      onOpenSessionHandled?.(request.nonce);
    } catch {
      // 注入失败：保留 pending，加载完成/再次可见时重试
    }
  }, [onOpenSessionHandled, useNativeMtlsView]);

  // 推送点击后 App 传入 openSessionRequest：先记录，等页面就绪后注入。
  useEffect(() => {
    if (!openSessionRequest) return;
    pendingOpenSessionRef.current = openSessionRequest;
    if (loadedRef.current) flushOpenSession();
  }, [openSessionRequest, flushOpenSession]);

  const openExternal = useCallback(async (url: string) => {
    try {
      const supported = await Linking.canOpenURL(url);
      if (supported) await Linking.openURL(url);
    } catch {
      // Ignore: the user tapped a link the OS cannot open.
    }
  }, []);

  const handleShouldStartLoad = useCallback(
    (request: { url: string }): boolean => {
      const { url } = request;
      if (url === 'about:blank' || url.startsWith('about:blank#')) return true;
      if (isTunnelUrl(url, connection.host)) return true;
      // Everything outside the tunnel: open in the system browser (evaluation §4.7.2).
      if (url.startsWith('https://') || url.startsWith('http://')) {
        void openExternal(url);
        return false;
      }
      // Custom schemes (mailto:, tel:, dshremote:) also go to the OS.
      void openExternal(url);
      return false;
    },
    [connection.host, openExternal],
  );

  // 设置页「清理缓存」后递增 reloadToken：重新加载当前页面（旧缓存已被原生清空）。
  useEffect(() => {
    if (reloadToken > 0) reload();
  }, [reloadToken, reload]);

  const handleNavigationStateChange = useCallback((navigation: WebViewNavigation) => {
    setCurrentUrl(navigation.url);
    if (navigation.title) setPageTitle(navigation.title);
  }, []);

  const handleLoadStart = useCallback(() => {
    loadingRef.current = true;
    loadedRef.current = false;
    statusRef.current = 'connecting';
    setStatus('connecting');
  }, []);

  const handleLoadEnd = useCallback(() => {
    loadingRef.current = false;
    loadedRef.current = true;
    statusRef.current = 'online';
    setStatus('online');
    setErrorMessage(null);
    flushOpenSession();
  }, [flushOpenSession]);

  const handleError = useCallback((description?: string) => {
    loadedRef.current = false;
    loadingRef.current = false;
    statusRef.current = 'error';
    setStatus('error');
    setErrorMessage(description ?? '无法加载 DSH 页面。');
  }, []);

  /**
   * Rebuild the native WebView after its renderer died.
   *
   * Android kills the WebView renderer under memory pressure (`onRenderProcessGone`);
   * the instance cannot be reused afterwards, so the only recovery is remounting the
   * native view (`key={reloadKey}`) — the Swift/Kotlin module then allocates a fresh
   * WKWebView/WebView. Guarded so a crash loop cannot turn into a reload loop.
   */
  const recoverNativeView = useCallback(() => {
    const now = Date.now();
    const state = nativeRecoveryRef.current;
    if (state.since === 0 || now - state.since > 60_000) {
      state.count = 0;
      state.since = now;
    }
    if (state.count >= 2) return;
    state.count += 1;
    loadedRef.current = false;
    loadingRef.current = true;
    statusRef.current = 'connecting';
    setStatus('connecting');
    setReloadKey((key) => key + 1);
  }, []);

  const handleNativeLoadingFinish = useCallback(() => {
    // 与 react-native-webview 路径对齐：加载成功后清掉上一次的（自动恢复）错误条，
    // 否则一次进程回收/自动 reload 之后错误条会永久留在页面上，挤压 WebView 布局。
    loadingRef.current = false;
    loadedRef.current = true;
    statusRef.current = 'online';
    setStatus('online');
    setErrorMessage(null);
    flushOpenSession();
  }, [flushOpenSession]);

  const handleNativeError = useCallback(
    (event: DshMtlsWebViewErrorEvent) => {
      const { description, reason } = event.nativeEvent;
      loadedRef.current = false;
      handleError(description);
      if (reason === 'render-process-gone') {
        // iOS 的 content-process-terminated 由原生侧自己 reload；Android 必须重建视图。
        recoverNativeView();
      }
    },
    [handleError, recoverNativeView],
  );

  const handleHttpError = useCallback((statusCode: number) => {
    loadingRef.current = false;
    statusRef.current = 'error';
    if (statusCode === 401 || statusCode === 403) {
      setStatus('error');
      setErrorMessage(
        '主机拒绝了连接（HTTP 403）：这通常意味着请求没有携带有效的设备证书。' +
          '请确认已完成配对，并使用包含原生 mTLS WebView 的构建（见 README）。',
      );
      return;
    }
    setStatus('error');
    setErrorMessage(`主机返回 HTTP ${statusCode}。`);
  }, []);

  /**
   * 收到注入层 / host 插件的桥消息：
   *  - dsh-ws-open/close：WebSocket 状态，主机重启时触发自动 reload；
   *  - dsh-remote/current-session：当前会话（host+sessionId），供 App 判断前台通知是否是当前会话。
   */
  const handleBridgeMessage = useCallback((raw: string) => {
    let payload: { type?: unknown; url?: unknown; host?: unknown; sessionId?: unknown } | null = null;
    try {
      payload = JSON.parse(raw) as { type?: unknown; url?: unknown; host?: unknown; sessionId?: unknown };
    } catch {
      return;
    }
    if (!payload || typeof payload.type !== 'string') return;
    if (payload.type === 'dsh-remote/current-session') {
      const host = typeof payload.host === 'string' ? payload.host : '';
      const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
      const info = sessionId ? { host, sessionId } : null;
      currentSessionRef.current = info;
      onCurrentSession?.(info);
      return;
    }
    const url = typeof payload.url === 'string' ? payload.url : '';
    if (url && !url.includes('remote.mux')) return;
    if (loadingRef.current) return;
    if (payload.type === 'dsh-ws-open') {
      setWsRecoveryPending(false);
      return;
    }
    if (payload.type === 'dsh-ws-close' && statusRef.current === 'online') {
      const now = Date.now();
      const budget = wsRecoveryRef.current;
      if (budget.since === 0 || now - budget.since > 60_000) {
        budget.count = 0;
        budget.since = now;
      }
      if (budget.count >= 2) {
        setStatus('error');
        setErrorMessage('与主机的实时连接已断开，自动重连未恢复，请点击刷新重试。');
        return;
      }
      budget.count += 1;
      setWsRecoveryPending(true);
    }
  }, [onCurrentSession]);

  const handleNativeMessage = useCallback((event: DshMtlsWebViewMessageEvent) => {
    handleBridgeMessage(event.nativeEvent.data);
  }, [handleBridgeMessage]);

  // 页面可见且检测到 WebSocket 已断开：稍等一小段时间让 DSH 自己重连；
  // 若仍未恢复（主机重启通常如此），重新挂载 WebView 并走缓存加载。
  useEffect(() => {
    if (!isVisible || !wsRecoveryPending) return undefined;
    const timer = setTimeout(() => {
      setWsRecoveryPending(false);
      reload();
    }, 600);
    return () => clearTimeout(timer);
  }, [isVisible, wsRecoveryPending, reload]);

  /**
   * App 回到前台 / 再次进入主机时，用设备证书探活。
   * 只做一次短超时 GET；失败就 reload，避免用户面对一个已经死掉的旧页面。
   * WebSocket 关闭导致的黑屏由上面的 monitor 处理；HTTP 探活覆盖主机重启后
   * 连 TLS/HTTP 都不通的情况。
   */
  const checkHostHealth = useCallback(async () => {
    if (!isVisible || !useNativeMtlsView || wsRecoveryPending) return;
    if (loadingRef.current || statusRef.current !== 'online') return;
    if (healthCheckRef.current.inFlight) return;
    const now = Date.now();
    if (now - healthCheckRef.current.lastStartedAt < 1500) return;
    healthCheckRef.current.inFlight = true;
    healthCheckRef.current.lastStartedAt = now;
    const seq = ++healthCheckSeq.current;
    if (connection.certRef) {
      try {
        // requestWithClientCert 使用全局 configuredLabel；切主机时先对齐当前设备身份。
        await setClientIdentity(connection.certRef);
      } catch {
        // 原生模块未链接时 requestWithClientCert 也会失败，交给 catch 统一 reload。
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('health-check-timeout')), 4000);
    });
    try {
      const response = await Promise.race([
        requestWithClientCert({
          url: `https://${connection.host}/__dsh_remote/status`,
          method: 'GET',
        }),
        timeout,
      ]);
      if (seq !== healthCheckSeq.current) return;
      if (response.status === 200) return;
      if (response.status === 401 || response.status === 403) {
        setStatus('error');
        setErrorMessage(
          '主机拒绝了连接（HTTP 403）：设备证书可能已失效或已被撤销，请检查配对状态。',
        );
        return;
      }
      throw new Error(`host health check HTTP ${response.status}`);
    } catch {
      if (seq !== healthCheckSeq.current) return;
      if (statusRef.current !== 'online') return;
      reload();
    } finally {
      if (timer) clearTimeout(timer);
      healthCheckRef.current.inFlight = false;
    }
  }, [connection.host, isVisible, reload, useNativeMtlsView, wsRecoveryPending]);

  // 从 Home / 设置页重新进入主机时探活；初次加载（status=connecting）不重复请求。
  useEffect(() => {
    const becameVisible = isVisible && !wasVisibleRef.current;
    wasVisibleRef.current = isVisible;
    if (becameVisible) void checkHostHealth();
  }, [checkHostHealth, isVisible]);

  // 重新进入主机时把缓存的当前会话补报一次：App 在离开 WebView 时会清掉该状态
  // （避免旧会话抑制前台推送），回到页面后再恢复，这样“当前会话不弹卡片”仍然生效。
  useEffect(() => {
    if (!isVisible) return;
    onCurrentSession?.(currentSessionRef.current);
  }, [isVisible, onCurrentSession]);

  // App 从后台回到前台：后台期间主机可能重启过，重新探活。
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') void checkHostHealth();
    });
    return () => subscription.remove();
  }, [checkHostHealth]);

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
              <View style={[styles.statusDot, { backgroundColor: STATUS_COLORS[status] }]} />
              <Text style={styles.statusText} numberOfLines={1}>
                {STATUS_LABELS[status]} · {connection.host}
              </Text>
            </View>
          </View>
          <TouchableOpacity accessibilityLabel="设置" onPress={onOpenSettings} style={styles.iconButton}>
            <Text style={styles.iconGlyphSmall}>⚙︎</Text>
          </TouchableOpacity>
          <TouchableOpacity accessibilityLabel="刷新" onPress={reload} style={styles.iconButton}>
            <Text style={styles.iconGlyphSmall}>↻</Text>
          </TouchableOpacity>
        </View>

        {/*
          * 进度条槽位常驻（只改 opacity）：之前是条件渲染，每次「开始加载/加载完成」
          * 都会让 topBar 高度变化 10px，WebView 随之上下跳一下。常驻后布局稳定。
          */}
        <View style={[styles.progressTrack, { opacity: status === 'connecting' ? 1 : 0 }]}>
          <View style={[styles.progressFill, { width: '45%' }]} />
        </View>
      </View>

      {useNativeMtlsView ? (
        __DEV__ ? (
          <Text style={styles.nativeHint}>
            正在使用原生 mTLS WebView（Keychain 身份：{connection.certRef}）
          </Text>
        ) : null
      ) : (
        <Pressable style={styles.warningBar} onPress={reload}>
          <Text style={styles.warningText}>
            ⚠️ POC：当前使用 react-native-webview，不会出示设备证书；主机要求 mTLS 时页面会显示
            403。请应用原生模块后重试（README「mTLS 验收」）。
          </Text>
        </Pressable>
      )}

      <View style={styles.webviewWrap}>
        {useNativeMtlsView && NativeMtlsWebView ? (
          <NativeMtlsWebView
            key={reloadKey}
            url={webUiUrl(connection.host)}
            clientIdentityLabel={connection.certRef}
            injectedJavaScript={MOBILE_WEB_SHELL_JS}
            style={styles.webview}
            onLoadingStart={(_event: DshMtlsWebViewLoadingEvent) => {
              loadedRef.current = false;
              loadingRef.current = true;
              statusRef.current = 'connecting';
              setWsRecoveryPending(false);
              setStatus('connecting');
            }}
            onLoadingFinish={handleNativeLoadingFinish}
            onLoadingError={handleNativeError}
            onMessage={handleNativeMessage}
          />
        ) : (
          <DshWebView
            key={reloadKey}
            ref={webViewRef}
            source={{ uri: webUiUrl(connection.host) }}
            injectedJavaScript={MOBILE_WEB_SHELL_JS}
            style={styles.webview}
            // A secure, cookie-less origin: the host proxies with its own session.
            sharedCookiesEnabled={false}
            thirdPartyCookiesEnabled={false}
            javaScriptEnabled
            domStorageEnabled
            allowsBackForwardNavigationGestures
            pullToRefreshEnabled // Android only; iOS uses the refresh button (see TODO above).
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
                <Text style={styles.loadingText}>正在通过中继连接 {connection.host}…</Text>
              </View>
            )}
            // Never allow http:// downgrades or arbitrary origins inside the shell.
            originWhitelist={[`https://${connection.host}`]}
            mixedContentMode="never"
            setSupportMultipleWindows={false}
            onMessage={(event) => handleBridgeMessage(event.nativeEvent.data)}
            applicationNameForUserAgent="DSHRemote/0.1 (Expo)"
          />
        )}

        {/*
          * 错误条做成 WebView 上方的覆盖层（absolute，且在 WebView 之后渲染以盖住它）。
          * 之前它插在 WebView 上方，出现/消失会把 WebView 高度挤掉/还回 ~50px——
          * 一次进程回收/自动恢复、或一次瞬时导航失败就会让整屏“跳一下”。
          */}
        {errorMessage ? (
          <View style={styles.errorBarOverlay}>
            <Text style={styles.errorText}>{errorMessage}</Text>
            <TouchableOpacity style={styles.retryButton} onPress={reload}>
              <Text style={styles.retryText}>重试</Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </View>

      <View style={[styles.bottomBar, { paddingBottom: insets.bottom + spacing.xs }]}>
        <Text style={styles.bottomText} numberOfLines={1}>
          {pageTitle} · {currentUrl}
        </Text>
      </View>
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
  nativeHint: {
    color: colors.success,
    fontSize: 11,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    backgroundColor: 'rgba(63, 212, 140, 0.08)',
  },
  warningBar: {
    backgroundColor: 'rgba(245, 184, 76, 0.12)',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  warningText: {
    color: colors.warning,
    fontSize: 11,
    lineHeight: 16,
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
