/**
 * DSH Remote — app shell / minimal navigation state machine（群体服务版）.
 *
 *   loading ──(stored connections?)──┬─ yes → home ⇄ webview | devices | settings
 *                                    └─ no  → pairing → webview
 *
 * No navigation library on purpose: a small route union keeps the dependency
 * surface (and app review surface) minimal.
 *
 * 本 App 只有群体版（A 模式，token 鉴权）：
 *   - 设备身份 = P-256 设备密钥（Secure Enclave / AndroidKeyStore）+ relay 短时 token；
 *   - 没有设备证书 / mTLS / 原生 mTLS WebView（classic 模式已删除）；
 *   - iOS APNs 推送（0.1.8+）：进入主机拿到会话 token 后登记 APNs device token；
 *     点系统通知按 payload 的 host/hostId 打开对应主机（self 模式可带 sessionId 跳会话）；
 *     设置页「推送」卡可开关/重新注册/查看状态（`src/lib/push.ts`）。
 *   - 「重启主机 DSH」是群体版功能：进入主机后按 Host 组件开关在顶栏显示 ⏻
 *     （见 `WebViewScreen`，用带会话 cookie 的请求调 host 内部接口）。
 *   - App 锁（0.1.3 语义）：设置页的全局锁**只负责冷启动解锁**；每台主机的
 *     「打开此连接时要求面容」是连接记录里的独立开关（`requireBiometricOnOpen`），
 *     只有全局锁开启且该主机开关开启时，打开连接才要求一次 Face ID / Touch ID。
 *
 * 配对记录只存在 SecureStore/Keychain（见 `src/lib/store.ts`），设备私钥不出原生安全区。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, BackHandler, StyleSheet, Text, View } from 'react-native';
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
  isSameConnection,
  loadConnections,
  removeConnection,
  setConnectionRequireBiometricOnOpen,
  type StoredConnection,
} from './src/lib/store';
import { onGroupSessionAvailable } from './src/lib/group';
import { configureNotificationHandler, registerPushForConnection } from './src/lib/push';
import { clearGroupDeviceKey } from './modules/dsh-mtls/src';
import { colors, spacing, typography } from './src/theme';

type Route = 'loading' | 'home' | 'pairing' | 'webview' | 'devices' | 'settings';

/** APNs payload 的 `body` 字典（relay/host 附带；expo-notifications 映射为 content.data）。 */
interface NotificationData {
  host?: string;
  hostId?: string;
  sessionId?: string;
}

/**
 * 从通知 payload 取跳转字段。
 *
 * host-plugin 的 APNs payload 是 `{aps:{...}, body:{kind,host,sessionId}}`；
 * expo-notifications iOS 把 APNs `userInfo["body"]` 映射成 `content.data`，
 * 所以正常形态是 data 本身就是 `{kind,host,sessionId}`；这里同时兼容
 * 字段直接平铺或嵌在 `data.body` 里的实现。
 */
function notificationDataOf(data: unknown): NotificationData {
  if (!data || typeof data !== 'object') return {};
  const record = data as Record<string, unknown>;
  const nested = record.body && typeof record.body === 'object'
    ? record.body as Record<string, unknown>
    : record;
  const pick = (key: string): string | undefined => {
    const value = nested[key] ?? record[key];
    return typeof value === 'string' && value !== '' ? value : undefined;
  };
  return {
    ...(pick('host') ? { host: pick('host') } : {}),
    ...(pick('hostId') ? { hostId: pick('hostId') } : {}),
    ...(pick('sessionId') ? { sessionId: pick('sessionId') } : {}),
  };
}

/** 主机地址归一化：小写、去掉可能的端口（连接记录的 host 与端口分开存）。 */
function normalizedHost(host: string): string {
  const lower = host.trim().toLowerCase();
  const withoutPort = lower.includes(':') && !lower.startsWith('[')
    ? lower.slice(0, lower.indexOf(':'))
    : lower;
  return withoutPort;
}

/** 按通知 payload 的 host/hostId 匹配已配对连接；匹配不到返回 null。 */
function matchNotificationConnection(
  connections: StoredConnection[],
  data: NotificationData,
): StoredConnection | null {
  const host = data.host ?? '';
  const hostId = data.hostId ?? '';
  if (host) {
    const exact = connections.find((item) => item.host.trim().toLowerCase() === host.trim().toLowerCase());
    if (exact) return exact;
    const hostname = normalizedHost(host);
    const byHostname = connections.find((item) => normalizedHost(item.host) === hostname);
    if (byHostname) return byHostname;
  }
  if (hostId) {
    const byHostId = connections.find((item) => item.hostId === hostId);
    if (byHostId) return byHostId;
  }
  return null;
}

export default function App() {
  const [route, setRoute] = useState<Route>('loading');
  const [connections, setConnections] = useState<StoredConnection[]>([]);
  const [connection, setConnection] = useState<StoredConnection | null>(null);
  const [locked, setLocked] = useState(false);
  const lockEnabledRef = useRef(false);
  /**
   * 「设备与安全」（单台主机的连接设置）的返回位置：
   *  - 从主机列表卡片进入 → 回列表；
   *  - 进入主机后从顶栏 ⚙ 进入 → 回该主机页面（WebView 常驻，不重新加载）。
   */
  const [devicesReturnRoute, setDevicesReturnRoute] = useState<'home' | 'webview'>('home');
  const [webViewReloadToken, setWebViewReloadToken] = useState(0);
  /** App 内嵌浏览器（DSH 页面里的外链，如平台查询用量/充值）；null = 未打开。 */
  const [externalPage, setExternalPage] = useState<{ url: string } | null>(null);
  /**
   * 通知点击后要打开的会话（self 模式 payload 的 sessionId）。
   * 由 WebViewScreen 在页面加载就绪后注入
   * `window.__DSH_REMOTE_OPEN_SESSION__(sessionId)`，注入成功后回调清空。
   */
  const [openSessionRequest, setOpenSessionRequest] = useState<{ sessionId: string; nonce: number } | null>(null);
  /** 通知点击后是否已处理过（避免 listener 与冷启动 API 重复处理同一次点击）。 */
  const lastHandledNotificationIdRef = useRef<string | null>(null);
  /** 冷启动「最后一次通知点击」是否已处理（连接列表加载完成后处理一次）。 */
  const coldStartHandledRef = useRef(false);
  /** 供异步通知回调读取的最新导航/连接状态。 */
  const routeRef = useRef<Route>('loading');
  const connectionRef = useRef<StoredConnection | null>(null);
  const connectionsRef = useRef<StoredConnection[]>([]);

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
  }, [route]);

  useEffect(() => {
    connectionRef.current = connection;
  }, [connection]);

  useEffect(() => {
    connectionsRef.current = connections;
  }, [connections]);

  /**
   * App 锁（全局）：**只负责冷启动解锁**（设置页开关）。
   *
   * 触发点（刻意不监听 AppState）：
   *   1. 冷启动：读取设置后若开启则 setLocked(true)；
   *   2. 打开**单独开启了「打开此连接时要求面容」**的主机连接时，
   *      `handleOpenConnection` / `handlePaired` 按该连接的开关 setLocked(true)
   *      （`requireBiometricOnOpen` 默认 false，所以默认打开连接不需要面容）。
   *
   * 注意：**不要**在 AppState 变 active 时重新上锁 —— 那是「进入 App 后每次同步信息 /
   * 心跳都弹面容」的根因：Face ID 弹窗收起时系统会回调 active，又把界面锁回去，
   * 形成反复弹窗。解锁成功后也不会再被系统回调重新上锁。
   */
  useEffect(() => {
    let cancelled = false;
    isAppLockEnabled().then((enabled) => {
      if (cancelled) return;
      lockEnabledRef.current = enabled;
      if (enabled) setLocked(true);
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  /** 设置页切换全局 App 锁后同步内存状态（开关本身存在 SecureStore）。 */
  const handleAppLockChanged = useCallback((enabled: boolean) => {
    lockEnabledRef.current = enabled;
    if (!enabled) setLocked(false);
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

  /**
   * 打开一台主机时是否要面容：必须同时满足
   *   ① 全局 App 锁开启（设置页，负责冷启动解锁）；
   *   ② 这台主机自己开了「打开此连接时要求面容」（默认关闭）。
   * 全局锁关闭时单连接开关不生效。
   */
  const shouldLockOnOpen = useCallback(
    (target: StoredConnection): boolean => lockEnabledRef.current && target.requireBiometricOnOpen === true,
    [],
  );

  /**
   * 点系统通知：按 payload 的 host/hostId 匹配已配对连接 → 打开该主机；
   * self 模式带 sessionId 时，进入后由 WebViewScreen 注入
   * `window.__DSH_REMOTE_OPEN_SESSION__(sessionId)` 直达会话（official 模式无 sessionId）。
   *
   * 连接列表可能尚未加载完（冷启动时 listener 先触发）：此时不标记已处理，
   * 交给下方的 `getLastNotificationResponseAsync` 在路由就绪后补处理。
   */
  const handleNotificationResponse = useCallback(
    (response: Notifications.NotificationResponse) => {
      const notificationId = response.notification.request.identifier;
      if (notificationId && lastHandledNotificationIdRef.current === notificationId) return;
      const data = notificationDataOf(response.notification.request.content.data);
      const target = matchNotificationConnection(connectionsRef.current, data);
      if (!target) {
        if (routeRef.current === 'loading') return;
        if (notificationId) lastHandledNotificationIdRef.current = notificationId;
        void Notifications.clearLastNotificationResponseAsync().catch(() => {});
        Alert.alert(
          '无法打开通知对应的主机',
          data.host || data.hostId
            ? '这台主机不在本机已配对列表中（可能已解除配对）。请回到主机列表重新扫码配对。'
            : '通知里没有携带可识别的主机信息，请手动打开主机。',
        );
        return;
      }
      if (shouldLockOnOpen(target)) setLocked(true);
      setConnection(target);
      setRoute('webview');
      setOpenSessionRequest(
        data.sessionId ? { sessionId: data.sessionId, nonce: Date.now() } : null,
      );
      if (notificationId) lastHandledNotificationIdRef.current = notificationId;
      void Notifications.clearLastNotificationResponseAsync().catch(() => {});
      // 打开通知后顺带（重新）登记一次推送 token：relay 重启会清空 token 表，
      // 用户从通知进入主机的路径也要能自动恢复推送。
      void registerPushForConnection(target, { force: true });
    },
    [shouldLockOnOpen],
  );

  useEffect(() => {
    configureNotificationHandler();
  }, []);

  // 系统通知点击（App 在前台/后台运行时的常规路径）。
  useEffect(() => {
    const subscription = Notifications.addNotificationResponseReceivedListener(handleNotificationResponse);
    return () => subscription.remove();
  }, [handleNotificationResponse]);

  // 冷启动：App 被通知拉起时，等连接列表加载完再处理「最后一次通知点击」。
  useEffect(() => {
    if (route === 'loading' || coldStartHandledRef.current) return;
    coldStartHandledRef.current = true;
    void (async () => {
      try {
        const response = await Notifications.getLastNotificationResponseAsync();
        if (!response) return;
        await Notifications.clearLastNotificationResponseAsync().catch(() => {});
        handleNotificationResponse(response);
      } catch {
        // 冷启动跳转失败不应影响正常进入 App。
      }
    })();
  }, [route, handleNotificationResponse]);

  // 回到前台：对当前连接重试推送登记（失败静默，状态在设置页可见；内部自动节流）。
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      const current = connectionRef.current;
      if (!current) return;
      void registerPushForConnection(current);
    });
    return () => subscription.remove();
  }, []);

  // 群体版会话 token 可用/刷新时（事件只含连接标识，不含 token）→ 对当前主机登记推送。
  useEffect(() => {
    return onGroupSessionAvailable((event) => {
      const current = connectionRef.current;
      if (!current) return;
      if (current.host !== event.host || current.port !== event.port || current.deviceId !== event.deviceId) {
        return;
      }
      void registerPushForConnection(current);
    });
  }, []);

  /** 配对成功 → 直接进入主机；只有该主机开了「打开此连接时要求面容」才解锁。 */
  const handlePaired = useCallback((paired: StoredConnection) => {
    if (shouldLockOnOpen(paired)) setLocked(true);
    setConnection(paired);
    void refreshConnections();
    setRoute('webview');
    // 进入主机后登记推送（拿到会话 token 后 group.ts 还会再触发一次非强制登记）。
    void registerPushForConnection(paired, { force: true, requestPermission: true });
  }, [refreshConnections, shouldLockOnOpen]);

  /** 从主机列表打开一台主机：仅当该连接单独开启「打开此连接时要求面容」时触发面容。 */
  const handleOpenConnection = useCallback((target: StoredConnection) => {
    if (shouldLockOnOpen(target)) setLocked(true);
    setConnection(target);
    setRoute('webview');
    void registerPushForConnection(target, { force: true, requestPermission: true });
  }, [shouldLockOnOpen]);

  /** 主机列表卡片上的 ⚙：打开这台主机的连接设置，返回时回到列表。 */
  const handleOpenDevices = useCallback((target: StoredConnection) => {
    setDevicesReturnRoute('home');
    setConnection(target);
    setRoute('devices');
  }, []);

  /**
   * 进入主机后顶栏的 ⚙：打开**这台主机**的连接设置（设备与安全：主机信息 /
   * 打开此连接时要求面容 / 解除本机配对），返回时回到当前主机页面。
   *
   * 顶栏不再打开 App 的「系统设置」：系统设置是 App 级配置（版本 / App 锁 /
   * 清理缓存），只从主机列表（外面）的 ⚙ 进入。
   */
  const handleOpenConnectionSettings = useCallback(() => {
    setDevicesReturnRoute('webview');
    setRoute('devices');
  }, []);

  /** 主机列表右上角的 ⚙：App 系统设置（版本 / App 锁 / 缓存）。 */
  const handleOpenSettings = useCallback(() => {
    setRoute('settings');
  }, []);

  const handleCacheCleared = useCallback(() => {
    setWebViewReloadToken((token) => token + 1);
  }, []);

  /** WebViewScreen 注入 `__DSH_REMOTE_OPEN_SESSION__` 成功后清空待处理请求（避免重复注入）。 */
  const handleOpenSessionHandled = useCallback((nonce: number) => {
    setOpenSessionRequest((current) => (current !== null && current.nonce === nonce ? null : current));
  }, []);

  /**
   * 设备与安全页：切换某台主机的「打开此连接时要求面容」开关。
   * 持久化到连接记录，并同步 App 内的连接列表（下次打开该主机时按新值判断）。
   * 仅在全局 App 锁开启时生效（设备页负责在全局关闭时禁用开关并提示）。
   */
  const handleRequireBiometricOnOpenChanged = useCallback(async (
    target: StoredConnection,
    enabled: boolean,
  ) => {
    const updated = await setConnectionRequireBiometricOnOpen(target, enabled);
    if (updated) {
      setConnection((prev) => (prev !== null && isSameConnection(prev, updated) ? updated : prev));
    }
    await refreshConnections();
  }, [refreshConnections]);

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

  /**
   * 删除一台主机的本机记录（不进入配对流程）：
   * 清除 SecureStore 里的配对信息和 Keychain/Keystore 里的群体版设备密钥。
   * 主机侧记录不会被远端删除，需要在主机「远程访问」里单独撤销（主机已撤销时
   * 这里只是清理本地残留，下次进入会提示重新配对）。
   */
  const handleDeleteConnection = useCallback(async (target: StoredConnection) => {
    await removeConnection(target);
    if (target.deviceKeyLabel) {
      try {
        await clearGroupDeviceKey(target.deviceKeyLabel);
      } catch {
        // 原生模块未链接时忽略：设备私钥仍留在 Keychain/Keystore，但已无主机可用。
      }
    }
    const remaining = await refreshConnections();
    const wasCurrent = connectionRef.current !== null && isSameConnection(connectionRef.current, target);
    if (wasCurrent) setConnection(null);
    if (remaining.length === 0) setRoute('pairing');
    else if (wasCurrent || routeRef.current === 'devices') setRoute('home');
  }, [refreshConnections]);

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
            onDelete={handleDeleteConnection}
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
            onCacheCleared={handleCacheCleared}
            onAppLockChanged={handleAppLockChanged}
            pushTarget={connection}
            onClose={() => setRoute('home')}
          />
        );
      case 'devices':
        return connection ? (
          <DevicesScreen
            connection={connection}
            onClose={() => setRoute(devicesReturnRoute)}
            onDeleteLocal={() => handleDeleteConnection(connection)}
            onRequireBiometricChanged={(enabled) => handleRequireBiometricOnOpenChanged(connection, enabled)}
          />
        ) : (
          <HomeScreen
            connections={connections}
            onOpen={handleOpenConnection}
            onOpenDevices={handleOpenDevices}
            onDelete={handleDeleteConnection}
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
         * Keep the WebView mounted while the user is on Home/Devices/pairing.
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
              key={`${connection.host}:${connection.port}`}
              connection={connection}
              onClose={handleCloseWebView}
              onOpenConnectionSettings={handleOpenConnectionSettings}
              reloadToken={webViewReloadToken}
              isVisible={route === 'webview' && !locked}
              onOpenExternal={handleOpenExternal}
              openSessionRequest={openSessionRequest}
              onOpenSessionHandled={handleOpenSessionHandled}
            />
          </View>
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
