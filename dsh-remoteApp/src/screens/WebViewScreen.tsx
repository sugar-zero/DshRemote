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

import { useCallback, useMemo, useRef, useState, type ComponentType, type Ref } from 'react';
import {
  ActivityIndicator,
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
import { getDshMtlsWebView, type DshMtlsWebViewErrorEvent, type DshMtlsWebViewLoadingEvent } from '../../modules/dsh-mtls/src';
import { colors, radii, sharedStyles, spacing, typography } from '../theme';

interface WebViewScreenProps {
  connection: StoredConnection;
  onClose: () => void;
  onOpenDevices: () => void;
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

export function WebViewScreen({ connection, onClose, onOpenDevices }: WebViewScreenProps) {
  const insets = useSafeAreaInsets();
  const webViewRef = useRef<WebView | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [pageTitle, setPageTitle] = useState<string>('DSH');
  const [currentUrl, setCurrentUrl] = useState(() => webUiUrl(connection.host));
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const NativeMtlsWebView = useMemo(() => getDshMtlsWebView(), []);
  /**
   * Use the native mTLS web view only when both the native module and a device
   * identity label exist. Without a cert the native view would behave like a
   * plain WebView; plain RN WebView is better for the POC until then.
   */
  const useNativeMtlsView = NativeMtlsWebView !== null && Boolean(connection.certRef);

  const reload = useCallback(() => {
    setErrorMessage(null);
    setStatus('connecting');
    if (useNativeMtlsView) {
      // Native view has no ref API in the POC skeleton; remount to reload.
      setReloadKey((key) => key + 1);
      return;
    }
    webViewRef.current?.reload();
  }, [useNativeMtlsView]);

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

  const handleNavigationStateChange = useCallback((navigation: WebViewNavigation) => {
    setCurrentUrl(navigation.url);
    if (navigation.title) setPageTitle(navigation.title);
  }, []);

  const handleLoadStart = useCallback(() => {
    setStatus('connecting');
  }, []);

  const handleLoadEnd = useCallback(() => {
    setStatus('online');
    setErrorMessage(null);
  }, []);

  const handleError = useCallback((description?: string) => {
    setStatus('error');
    setErrorMessage(description ?? '无法加载 DSH 页面。');
  }, []);

  const handleHttpError = useCallback((statusCode: number) => {
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
          <TouchableOpacity accessibilityLabel="设备与安全" onPress={onOpenDevices} style={styles.iconButton}>
            <Text style={styles.iconGlyphSmall}>⚙︎</Text>
          </TouchableOpacity>
          <TouchableOpacity accessibilityLabel="刷新" onPress={reload} style={styles.iconButton}>
            <Text style={styles.iconGlyphSmall}>↻</Text>
          </TouchableOpacity>
        </View>

        {status === 'connecting' ? (
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: '45%' }]} />
          </View>
        ) : null}
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

      {errorMessage ? (
        <View style={styles.errorBar}>
          <Text style={styles.errorText}>{errorMessage}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={reload}>
            <Text style={styles.retryText}>重试</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <View style={styles.webviewWrap}>
        {useNativeMtlsView && NativeMtlsWebView ? (
          <NativeMtlsWebView
            key={reloadKey}
            url={webUiUrl(connection.host)}
            clientIdentityLabel={connection.certRef}
            injectedJavaScript={MOBILE_WEB_SHELL_JS}
            style={styles.webview}
            onLoadingStart={(_event: DshMtlsWebViewLoadingEvent) => setStatus('connecting')}
            onLoadingFinish={(_event: DshMtlsWebViewLoadingEvent) => setStatus('online')}
            onLoadingError={(event: DshMtlsWebViewErrorEvent) =>
              handleError(event.nativeEvent.description)
            }
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
            onMessage={() => undefined}
            applicationNameForUserAgent="DSHRemote/0.1 (Expo)"
          />
        )}
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
  errorBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: 'rgba(242, 99, 122, 0.12)',
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
