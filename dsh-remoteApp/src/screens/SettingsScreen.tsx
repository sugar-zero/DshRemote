/**
 * SettingsScreen — App 设置页（版本 / 通知 / 缓存 / 设备与安全入口）。
 *
 * 从 Home 或 WebView 打开；设置项写 SecureStore，清理缓存调用原生模块
 * `clearWebCache()`（WKWebView 的 cache/cookie/存储 + URLCache）。
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  AppState,
  Linking,
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
import * as Notifications from 'expo-notifications';

import type { StoredConnection } from '../lib/store';
import { clearWebCache, isDshMtlsAvailable } from '../../modules/dsh-mtls/src';
import { colors, radii, sharedStyles, spacing, typography } from '../theme';

interface SettingsScreenProps {
  connection: StoredConnection | null;
  inAppNotificationsEnabled: boolean;
  onToggleInAppNotifications: (enabled: boolean) => void;
  onCacheCleared: () => void;
  onOpenDevices?: () => void;
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
  connection,
  inAppNotificationsEnabled,
  onToggleInAppNotifications,
  onCacheCleared,
  onOpenDevices,
  onClose,
}: SettingsScreenProps) {
  const insets = useSafeAreaInsets();
  const [permissionGranted, setPermissionGranted] = useState<boolean | null>(null);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');

  const refreshPermission = useCallback(async () => {
    try {
      const permission = await Notifications.getPermissionsAsync();
      setPermissionGranted(permission.granted === true);
    } catch {
      setPermissionGranted(null);
    }
  }, []);

  useEffect(() => {
    void refreshPermission();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refreshPermission();
    });
    return () => subscription.remove();
  }, [refreshPermission]);

  const sendTestNotification = async () => {
    if (busy !== '') return;
    setBusy('test');
    try {
      let granted = permissionGranted === true;
      if (!granted) {
        const requested = await Notifications.requestPermissionsAsync();
        granted = requested.granted === true;
        setPermissionGranted(granted);
      }
      if (!granted) {
        setNotice('通知权限未允许，无法发送测试通知；请在系统设置中允许通知');
        return;
      }
      await Notifications.scheduleNotificationAsync({
        content: {
          title: '应用内通知测试',
          body: '如果 App 在前台，应在 App 内显示这张卡片，而不是系统横幅。',
          sound: false,
        },
        trigger: null,
      });
      setNotice(inAppNotificationsEnabled ? '测试通知已发送：前台应显示应用内卡片' : '测试通知已发送：前台应显示系统横幅');
    } catch (error) {
      setNotice(`发送测试通知失败：${errorText(error)}`);
    } finally {
      setBusy('');
    }
  };

  const clearCache = async () => {
    if (busy !== '') return;
    setBusy('cache');
    try {
      if (!isDshMtlsAvailable) {
        throw new Error('当前构建未链接原生模块，无法清理 WebView 缓存；请使用包含 dsh-mtls 的构建');
      }
      const cleared = await clearWebCache();
      onCacheCleared();
      setNotice(cleared === false
        ? '清理缓存超时，正在重新加载；若仍看到旧数据请再试一次'
        : '缓存已清理，主机页面正在重新加载');
    } catch (error) {
      setNotice(`清理缓存失败：${errorText(error)}`);
    } finally {
      setBusy('');
    }
  };

  const confirmClearCache = () => {
    Alert.alert(
      '清理缓存',
      '将清理 WebView 的缓存、Cookie 与本地存储，并重新加载当前主机页面。配对证书不会被删除。',
      [
        { text: '取消', style: 'cancel' },
        { text: '清理', style: 'destructive', onPress: () => { void clearCache(); } },
      ],
    );
  };

  const openSystemSettings = () => {
    Linking.openSettings().catch(() => setNotice('无法打开系统设置，请到 iOS 设置 → 通知 → DSH Remote 中调整'));
  };

  const permissionText = permissionGranted === null ? '未知' : permissionGranted ? '已允许' : '未允许';

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
          <Text style={styles.sectionTitle}>通知</Text>
          <View style={styles.row}>
            <View style={styles.rowText}>
              <Text style={styles.rowLabel}>应用内通知</Text>
              <Text style={styles.rowHint}>
                开启：App 在前台收到推送时显示应用内卡片，不弹系统横幅；关闭：前台仍显示系统通知。后台始终是系统通知。
              </Text>
            </View>
            <Switch
              value={inAppNotificationsEnabled}
              onValueChange={onToggleInAppNotifications}
              trackColor={{ false: colors.borderStrong, true: colors.accentPressed }}
              thumbColor={inAppNotificationsEnabled ? colors.accent : colors.textMuted}
            />
          </View>
          <View style={styles.divider} />
          <View style={styles.row}>
            <View style={styles.rowText}>
              <Text style={styles.rowLabel}>通知权限</Text>
              <Text style={styles.rowHint}>后台推送需要系统通知权限；未允许时收不到任何通知。</Text>
            </View>
            <Text style={[styles.rowValue, permissionGranted === false ? styles.valueWarn : null]}>
              {permissionText}
            </Text>
          </View>
          <View style={styles.actions}>
            <TouchableOpacity style={sharedStyles.secondaryButton} onPress={openSystemSettings}>
              <Text style={sharedStyles.secondaryButtonText}>系统设置</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[sharedStyles.secondaryButton, busy === 'test' ? sharedStyles.disabledButton : null]}
              disabled={busy === 'test'}
              onPress={() => { void sendTestNotification(); }}
            >
              <Text style={sharedStyles.secondaryButtonText}>
                {busy === 'test' ? '发送中…' : '发送测试通知'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={sharedStyles.card}>
          <Text style={styles.sectionTitle}>缓存</Text>
          <Text style={styles.rowHint}>
            清理 WebView 的磁盘缓存、Cookie、localStorage 与 URLCache，然后重新加载主机页面。
            会话数据保存在主机上，不受影响。
          </Text>
          <View style={styles.actions}>
            <TouchableOpacity
              style={[sharedStyles.secondaryButton, busy === 'cache' ? sharedStyles.disabledButton : null]}
              disabled={busy === 'cache'}
              onPress={confirmClearCache}
            >
              <Text style={sharedStyles.secondaryButtonText}>
                {busy === 'cache' ? '清理中…' : '清理 WebView 缓存'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={sharedStyles.card}>
          <Text style={styles.sectionTitle}>设备与安全</Text>
          <Text style={styles.rowHint}>
            查看本机设备证书、诊断信息、App 锁开关，或重新配对/解除配对。
          </Text>
          <View style={styles.actions}>
            <TouchableOpacity
              style={[
                sharedStyles.secondaryButton,
                (!connection || !onOpenDevices) ? sharedStyles.disabledButton : null,
              ]}
              disabled={!connection || !onOpenDevices}
              onPress={() => onOpenDevices?.()}
            >
              <Text style={sharedStyles.secondaryButtonText}>
                {connection ? '打开设备与安全' : '尚未配对主机'}
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
          通知内容来自会话摘要，锁屏可见；可在 iOS 设置里关闭锁屏预览。
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
  rowText: { flex: 1, gap: 2 },
  rowLabel: { color: colors.text, fontSize: 15, fontWeight: '600' },
  rowHint: { color: colors.textMuted, fontSize: 12, lineHeight: 18, marginTop: 2 },
  rowValue: { color: colors.textMuted, fontSize: 13, maxWidth: '52%', textAlign: 'right' },
  valueWarn: { color: colors.warning },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: spacing.xs },
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
