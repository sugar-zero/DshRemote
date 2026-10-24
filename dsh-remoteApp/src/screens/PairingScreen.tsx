/**
 * PairingScreen — QR scan / manual URI entry / fingerprint confirmation.
 *
 * Flow (evaluation §4.3, ADMIN-API.md §3):
 *   scan or paste `dshremote://pair?...` → validate locally → show host + FULL
 *   fingerprint + short fingerprint → "开始配对" → POST /__dsh_remote/pair →
 *   (desktop approval) poll /pair/status → device certificate → onPaired().
 *
 * Security UX notes:
 *   - The full fingerprint is always shown; the short one is for eyeballing the
 *     desktop UI only and is never used as a pin (ADMIN-API.md §3).
 *   - The laptop may require approval; the desktop shows the device name + SAS.
 *     We tell the user to compare them, but we never auto-approve.
 *   - The one-time secret is not logged and not displayed.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  formatFingerprint,
  formatPairingCode,
  isCompletePairingCode,
  pairingTimeLeftMs,
  parsePairingUri,
  PairingUriError,
  shortFingerprint,
  type PairingUri,
} from '../lib/protocol';
import {
  currentPairPlatform,
  defaultDeviceName,
  pairDevice,
  PairingError,
  POC_PLACEHOLDER_CSR,
  toPairingError,
} from '../lib/pairing';
import { loadDeviceName, saveDeviceName, type StoredConnection } from '../lib/store';
import { isDshMtlsAvailable } from '../../modules/dsh-mtls/src';
import { colors, radii, sharedStyles, spacing, typography } from '../theme';

type Phase = 'scan' | 'review' | 'pairing' | 'error';

interface PairingScreenProps {
  onPaired: (connection: StoredConnection) => void;
}

interface ScreenError {
  title: string;
  message: string;
  code?: string;
}

const PHASE_LABELS = [
  { key: 'requesting', label: '生成设备密钥并提交配对请求' },
  { key: 'pending', label: '等待桌面端确认' },
  { key: 'paired', label: '保存设备证书' },
] as const;

function phaseMessage(phase: 'requesting' | 'pending' | 'polling' | 'paired'): string {
  switch (phase) {
    case 'requesting':
      return '正在向主机提交配对请求…';
    case 'pending':
      return '已提交，等待桌面端确认…';
    case 'polling':
      return '等待桌面端确认（请在 Mac 上允许此设备）…';
    case 'paired':
      return '配对成功，正在保存设备证书…';
  }
}

function errorTitle(error: PairingError): string {
  switch (error.code) {
    case 'network':
      return '网络连接失败';
    case 'timeout':
      return '连接超时';
    case 'denied':
      return '配对被拒绝';
    case 'expired':
      return '配对已过期';
    case 'fingerprint_mismatch':
      return '主机指纹不匹配';
    case 'unauthorized':
    case 'rate_limited':
      return '主机拒绝了请求';
    case 'unsupported':
      return '当前构建缺少原生能力';
    case 'invalid_request':
      return '配对请求无效';
    default:
      return '配对失败';
  }
}

function formatCountdown(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

export function PairingScreen({ onPaired }: PairingScreenProps) {
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [phase, setPhase] = useState<Phase>('scan');
  const [manualOpen, setManualOpen] = useState(false);
  const [manualUri, setManualUri] = useState('');
  const [deviceName, setDeviceName] = useState(defaultDeviceName());
  const [pairing, setPairing] = useState<PairingUri | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [pairingMessage, setPairingMessage] = useState(phaseMessage('requesting'));
  const [error, setError] = useState<ScreenError | null>(null);
  const [usePlaceholderCsr, setUsePlaceholderCsr] = useState(false);
  const [backupCode, setBackupCode] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const scanLockRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  // Restore the device name chosen during a previous pairing attempt.
  useEffect(() => {
    let cancelled = false;
    loadDeviceName()
      .then((saved) => {
        if (!cancelled && saved) setDeviceName(saved);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // Live countdown while a pairing URI / request is active.
  useEffect(() => {
    if (phase !== 'review' && phase !== 'pairing') return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [phase]);

  // Abort in-flight pairing if the screen unmounts.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const secondsLeft = useMemo(() => {
    if (!pairing) return 0;
    return Math.floor(pairingTimeLeftMs(pairing, now) / 1000);
  }, [pairing, now]);

  const handleUri = useCallback((raw: string) => {
    if (!raw.trim()) {
      setParseError('请先粘贴配对链接。');
      return;
    }
    try {
      const parsed = parsePairingUri(raw);
      setPairing(parsed);
      setParseError(null);
      setManualOpen(false);
      setPhase('review');
    } catch (parseFailure) {
      const message =
        parseFailure instanceof PairingUriError
          ? parseFailure.message
          : '无法解析配对链接，请确认二维码/链接完整。';
      setParseError(message);
    }
  }, []);

  const handleBarcodeScanned = useCallback(
    (data: string) => {
      if (scanLockRef.current || phase !== 'scan') return;
      scanLockRef.current = true;
      handleUri(data);
      // Allow rescanning after a failed parse; a successful parse leaves 'scan'.
      setTimeout(() => {
        scanLockRef.current = false;
      }, 1500);
    },
    [handleUri, phase],
  );

  const resetToScan = useCallback(() => {
    abortRef.current?.abort();
    setPairing(null);
    setError(null);
    setParseError(null);
    setBackupCode('');
    setManualUri('');
    setPhase('scan');
  }, []);

  const startPairing = useCallback(async () => {
    if (!pairing) return;
    const name = deviceName.trim() || defaultDeviceName();
    setError(null);
    setPairingMessage(phaseMessage('requesting'));
    setPhase('pairing');
    const controller = new AbortController();
    abortRef.current = controller;
    await saveDeviceName(name).catch(() => undefined);
    try {
      const result = await pairDevice({
        pairing,
        deviceName: name,
        platform: currentPairPlatform(),
        allowPlaceholderCsr: usePlaceholderCsr,
        pollIntervalMs: 1500,
        signal: controller.signal,
        onPhase: (nextPhase) => setPairingMessage(phaseMessage(nextPhase)),
      });
      onPaired(result.connection);
    } catch (pairingFailure) {
      const normalized = toPairingError(pairingFailure);
      if (normalized.code === 'aborted') {
        setPhase('review');
        return;
      }
      setError({
        title: errorTitle(normalized),
        message: normalized.message,
        code: normalized.code,
      });
      setPhase('error');
    } finally {
      abortRef.current = null;
    }
  }, [deviceName, onPaired, pairing, usePlaceholderCsr]);

  const cancelPairing = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase('review');
    setPairingMessage(phaseMessage('requesting'));
  }, []);

  const renderScanPhase = () => (
    <>
      <View style={styles.header}>
        <Text style={styles.title}>连接 DSH 主机</Text>
        <Text style={styles.subtitle}>
          在 Mac 的 DSH「设置 → 远程访问」中点击「配对新设备」，然后扫描二维码。
        </Text>
      </View>

      {permission?.granted ? (
        <View style={styles.cameraFrame}>
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={({ data }) => handleBarcodeScanned(data)}
          />
          <View pointerEvents="none" style={styles.cameraOverlay}>
            <View style={styles.cameraReticle} />
            <Text style={styles.cameraHint}>将二维码放入框内</Text>
          </View>
        </View>
      ) : (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>需要相机权限</Text>
          <Text style={styles.cardBody}>
            {permission?.canAskAgain === false
              ? '相机权限已被永久拒绝。请到系统「设置 → DSH Remote → 相机」中开启，或使用手动粘贴配对链接。'
              : '扫码需要相机权限。也可以使用下方的手动粘贴方式。'}
          </Text>
          {permission?.canAskAgain !== false ? (
            <TouchableOpacity style={styles.primaryButton} onPress={() => void requestPermission()}>
              <Text style={styles.primaryButtonText}>授权相机</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      )}

      <TouchableOpacity
        style={styles.manualToggle}
        onPress={() => {
          setManualOpen((open) => !open);
          setParseError(null);
        }}
      >
        <Text style={styles.manualToggleText}>
          {manualOpen ? '收起手动输入' : '无法扫码？手动粘贴配对链接'}
        </Text>
      </TouchableOpacity>

      {manualOpen ? (
        <View style={styles.card}>
          <Text style={styles.inputLabel}>配对链接（dshremote://pair?...）</Text>
          <TextInput
            value={manualUri}
            onChangeText={setManualUri}
            style={[sharedStyles.input, styles.multiline]}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="dshremote://pair?v=1&host=…"
            placeholderTextColor={colors.textFaint}
          />
          <TouchableOpacity style={styles.primaryButton} onPress={() => handleUri(manualUri)}>
            <Text style={styles.primaryButtonText}>解析链接</Text>
          </TouchableOpacity>
          <Text style={styles.hint}>
            链接里只有一次性配对密钥（约 120 秒有效），不含账号或长期令牌。
          </Text>
        </View>
      ) : null}

      {parseError ? (
        <View style={[styles.card, styles.errorCard]}>
          <Text style={styles.errorTitle}>链接无效</Text>
          <Text style={styles.cardBody}>{parseError}</Text>
        </View>
      ) : null}

      <View style={styles.card}>
        <Text style={styles.inputLabel}>设备名称（显示在主机设备列表中）</Text>
        <TextInput
          value={deviceName}
          onChangeText={setDeviceName}
          style={sharedStyles.input}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={64}
          placeholder={defaultDeviceName()}
          placeholderTextColor={colors.textFaint}
        />
        <Text style={styles.hint}>建议包含机型，方便日后在主机侧识别与撤销。</Text>
      </View>

      <View style={styles.card}>
        <View style={styles.debugHeader}>
          <View style={styles.debugTitleWrap}>
            <Text style={styles.cardTitle}>POC 调试选项</Text>
            <Text style={styles.hint}>
              设备密钥/CSR 已由原生模块生成（Secure Enclave 优先）。此开关仅用于 mock 主机的占位 CSR 调试；
              真实主机会拒绝占位 CSR。
            </Text>
          </View>
          <Switch
            value={usePlaceholderCsr}
            onValueChange={setUsePlaceholderCsr}
            trackColor={{ false: colors.border, true: colors.accent }}
            thumbColor={colors.text}
          />
        </View>
        {usePlaceholderCsr ? (
          <Text style={[styles.monoHint, { marginTop: spacing.sm }]} numberOfLines={3}>
            {POC_PLACEHOLDER_CSR}
          </Text>
        ) : null}
        {!isDshMtlsAvailable ? (
          <Text style={[styles.warningText, { marginTop: spacing.sm }]}>
            当前构建未链接 mTLS 原生模块（例如 Expo Go）。正式配对请使用 npx expo run:ios 构建的 dev
            client。
          </Text>
        ) : null}
      </View>
    </>
  );

  const renderReviewPhase = () => {
    if (!pairing) return null;
    const codeComplete = isCompletePairingCode(backupCode);
    return (
      <>
        <View style={styles.header}>
          <Text style={styles.title}>确认主机身份</Text>
          <Text style={styles.subtitle}>
            请核对下面的指纹与桌面端显示的一致，再开始配对。
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.inputLabel}>主机地址</Text>
          <Text style={styles.monoValue} selectable>
            {pairing.host}
          </Text>
          <View style={sharedStyles.divider} />
          <Text style={styles.inputLabel}>中继域名</Text>
          <Text style={styles.monoValue} selectable>
            {pairing.relayDomain}
          </Text>
          <View style={sharedStyles.divider} />
          <Text style={styles.inputLabel}>主机指纹（短）</Text>
          <Text style={styles.shortFingerprint}>{shortFingerprint(pairing.hostFingerprint)}</Text>
          <Text style={styles.inputLabel}>主机指纹（完整 SHA-256 / base64url）</Text>
          <Text style={styles.monoValueSmall} selectable>
            {formatFingerprint(pairing.hostFingerprint)}
          </Text>
          <Text style={styles.hint}>
            短指纹仅用于人工对照；完整指纹才是权威值（主机侧设备 CA 绑定）。
          </Text>
        </View>

        <View style={styles.card}>
          <View style={styles.rowBetween}>
            <Text style={styles.cardTitle}>配对有效期</Text>
            <Text style={[styles.countdown, secondsLeft <= 15 ? styles.countdownDanger : null]}>
              {formatCountdown(secondsLeft)}
            </Text>
          </View>
          {secondsLeft <= 0 ? (
            <Text style={styles.warningText}>链接已过期，请在主机上重新生成二维码。</Text>
          ) : (
            <Text style={styles.hint}>过期后需要重新扫码。桌面端可能要求再次确认（显示设备名 + SAS 短码）。</Text>
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.inputLabel}>备用码 / SAS（可选）</Text>
          <TextInput
            value={formatPairingCode(backupCode)}
            onChangeText={setBackupCode}
            style={[sharedStyles.input, styles.codeInput]}
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={15}
            placeholder="XXXX-XXXX-XXXX"
            placeholderTextColor={colors.textFaint}
          />
          <Text style={styles.hint}>
            {codeComplete
              ? '备用码格式有效。POC 阶段使用二维码中的一次性密钥，备用码提交由主机端 /pairing/* 接口支持后接入。'
              : '只有主机要求手动核对时才需要填写；扫码配对不需要。'}
          </Text>
        </View>

        <TouchableOpacity
          style={[styles.primaryButton, secondsLeft <= 0 ? sharedStyles.disabledButton : null]}
          onPress={() => void startPairing()}
          disabled={secondsLeft <= 0}
        >
          <Text style={styles.primaryButtonText}>开始配对</Text>
        </TouchableOpacity>

        <View style={styles.buttonRow}>
          <TouchableOpacity style={styles.secondaryButton} onPress={resetToScan}>
            <Text style={styles.secondaryButtonText}>重新扫描</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.secondaryButton}
            onPress={() => {
              setPhase('scan');
              setManualOpen(true);
            }}
          >
            <Text style={styles.secondaryButtonText}>编辑链接</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.footnote}>
          配对会生成设备密钥对；私钥保存在系统安全区，永远不会离开手机。
        </Text>
      </>
    );
  };

  const renderPairingPhase = () => (
    <>
      <View style={styles.header}>
        <Text style={styles.title}>正在配对</Text>
        <Text style={styles.subtitle}>{pairingMessage}</Text>
      </View>
      <View style={[styles.card, styles.centerCard]}>
        <ActivityIndicator size="large" color={colors.accent} />
        <Text style={[styles.cardBody, { marginTop: spacing.lg }]}>{pairingMessage}</Text>
        {pairing ? (
          <Text style={styles.hint}>链接剩余有效期：{formatCountdown(secondsLeft)}</Text>
        ) : null}
        <View style={styles.steps}>
          {PHASE_LABELS.map((step) => (
            <Text key={step.key} style={styles.stepText}>
              · {step.label}
            </Text>
          ))}
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>桌面端确认</Text>
        <Text style={styles.cardBody}>
          请在 Mac 上打开 DSH 设置 → 远程访问。若出现配对确认，核对设备名称与 SAS
          短码是否与本机一致，然后点击「允许」。两边显示不一致时请拒绝。
        </Text>
      </View>

      <TouchableOpacity style={styles.secondaryButton} onPress={cancelPairing}>
        <Text style={styles.secondaryButtonText}>取消配对</Text>
      </TouchableOpacity>
    </>
  );

  const renderErrorPhase = () => (
    <>
      <View style={styles.header}>
        <Text style={styles.title}>配对未完成</Text>
        <Text style={styles.subtitle}>没有保存任何凭据，可以安全重试。</Text>
      </View>
      <View style={[styles.card, styles.errorCard]}>
        <Text style={styles.errorTitle}>{error?.title ?? '配对失败'}</Text>
        <Text style={styles.cardBody}>{error?.message ?? '未知错误。'}</Text>
        {error?.code ? <Text style={styles.errorCode}>code: {error.code}</Text> : null}
      </View>
      {error?.code === 'unsupported' || !isDshMtlsAvailable ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>开发提示</Text>
          <Text style={styles.cardBody}>
            设备证书挑战依赖自定义原生 WebView 与原生 CSR 生成（modules/dsh-mtls）。请使用 Xcode
            构建的 dev client（npx expo run:ios）而不是 Expo Go，详见 README。
          </Text>
        </View>
      ) : null}
      <TouchableOpacity
        style={styles.primaryButton}
        onPress={() => {
          setError(null);
          setPhase(pairing ? 'review' : 'scan');
        }}
      >
        <Text style={styles.primaryButtonText}>重试</Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.secondaryButton} onPress={resetToScan}>
        <Text style={styles.secondaryButtonText}>重新扫描二维码</Text>
      </TouchableOpacity>
    </>
  );

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={insets.top}
    >
      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          { paddingTop: insets.top + spacing.lg, paddingBottom: insets.bottom + spacing.xxl },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        {phase === 'scan' ? renderScanPhase() : null}
        {phase === 'review' ? renderReviewPhase() : null}
        {phase === 'pairing' ? renderPairingPhase() : null}
        {phase === 'error' ? renderErrorPhase() : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scrollContent: {
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  header: {
    marginBottom: spacing.sm,
    gap: spacing.xs,
  },
  title: {
    ...typography.title,
  },
  subtitle: {
    ...typography.subtitle,
    lineHeight: 21,
  },
  card: {
    ...sharedStyles.card,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.text,
    marginBottom: spacing.xs,
  },
  cardBody: {
    ...typography.body,
    color: colors.textMuted,
    lineHeight: 20,
  },
  inputLabel: {
    ...typography.label,
    marginBottom: spacing.xs,
  },
  multiline: {
    minHeight: 96,
    textAlignVertical: 'top',
    marginVertical: spacing.sm,
  },
  hint: {
    fontSize: 12,
    color: colors.textFaint,
    lineHeight: 17,
    marginTop: spacing.sm,
  },
  monoHint: {
    ...typography.mono,
    color: colors.textFaint,
  },
  monoValue: {
    ...typography.mono,
    fontSize: 13,
    color: colors.text,
  },
  monoValueSmall: {
    ...typography.mono,
    fontSize: 12,
    color: colors.text,
    lineHeight: 19,
  },
  shortFingerprint: {
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: 1,
    color: colors.accent,
    marginBottom: spacing.sm,
    ...(Platform.OS === 'ios' ? { fontFamily: 'Menlo' } : {}),
  },
  cameraFrame: {
    height: 300,
    borderRadius: radii.lg,
    overflow: 'hidden',
    backgroundColor: '#000',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
  },
  cameraOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
  },
  cameraReticle: {
    width: 208,
    height: 208,
    borderRadius: radii.lg,
    borderWidth: 2,
    borderColor: colors.accent,
    backgroundColor: 'rgba(79, 141, 247, 0.08)',
  },
  cameraHint: {
    color: colors.text,
    fontSize: 13,
    backgroundColor: colors.overlay,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.pill,
    overflow: 'hidden',
  },
  manualToggle: {
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },
  manualToggleText: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: '600',
  },
  primaryButton: {
    ...sharedStyles.primaryButton,
    marginTop: spacing.xs,
  },
  primaryButtonText: {
    ...sharedStyles.primaryButtonText,
  },
  secondaryButton: {
    ...sharedStyles.secondaryButton,
    flex: 1,
  },
  secondaryButtonText: {
    ...sharedStyles.secondaryButtonText,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  errorCard: {
    borderColor: colors.danger,
  },
  errorTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.danger,
    marginBottom: spacing.xs,
  },
  errorCode: {
    ...typography.mono,
    color: colors.textFaint,
    marginTop: spacing.sm,
  },
  warningText: {
    fontSize: 12,
    color: colors.warning,
    lineHeight: 17,
  },
  debugHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
  },
  debugTitleWrap: {
    flex: 1,
  },
  rowBetween: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  countdown: {
    ...typography.mono,
    fontSize: 18,
    color: colors.accent,
  },
  countdownDanger: {
    color: colors.danger,
  },
  codeInput: {
    letterSpacing: 2,
    textAlign: 'center',
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
  },
  centerCard: {
    alignItems: 'center',
  },
  steps: {
    marginTop: spacing.lg,
    gap: spacing.xs,
    alignSelf: 'stretch',
  },
  stepText: {
    fontSize: 13,
    color: colors.textMuted,
  },
  footnote: {
    fontSize: 12,
    color: colors.textFaint,
    textAlign: 'center',
    lineHeight: 17,
  },
});
