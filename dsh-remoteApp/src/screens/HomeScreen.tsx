/**
 * HomeScreen — 已配对主机列表（多设备入口）。
 *
 * 导航约定：
 *   Home → 点主机卡片 → WebView（返回键回到 Home）
 *   Home → 齿轮 → Devices（返回/清除配对后回 Home）
 *   Home → 配对新主机 → PairingScreen
 *
 * 记录管理：
 *   - 每台主机都有「删除」入口，只清本机配对记录与设备证书，不需要走重新配对流程；
 *   - 主机侧撤销本设备后，App 同步时会标记 `revokedAt`，卡片显示警告并提供删除；
 *   - 卡片标题使用主机名（重新回到列表时通过 mTLS `/__dsh_remote/status` 同步）。
 */
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import type { StoredConnection } from '../lib/store';
import { displayHostName } from '../lib/hostSync';
import { colors, radii, sharedStyles, spacing, typography } from '../theme';

interface HomeScreenProps {
  connections: StoredConnection[];
  /** 正在向主机同步主机名/撤销状态。 */
  syncing?: boolean;
  onOpen: (connection: StoredConnection) => void;
  onOpenDevices: (connection: StoredConnection) => void;
  /** 删除一台主机的本机配对记录与设备证书（不进入配对流程）。 */
  onDelete: (connection: StoredConnection) => Promise<void> | void;
  /** 手动重新向主机同步（主机改名/撤销后可立即刷新）。 */
  onSync?: () => void;
  onPairNew: () => void;
  onOpenSettings: () => void;
}

function formatPairedAt(epochMs: number): string {
  try {
    return new Date(epochMs).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return '—';
  }
}

function formatRevokedAt(epochMs: number): string {
  try {
    return new Date(epochMs).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return '—';
  }
}

export function HomeScreen({
  connections,
  syncing = false,
  onOpen,
  onOpenDevices,
  onDelete,
  onSync,
  onPairNew,
  onOpenSettings,
}: HomeScreenProps) {
  const insets = useSafeAreaInsets();

  const confirmDelete = (connection: StoredConnection) => {
    const name = displayHostName(connection);
    const revoked = connection.revokedAt !== undefined;
    Alert.alert(
      revoked ? '删除已解除配对的主机' : '删除主机记录',
      revoked
        ? `主机「${name}」已在主机侧解除对本机的配对。\n\n删除后本机不再保留这台主机的配对信息和设备证书；需要时可以重新扫码配对。`
        : `将删除本机保存的「${name}」配对信息和设备证书。\n\n主机上的设备记录不会被删除（如需彻底解除，请在主机「远程访问」里撤销该设备）。删除后需要重新扫码配对。`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '删除本机记录',
          style: 'destructive',
          onPress: () => {
            void onDelete(connection);
          },
        },
      ],
    );
  };

  const openConnection = (connection: StoredConnection) => {
    if (connection.revokedAt !== undefined) {
      confirmDelete(connection);
      return;
    }
    onOpen(connection);
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
          <View style={styles.titleActions}>
            {onSync ? (
              <TouchableOpacity
                style={styles.settingsButton}
                onPress={onSync}
                disabled={syncing}
                accessibilityRole="button"
                accessibilityLabel="同步主机状态"
              >
                {syncing ? (
                  <ActivityIndicator size="small" color={colors.accent} />
                ) : (
                  <Text style={styles.syncGlyph}>↻</Text>
                )}
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity
              style={styles.settingsButton}
              onPress={onOpenSettings}
              accessibilityRole="button"
              accessibilityLabel="设置"
            >
              <Text style={styles.settingsGlyph}>⚙︎</Text>
            </TouchableOpacity>
          </View>
        </View>
        <Text style={styles.subtitle}>
          已配对的主机（{connections.length}）
          {syncing ? ' · 正在同步主机名与配对状态…' : ''}
        </Text>

        {connections.length === 0 ? (
          <View style={sharedStyles.card}>
            <Text style={styles.emptyTitle}>还没有配对主机</Text>
            <Text style={styles.hint}>在桌面 DSH 的「远程访问」里生成配对二维码，然后在这里扫码。</Text>
          </View>
        ) : (
          connections.map((connection) => {
            const revoked = connection.revokedAt !== undefined;
            const name = displayHostName(connection);
            return (
              <View
                key={`${connection.host}-${connection.deviceId}`}
                style={[styles.card, revoked ? styles.cardRevoked : null]}
              >
                <TouchableOpacity
                  style={styles.mainRow}
                  onPress={() => openConnection(connection)}
                  accessibilityRole="button"
                  accessibilityLabel={revoked ? `${name}（主机侧已解除配对）` : `打开 ${name}`}
                >
                  <View style={[styles.hostGlyph, revoked ? styles.hostGlyphRevoked : null]}>
                    <Text style={[styles.hostGlyphText, revoked ? styles.hostGlyphTextRevoked : null]}>
                      {revoked ? '!' : 'DSH'}
                    </Text>
                  </View>
                  <View style={styles.textWrap}>
                    <Text style={styles.hostName} numberOfLines={1}>
                      {name}
                    </Text>
                    <Text style={styles.hostAddress} numberOfLines={1}>
                      {connection.host}
                    </Text>
                    <Text style={styles.meta}>
                      {connection.deviceName}
                      {connection.pairedAt ? ` · 配对于 ${formatPairedAt(connection.pairedAt)}` : ''}
                    </Text>
                    {revoked ? (
                      <Text style={styles.revokedText}>
                        主机侧已解除配对 · 检测于 {formatRevokedAt(connection.revokedAt ?? 0)} · 点按删除本机记录
                      </Text>
                    ) : null}
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

        <Text style={styles.footnote}>
          每台主机使用独立的设备证书（Secure Enclave/Keystore）；打开主机后，左上角返回会回到此列表。
          主机侧撤销设备后，此处的记录会显示警告，可随时删除。
        </Text>
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
  syncGlyph: { color: colors.textMuted, fontSize: 20, fontWeight: '700' },
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
  cardRevoked: {
    borderColor: colors.danger,
    backgroundColor: 'rgba(242, 99, 122, 0.06)',
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
  hostGlyphRevoked: { backgroundColor: 'rgba(242, 99, 122, 0.16)' },
  hostGlyphText: { color: colors.accent, fontWeight: '700', fontSize: 12 },
  hostGlyphTextRevoked: { color: colors.danger, fontSize: 18 },
  textWrap: { flex: 1, gap: 2 },
  hostName: { color: colors.text, fontSize: 16, fontWeight: '600' },
  hostAddress: { color: colors.textMuted, fontSize: 12 },
  meta: { color: colors.textFaint, fontSize: 12 },
  revokedText: { color: colors.danger, fontSize: 12, lineHeight: 17, marginTop: spacing.xs },
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
