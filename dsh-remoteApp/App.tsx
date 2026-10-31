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
 *   - 没有 APNs 推送 / 应用内通知 / 通知设置（群体版暂不实现本机推送）；
 *   - 「重启主机 DSH」是群体版功能：进入主机后按 Host 组件开关在顶栏显示 ⏻
 *     （见 `WebViewScreen`，用带会话 cookie 的请求调 host 内部接口）。
 *   - App 锁（0.1.3 语义）：设置页的全局锁**只负责冷启动解锁**；每台主机的
 *     「打开此连接时要求面容」是连接记录里的独立开关（`requireBiometricOnOpen`），
 *     只有全局锁开启且该主机开关开启时，打开连接才要求一次 Face ID / Touch ID。
 *
 * 配对记录只存在 SecureStore/Keychain（见 `src/lib/store.ts`），设备私钥不出原生安全区。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
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
import { clearGroupDeviceKey } from './modules/dsh-mtls/src';
import { colors, spacing, typography } from './src/theme';

type Route = 'loading' | 'home' | 'pairing' | 'webview' | 'devices' | 'settings';

export default function App() {
  const [route, setRoute] = useState<Route>('loading');
  const [connections, setConnections] = useState<StoredConnection[]>([]);
  const [connection, setConnection] = useState<StoredConnection | null>(null);
  const [locked, setLocked] = useState(false);
  const lockEnabledRef = useRef(false);
  const [settingsReturnRoute, setSettingsReturnRoute] = useState<Route>('home');
  const [webViewReloadToken, setWebViewReloadToken] = useState(0);
  /** App 内嵌浏览器（DSH 页面里的外链，如平台查询用量/充值）；null = 未打开。 */
  const [externalPage, setExternalPage] = useState<{ url: string } | null>(null);
  /** 供异步回调读取的最新导航/连接状态。 */
  const routeRef = useRef<Route>('loading');
  const connectionRef = useRef<StoredConnection | null>(null);

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

  /** 配对成功 → 直接进入主机；只有该主机开了「打开此连接时要求面容」才解锁。 */
  const handlePaired = useCallback((paired: StoredConnection) => {
    if (shouldLockOnOpen(paired)) setLocked(true);
    setConnection(paired);
    void refreshConnections();
    setRoute('webview');
  }, [refreshConnections, shouldLockOnOpen]);

  /** 从主机列表打开一台主机：仅当该连接单独开启「打开此连接时要求面容」时触发面容。 */
  const handleOpenConnection = useCallback((target: StoredConnection) => {
    if (shouldLockOnOpen(target)) setLocked(true);
    setConnection(target);
    setRoute('webview');
  }, [shouldLockOnOpen]);

  const handleOpenDevices = useCallback((target: StoredConnection) => {
    setConnection(target);
    setRoute('devices');
  }, []);

  const handleOpenSettings = useCallback(() => {
    setSettingsReturnRoute(route === 'webview' ? 'webview' : 'home');
    setRoute('settings');
  }, [route]);

  const handleCacheCleared = useCallback(() => {
    setWebViewReloadToken((token) => token + 1);
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
            connection={connection}
            onCacheCleared={handleCacheCleared}
            onOpenDevices={() => setRoute('devices')}
            onAppLockChanged={handleAppLockChanged}
            onClose={() => setRoute(settingsReturnRoute)}
          />
        );
      case 'devices':
        return connection ? (
          <DevicesScreen
            connection={connection}
            onClose={() => setRoute('home')}
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
              onOpenSettings={handleOpenSettings}
              reloadToken={webViewReloadToken}
              isVisible={route === 'webview' && !locked}
              onOpenExternal={handleOpenExternal}
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
