/**
 * SettingsScreen — App「系统设置」页（版本 / App 锁 / 主机页面手势 / 缓存）。
 *
 * 只从**主机列表（外面）**右上角的 ⚙ 进入：这里是 App 级配置。
 * 单台主机的连接设置（设备身份 / 打开此连接时要求面容 / 解除本机配对）不在本页，
 * 从该主机卡片上的 ⚙ 或**进入主机后**顶栏的 ⚙ 打开「设备与安全」。
 *
 * 群体服务版（A 模式）：
 *   - 全局 App 锁开关在这里（本页）：**只负责 App 冷启动解锁**（Face ID / Touch ID），
 *     打开主机连接、同步信息、心跳、切会话、回前台都不要求识别；
 *   - 单台主机的「打开此连接时要求面容」开关在 DevicesScreen（设备与安全），
 *     仅在全局 App 锁开启时生效；
 *   - 「推送」（0.1.8+；0.1.9 R2）：本地偏好开关（默认开）、推送通道（官方=设备直连 /
 *     自部署=经 relay）、当前状态（已注册/未注册/权限被拒/服务器未开启/错误原因）、
 *     「重新注册」按钮；从当前主机的 `/__dsh_remote/status.push` 显示按通道的已登记
 *     设备数与失败原因（旧版 Host 无该字段时显示未知）。
 *     APNs device token / 官方 credential 不打印；被拒/失败只提示，不影响进入主机；
 *   - 「挂件贴底拖动」（iOS）：进入主机页面时 defer 底部「上滑回主屏」手势，默认开启；
 *     关闭后恢复一次上滑回主屏（挂件贴底时从底边起手拖可能被系统手势抢走）；
 *   - 不再有 classic/mTLS/设备证书相关设置项；
 *   - 清理缓存调用原生模块 `clearWebCache()`（WKWebView 的 cache/cookie/存储 + URLCache）。
 */
import { useCallback, useEffect, useState } from 'react';
import {
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
import * as Application from 'expo-application';

import {
  getBiometricAvailability,
  isAppLockEnabled,
  setAppLockEnabled,
  type BiometricAvailability,
} from '../lib/appLock';
import {
  isBottomEdgeGestureDeferralEnabled,
  setBottomEdgeGestureDeferralEnabled,
} from '../lib/settings';
import {
  getPushStatus,
  isPushEnabled,
  readServerPushStatus,
  registerPushForConnection,
  setPushEnabled,
  type PushStatus,
} from '../lib/push';
import { PUSH_CHANNEL } from '../lib/pushConfig';
import type { GroupPushServerStatusData } from '../lib/protocol';
import type { StoredConnection } from '../lib/store';
import { clearWebCache, isDshMtlsAvailable } from '../../modules/dsh-mtls/src';
import { colors, radii, sharedStyles, spacing, typography } from '../theme';

interface SettingsScreenProps {
  onCacheCleared: () => void;
  /** App 锁开关变化（App.tsx 用它同步内存状态；开关本身存 SecureStore）。 */
  onAppLockChanged?: (enabled: boolean) => void;
  /** 当前/最近打开的主机连接：用于「重新注册」与读取服务端推送状态；null = 还没进过主机。 */
  pushTarget?: StoredConnection | null;
  onClose: () => void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatVersion(): string {
  const version = Application.nativeApplicationVersion ?? '—';
  const build = Application.nativeBuildVersion ?? '—';
  return `${version} (build ${build})`;
}

/** 推送状态 → 设置页文案（通道来自登记结果，缺失时用构建标记兜底）。 */
function describePushState(status: PushStatus | null): string {
  if (!status) return '检测中…';
  switch (status.state) {
    case 'registered': {
      const channel = status.mode ?? status.channel;
      if (channel === 'official') return '已注册（官方推送）';
      if (channel === 'self') return '已注册（自部署）';
      return '已注册';
    }
    case 'denied':
      return '通知权限被拒';
    case 'unavailable':
      // 「尚未登记 / 已开启待登记」是正常初态，显示未注册；其它（无 token、服务器未开推送）按暂不可用。
      if (status.error?.includes('尚未登记') || status.error?.includes('已开启，进入主机后')) {
        return '未注册';
      }
      return '暂不可用';
    case 'error':
      return '登记失败';
    case 'off':
      return '已关闭';
    default:
      return '未知';
  }
}

function defaultPushSwitchStatus(enabled: boolean): PushStatus {
  return enabled
    ? { state: 'unavailable', channel: PUSH_CHANNEL, error: '已开启，进入主机后自动登记推送 token' }
    : { state: 'off', channel: PUSH_CHANNEL };
}

/**
 * 主机 status.push →「服务器」行文案。
 * R2（host-plugin 0.2.6+）有按通道的 `self`/`official`；旧版 Host 只有扁平字段。
 */
function describeServerPushState(status: GroupPushServerStatusData | null): string {
  if (status === null) return '未知（旧版主机或状态暂不可达）';
  const selfDevices = status.self?.devices ?? 0;
  const officialDevices = status.official?.devices ?? 0;
  if (status.self !== undefined || status.official !== undefined) {
    if (status.mode === 'mixed' || (selfDevices > 0 && officialDevices > 0)) {
      return '已开启推送（自部署 + 官方混用）';
    }
    if (officialDevices > 0) return '已开启推送（官方）';
    if (selfDevices > 0) return '已开启推送（自部署）';
    return status.enabled === false ? '未开启推送' : '已开启推送（暂无已登记设备）';
  }
  if (status.serverEnabled === false) return '未开启推送';
  if (status.serverEnabled === true) return '已开启推送';
  return '未知';
}

/** 某通道已登记设备数（旧版 Host 没有按通道拆分时显示 未知）。 */
function describeChannelDevices(
  status: GroupPushServerStatusData,
  channel: 'self' | 'official',
): string {
  const data = channel === 'self' ? status.self : status.official;
  if (data === undefined) {
    if (typeof status.tokens === 'number' && status.mode === channel) return `${status.tokens} 台（旧版统计）`;
    return '未知';
  }
  return typeof data.devices === 'number' ? `${data.devices} 台` : '未知';
}

/** 主机侧推送错误（按通道；不含 token/credential）。 */
function pushServerErrors(status: GroupPushServerStatusData): string[] {
  const lines: string[] = [];
  if (status.self?.lastError) lines.push(`自部署：${status.self.lastError}`);
  if (status.official?.lastError) lines.push(`官方：${status.official.lastError}`);
  if (status.self === undefined && status.official === undefined && status.lastError) {
    lines.push(status.lastError);
  }
  return lines;
}

/** 官方 hub 基址 → 只显示 host（UI 行宽有限；不含凭据）。 */
function displayHubHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

export function SettingsScreen({
  onCacheCleared,
  onAppLockChanged,
  pushTarget = null,
  onClose,
}: SettingsScreenProps) {
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  // App 锁：开关值存 SecureStore；生物识别能力用于提示/阻止在未录入时开启。
  const [appLockEnabled, setAppLockEnabledState] = useState(false);
  const [biometrics, setBiometrics] = useState<BiometricAvailability | null>(null);
  // 主机页面底部手势 defer（iOS）：默认开启，关闭后恢复一次上滑回主屏。
  const [bottomEdgeDeferral, setBottomEdgeDeferralState] = useState(true);
  // 推送（iOS APNs）：本地开关 + 当前状态 + 主机侧 `/__dsh_remote/status.push`。
  const [pushEnabledState, setPushEnabledState] = useState(true);
  const [pushStatus, setPushStatus] = useState<PushStatus | null>(null);
  const [serverPush, setServerPush] = useState<GroupPushServerStatusData | null>(null);
  const [pushBusy, setPushBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      isAppLockEnabled(),
      getBiometricAvailability(),
      isBottomEdgeGestureDeferralEnabled(),
    ]).then(([enabled, availability, deferral]) => {
      if (cancelled) return;
      setAppLockEnabledState(enabled);
      setBiometrics(availability);
      setBottomEdgeDeferralState(deferral);
    });
    return () => { cancelled = true; };
  }, []);

  // 推送状态：本地开关/权限 + 当前主机的服务端状态（旧版 Host 没有 push 字段 → 未知）。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [enabled, status] = await Promise.all([isPushEnabled(), getPushStatus()]);
      if (cancelled) return;
      setPushEnabledState(enabled);
      setPushStatus(status);
      if (pushTarget) {
        const server = await readServerPushStatus(pushTarget);
        if (!cancelled) setServerPush(server);
      }
    })();
    return () => { cancelled = true; };
  }, [pushTarget]);

  const handleTogglePush = useCallback(async (enabled: boolean) => {
    if (pushBusy) return;
    setPushEnabledState(enabled);
    await setPushEnabled(enabled);
    if (!enabled) {
      setPushStatus(defaultPushSwitchStatus(false));
      setNotice('已关闭本机推送登记。已登记的 token 需要主机「推送提醒」关闭或解除配对后才会彻底停止通知。');
      return;
    }
    if (!pushTarget) {
      setPushStatus(defaultPushSwitchStatus(true));
      setNotice('已开启推送。进入任意主机后会自动登记推送 token。');
      return;
    }
    setPushBusy(true);
    try {
      const result = await registerPushForConnection(pushTarget, { force: true, requestPermission: true });
      setPushStatus(result);
      setServerPush(await readServerPushStatus(pushTarget));
      setNotice(result.ok
        ? `已登记推送 token${result.environment ? `（APNs ${result.environment}）` : ''}。`
        : `推送登记未完成：${result.error ?? '未知原因'}`);
    } catch (error) {
      setNotice(`推送登记失败：${errorText(error)}`);
    } finally {
      setPushBusy(false);
    }
  }, [pushBusy, pushTarget]);

  const handleReregisterPush = useCallback(async () => {
    if (pushBusy) return;
    if (!pushTarget) {
      setNotice('还没有已配对主机：请先进入一台主机，再回到设置页重新注册推送。');
      return;
    }
    setPushBusy(true);
    try {
      const result = await registerPushForConnection(pushTarget, { force: true, requestPermission: true });
      setPushStatus(result);
      setServerPush(await readServerPushStatus(pushTarget));
      setNotice(result.ok
        ? `已重新登记推送 token${result.environment ? `（APNs ${result.environment}）` : ''}。`
        : `推送登记未完成：${result.error ?? '未知原因'}`);
    } catch (error) {
      setNotice(`推送登记失败：${errorText(error)}`);
    } finally {
      setPushBusy(false);
    }
  }, [pushBusy, pushTarget]);

  const handleToggleBottomEdgeDeferral = useCallback(async (enabled: boolean) => {
    setBottomEdgeDeferralState(enabled);
    await setBottomEdgeGestureDeferralEnabled(enabled);
  }, []);

  const handleToggleAppLock = useCallback(async (enabled: boolean) => {
    if (enabled && biometrics && !biometrics.enrolled) {
      Alert.alert(
        '无法开启 App 锁',
        `${biometrics.label} 尚未在系统中设置。请先在系统设置里录入生物识别，再回到这里开启。`,
      );
      return;
    }
    await setAppLockEnabled(enabled);
    setAppLockEnabledState(enabled);
    onAppLockChanged?.(enabled);
  }, [biometrics, onAppLockChanged]);

  const biometricsLabel = biometrics === null
    ? '检测中…'
    : biometrics.available
      ? biometrics.enrolled
        ? `${biometrics.label} 已设置`
        : `${biometrics.label} 未设置`
      : '设备不支持生物识别';

  const clearCache = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (!isDshMtlsAvailable) {
        throw new Error('当前构建未链接原生模块，无法清理 WebView 缓存；请使用包含 dsh-mtls 的原生构建');
      }
      const cleared = await clearWebCache();
      onCacheCleared();
      setNotice(cleared === false
        ? '清理缓存超时，正在重新加载；若仍看到旧数据请再试一次'
        : '缓存已清理，主机页面正在重新加载');
    } catch (error) {
      setNotice(`清理缓存失败：${errorText(error)}`);
    } finally {
      setBusy(false);
    }
  }, [busy, onCacheCleared]);

  const confirmClearCache = useCallback(() => {
    Alert.alert(
      '清理缓存',
      '将清理 WebView 的缓存、Cookie 与本地存储，并重新加载当前主机页面。配对信息与设备密钥不会被删除。',
      [
        { text: '取消', style: 'cancel' },
        { text: '清理', style: 'destructive', onPress: () => { void clearCache(); } },
      ],
    );
  }, [clearCache]);

  return (
    <View style={styles.screen}>
      <View style={[styles.topBar, { paddingTop: insets.top + spacing.sm }]}>
        <TouchableOpacity accessibilityLabel="返回" onPress={onClose} style={styles.iconButton}>
          <Text style={styles.iconGlyph}>‹</Text>
        </TouchableOpacity>
        <Text style={styles.topTitle}>设置</Text>
        <View style={styles.iconButton} />
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xl }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={sharedStyles.card}>
          <Text style={styles.sectionTitle}>版本</Text>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>DSH Remote</Text>
            <Text style={styles.rowValue}>{formatVersion()}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Bundle ID</Text>
            <Text style={styles.rowValue} numberOfLines={1}>{Application.applicationId ?? '—'}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>系统</Text>
            <Text style={styles.rowValue}>
              {Platform.OS === 'ios' ? `iOS ${Platform.Version}` : `${Platform.OS} ${Platform.Version}`}
            </Text>
          </View>
        </View>

        <View style={sharedStyles.card}>
          <Text style={styles.sectionTitle}>App 锁（冷启动解锁）</Text>
          <View style={styles.switchRow}>
            <View style={styles.switchText}>
              <Text style={styles.rowLabel}>App 冷启动时要求生物识别</Text>
              <Text style={styles.rowHint}>{biometricsLabel}</Text>
            </View>
            <Switch
              value={appLockEnabled}
              onValueChange={(enabled) => { void handleToggleAppLock(enabled); }}
              trackColor={{ false: colors.borderStrong, true: colors.accentPressed }}
              thumbColor={appLockEnabled ? colors.accent : colors.textMuted}
            />
          </View>
          <Text style={styles.rowHint}>
            开启后，App 冷启动首次进入时需用 Face ID / Touch ID / 指纹解锁；打开主机连接、
            同步信息、心跳与切换会话均不会再次要求识别。若希望某台主机在打开时也要求识别，
            请在该主机卡片上点 ⚙（或进入该主机后点顶栏 ⚙）打开「设备与安全」，再单独开启
            「打开此连接时要求面容」。
          </Text>
        </View>

        <View style={sharedStyles.card}>
          <Text style={styles.sectionTitle}>推送</Text>
          <View style={styles.switchRow}>
            <View style={styles.switchText}>
              <Text style={styles.rowLabel}>推送提醒</Text>
              <Text style={styles.rowHint}>{describePushState(pushStatus)}</Text>
            </View>
            <Switch
              value={pushEnabledState}
              onValueChange={(enabled) => { void handleTogglePush(enabled); }}
              trackColor={{ false: colors.borderStrong, true: colors.accentPressed }}
              thumbColor={pushEnabledState ? colors.accent : colors.textMuted}
            />
          </View>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>推送通道</Text>
            <Text style={styles.rowValue}>
              {PUSH_CHANNEL === 'official' ? '官方（设备直连）' : '自部署（经 relay）'}
            </Text>
          </View>
          {pushStatus?.error ? (
            <Text style={[styles.rowHint, styles.pushError]}>{pushStatus.error}</Text>
          ) : null}
          {pushTarget ? (
            <View style={styles.pushServerRows}>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>服务器</Text>
                <Text style={styles.rowValue}>{describeServerPushState(serverPush)}</Text>
              </View>
              {serverPush !== null ? (
                serverPush.self !== undefined || serverPush.official !== undefined ? (
                  <>
                    <View style={styles.row}>
                      <Text style={styles.rowLabel}>自部署设备</Text>
                      <Text style={styles.rowValue}>{describeChannelDevices(serverPush, 'self')}</Text>
                    </View>
                    <View style={styles.row}>
                      <Text style={styles.rowLabel}>官方设备</Text>
                      <Text style={styles.rowValue}>{describeChannelDevices(serverPush, 'official')}</Text>
                    </View>
                    {serverPush.official?.hub ? (
                      <View style={styles.row}>
                        <Text style={styles.rowLabel}>官方 hub</Text>
                        <Text style={styles.rowValue} numberOfLines={1}>
                          {displayHubHost(serverPush.official.hub)}
                        </Text>
                      </View>
                    ) : null}
                    {pushServerErrors(serverPush).map((line) => (
                      <Text key={line} style={[styles.rowHint, styles.pushError]}>{line}</Text>
                    ))}
                  </>
                ) : (
                  <>
                    {typeof serverPush.tokens === 'number' ? (
                      <View style={styles.row}>
                        <Text style={styles.rowLabel}>主机已登记设备</Text>
                        <Text style={styles.rowValue}>{serverPush.tokens}</Text>
                      </View>
                    ) : null}
                    {serverPush.lastError ? (
                      <Text style={[styles.rowHint, styles.pushError]}>主机侧错误：{serverPush.lastError}</Text>
                    ) : null}
                  </>
                )
              ) : null}
            </View>
          ) : null}
          <Text style={styles.rowHint}>
            iOS APNs：进入主机并拿到访问令牌后自动登记 APNs device token（不落盘、不打印）。
            官方构建走官方推送 hub（本机设备凭证由设备私钥登记，主机直连 hub，不依赖 relay 的推送配置）；
            自部署构建经 relay。前台/后台/锁屏都由系统显示通知；点击通知打开对应主机，
            自部署模式可直达会话。关闭本开关只停止本机登记；要彻底停止通知，请在主机
            「设置 → 远程访问 → 推送提醒」关闭。
            {Platform.OS === 'ios' ? '' : '（Android FCM 未接入，本开关不生效。）'}
          </Text>
          <View style={styles.actions}>
            <TouchableOpacity
              style={[sharedStyles.secondaryButton, pushBusy ? sharedStyles.disabledButton : null]}
              disabled={pushBusy}
              onPress={() => { void handleReregisterPush(); }}
            >
              <Text style={sharedStyles.secondaryButtonText}>{pushBusy ? '登记中…' : '重新注册'}</Text>
            </TouchableOpacity>
          </View>
        </View>

        {Platform.OS === 'ios' ? (
          <View style={sharedStyles.card}>
            <Text style={styles.sectionTitle}>主机页面手势</Text>
            <View style={styles.switchRow}>
              <View style={styles.switchText}>
                <Text style={styles.rowLabel}>挂件贴底拖动</Text>
                <Text style={styles.rowHint}>
                  开启时，主机页面内从屏幕最底边上滑回主屏需连划两次
                </Text>
              </View>
              <Switch
                value={bottomEdgeDeferral}
                onValueChange={(enabled) => { void handleToggleBottomEdgeDeferral(enabled); }}
                trackColor={{ false: colors.borderStrong, true: colors.accentPressed }}
                thumbColor={bottomEdgeDeferral ? colors.accent : colors.textMuted}
              />
            </View>
            <Text style={styles.rowHint}>
              开启：进入主机页面时 defer iOS 底部（Home 指示条）的「上滑回主屏」系统手势——页面里
              可拖动的悬浮挂件贴到屏幕最底边后，仍能按住自由拖动，不会被系统手势切到后台；
              代价是从最底边上滑回主屏要连划两次（第一次只高亮 Home 指示条）。
              关闭：恢复系统默认（一次上滑即回主屏）；挂件贴到最底边时从底边起手拖动仍可能被
              系统手势抢走。两者都只影响「进入主机页面后」，主机列表 / 本设置页不受影响。
            </Text>
          </View>
        ) : null}

        <View style={sharedStyles.card}>
          <Text style={styles.sectionTitle}>缓存</Text>
          <Text style={styles.rowHint}>
            清理 WebView 的磁盘缓存、Cookie、localStorage 与 URLCache，然后重新加载主机页面。
            会话数据保存在主机上，不受影响。
          </Text>
          <View style={styles.actions}>
            <TouchableOpacity
              style={[sharedStyles.secondaryButton, busy ? sharedStyles.disabledButton : null]}
              disabled={busy}
              onPress={confirmClearCache}
            >
              <Text style={sharedStyles.secondaryButtonText}>
                {busy ? '清理中…' : '清理 WebView 缓存'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        {notice ? (
          <View style={styles.notice}>
            <Text style={styles.noticeText}>{notice}</Text>
          </View>
        ) : null}

        <Text style={styles.footer}>
          DSH Remote · AGPL-3.0-or-later{'\n'}
          群体服务版：P-256 设备密钥 + 短时 token；relay 终止手机 TLS，部署方可见会话明文。
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.sm,
    paddingBottom: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  topTitle: { color: colors.text, fontSize: 17, fontWeight: '700' },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  iconGlyph: { color: colors.text, fontSize: 30, lineHeight: 32 },
  content: { padding: spacing.lg, gap: spacing.md },
  sectionTitle: {
    ...typography.label,
    marginBottom: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  rowLabel: { color: colors.text, fontSize: 15, fontWeight: '600' },
  rowHint: { color: colors.textMuted, fontSize: 12, lineHeight: 18, marginTop: 2 },
  rowValue: { color: colors.textMuted, fontSize: 13, maxWidth: '52%', textAlign: 'right' },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  switchText: {
    flex: 1,
    gap: 2,
  },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  pushServerRows: {
    marginTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: spacing.xs,
  },
  pushError: { color: colors.danger },
  notice: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    padding: spacing.md,
  },
  noticeText: { color: colors.text, fontSize: 13, lineHeight: 19 },
  footer: { ...typography.subtitle, fontSize: 11, lineHeight: 17, textAlign: 'center', marginTop: spacing.sm },
});
