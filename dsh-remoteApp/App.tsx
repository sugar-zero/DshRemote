/**
 * DSH Remote — app shell / minimal navigation state machine.
 *
 *   loading ──(stored connection?)──┬─ yes → webview ⇄ devices
 *                                    └─ no  → pairing → webview
 *
 * No navigation library on purpose: the POC has three screens and a linear
 * flow, so a small route union keeps the dependency surface (and app review
 * surface) minimal. If native screens are added later (session list, approvals),
 * this is the place to introduce expo-router / react-navigation.
 *
 * The paired-host record + device certificate live in SecureStore/Keychain
 * (see `src/lib/store.ts`). The device private key never enters JS.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, BackHandler, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { PairingScreen } from './src/screens/PairingScreen';
import { LockScreen } from './src/screens/LockScreen';
import { isAppLockEnabled } from './src/lib/appLock';
import { WebViewScreen } from './src/screens/WebViewScreen';
import { DevicesScreen } from './src/screens/DevicesScreen';
import { HomeScreen } from './src/screens/HomeScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { ExternalPageScreen } from './src/screens/ExternalPageScreen';
import {
  clearCertificate,
  loadConnections,
  removeConnection,
  type StoredConnection,
} from './src/lib/store';
import {
  configureNotificationHandler,
  enablePushForConnection,
  setForegroundCurrentSession,
  setForegroundInAppEnabled,
  setForegroundLocked,
} from './src/lib/notifications';
import { isInAppNotificationsEnabled, setInAppNotificationsEnabled } from './src/lib/settings';
import { InAppNotificationBanner, type InAppNotificationMessage } from './src/components/InAppNotificationBanner';
import { colors, spacing, typography } from './src/theme';

type Route = 'loading' | 'home' | 'pairing' | 'webview' | 'devices' | 'settings';

/** APNs payload 的 body 字典（host/sessionId 由 host 插件附带，用于点通知跳会话）。 */
function notificationDataOf(data: unknown): { sessionId?: string; host?: string } {
  if (!data || typeof data !== 'object') return {};
  const record = data as Record<string, unknown>;
  return {
    ...(typeof record.sessionId === 'string' && record.sessionId !== ''
      ? { sessionId: record.sessionId }
      : {}),
    ...(typeof record.host === 'string' && record.host !== '' ? { host: record.host } : {}),
  };
}

export default function App() {
  const [route, setRoute] = useState<Route>('loading');
  const [connections, setConnections] = useState<StoredConnection[]>([]);
  const [connection, setConnection] = useState<StoredConnection | null>(null);
  const [locked, setLocked] = useState(false);
  const lockEnabledRef = useRef(false);
  const lockedRef = useRef(false);
  const [inAppEnabled, setInAppEnabled] = useState(true);
  const inAppEnabledRef = useRef(true);
  const [inAppMessage, setInAppMessage] = useState<InAppNotificationMessage | null>(null);
  const [settingsReturnRoute, setSettingsReturnRoute] = useState<Route>('home');
  const [webViewReloadToken, setWebViewReloadToken] = useState(0);
  /** App 内嵌浏览器（DSH 页面里的外链，如平台查询用量/充值）；null = 未打开。 */
  const [externalPage, setExternalPage] = useState<{ url: string } | null>(null);
  /** 点击推送后要打开的会话；由 WebViewScreen 在页面就绪后注入执行并回调清空。 */
  const [openSessionRequest, setOpenSessionRequest] = useState<{ sessionId: string; nonce: number } | null>(null);
  /** 通知点击后是否已处理过（避免 listener 与冷启动 API 重复处理同一次点击）。 */
  const lastHandledNotificationIdRef = useRef<string | null>(null);
  const coldStartHandledRef = useRef(false);
  /** 供异步通知回调读取的最新导航/连接状态。 */
  const routeRef = useRef<Route>('loading');
  const connectionsRef = useRef<StoredConnection[]>([]);
  const connectionRef = useRef<StoredConnection | null>(null);
  /** host 插件上报的当前会话（用于前台通知的“当前会话不弹卡片”判断）。 */
  const currentSessionRef = useRef<{ host: string; sessionId: string } | null>(null);

  const refreshConnections = useCallback(async () => {
    const stored = await loadConnections();
    setConnections(stored);
    return stored;
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadConnections()
      .then((stored) => {
        if (cancelled) return;
        setConnections(stored);
        setRoute(stored.length > 0 ? 'home' : 'pairing');
      })
      .catch(() => {
        if (cancelled) return;
        setConnections([]);
        setRoute('pairing');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    routeRef.current = route;
    // 离开 WebView（Home/设置/设备页）后不再把旧会话当成「当前正在查看」：
    // 否则前台推送会被通知 handler 误判为当前会话而抑制掉系统横幅。
    // 重新进入主机时由 WebViewScreen 把缓存的当前会话补报回来。
    if (route !== 'webview') {
      currentSessionRef.current = null;
      setForegroundCurrentSession(null);
    }
  }, [route]);

  useEffect(() => {
    connectionsRef.current = connections;
  }, [connections]);

  useEffect(() => {
    connectionRef.current = connection;
    // 切换主机后缓存的当前会话不再属于这个连接。
    currentSessionRef.current = null;
    setForegroundCurrentSession(null);
  }, [connection]);

  /**
   * 点击推送（系统横幅或应用内卡片）→ 切到对应已配对主机并打开对应会话。
   * `host` 与 App 的 connection.host 同格式；找不到目标主机时保持当前主机。
   */
  const openNotificationSession = useCallback((data: { sessionId?: string; host?: string }): boolean => {
    const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
    if (!sessionId) return false;
    const list = connectionsRef.current;
    const host = typeof data.host === 'string' ? data.host : '';
    let target: StoredConnection | null = null;
    if (host) {
      target = list.find((item) => item.host === host) ?? null;
      if (!target && connectionRef.current?.host === host) target = connectionRef.current ?? null;
      // 单主机时允许 host 文本格式差异（例如端口展示方式不同）兜底。
      if (!target && list.length === 1) target = list[0] ?? null;
    } else {
      target = connectionRef.current ?? (list.length === 1 ? list[0] ?? null : null);
    }
    if (!target) return false;
    setConnection(target);
    setRoute('webview');
    setOpenSessionRequest({ sessionId, nonce: Date.now() });
    return true;
  }, []);

  const handleNotificationResponse = useCallback((response: Notifications.NotificationResponse) => {
    const notificationId = response.notification.request.identifier;
    if (notificationId && lastHandledNotificationIdRef.current === notificationId) return;
    const opened = openNotificationSession(notificationDataOf(response.notification.request.content.data));
    // 连接列表可能还没加载（冷启动时监听会先触发）：先不标记，交给
    // getLastNotificationResponseAsync 在加载完成后补处理。
    if (opened) {
      if (notificationId) lastHandledNotificationIdRef.current = notificationId;
      // 清掉原生记录的“最后一次点击”，避免下次正常冷启动时重复跳转。
      void Notifications.clearLastNotificationResponseAsync().catch(() => {});
    }
  }, [openNotificationSession]);

  const handlePaired = useCallback((paired: StoredConnection) => {
    setConnection(paired);
    void refreshConnections();
    setRoute('webview');
  }, [refreshConnections]);

  const handleOpenConnection = useCallback((target: StoredConnection) => {
    setConnection(target);
    setRoute('webview');
  }, []);

  const handleOpenDevices = useCallback((target: StoredConnection) => {
    setConnection(target);
    setRoute('devices');
  }, []);

  // POC：通知权限/推送 token 注册；原生 mTLS 客户端未实现时只打日志，不打断主流程。
  useEffect(() => {
    configureNotificationHandler();
  }, []);

  // 应用内通知开关（前台推送的展示方式）；默认开启。
  useEffect(() => {
    let cancelled = false;
    isInAppNotificationsEnabled()
      .then((enabled) => {
        if (cancelled) return;
        setInAppEnabled(enabled);
        inAppEnabledRef.current = enabled;
        setForegroundInAppEnabled(enabled);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // 前台推送：系统横幅已被 handler 抑制，这里转成 App 内卡片。
  // 如果推送属于当前正在查看的会话，则完全不再提示（DSH 页面本身会更新）。
  useEffect(() => {
    const subscription = Notifications.addNotificationReceivedListener((notification) => {
      if (!inAppEnabledRef.current) return;
      if (AppState.currentState !== 'active') return;
      if (lockedRef.current) return;
      const content = notification.request.content;
      const data = notificationDataOf(content.data);
      const current = currentSessionRef.current;
      if (data.sessionId && current && current.sessionId === data.sessionId
        && (!data.host || !current.host || data.host === current.host)
        && routeRef.current === 'webview') {
        return;
      }
      setInAppMessage({
        id: notification.request.identifier,
        title: content.title ?? 'DSH Remote',
        body: content.body ?? '',
        ...data,
      });
    });
    return () => subscription.remove();
  }, []);

  // 应用内通知卡片 5 秒自动消失；锁屏时立即清除，避免内容泄露。
  useEffect(() => {
    if (!inAppMessage) return undefined;
    const timer = setTimeout(() => setInAppMessage(null), 5000);
    return () => clearTimeout(timer);
  }, [inAppMessage]);

  useEffect(() => {
    lockedRef.current = locked;
    // 锁屏时通知 handler 需要知道：LockScreen 在前台时按后台处理（允许系统通知）。
    setForegroundLocked(locked);
    if (locked) {
      setInAppMessage(null);
      setExternalPage(null);
    }
  }, [locked]);

  // App 锁：启动/回前台时按设置要求生物识别；WebView 常驻但被 LockScreen 覆盖。
  useEffect(() => {
    let cancelled = false;
    isAppLockEnabled().then((enabled) => {
      if (cancelled) return;
      lockEnabledRef.current = enabled;
      if (enabled) setLocked(true);
    });
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && lockEnabledRef.current) setLocked(true);
    });
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, []);

  // 设置页可能改变 App 锁开关：回到 active 时刷新一次。
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      isAppLockEnabled().then((enabled) => {
        lockEnabledRef.current = enabled;
        if (!enabled) setLocked(false);
      }).catch(() => {});
    });
    return () => subscription.remove();
  }, []);

  // Android 返回键：内嵌外链页打开时先回 DSH（iOS 用内嵌页左上返回）。
  useEffect(() => {
    if (!externalPage) return undefined;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      setExternalPage(null);
      return true;
    });
    return () => subscription.remove();
  }, [externalPage]);

  useEffect(() => {
    if (!connection) return undefined;
    let cancelled = false;
    enablePushForConnection(connection)
      .then((result) => {
        if (cancelled) return;
        const environment = result.environment ? ` (apns/${result.environment})` : ' (apns)';
        console.log(`[dsh-remote] push ${result.ok ? `registered${environment}` : `unavailable: ${result.reason ?? 'unknown'}`}`);
      })
      .catch((error: unknown) => {
        if (!cancelled) console.log(`[dsh-remote] push setup failed: ${String(error)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [connection]);

  // 系统通知点击：从 payload 的 body 字典取出 host/sessionId，切主机并打开对应会话。
  useEffect(() => {
    const subscription = Notifications.addNotificationResponseReceivedListener(handleNotificationResponse);
    return () => subscription.remove();
  }, [handleNotificationResponse]);

  // 冷启动：App 被通知拉起时，等连接列表加载完再处理“最后一次通知点击”。
  useEffect(() => {
    if (route === 'loading' || coldStartHandledRef.current) return;
    coldStartHandledRef.current = true;
    void (async () => {
      try {
        const response = await Notifications.getLastNotificationResponseAsync();
        if (!response) return;
        await Notifications.clearLastNotificationResponseAsync();
        handleNotificationResponse(response);
      } catch {
        // 冷启动跳转失败不应影响正常进入 App。
      }
    })();
  }, [route, handleNotificationResponse]);

  const handleOpenSettings = useCallback(() => {
    setSettingsReturnRoute(route === 'webview' ? 'webview' : 'home');
    setRoute('settings');
  }, [route]);

  const handleToggleInAppNotifications = useCallback((enabled: boolean) => {
    setInAppEnabled(enabled);
    inAppEnabledRef.current = enabled;
    setForegroundInAppEnabled(enabled);
    void setInAppNotificationsEnabled(enabled);
  }, []);

  const handleCacheCleared = useCallback(() => {
    setWebViewReloadToken((token) => token + 1);
  }, []);

  const handleOpenSessionHandled = useCallback((nonce: number) => {
    setOpenSessionRequest((current) => (current && current.nonce === nonce ? null : current));
  }, []);

  const handleCurrentSession = useCallback((info: { host: string; sessionId: string } | null) => {
    currentSessionRef.current = info;
    setForegroundCurrentSession(info);
  }, []);

  const handleCloseWebView = useCallback(() => {
    // 左上角返回 → 主机列表（支持多台已配对主机）。
    setRoute('home');
  }, []);

  /**
   * DSH 页面里的外链：在 App 内嵌浏览器打开（对应桌面 DSH 内嵌平台页的体验）。
   * WebViewScreen 已校验 http(s) 且排除隧道主机，这里再兜底一次协议。
   */
  const handleOpenExternal = useCallback((externalUrl: string) => {
    if (!/^https?:\/\//i.test(externalUrl)) return;
    setExternalPage({ url: externalUrl });
  }, []);

  const handleRepair = useCallback(async () => {
    if (connection) {
      await removeConnection(connection);
      await clearCertificate(connection.hostFingerprint);
    }
    const remaining = await refreshConnections();
    setConnection(null);
    setRoute(remaining.length > 0 ? 'home' : 'pairing');
  }, [connection, refreshConnections]);

  const renderRoute = () => {
    switch (route) {
      case 'loading':
        return (
          <View style={styles.loadingScreen}>
            <ActivityIndicator color={colors.accent} size="large" />
            <Text style={styles.loadingText}>正在读取本机配对信息…</Text>
          </View>
        );
      case 'home':
        return (
          <HomeScreen
            connections={connections}
            onOpen={handleOpenConnection}
            onOpenDevices={handleOpenDevices}
            onPairNew={() => setRoute('pairing')}
            onOpenSettings={handleOpenSettings}
          />
        );
      case 'pairing':
        return (
          <PairingScreen
            onPaired={handlePaired}
            {...(connections.length > 0 ? { onCancel: () => setRoute('home') } : {})}
          />
        );
      case 'webview':
        // WebView is rendered as a persistent layer below; nothing to overlay.
        return null;
      case 'settings':
        return (
          <SettingsScreen
            connection={connection}
            inAppNotificationsEnabled={inAppEnabled}
            onToggleInAppNotifications={handleToggleInAppNotifications}
            onCacheCleared={handleCacheCleared}
            onOpenDevices={() => setRoute('devices')}
            onClose={() => setRoute(settingsReturnRoute)}
          />
        );
      case 'devices':
        return connection ? (
          <DevicesScreen
            connection={connection}
            onClose={() => setRoute('home')}
            onRepair={handleRepair}
            onConnectionUpdated={setConnection}
          />
        ) : (
          <HomeScreen
            connections={connections}
            onOpen={handleOpenConnection}
            onOpenDevices={handleOpenDevices}
            onPairNew={() => setRoute('pairing')}
            onOpenSettings={handleOpenSettings}
          />
        );
    }
  };

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <View style={styles.container}>
        {/*
         * Keep the WKWebView mounted while the user is on Home/Devices/pairing.
         * Returning to a host then only reveals the already-loaded page instead
         * of rebuilding the WebView and re-fetching the whole DSH bundle.
         */}
        {connection ? (
          <View
            style={styles.webViewLayer}
            pointerEvents={route === 'webview' && !locked ? 'auto' : 'none'}
            accessibilityElementsHidden={route !== 'webview' || locked}
            importantForAccessibility={route === 'webview' && !locked ? 'auto' : 'no-hide-descendants'}
          >
            <WebViewScreen
              key={connection.host}
              connection={connection}
              onClose={handleCloseWebView}
              onOpenSettings={handleOpenSettings}
              reloadToken={webViewReloadToken}
              isVisible={route === 'webview' && !locked}
              openSessionRequest={openSessionRequest}
              onOpenSessionHandled={handleOpenSessionHandled}
              onCurrentSession={handleCurrentSession}
              onOpenExternal={handleOpenExternal}
            />
          </View>
        ) : null}
        {!locked ? (
          <InAppNotificationBanner
            notification={inAppMessage}
            onDismiss={() => setInAppMessage(null)}
            onPress={inAppMessage ? () => {
              const message = inAppMessage;
              setInAppMessage(null);
              if (message.sessionId) {
                openNotificationSession({ sessionId: message.sessionId, host: message.host });
              } else if (connection) {
                setRoute('webview');
              }
            } : undefined}
          />
        ) : null}
        {locked ? <LockScreen onUnlocked={() => setLocked(false)} /> : route !== 'webview' ? renderRoute() : null}
        {/* App 内嵌浏览器：盖在主机 WebView 之上；锁屏时不渲染（上面的 locked 分支优先）。 */}
        {!locked && externalPage ? (
          <View style={styles.externalPageLayer}>
            <ExternalPageScreen
              key={externalPage.url}
              url={externalPage.url}
              onClose={() => setExternalPage(null)}
            />
          </View>
        ) : null}
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  webViewLayer: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  externalPageLayer: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 1200,
  },
  loadingScreen: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
  },
  loadingText: {
    ...typography.subtitle,
  },
});
