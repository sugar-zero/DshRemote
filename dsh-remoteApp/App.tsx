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

import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { PairingScreen } from './src/screens/PairingScreen';
import { WebViewScreen } from './src/screens/WebViewScreen';
import { DevicesScreen } from './src/screens/DevicesScreen';
import { clearAll, loadConnection, type StoredConnection } from './src/lib/store';
import { colors, spacing, typography } from './src/theme';

type Route = 'loading' | 'pairing' | 'webview' | 'devices';

export default function App() {
  const [route, setRoute] = useState<Route>('loading');
  const [connection, setConnection] = useState<StoredConnection | null>(null);

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

  const handleCloseWebView = useCallback(() => {
    // The shell has no home screen: "back" from the WebView returns to pairing
    // only after an explicit unpair. Keeping the WebView mounted is intentional.
    setRoute(connection ? 'webview' : 'pairing');
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
      {renderRoute()}
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
