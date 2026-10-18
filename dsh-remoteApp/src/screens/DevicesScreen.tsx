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
  Platform,
  ScrollView,
  StyleSheet,
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
import { colors, radii, sharedStyles, spacing, typography } from '../theme';

interface DevicesScreenProps {
  connection: StoredConnection;
  onClose: () => void;
  /** Clear local credentials and return to the pairing screen. */
  onRepair: () => Promise<void> | void;
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

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [storedCertificate, nativeDiagnostics] = await Promise.all([
        loadCertificate().catch(() => null),
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

        <View style={sharedStyles.card}>
          <Text style={styles.sectionTitle}>当前主机</Text>
          <DetailRow label="主机" value={connection.hostName ?? connection.host} />
          <DetailRow label="隧道地址" value={`https://${connection.host}/`} mono />
          <DetailRow label="中继域名" value={connection.relayDomain} mono />
          <DetailRow label="短指纹" value={shortFingerprint(connection.hostFingerprint)} mono />
          <DetailRow
            label="完整指纹"
            value={formatFingerprint(connection.hostFingerprint)}
            mono
          />
          <DetailRow label="配对时间" value={formatTimestamp(connection.pairedAt)} />
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
          <Text style={styles.sectionTitle}>POC 调试：导入设备证书（PKCS#12）</Text>
          <Text style={styles.bodyText}>
            原生 CSR 尚未实现。POC 可先用 openssl 在 Mac 上生成 P-256 设备密钥与 CSR，交由主机侧设备
            CA 签发后打包成 PKCS#12，再粘到这里导入 Keychain / Android Keystore（README 有完整命令）。
          </Text>
          <TouchableOpacity
            style={styles.secondaryButton}
            onPress={() => setDevImportOpen((open) => !open)}
          >
            <Text style={styles.secondaryButtonText}>
              {devImportOpen ? '收起调试导入' : '展开调试导入'}
            </Text>
          </TouchableOpacity>
          {devImportOpen ? (
            <View style={styles.devImportBody}>
              <Text style={styles.inputLabel}>PKCS#12（base64，含设备证书 + 私钥）</Text>
              <TextInput
                value={p12Base64}
                onChangeText={setP12Base64}
                style={[sharedStyles.input, styles.p12Input]}
                multiline
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="MIIJ…（base64）"
                placeholderTextColor={colors.textFaint}
              />
              <Text style={styles.inputLabel}>PKCS#12 密码</Text>
              <TextInput
                value={p12Password}
                onChangeText={setP12Password}
                style={sharedStyles.input}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="仅本次导入使用，不持久化"
                placeholderTextColor={colors.textFaint}
              />
              <TouchableOpacity
                style={[styles.primaryButton, importing ? styles.disabledButton : null]}
                onPress={() => void handleImportP12()}
                disabled={importing}
              >
                {importing ? (
                  <ActivityIndicator color="#04101F" />
                ) : (
                  <Text style={styles.primaryButtonText}>导入设备证书</Text>
                )}
              </TouchableOpacity>
              {importMessage ? <Text style={styles.hint}>{importMessage}</Text> : null}
            </View>
          ) : null}
        </View>

        <View style={sharedStyles.card}>
          <Text style={styles.sectionTitle}>主机侧设备管理</Text>
          <Text style={styles.bodyText}>
            POC 阶段请在被控主机的桌面 DSH 界面中管理设备（列表、撤销、重新签发）。本机管理 API
            只对本机已认证浏览器开放，远程隧道明确拒绝该前缀，因此 App 无法直接调用。
          </Text>
          <DetailRow label="桌面端接口（仅本机）" value={ADMIN_PATHS.devices} mono />
          <Text style={styles.hint}>
            后续版本可增加经 mTLS 认证的隧道接口（如 /__dsh_remote/devices）来支持 App 内列表与撤销；
            在那之前此页只显示本地状态。
          </Text>
          <View style={styles.buttonRow}>
            <TouchableOpacity style={[styles.secondaryButton, styles.disabledButton]} disabled>
              <Text style={styles.secondaryButtonText}>刷新主机设备列表（未接通）</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.buttonRow}>
            <TouchableOpacity style={[styles.secondaryButton, styles.disabledButton]} disabled>
              <Text style={styles.secondaryButtonText}>撤销此设备（请在桌面端操作）</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={sharedStyles.card}>
          <Text style={styles.sectionTitle}>重新配对</Text>
          <Text style={styles.bodyText}>
            重新配对会清除本机保存的主机信息与设备证书，并返回扫码页面。若设备已在主机侧被撤销，也必须重新配对。
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
        </View>

        <Text style={styles.footnote}>
          DSH Remote POC · 远程访问采用 mTLS 设备证书；主机侧可随时撤销。安全模型详见
          docs/remote-access-evaluation.zh.md。
        </Text>
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
