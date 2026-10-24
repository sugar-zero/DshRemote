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
import { ActivityIndicator, AppState, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { PairingScreen } from './src/screens/PairingScreen';
import { LockScreen } from './src/screens/LockScreen';
import { isAppLockEnabled } from './src/lib/appLock';
import { WebViewScreen } from './src/screens/WebViewScreen';
import { DevicesScreen } from './src/screens/DevicesScreen';
import { HomeScreen } from './src/screens/HomeScreen';
import {
  clearCertificate,
  loadConnections,
  removeConnection,
  type StoredConnection,
} from './src/lib/store';
import { configureNotificationHandler, enablePushForConnection } from './src/lib/notifications';
import { colors, spacing, typography } from './src/theme';

type Route = 'loading' | 'home' | 'pairing' | 'webview' | 'devices';

export default function App() {
  const [route, setRoute] = useState<Route>('loading');
  const [connections, setConnections] = useState<StoredConnection[]>([]);
  const [connection, setConnection] = useState<StoredConnection | null>(null);
  const [locked, setLocked] = useState(false);
  const lockEnabledRef = useRef(false);

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

  useEffect(() => {
    if (!connection) return undefined;
    let cancelled = false;
    enablePushForConnection(connection)
      .then((result) => {
        if (cancelled) return;
        console.log(`[dsh-remote] push ${result.ok ? 'registered' : `unavailable: ${result.reason ?? 'unknown'}`}`);
      })
      .catch((error: unknown) => {
        if (!cancelled) console.log(`[dsh-remote] push setup failed: ${String(error)}`);
      });
    // 点击通知时当前设计保持 WebView 常驻；后续可在此聚焦并刷新。
    const subscription = Notifications.addNotificationResponseReceivedListener(() => {});
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, [connection]);

  const handleCloseWebView = useCallback(() => {
    // 左上角返回 → 主机列表（支持多台已配对主机）。
    setRoute('home');
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
        return connection ? (
          <WebViewScreen
            connection={connection}
            onClose={handleCloseWebView}
            onOpenDevices={() => setRoute('devices')}
          />
        ) : (
          <HomeScreen
            connections={connections}
            onOpen={handleOpenConnection}
            onOpenDevices={handleOpenDevices}
            onPairNew={() => setRoute('pairing')}
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
          />
        );
    }
  };

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      {locked ? <LockScreen onUnlocked={() => setLocked(false)} /> : renderRoute()}
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
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
