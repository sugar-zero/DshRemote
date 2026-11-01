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
 *   - 「挂件贴底拖动」（iOS）：进入主机页面时 defer 底部「上滑回主屏」手势，默认开启；
 *     关闭后恢复一次上滑回主屏（挂件贴底时从底边起手拖可能被系统手势抢走）；
 *   - 不再有 APNs 推送 / 应用内通知 / 通知权限设置（群体版暂不实现本机推送）；
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
import { clearWebCache, isDshMtlsAvailable } from '../../modules/dsh-mtls/src';
import { colors, radii, sharedStyles, spacing, typography } from '../theme';

interface SettingsScreenProps {
  onCacheCleared: () => void;
  /** App 锁开关变化（App.tsx 用它同步内存状态；开关本身存 SecureStore）。 */
  onAppLockChanged?: (enabled: boolean) => void;
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

export function SettingsScreen({
  onCacheCleared,
  onAppLockChanged,
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
