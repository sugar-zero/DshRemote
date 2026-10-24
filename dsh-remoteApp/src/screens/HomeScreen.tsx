/**
 * HomeScreen — 已配对主机列表（多设备入口）。
 *
 * 导航约定：
 *   Home → 点主机卡片 → WebView（返回键回到 Home）
 *   Home → 齿轮 → Devices（返回/清除配对后回 Home）
 *   Home → 配对新主机 → PairingScreen
 */
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import type { StoredConnection } from '../lib/store';
import { colors, radii, sharedStyles, spacing, typography } from '../theme';

interface HomeScreenProps {
  connections: StoredConnection[];
  onOpen: (connection: StoredConnection) => void;
  onOpenDevices: (connection: StoredConnection) => void;
  onPairNew: () => void;
}

function formatPairedAt(epochMs: number): string {
  try {
    return new Date(epochMs).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return '—';
  }
}

export function HomeScreen({ connections, onOpen, onOpenDevices, onPairNew }: HomeScreenProps) {
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.screen}>
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + spacing.lg, paddingBottom: insets.bottom + spacing.xl },
        ]}
      >
        <Text style={styles.title}>DSH Remote</Text>
        <Text style={styles.subtitle}>已配对的主机（{connections.length}）</Text>

        {connections.length === 0 ? (
          <View style={sharedStyles.card}>
            <Text style={styles.emptyTitle}>还没有配对主机</Text>
            <Text style={styles.hint}>在桌面 DSH 的「远程访问」里生成配对二维码，然后在这里扫码。</Text>
          </View>
        ) : (
          connections.map((connection) => (
            <View key={`${connection.host}-${connection.deviceId}`} style={styles.card}>
              <TouchableOpacity
                style={styles.mainRow}
                onPress={() => onOpen(connection)}
                accessibilityRole="button"
                accessibilityLabel={`打开 ${connection.hostName ?? connection.host}`}
              >
                <View style={styles.hostGlyph}>
                  <Text style={styles.hostGlyphText}>DSH</Text>
                </View>
                <View style={styles.textWrap}>
                  <Text style={styles.hostName} numberOfLines={1}>
                    {connection.hostName || connection.deviceName || connection.host}
                  </Text>
                  <Text style={styles.hostAddress} numberOfLines={1}>
                    {connection.host}
                  </Text>
                  <Text style={styles.meta}>
                    {connection.deviceName}
                    {connection.pairedAt ? ` · 配对于 ${formatPairedAt(connection.pairedAt)}` : ''}
                  </Text>
                </View>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.gearButton}
                onPress={() => onOpenDevices(connection)}
                accessibilityRole="button"
                accessibilityLabel="设备与安全"
              >
                <Text style={styles.gearText}>⚙︎</Text>
              </TouchableOpacity>
            </View>
          ))
        )}

        <TouchableOpacity style={[sharedStyles.primaryButton, styles.pairButton]} onPress={onPairNew}>
          <Text style={sharedStyles.primaryButtonText}>＋ 配对新主机</Text>
        </TouchableOpacity>

        <Text style={styles.footnote}>
          每台主机使用独立的设备证书（Secure Enclave/Keystore）；打开主机后，左上角返回会回到此列表。
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: spacing.lg, gap: spacing.md },
  title: { ...typography.title },
  subtitle: { ...typography.subtitle, marginBottom: spacing.sm },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  mainRow: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  hostGlyph: {
    width: 44,
    height: 44,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hostGlyphText: { color: colors.accent, fontWeight: '700', fontSize: 12 },
  textWrap: { flex: 1, gap: 2 },
  hostName: { color: colors.text, fontSize: 16, fontWeight: '600' },
  hostAddress: { color: colors.textMuted, fontSize: 12 },
  meta: { color: colors.textFaint, fontSize: 12 },
  gearButton: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  gearText: { color: colors.textMuted, fontSize: 22 },
  pairButton: { marginTop: spacing.sm },
  emptyTitle: { color: colors.text, fontSize: 16, fontWeight: '600', marginBottom: spacing.xs },
  hint: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  footnote: { ...typography.subtitle, fontSize: 12, marginTop: spacing.md },
});
