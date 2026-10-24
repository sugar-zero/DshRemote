/**
 * SessionListSheet — 原生会话列表（覆盖在 WebView 上方）。
 *
 * 数据来自 mobileSessionBridge：只读标题/时间/工作区，不保存 DSH 会话内容。
 * 点会话 → 原生通过 bridge 调 DSH 自己的 open handler，一次点击即进入。
 */
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { colors, radii, sharedStyles, spacing, typography } from '../theme';

export interface MobileSessionSummary {
  id: string;
  title: string;
  time: string;
  workspace: string;
  selected: boolean;
}

interface SessionListSheetProps {
  visible: boolean;
  hostName: string;
  sessions: MobileSessionSummary[];
  loading: boolean;
  error: string | null;
  onBack: () => void;
  onSelect: (session: MobileSessionSummary) => void;
  onNewSession: () => void;
  onOpenPlugins: () => void;
  onContinue: () => void;
  onRefresh: () => void;
}

export function SessionListSheet({
  visible,
  hostName,
  sessions,
  loading,
  error,
  onBack,
  onSelect,
  onNewSession,
  onOpenPlugins,
  onContinue,
  onRefresh,
}: SessionListSheetProps) {
  const insets = useSafeAreaInsets();
  if (!visible) return null;

  return (
    <View style={styles.overlay}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="返回主机列表"
          onPress={onBack}
          style={styles.iconButton}
        >
          <Text style={styles.backGlyph}>‹</Text>
        </TouchableOpacity>
        <View style={styles.headerText}>
          <Text style={styles.title}>会话</Text>
          <Text style={styles.host} numberOfLines={1}>
            {hostName}
          </Text>
        </View>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="刷新会话列表"
          onPress={onRefresh}
          style={styles.iconButton}
        >
          <Text style={styles.smallGlyph}>↻</Text>
        </TouchableOpacity>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="新建会话"
          onPress={onNewSession}
          style={[styles.iconButton, styles.accentButton]}
        >
          <Text style={styles.plusGlyph}>＋</Text>
        </TouchableOpacity>
      </View>

      {error ? (
        <View style={styles.errorBar}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <FlatList
        data={sessions}
        keyExtractor={(item) => item.id}
        contentContainerStyle={[
          styles.listContent,
          { paddingBottom: spacing.lg },
          sessions.length === 0 && styles.emptyContent,
        ]}
        renderItem={({ item }) => (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={`打开会话 ${item.title}`}
            onPress={() => onSelect(item)}
            style={[styles.row, item.selected && styles.rowSelected]}
          >
            <View style={styles.rowText}>
              <Text style={[styles.rowTitle, item.selected && styles.rowTitleSelected]} numberOfLines={2}>
                {item.title}
              </Text>
              <Text style={styles.rowMeta} numberOfLines={1}>
                {[item.workspace, item.time].filter(Boolean).join(' · ') || '会话'}
              </Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </TouchableOpacity>
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            {loading ? (
              <>
                <ActivityIndicator color={colors.accent} />
                <Text style={styles.emptyText}>正在从主机读取会话…</Text>
              </>
            ) : (
              <>
                <Text style={styles.emptyTitle}>还没有可见的会话</Text>
                <Text style={styles.emptyText}>可以直接进入 DSH 界面，或点右上角 ＋ 新建会话。</Text>
              </>
            )}
          </View>
        }
      />

      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.sm }]}>
        <TouchableOpacity style={styles.pluginButton} onPress={onOpenPlugins}>
          <Text style={styles.pluginButtonText}>插件 / 完整 DSH 界面</Text>
          <Text style={styles.pluginHint}>主机插件、自动化任务、设置都在这里</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.continueButton} onPress={onContinue}>
          <Text style={styles.continueText}>直接进入当前 DSH 界面</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: colors.background,
    zIndex: 100,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  headerText: { flex: 1, minWidth: 0 },
  title: { color: colors.text, fontSize: 20, fontWeight: '700' },
  host: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  iconButton: {
    width: 38,
    height: 38,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  accentButton: { backgroundColor: colors.accent },
  backGlyph: { color: colors.text, fontSize: 26, lineHeight: 28, marginTop: -2 },
  smallGlyph: { color: colors.text, fontSize: 18 },
  plusGlyph: { color: '#04101F', fontSize: 22, fontWeight: '700', lineHeight: 24 },
  listContent: { paddingHorizontal: spacing.md, paddingTop: spacing.sm, gap: spacing.xs },
  emptyContent: { flexGrow: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  rowSelected: { borderColor: colors.accent, backgroundColor: colors.surfaceRaised },
  rowText: { flex: 1, minWidth: 0, gap: 4 },
  rowTitle: { color: colors.text, fontSize: 15, fontWeight: '600', lineHeight: 21 },
  rowTitleSelected: { color: colors.accent },
  rowMeta: { color: colors.textMuted, fontSize: 12 },
  chevron: { color: colors.textFaint, fontSize: 22 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, padding: spacing.xl },
  emptyTitle: { color: colors.text, fontSize: 16, fontWeight: '600' },
  emptyText: { color: colors.textMuted, fontSize: 13, textAlign: 'center', lineHeight: 19 },
  errorBar: { backgroundColor: 'rgba(242, 99, 122, 0.15)', paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  errorText: { color: colors.danger, fontSize: 12 },
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    gap: spacing.sm,
    backgroundColor: colors.surface,
  },
  pluginButton: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    gap: 2,
  },
  pluginButtonText: { color: colors.text, fontSize: 15, fontWeight: '600' },
  pluginHint: { color: colors.textMuted, fontSize: 11 },
  continueButton: { alignItems: 'center', paddingVertical: spacing.sm },
  continueText: { color: colors.accent, fontSize: 13, fontWeight: '600' },
});
