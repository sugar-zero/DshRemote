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
import { clearAll, loadConnection, type StoredConnection } from './src/lib/store';
import { configureNotificationHandler, enablePushForConnection } from './src/lib/notifications';
import { colors, spacing, typography } from './src/theme';

type Route = 'loading' | 'pairing' | 'webview' | 'devices';

export default function App() {
  const [route, setRoute] = useState<Route>('loading');
  const [connection, setConnection] = useState<StoredConnection | null>(null);
  const [locked, setLocked] = useState(false);
  const lockEnabledRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    loadConnection()
      .then((stored) => {
        if (cancelled) return;
        setConnection(stored);
        setRoute(stored ? 'webview' : 'pairing');
      })
      .catch(() => {
        if (cancelled) return;
        setConnection(null);
        setRoute('pairing');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handlePaired = useCallback((paired: StoredConnection) => {
    setConnection(paired);
    setRoute('webview');
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
    // 返回 → 设备页（可查看状态 / 清除旧配对 / 重新配对）。
    setRoute(connection ? 'devices' : 'pairing');
  }, [connection]);

  const handleRepair = useCallback(async () => {
    await clearAll();
    setConnection(null);
    setRoute('pairing');
  }, []);

  const renderRoute = () => {
    switch (route) {
      case 'loading':
        return (
          <View style={styles.loadingScreen}>
            <ActivityIndicator color={colors.accent} size="large" />
            <Text style={styles.loadingText}>正在读取本机配对信息…</Text>
          </View>
        );
      case 'pairing':
        return <PairingScreen onPaired={handlePaired} />;
      case 'webview':
        return connection ? (
          <WebViewScreen
            connection={connection}
            onClose={handleCloseWebView}
            onOpenDevices={() => setRoute('devices')}
          />
        ) : (
          <PairingScreen onPaired={handlePaired} />
        );
      case 'devices':
        return connection ? (
          <DevicesScreen
            connection={connection}
            onClose={() => setRoute('webview')}
            onRepair={handleRepair}
            onConnectionUpdated={setConnection}
          />
        ) : (
          <PairingScreen onPaired={handlePaired} />
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
