/**
 * PairingScreen — 群体服务版配对：扫码 / 手动粘贴 / 指纹确认 / 桌面确认。
 *
 * Flow（docs/group-service-design.zh.md）：
 *   scan or paste `dshremote://pair?v=2&...&auth=token` → 本地校验（v2 + token）
 *   → 展示主机地址、服务端口、完整/短指纹 → 「开始配对」
 *   → 原生生成/复用 P-256 设备密钥 → POST /__dsh_remote/pair {secret, publicKey}
 *   → （需要时）桌面端确认 + 轮询 /pair/status → 保存连接（token 认证）。
 *
 * Security UX notes:
 *   - The full fingerprint is always shown; the short one is for eyeballing the
 *     desktop UI only and is never used as a pin.
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
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  formatFingerprint,
  pairingTimeLeftMs,
  parseGroupPairingUri,
  PairingUriError,
  shortFingerprint,
  type GroupPairingUri,
} from '../lib/protocol';
import {
  currentPairPlatform,
  defaultGroupDeviceLabel,
  GroupPairingError,
  isGroupNativeAvailable,
  pairGroupDevice,
  toGroupPairingError,
} from '../lib/group';
import { defaultDeviceName, isLegacyDefaultDeviceName } from '../lib/deviceName';
import { loadDeviceName, saveDeviceName, clearDeviceName, type StoredConnection } from '../lib/store';
import { colors, radii, sharedStyles, spacing, typography } from '../theme';

type Phase = 'scan' | 'review' | 'pairing' | 'error';

interface PairingScreenProps {
  onPaired: (connection: StoredConnection) => void;
  /** 已有配对主机时，返回主机列表。 */
  onCancel?: () => void;
}

interface ScreenError {
  title: string;
  message: string;
  code?: string;
}

const GROUP_PHASE_LABELS = [
  { key: 'requesting', label: '提交配对请求' },
  { key: 'pending', label: '等待主机确认' },
  { key: 'paired', label: '完成配对' },
] as const;

function phaseMessage(phase: 'requesting' | 'pending' | 'polling' | 'paired'): string {
  switch (phase) {
    case 'requesting':
      return '正在向主机提交配对请求…';
    case 'pending':
      return '已提交，等待主机确认…';
    case 'polling':
      return '等待主机确认…';
    case 'paired':
      return '配对成功，正在保存连接…';
  }
}

function errorTitle(error: GroupPairingError): string {
  switch (error.code) {
    case 'native_unavailable':
      return '当前构建缺少原生能力';
    case 'network':
      return '网络连接失败';
    case 'timeout':
      return '连接超时';
    case 'denied':
      return '配对被拒绝';
    case 'expired':
      return '配对已过期';
    case 'fingerprint_mismatch':
      return '安全码不匹配';
    case 'pending_timeout':
      return '等待确认超时';
    case 'invalid_request':
    case 'invalid_response':
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

export function PairingScreen({ onPaired, onCancel }: PairingScreenProps) {
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [phase, setPhase] = useState<Phase>('scan');
  const [manualOpen, setManualOpen] = useState(false);
  const [manualUri, setManualUri] = useState('');
  const [deviceName, setDeviceName] = useState(defaultDeviceName());
  const [pairing, setPairing] = useState<GroupPairingUri | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [pairingMessage, setPairingMessage] = useState(phaseMessage('requesting'));
  const [error, setError] = useState<ScreenError | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const scanLockRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  /** 群体版配对 pending 时桌面端展示的 SAS（用于轮询期间持续提示）。 */
  const pendingSasRef = useRef<string | null>(null);

  // 恢复上一次用户自定义的设备名；旧版本写死的默认名不再沿用（改用系统设备名）。
  useEffect(() => {
    let cancelled = false;
    loadDeviceName()
      .then((saved) => {
        if (cancelled || !saved) return;
        if (isLegacyDefaultDeviceName(saved)) return;
        setDeviceName(saved);
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
      const parsed = parseGroupPairingUri(raw);
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
    pendingSasRef.current = null;
    setPairing(null);
    setError(null);
    setParseError(null);
    setManualUri('');
    setPhase('scan');
  }, []);

  const startPairing = useCallback(async () => {
    if (!pairing) return;
    const name = deviceName.trim() || defaultDeviceName();
    setError(null);
    setPairingMessage(phaseMessage('requesting'));
    setPhase('pairing');
    pendingSasRef.current = null;
    const controller = new AbortController();
    abortRef.current = controller;
    // 只持久化用户真正改过的名字：默认名每次配对都重新取系统设备名。
    if (name === defaultDeviceName()) await clearDeviceName().catch(() => undefined);
    else await saveDeviceName(name).catch(() => undefined);
    try {
      // 群体服务版（A 模式）：P-256 设备密钥 + 短时 token，无 CSR/证书。
      const result = await pairGroupDevice({
        pairing,
        deviceName: name,
        platform: currentPairPlatform(),
        label: defaultGroupDeviceLabel(pairing.host),
        pollIntervalMs: 1500,
        signal: controller.signal,
        onPhase: (nextPhase) => {
          const sas = pendingSasRef.current;
          setPairingMessage(
            nextPhase === 'polling' && sas
              ? '等待主机确认…'
              : phaseMessage(nextPhase),
          );
        },
        onPending: ({ sas }) => {
          if (!sas) return;
          pendingSasRef.current = sas;
          setPairingMessage('等待主机确认…');
        },
      });
      onPaired(result.connection);
    } catch (pairingFailure) {
      if (pairingFailure instanceof GroupPairingError && pairingFailure.code === 'aborted') {
        setPhase('review');
        return;
      }
      const normalized = toGroupPairingError(pairingFailure);
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
  }, [deviceName, onPaired, pairing]);

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
          在主机 DSH「设置 → 远程访问」中生成配对二维码，然后扫描。
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
          <Text style={styles.inputLabel}>配对链接</Text>
          <TextInput
            value={manualUri}
            onChangeText={setManualUri}
            style={[sharedStyles.input, styles.multiline]}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="dshremote://pair?v=2&auth=token…"
            placeholderTextColor={colors.textFaint}
          />
          <TouchableOpacity style={styles.primaryButton} onPress={() => handleUri(manualUri)}>
            <Text style={styles.primaryButtonText}>解析链接</Text>
          </TouchableOpacity>
          <Text style={styles.hint}>粘贴主机生成的配对链接。</Text>
        </View>
      ) : null}

      {parseError ? (
        <View style={[styles.card, styles.errorCard]}>
          <Text style={styles.errorTitle}>链接无效</Text>
          <Text style={styles.cardBody}>{__DEV__ ? parseError : '无法识别该二维码，请使用主机生成的配对链接。'}</Text>
        </View>
      ) : null}

      <View style={styles.card}>
        <Text style={styles.inputLabel}>设备名称</Text>
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
        <Text style={styles.hint}>可以使用更容易识别的名称。</Text>
      </View>

      {__DEV__ && !isGroupNativeAvailable() ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>开发提示</Text>
          <Text style={styles.cardBody}>
            当前构建未链接群体版原生能力（P-256 设备密钥/签名）。请使用 Xcode 或 Gradle 构建的
            原生包，而不是 Expo Go。
          </Text>
        </View>
      ) : null}
    </>
  );

  const renderReviewPhase = () => {
    if (!pairing) return null;
    return (
      <>
        <View style={styles.header}>
          <Text style={styles.title}>确认主机身份</Text>
          <Text style={styles.subtitle}>
            请确认主机信息，然后开始配对。
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.inputLabel}>主机地址</Text>
          <Text style={styles.monoValue} selectable>
            {pairing.host}
          </Text>
          <View style={sharedStyles.divider} />
          <Text style={styles.inputLabel}>安全码</Text>
          <Text style={styles.shortFingerprint}>{shortFingerprint(pairing.hostFingerprint)}</Text>
          <Text style={styles.hint}>请与主机上显示的安全码一致。</Text>
          {__DEV__ ? (
            <>
              <Text style={styles.inputLabel}>中继域名</Text>
              <Text style={styles.monoValue} selectable>
                {pairing.relayDomain}
              </Text>
              <View style={sharedStyles.divider} />
              <Text style={styles.inputLabel}>服务端口</Text>
              <Text style={styles.monoValue} selectable>
                {pairing.port}
              </Text>
              <View style={sharedStyles.divider} />
              <Text style={styles.inputLabel}>主机指纹（完整 SHA-256 / base64url）</Text>
              <Text style={styles.monoValueSmall} selectable>
                {formatFingerprint(pairing.hostFingerprint)}
              </Text>
              <Text style={styles.hint}>
                短指纹仅用于人工对照；完整指纹才是权威值。群体服务版使用 P-256 设备密钥 +
                短时 token 认证（不使用设备 mTLS 证书）。
              </Text>
            </>
          ) : null}
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
            <Text style={styles.hint}>二维码过期后请重新生成。</Text>
          )}
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

        <Text style={styles.footnote}>配对信息保存在本机安全存储中。</Text>
        {__DEV__ ? (
          <Text style={styles.footnote}>
            配对会生成 P-256 设备密钥；私钥保存在系统安全区，访问 token 只存在内存与 `__Host-` cookie 中。
          </Text>
        ) : null}
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
          {GROUP_PHASE_LABELS.map((step) => (
            <Text key={step.key} style={styles.stepText}>
              · {step.label}
            </Text>
          ))}
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>主机端确认</Text>
        <Text style={styles.cardBody}>
          请在主机上确认本次配对请求（核对设备名称），然后点击「允许」。
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
        {__DEV__ && error?.code ? <Text style={styles.errorCode}>code: {error.code}</Text> : null}
      </View>
      {error?.code === 'native_unavailable' ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>开发提示</Text>
          <Text style={styles.cardBody}>
            群体版设备密钥/签名依赖 modules/dsh-mtls 原生模块。请使用 Xcode / Gradle 构建的
            原生包（expo run:ios / run:android），不要使用 Expo Go。
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
        {onCancel ? (
          <TouchableOpacity style={styles.cancelRow} onPress={onCancel}>
            <Text style={styles.cancelText}>‹ 返回主机列表</Text>
          </TouchableOpacity>
        ) : null}
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
  cancelRow: { paddingVertical: spacing.sm, marginBottom: spacing.xs },
  cancelText: { color: colors.accent, fontSize: 14 },
});
