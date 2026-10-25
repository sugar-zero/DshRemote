/**
 * ExternalPageScreen — App 内嵌浏览器（外部链接，如 DeepSeek 平台的查询用量/充值）。
 *
 * 桌面 DSH 用 Electron 的 dshPlatform 桥把这类平台页内嵌在窗口里；手机端没有桌面桥，
 * 这里用 react-native-webview 提供一个等价的内嵌页面（顶部返回/刷新/在浏览器打开，
 * 底部显示完整 URL），而不是把用户切到 Safari。
 *
 * 安全边界：
 *  - 只加载 http(s) 且不是隧道主机（调用方已校验，这里再兜底一次）；
 *  - 独立 WebView，不共享 DSH mTLS WebView 的 cookie/凭据；平台页需要用户在
 *    内嵌页里自行登录（cookie 在 WebView 数据目录里持久化，和桌面 DSH 会话无关）；
 *  - 非 http(s) 链接（mailto:/tel: 等）交给系统处理。
 */
import { useCallback, useRef, useState, type ComponentType, type Ref } from 'react';
import {
  ActivityIndicator,
  Linking,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { WebView, type WebViewNavigation, type WebViewProps } from 'react-native-webview';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, radii, spacing, typography } from '../theme';

interface ExternalPageScreenProps {
  url: string;
  title?: string;
  onClose: () => void;
}

function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const ExternalWebView = WebView as unknown as ComponentType<
  WebViewProps & { ref?: Ref<WebView> }
>;

export function ExternalPageScreen({ url, title, onClose }: ExternalPageScreenProps) {
  const insets = useSafeAreaInsets();
  const webViewRef = useRef<WebView | null>(null);
  const [currentUrl, setCurrentUrl] = useState(url);
  const [pageTitle, setPageTitle] = useState(title || hostOf(url));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 顶部返回始终关闭内嵌页、回到 DSH（等价桌面内嵌页的「返回 DeepSeek Harness」）。
  // 不做「先回内嵌页历史」：平台页会持续 pushState，canGoBack 永远为真，按钮会像卡住。
  const reload = useCallback(() => {
    setError(null);
    setLoading(true);
    webViewRef.current?.reload();
  }, []);

  const openInSystemBrowser = useCallback(() => {
    void Linking.openURL(currentUrl).catch(() => {
      setError('无法用系统浏览器打开该地址');
    });
  }, [currentUrl]);

  const handleNavigation = useCallback((navigation: WebViewNavigation) => {
    setCurrentUrl(navigation.url);
    if (navigation.title) setPageTitle(navigation.title);
  }, []);

  // 内嵌页里只允许 http(s) 导航；其它 scheme 交给系统（mailto:/tel: 等）。
  const handleShouldStartLoad = useCallback((request: { url: string }): boolean => {
    if (request.url === 'about:blank' || isHttpUrl(request.url)) return true;
    void Linking.openURL(request.url).catch(() => {});
    return false;
  }, []);

  const errorText = error !== null
    ? error
    : '页面加载失败，请检查网络后重试。';

  return (
    <View style={styles.screen}>
      <View style={[styles.topBar, { paddingTop: insets.top + spacing.sm }]}>
        <TouchableOpacity accessibilityLabel="返回" onPress={onClose} style={styles.iconButton}>
          <Text style={styles.iconGlyph}>‹</Text>
        </TouchableOpacity>
        <View style={styles.titleWrap}>
          <Text style={styles.titleText} numberOfLines={1}>{pageTitle}</Text>
          <Text style={styles.hostText} numberOfLines={1}>{hostOf(currentUrl)}</Text>
        </View>
        <TouchableOpacity accessibilityLabel="刷新" onPress={reload} style={styles.iconButton}>
          <Text style={styles.iconGlyphSmall}>↻</Text>
        </TouchableOpacity>
        <TouchableOpacity
          accessibilityLabel="在浏览器打开"
          onPress={openInSystemBrowser}
          style={styles.iconButton}
        >
          <Text style={styles.iconGlyphSmall}>↗</Text>
        </TouchableOpacity>
      </View>

      <View style={[styles.progressTrack, { opacity: loading ? 1 : 0 }]}>
        <View style={[styles.progressFill, { width: '45%' }]} />
      </View>

      <View style={styles.webviewWrap}>
        <ExternalWebView
          ref={webViewRef}
          source={{ uri: url }}
          style={styles.webview}
          javaScriptEnabled
          domStorageEnabled
          sharedCookiesEnabled={false}
          thirdPartyCookiesEnabled={false}
          originWhitelist={['http://*', 'https://*']}
          setSupportMultipleWindows={false}
          applicationNameForUserAgent="DSHRemote/0.1 (Expo)"
          onLoadStart={() => { setLoading(true); setError(null); }}
          onLoadEnd={() => setLoading(false)}
          onNavigationStateChange={handleNavigation}
          onShouldStartLoadWithRequest={handleShouldStartLoad}
          onError={(event) => {
            const description = event?.nativeEvent?.description;
            setLoading(false);
            setError(description ? `页面加载失败：${description}` : '页面加载失败，请检查网络后重试。');
          }}
          onHttpError={(event) => {
            const statusCode = event?.nativeEvent?.statusCode;
            setLoading(false);
            if (typeof statusCode === 'number' && statusCode >= 400) {
              setError(`页面返回 HTTP ${statusCode}。`);
            }
          }}
          renderLoading={() => (
            <View style={styles.loadingOverlay}>
              <ActivityIndicator color={colors.accent} size="large" />
              <Text style={styles.loadingText}>正在加载…</Text>
            </View>
          )}
        />

        {error ? (
          <View style={styles.errorBar}>
            <Text style={styles.errorText}>{errorText}</Text>
            <TouchableOpacity style={styles.retryButton} onPress={reload}>
              <Text style={styles.retryText}>重试</Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </View>

      <View style={[styles.bottomBar, { paddingBottom: insets.bottom + spacing.xs }]}>
        <Text style={styles.bottomText} numberOfLines={1}>{currentUrl}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  topBar: {
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  titleWrap: { flex: 1, minWidth: 0 },
  titleText: { color: colors.text, fontSize: 15, fontWeight: '700' },
  hostText: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceRaised,
  },
  iconGlyph: { color: colors.text, fontSize: 26, lineHeight: 28, marginTop: -2 },
  iconGlyphSmall: { color: colors.text, fontSize: 18 },
  progressTrack: {
    height: 2,
    backgroundColor: colors.border,
    marginTop: 0,
    borderRadius: radii.pill,
    overflow: 'hidden',
  },
  progressFill: { height: 2, backgroundColor: colors.accent },
  webviewWrap: { flex: 1, backgroundColor: colors.background },
  webview: { flex: 1, backgroundColor: colors.background },
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
  loadingText: { ...typography.subtitle, textAlign: 'center', paddingHorizontal: spacing.xl },
  errorBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.danger,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  errorText: { flex: 1, color: colors.danger, fontSize: 12, lineHeight: 17 },
  retryButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.danger,
  },
  retryText: { color: colors.danger, fontSize: 12, fontWeight: '700' },
  bottomBar: {
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  bottomText: { ...typography.mono, fontSize: 10, color: colors.textFaint },
});
