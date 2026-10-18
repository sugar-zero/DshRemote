/**
 * LockScreen — App 锁门禁（Face ID / Touch ID / 指纹）。
 */
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { authenticateBiometric, getBiometricAvailability } from '../lib/appLock';
import { colors, radii, sharedStyles, spacing, typography } from '../theme';

interface LockScreenProps {
  onUnlocked: () => void;
}

export function LockScreen({ onUnlocked }: LockScreenProps) {
  const insets = useSafeAreaInsets();
  const [label, setLabel] = useState('生物识别');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unlock = useCallback(async () => {
    setBusy(true);
    setError(null);
    const ok = await authenticateBiometric('解锁 DSH Remote');
    setBusy(false);
    if (ok) onUnlocked();
    else setError('未通过验证，可重试');
  }, [onUnlocked]);

  useEffect(() => {
    let cancelled = false;
    getBiometricAvailability().then((availability) => {
      if (!cancelled) setLabel(availability.label);
    });
    void unlock();
    return () => { cancelled = true; };
  }, [unlock]);

  return (
    <View style={[styles.root, { paddingTop: insets.top + spacing.xl, paddingBottom: insets.bottom + spacing.xl }]}>
      <Text style={styles.lockGlyph}>🔒</Text>
      <Text style={styles.title}>DSH Remote 已锁定</Text>
      <Text style={styles.subtitle}>使用 {label} 解锁后才能访问远程会话与审批</Text>
      {busy ? (
        <ActivityIndicator color={colors.accent} style={styles.spinner} />
      ) : (
        <TouchableOpacity style={sharedStyles.primaryButton} onPress={() => { void unlock(); }}>
          <Text style={sharedStyles.primaryButtonText}>使用 {label} 解锁</Text>
        </TouchableOpacity>
      )}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  lockGlyph: { fontSize: 48, marginBottom: spacing.lg },
  title: { ...typography.title, marginBottom: spacing.sm },
  subtitle: { ...typography.subtitle, textAlign: 'center', marginBottom: spacing.xl },
  spinner: { marginVertical: spacing.lg },
  error: { fontSize: 13, color: colors.danger, marginTop: spacing.md },
});
