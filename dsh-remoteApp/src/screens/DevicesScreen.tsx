/**
 * DevicesScreen — 当前主机 / 群体版设备身份 / 单连接面容开关 / 解除本机配对。
 *
 * 群体服务版（A 模式）：
 *   - 设备身份是 Secure Enclave / AndroidKeyStore 里的 P-256 设备密钥（用 label 引用），
 *     不是设备证书；本页不再展示任何证书 / mTLS 诊断 / 证书导入入口。
 *   - 设备列表与撤销在主机侧 DSH「远程访问」里操作；relay 明确返回 unknown_device 时，
 *     WebView 会提示本机记录失效并引导重新配对。
 *   - 全局 App 锁（冷启动解锁）开关在 App 设置页；本页只放**这台主机**的
 *     「打开此连接时要求面容」开关（全局 App 锁关闭时禁用、不生效）。
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  formatFingerprint,
  shortFingerprint,
  truncateMiddle,
} from '../lib/protocol';
import { isAppLockEnabled } from '../lib/appLock';
import type { StoredConnection } from '../lib/store';
import { colors, radii, sharedStyles, spacing } from '../theme';

interface DevicesScreenProps {
  connection: StoredConnection;
  onClose: () => void;
  /** 删除本机配对记录与群体版设备密钥，返回主机列表 / 扫码页（不进入配对流程）。 */
  onDeleteLocal: () => Promise<void> | void;
  /**
   * 切换这台主机的「打开此连接时要求面容」开关。
   * App 负责持久化到连接记录（全局 App 锁关闭时该开关不生效）。
   */
  onRequireBiometricChanged?: (enabled: boolean) => Promise<void> | void;
}

function formatTimestamp(epochMs: number | null | undefined): string {
  if (!epochMs) return '—';
  try {
    return new Date(epochMs).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return String(epochMs);
  }
}

function DetailRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={[styles.detailValue, mono ? styles.detailValueMono : null]} selectable>
        {value}
      </Text>
    </View>
  );
}

export function DevicesScreen({
  connection,
  onClose,
  onDeleteLocal,
  onRequireBiometricChanged,
}: DevicesScreenProps) {
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);
  // 全局 App 锁（设置页，冷启动解锁）是否开启；null = 读取中（开关先禁用）。
  const [globalLockEnabled, setGlobalLockEnabled] = useState<boolean | null>(null);
  // 这台主机的「打开此连接时要求面容」开关（持久化在连接记录的 requireBiometricOnOpen）。
  const [requireBiometric, setRequireBiometric] = useState(
    connection.requireBiometricOnOpen === true,
  );
  const [savingBiometric, setSavingBiometric] = useState(false);

  useEffect(() => {
    let cancelled = false;
    isAppLockEnabled().then((enabled) => {
      if (!cancelled) setGlobalLockEnabled(enabled);
    }).catch(() => {
      if (!cancelled) setGlobalLockEnabled(false);
    });
    return () => { cancelled = true; };
  }, []);

  const handleToggleRequireBiometric = useCallback(async (enabled: boolean) => {
    // 全局 App 锁关闭时单连接开关不生效，也不允许改（按钮本身就是 disabled）。
    if (globalLockEnabled !== true || savingBiometric) return;
    setSavingBiometric(true);
    try {
      await onRequireBiometricChanged?.(enabled);
      setRequireBiometric(enabled);
    } catch {
      Alert.alert('保存失败', '无法保存这台主机的面容开关，请稍后重试。');
    } finally {
      setSavingBiometric(false);
    }
  }, [globalLockEnabled, onRequireBiometricChanged, savingBiometric]);

  const handleDeleteLocal = useCallback(() => {
    Alert.alert(
      '解除本机配对',
      '将删除本机保存的这台主机的配对信息，并回到主机列表。主机上的设备记录不会被删除；删除后需要重新扫码配对。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: () => {
            setBusy(true);
            void Promise.resolve(onDeleteLocal()).catch(() => setBusy(false));
          },
        },
      ],
    );
  }, [onDeleteLocal]);

  return (
    <View style={styles.screen}>
      <View style={[styles.topBar, { paddingTop: insets.top + spacing.sm }]}>
        <TouchableOpacity accessibilityLabel="返回" onPress={onClose} style={styles.iconButton}>
          <Text style={styles.iconGlyph}>‹</Text>
        </TouchableOpacity>
        <Text style={styles.topTitle}>设备与安全</Text>
        <View style={styles.iconButton} />
      </View>

      <ScrollView
        contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + spacing.xxl }]}
      >
        <View style={sharedStyles.card}>
          <Text style={styles.sectionTitle}>当前主机</Text>
          <DetailRow label="主机" value={connection.hostName || connection.host} />
          {__DEV__ ? (
            <>
              <DetailRow
                label="隧道地址"
                value={connection.port === 443
                  ? `https://${connection.host}/`
                  : `https://${connection.host}:${connection.port}/`}
                mono
              />
              <DetailRow label="中继域名" value={connection.relayDomain} mono />
              <DetailRow label="短指纹" value={shortFingerprint(connection.hostFingerprint)} mono />
              <DetailRow
                label="完整指纹"
                value={formatFingerprint(connection.hostFingerprint)}
                mono
              />
            </>
          ) : null}
          <DetailRow label="配对时间" value={formatTimestamp(connection.pairedAt)} />
        </View>

        {__DEV__ ? (
          <View style={sharedStyles.card}>
            <Text style={styles.sectionTitle}>认证与会话</Text>
            <DetailRow label="认证模式" value="token（短时令牌，无需本地证书）" />
            <DetailRow label="主机 ID" value={connection.hostId} mono />
            <DetailRow label="手机访问端口" value={String(connection.port)} />
            <Text style={styles.hint}>
              群体服务版由 relay 终止手机 TLS，主机只做出站隧道；本机使用 Secure Enclave / Keystore
              中的 P-256 设备密钥对 challenge 签名，换取短时 token。主机侧设备列表请在主机的
              「远程访问」里查看。
            </Text>
          </View>
        ) : null}

        <View style={sharedStyles.card}>
          <Text style={styles.sectionTitle}>本机设备</Text>
          <DetailRow label="设备名称" value={connection.deviceName} />
          {__DEV__ ? (
            <>
              <DetailRow label="设备 ID" value={truncateMiddle(connection.deviceId, 8)} mono />
              <DetailRow label="设备密钥标签" value={connection.deviceKeyLabel} mono />
              <Text style={styles.hint}>
                群体版不保存设备证书；P-256 私钥在 Secure Enclave / Keychain（Android 为 AndroidKeyStore）中，
                只用于对 relay 下发的 challenge 签名，App 与 JS 层都无法读取或导出。
              </Text>
            </>
          ) : null}
        </View>

        <View style={sharedStyles.card}>
          <Text style={styles.sectionTitle}>打开此连接时要求面容</Text>
          <View style={styles.switchRow}>
            <View style={styles.switchText}>
              <Text style={styles.rowLabel}>从主机列表打开这台主机时要求面容</Text>
              <Text style={styles.rowHint}>
                {globalLockEnabled === null
                  ? '正在读取 App 锁状态…'
                  : globalLockEnabled
                    ? '全局 App 锁已开启'
                    : '需先在「设置」中开启 App 锁，此开关才会生效'}
              </Text>
            </View>
            <Switch
              value={requireBiometric}
              disabled={globalLockEnabled !== true || savingBiometric}
              onValueChange={(enabled) => { void handleToggleRequireBiometric(enabled); }}
              trackColor={{ false: colors.borderStrong, true: colors.accentPressed }}
              thumbColor={requireBiometric ? colors.accent : colors.textMuted}
            />
          </View>
          <Text style={styles.hint}>开启后，每次打开这台主机都需要生物识别。</Text>
          {__DEV__ ? (
            <Text style={styles.hint}>
              只影响这台主机；App 冷启动时的解锁由「设置 → App 锁」负责。
            </Text>
          ) : null}
        </View>

        <View style={sharedStyles.card}>
          <Text style={styles.sectionTitle}>解除本机配对</Text>
          <Text style={styles.bodyText}>
            将删除本机保存的这台主机的配对信息；主机上的设备记录不会被删除，如需彻底解除请在主机端撤销该设备。
          </Text>
          <TouchableOpacity
            style={[styles.dangerButton, busy ? styles.disabledButton : null]}
            onPress={handleDeleteLocal}
            disabled={busy}
          >
            {busy ? (
              <ActivityIndicator color={colors.danger} />
            ) : (
              <Text style={styles.dangerButtonText}>删除本机配对记录</Text>
            )}
          </TouchableOpacity>
        </View>

        {__DEV__ ? (
          <Text style={styles.footnote}>
            DSH Remote · 群体模式：P-256 设备密钥 + 短时 token 会话；主机侧可随时撤销设备。
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  topTitle: {
    flex: 1,
    textAlign: 'center',
    color: colors.text,
    fontSize: 16,
    fontWeight: '700',
  },
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceRaised,
  },
  iconGlyph: {
    color: colors.text,
    fontSize: 26,
    lineHeight: 28,
    marginTop: -2,
  },
  scrollContent: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.text,
    marginBottom: spacing.sm,
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: spacing.xs,
  },
  detailLabel: {
    color: colors.textFaint,
    fontSize: 13,
    flexShrink: 0,
  },
  detailValue: {
    color: colors.text,
    fontSize: 13,
    flexShrink: 1,
    textAlign: 'right',
  },
  detailValueMono: {
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    fontSize: 11,
    lineHeight: 17,
  },
  hint: {
    fontSize: 12,
    color: colors.textFaint,
    lineHeight: 17,
    marginTop: spacing.sm,
  },
  bodyText: {
    fontSize: 13,
    color: colors.textMuted,
    lineHeight: 19,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  switchText: {
    flex: 1,
    gap: 2,
  },
  rowLabel: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '600',
  },
  rowHint: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 18,
  },
  dangerButton: {
    marginTop: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.danger,
    backgroundColor: 'rgba(242, 99, 122, 0.1)',
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  dangerButtonText: {
    color: colors.danger,
    fontSize: 15,
    fontWeight: '700',
  },
  disabledButton: {
    opacity: 0.45,
  },
  footnote: {
    fontSize: 11,
    color: colors.textFaint,
    textAlign: 'center',
    lineHeight: 16,
    paddingHorizontal: spacing.md,
  },
});
