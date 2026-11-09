/**
 * HomeScreen — 已配对主机列表（多设备入口，群体服务版）。
 *
 * 导航约定：
 *   Home → 点主机卡片 → WebView（返回键回到 Home）
 *   Home → 右上角齿轮 → Settings（App 系统设置：版本 / App 锁 / 缓存）
 *   Home → 主机卡片上的齿轮 → Devices（该主机的连接设置；返回/解除配对后回 Home）
 *   Home → 配对新主机 → PairingScreen
 *
 * 记录管理：
 *   - 每台主机都有「删除」入口，只清本机配对记录与设备密钥（Keychain/Keystore），
 *     不需要走重新配对流程；
 *   - 主机侧撤销设备后，App 进入该主机会提示「设备已在主机侧失效」，删除本机记录后
 *     重新扫码配对即可（群体版没有 mTLS 后台同步，不再轮询主机状态）。
 */
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import type { StoredConnection } from '../lib/store';
import { colors, radii, sharedStyles, spacing, typography } from '../theme';

interface HomeScreenProps {
  connections: StoredConnection[];
  onOpen: (connection: StoredConnection) => void;
  onOpenDevices: (connection: StoredConnection) => void;
  /** 删除一台主机的本机配对记录与设备密钥（不进入配对流程）。 */
  onDelete: (connection: StoredConnection) => Promise<void> | void;
  onPairNew: () => void;
  onOpenSettings: () => void;
}

function displayHostName(connection: StoredConnection): string {
  return connection.hostName || '未命名主机';
}

function formatPairedAt(epochMs: number): string {
  try {
    return new Date(epochMs).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return '—';
  }
}

export function HomeScreen({
  connections,
  onOpen,
  onOpenDevices,
  onDelete,
  onPairNew,
  onOpenSettings,
}: HomeScreenProps) {
  const insets = useSafeAreaInsets();

  const confirmDelete = (connection: StoredConnection) => {
    const name = displayHostName(connection);
    Alert.alert(
      '删除主机记录',
      `将删除本机保存的「${name}」配对信息。主机上的设备记录不会被删除；删除后需重新扫码配对。`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: () => {
            void onDelete(connection);
          },
        },
      ],
    );
  };

  return (
    <View style={styles.screen}>
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + spacing.lg, paddingBottom: insets.bottom + spacing.xl },
        ]}
      >
        <View style={styles.titleRow}>
          <Text style={styles.title}>DSH Remote</Text>
          <TouchableOpacity
            style={styles.settingsButton}
            onPress={onOpenSettings}
            accessibilityRole="button"
            accessibilityLabel="设置"
          >
            <Text style={styles.settingsGlyph}>⚙︎</Text>
          </TouchableOpacity>
        </View>
        <Text style={styles.subtitle}>已配对的主机（{connections.length}）</Text>

        {connections.length === 0 ? (
          <View style={sharedStyles.card}>
            <Text style={styles.emptyTitle}>还没有配对主机</Text>
            <Text style={styles.hint}>在主机「远程访问」里生成配对二维码，然后在这里扫码。</Text>
          </View>
        ) : (
          connections.map((connection) => {
            const name = displayHostName(connection);
            return (
              <View key={`${connection.host}-${connection.deviceId}`} style={styles.card}>
                <TouchableOpacity
                  style={styles.mainRow}
                  onPress={() => onOpen(connection)}
                  accessibilityRole="button"
                  accessibilityLabel={`打开 ${name}`}
                >
                  <View style={styles.hostGlyph}>
                    <Text style={styles.hostGlyphText}>DSH</Text>
                  </View>
                  <View style={styles.textWrap}>
                    <Text style={styles.hostName} numberOfLines={1}>
                      {name}
                    </Text>
                    <Text style={styles.meta}>
                      {connection.deviceName}
                      {connection.pairedAt ? ` · 配对于 ${formatPairedAt(connection.pairedAt)}` : ''}
                    </Text>
                  </View>
                </TouchableOpacity>
                <View style={styles.cardActions}>
                  <TouchableOpacity
                    style={styles.gearButton}
                    onPress={() => onOpenDevices(connection)}
                    accessibilityRole="button"
                    accessibilityLabel="设备与安全"
                  >
                    <Text style={styles.gearText}>⚙︎</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.deleteButton}
                    onPress={() => confirmDelete(connection)}
                    accessibilityRole="button"
                    accessibilityLabel={`删除 ${name} 的本机配对记录`}
                  >
                    <Text style={styles.deleteButtonText}>删除</Text>
                  </TouchableOpacity>
                </View>
              </View>
            );
          })
        )}

        <TouchableOpacity style={[sharedStyles.primaryButton, styles.pairButton]} onPress={onPairNew}>
          <Text style={sharedStyles.primaryButtonText}>＋ 配对新主机</Text>
        </TouchableOpacity>

        {__DEV__ ? (
          <Text style={styles.footnote}>
            群体服务版：每台主机使用独立的 P-256 设备密钥（Secure Enclave/Keystore）+ 短时访问令牌；
            打开主机后，左上角返回会回到此列表。主机侧撤销设备后，进入主机时会提示重新配对。
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: spacing.lg, gap: spacing.md },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  titleActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  title: { ...typography.title },
  settingsButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  settingsGlyph: { color: colors.textMuted, fontSize: 22 },
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
  meta: { color: colors.textFaint, fontSize: 12 },
  cardActions: { alignItems: 'center', gap: spacing.xs },
  gearButton: { width: 40, height: 32, alignItems: 'center', justifyContent: 'center' },
  gearText: { color: colors.textMuted, fontSize: 22 },
  deleteButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.danger,
    backgroundColor: 'rgba(242, 99, 122, 0.1)',
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  deleteButtonText: { color: colors.danger, fontSize: 12, fontWeight: '700' },
  pairButton: { marginTop: spacing.sm },
  emptyTitle: { color: colors.text, fontSize: 16, fontWeight: '600', marginBottom: spacing.xs },
  hint: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  footnote: { ...typography.subtitle, fontSize: 12, marginTop: spacing.md },
});
