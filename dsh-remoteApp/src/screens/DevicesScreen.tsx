/**
 * DevicesScreen — current device / certificate / connection management.
 *
 * IMPORTANT (ADMIN-API.md §1/§2):
 *   Device list + revoke live behind the LOCAL admin API
 *   (`/api/remote-access/devices`, `/devices/:id/revoke`). That API is
 *   authenticated with the host's DSH browser cookie and is explicitly DENIED
 *   through the remote tunnel. It is also same-origin-only and not reachable
 *   from React Native (the WebView's cookies live inside WKWebView/WebView, not
 *   in fetch()).
 *
 *   Therefore, in the POC:
 *     - device management happens on the desktop DSH UI (host side), and
 *     - this screen shows the locally stored device identity + certificate
 *       state, and lets the user re-pair / unpair the device.
 *
 *   A future milestone can either (a) add a "device list" bridge in the host
 *   plugin's tunnel API (authenticated by mTLS, e.g.
 *   `/__dsh_remote/devices`), or (b) surface a deep-link to the desktop UI.
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
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  ADMIN_PATHS,
  formatFingerprint,
  shortFingerprint,
  truncateMiddle,
} from '../lib/protocol';
import {
  loadCertificate,
  saveConnection,
  type StoredCertificate,
  type StoredConnection,
} from '../lib/store';
import {
  getDiagnostics,
  importClientIdentityFromP12,
  isDshMtlsAvailable,
  setClientIdentity,
  type DshMtlsDiagnostics,
} from '../../modules/dsh-mtls/src';
import {
  getBiometricAvailability,
  isAppLockEnabled,
  setAppLockEnabled,
  type BiometricAvailability,
} from '../lib/appLock';
import {
  canManageRemoteDevices,
  fetchAudit,
  fetchRemoteDevices,
  revokeRemoteDevice,
  type AuditEntry,
  type HostStatus,
  type RemoteDevice,
} from '../lib/devices';
import { syncConnectionWithHost } from '../lib/hostSync';
import { colors, radii, sharedStyles, spacing, typography } from '../theme';

interface DevicesScreenProps {
  connection: StoredConnection;
  onClose: () => void;
  /** Clear local credentials and return to the pairing screen. */
  onRepair: () => Promise<void> | void;
  /** 只删除本机配对记录与设备证书，不进入配对流程。 */
  onDeleteLocal: () => Promise<void> | void;
  /** Called after the POC import updates `certRef` so the WebView picks it up. */
  onConnectionUpdated?: (connection: StoredConnection) => void;
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
  onRepair,
  onDeleteLocal,
  onConnectionUpdated,
}: DevicesScreenProps) {
  const insets = useSafeAreaInsets();
  const [certificate, setCertificate] = useState<StoredCertificate | null>(null);
  const [diagnostics, setDiagnostics] = useState<DshMtlsDiagnostics | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [devImportOpen, setDevImportOpen] = useState(false);
  const [p12Base64, setP12Base64] = useState('');
  const [p12Password, setP12Password] = useState('');
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [appLockEnabled, setAppLockEnabledState] = useState(false);
  const [biometrics, setBiometrics] = useState<BiometricAvailability | null>(null);
  const [remoteDevices, setRemoteDevices] = useState<RemoteDevice[] | null>(null);
  const [remoteDevicesError, setRemoteDevicesError] = useState<string | null>(null);
  const [remoteBusy, setRemoteBusy] = useState<string | null>(null);
  const [hostStatus, setHostStatus] = useState<HostStatus | null>(null);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[] | null>(null);

  useEffect(() => {
    if (!canManageRemoteDevices()) return undefined;
    let cancelled = false;
    void (async () => {
      // 先从主机同步：主机名可能已在桌面侧改过；401/403 则说明本设备已被撤销。
      const sync = await syncConnectionWithHost(connection);
      if (cancelled) return;
      if (sync.status) setHostStatus(sync.status);
      if (sync.changed) onConnectionUpdated?.(sync.connection);
      if (sync.revocation === 'revoked') {
        setRemoteDevices(null);
        setAuditEntries(null);
        setRemoteDevicesError(
          '主机拒绝了本机的设备证书：这台主机可能已在主机侧解除配对（设备已撤销或证书已过期）。',
        );
        return;
      }
      if (sync.error) {
        setRemoteDevicesError(sync.error);
        return;
      }
      try {
        const [devices, audit] = await Promise.all([
          fetchRemoteDevices(sync.connection),
          fetchAudit(sync.connection, 10),
        ]);
        if (cancelled) return;
        setRemoteDevices(devices);
        setAuditEntries(audit);
        setRemoteDevicesError(null);
      } catch (error) {
        if (!cancelled) {
          setRemoteDevicesError(error instanceof Error ? error.message : String(error));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [connection, onConnectionUpdated]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([isAppLockEnabled(), getBiometricAvailability()]).then(([enabled, availability]) => {
      if (cancelled) return;
      setAppLockEnabledState(enabled);
      setBiometrics(availability);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [storedCertificate, nativeDiagnostics] = await Promise.all([
        loadCertificate(connection.hostFingerprint).catch(() => null),
        getDiagnostics().catch(() => null),
      ]);
      if (cancelled) return;
      setCertificate(storedCertificate);
      setDiagnostics(nativeDiagnostics);
      setLoading(false);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleImportP12 = useCallback(async () => {
    if (!p12Base64.trim()) {
      setImportMessage('请先粘贴 PKCS#12 的 base64 内容。');
      return;
    }
    setImporting(true);
    setImportMessage(null);
    try {
      const result = await importClientIdentityFromP12(
        p12Base64.trim(),
        p12Password,
        connection.certRef,
      );
      if (result.configuredIdentityLabel) {
        await setClientIdentity(result.configuredIdentityLabel);
        const updated: StoredConnection = {
          ...connection,
          certRef: result.configuredIdentityLabel,
        };
        await saveConnection(updated);
        onConnectionUpdated?.(updated);
      }
      setImportMessage(
        result.pendingUserConfirmation
          ? '已打开系统证书安装界面：请在系统中确认安装，然后回到 App 重新构建/重启 WebView。'
          : `导入完成：${result.imported ? '已安装设备身份' : '状态未知'}` +
              (result.subject ? ` · ${result.subject}` : ''),
      );
      setP12Base64('');
      setP12Password('');
    } catch (error) {
      setImportMessage(error instanceof Error ? error.message : '导入设备证书失败。');
    } finally {
      setImporting(false);
    }
  }, [connection, onConnectionUpdated, p12Base64, p12Password]);

  const handleRepair = useCallback(async () => {
    setBusy(true);
    try {
      await onRepair();
    } finally {
      setBusy(false);
    }
  }, [onRepair]);

  const handleDeleteLocal = useCallback(() => {
    Alert.alert(
      '删除本机配对记录',
      '将清除本机保存的这台主机的配对信息和设备证书，并回到主机列表。\n\n主机上的设备记录不会因此删除（如需彻底解除，请在主机「远程访问」里撤销该设备）。删除后需要重新扫码配对。',
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
        {loading ? (
          <View style={[sharedStyles.card, styles.centerCard]}>
            <ActivityIndicator color={colors.accent} />
            <Text style={styles.hint}>读取本地设备信息…</Text>
          </View>
        ) : null}

        {connection.revokedAt !== undefined ? (
          <View style={[sharedStyles.card, styles.revokedCard]}>
            <Text style={styles.revokedTitle}>主机侧已解除配对</Text>
            <Text style={styles.bodyText}>
              主机不再接受本机的设备证书（可能已在桌面端撤销该设备，或证书已过期）。
              本机保存的记录不会自动删除，可以使用下面的「删除本机配对记录」清理，然后重新扫码配对。
            </Text>
          </View>
        ) : null}

        <View style={sharedStyles.card}>
          <Text style={styles.sectionTitle}>当前主机</Text>
          <DetailRow label="主机" value={connection.hostName || connection.host} />
          <DetailRow label="隧道地址" value={`https://${connection.host}/`} mono />
          <DetailRow label="中继域名" value={connection.relayDomain} mono />
          <DetailRow label="短指纹" value={shortFingerprint(connection.hostFingerprint)} mono />
          <DetailRow
            label="完整指纹"
            value={formatFingerprint(connection.hostFingerprint)}
            mono
          />
          <DetailRow label="配对时间" value={formatTimestamp(connection.pairedAt)} />
          {connection.revokedAt !== undefined ? (
            <DetailRow label="检测到主机拒绝" value={formatTimestamp(connection.revokedAt)} />
          ) : null}
        </View>

        <View style={sharedStyles.card}>
          <Text style={styles.sectionTitle}>主机状态</Text>
          {remoteDevicesError ? (
            <Text style={styles.statusError}>{remoteDevicesError}</Text>
          ) : hostStatus ? (
            <>
              <DetailRow label="主机名称（已同步）" value={hostStatus.hostName || '（未设置）'} />
              <DetailRow
                label="中继连接"
                value={
                  hostStatus.relayConnected === null
                    ? '—'
                    : hostStatus.relayConnected
                      ? '已连接'
                      : '未连接'
                }
              />
              <DetailRow label="主机版本" value={hostStatus.version ?? '—'} mono />
              <DetailRow
                label="已配对设备"
                value={`${hostStatus.devices?.active ?? 0} 台有效 / 共 ${hostStatus.devices?.total ?? 0} 台`}
              />
              <Text style={styles.hint}>
                主机改名后，App 回到主机列表或重新进入本页时会通过 mTLS 自动同步。
              </Text>
            </>
          ) : (
            <Text style={styles.hint}>正在读取主机状态…</Text>
          )}
        </View>

        <View style={sharedStyles.card}>
          <Text style={styles.sectionTitle}>本机设备身份</Text>
          <DetailRow label="设备名称" value={connection.deviceName} />
          <DetailRow label="设备 ID" value={truncateMiddle(connection.deviceId, 8)} mono />
          <DetailRow label="证书引用" value={connection.certRef ?? '（未安装原生身份）'} mono />
          <View style={styles.divider} />
          <Text style={styles.sectionSubtitle}>设备证书</Text>
          <DetailRow
            label="证书状态"
            value={certificate ? '已保存（SecureStore）' : '未保存'}
          />
          <DetailRow label="保存时间" value={formatTimestamp(certificate?.storedAt)} />
          <DetailRow
            label="证书长度"
            value={certificate ? `${certificate.certPem.length} 字符` : '—'}
          />
          <Text style={styles.hint}>
            设备私钥由原生模块保存在 Keychain / Android Keystore 中，App 与 JS 层都无法读取或导出。
          </Text>
        </View>

        <View style={sharedStyles.card}>
          <Text style={styles.sectionTitle}>原生 mTLS 模块</Text>
          <DetailRow
            label="模块状态"
            value={
              isDshMtlsAvailable
                ? diagnostics?.moduleAvailable
                  ? '已链接'
                  : '已链接（诊断不可用）'
                : '未链接（Expo Go / 未构建 dev client）'
            }
          />
          <DetailRow
            label="身份状态"
            value={diagnostics?.identityPresent ? 'Keychain/Keystore 中存在设备身份' : '未检测到设备身份'}
          />
          <DetailRow label="证书主题" value={diagnostics?.subject ?? '—'} mono />
          <DetailRow label="证书到期" value={diagnostics?.notAfter ?? '—'} />
          <DetailRow label="平台" value={diagnostics?.platform ?? '—'} />
          <Text style={styles.hint}>
            原生身份由 modules/dsh-mtls 提供：WKWebView 客户端证书挑战 / Android
            onReceivedClientCertRequest。
          </Text>
        </View>

        <View style={sharedStyles.card}>
          <Text style={styles.sectionTitle}>重新配对 / 删除本机记录</Text>
          <Text style={styles.bodyText}>
            重新配对会清除本机保存的主机信息与设备证书，并进入扫码页面。若设备已在主机侧被撤销，也需要重新扫码配对。
          </Text>
          <TouchableOpacity
            style={[styles.dangerButton, busy ? styles.disabledButton : null]}
            onPress={() => void handleRepair()}
            disabled={busy}
          >
            {busy ? (
              <ActivityIndicator color={colors.danger} />
            ) : (
              <Text style={styles.dangerButtonText}>清除本地凭据并重新配对</Text>
            )}
          </TouchableOpacity>

          <View style={styles.divider} />

          <Text style={styles.sectionSubtitle}>只删除本机记录</Text>
          <Text style={styles.bodyText}>
            只在手机上清除这台主机的配对记录与设备证书，不进入扫码流程。主机侧的设备记录需要在主机「远程访问」里单独撤销。
          </Text>
          <TouchableOpacity
            style={[styles.secondaryDangerButton, busy ? styles.disabledButton : null]}
            onPress={handleDeleteLocal}
            disabled={busy}
          >
            <Text style={styles.secondaryDangerButtonText}>删除本机配对记录</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.footnote}>
          DSH Remote · 远程访问采用 mTLS 设备证书；主机侧可随时撤销。安全模型详见
          docs/remote-access-evaluation.zh.md。
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: spacing.lg },
  lockRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  remoteDeviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  revokeButton: {
    backgroundColor: 'rgba(242, 99, 122, 0.14)',
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  revokeButtonText: { color: colors.danger, fontSize: 13, fontWeight: '600' },
  detailHint: { fontSize: 12, color: colors.textMuted, marginTop: spacing.xs },
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
  sectionSubtitle: {
    ...typography.label,
    marginBottom: spacing.xs,
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
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginVertical: spacing.sm,
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
  buttonRow: {
    marginTop: spacing.sm,
  },
  secondaryButton: {
    ...sharedStyles.secondaryButton,
  },
  secondaryButtonText: {
    ...sharedStyles.secondaryButtonText,
    fontSize: 13,
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
  secondaryDangerButton: {
    marginTop: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.danger,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  secondaryDangerButtonText: {
    color: colors.danger,
    fontSize: 14,
    fontWeight: '600',
  },
  revokedCard: {
    borderColor: colors.danger,
    backgroundColor: 'rgba(242, 99, 122, 0.08)',
  },
  revokedTitle: {
    color: colors.danger,
    fontSize: 16,
    fontWeight: '700',
    marginBottom: spacing.xs,
  },
  statusError: {
    color: colors.warning,
    fontSize: 13,
    lineHeight: 19,
  },
  disabledButton: {
    opacity: 0.45,
  },
  centerCard: {
    alignItems: 'center',
    gap: spacing.sm,
  },
  devImportBody: {
    marginTop: spacing.md,
    gap: spacing.sm,
  },
  p12Input: {
    minHeight: 88,
    textAlignVertical: 'top',
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    fontSize: 11,
  },
  inputLabel: {
    ...typography.label,
    marginBottom: spacing.xs,
  },
  primaryButton: {
    ...sharedStyles.primaryButton,
    marginTop: spacing.xs,
  },
  primaryButtonText: {
    ...sharedStyles.primaryButtonText,
  },
  footnote: {
    fontSize: 11,
    color: colors.textFaint,
    textAlign: 'center',
    lineHeight: 16,
    paddingHorizontal: spacing.md,
  },
});
