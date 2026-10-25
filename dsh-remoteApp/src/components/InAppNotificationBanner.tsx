/**
 * 应用内通知卡片（前台推送）。
 *
 * App 在前台收到推送时，通知 handler 会抑制系统横幅；这里用一张顶部浮层卡片
 * 展示标题/正文，点击可打开主机（或仅关闭），5 秒自动消失。
 * 锁屏（App 锁）状态下不渲染，避免内容出现在锁屏之上。
 */
import { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, radii, spacing, typography } from '../theme';

export interface InAppNotificationMessage {
  id: string;
  title: string;
  body: string;
  /** 推送所属会话；点击卡片时用于跳到对应会话。 */
  sessionId?: string;
  /** 推送所属主机地址（与 StoredConnection.host 一致）。 */
  host?: string;
}

interface InAppNotificationBannerProps {
  notification: InAppNotificationMessage | null;
  onDismiss: () => void;
  /** 点击卡片（可选）：App 可在此打开对应主机。 */
  onPress?: () => void;
}

export function InAppNotificationBanner({ notification, onDismiss, onPress }: InAppNotificationBannerProps) {
  const insets = useSafeAreaInsets();
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(-10)).current;

  useEffect(() => {
    if (!notification) return;
    opacity.setValue(0);
    translateY.setValue(-10);
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: true }),
      Animated.timing(translateY, { toValue: 0, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
    ]).start();
  }, [notification, opacity, translateY]);

  if (!notification) return null;

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[styles.wrap, { top: insets.top + spacing.sm, opacity, transform: [{ translateY }] }]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`应用内通知：${notification.title}`}
        onPress={onPress ?? onDismiss}
        style={styles.card}
      >
        <Text style={styles.title} numberOfLines={1}>
          {notification.title}
        </Text>
        {notification.body ? (
          <Text style={styles.body} numberOfLines={3}>
            {notification.body}
          </Text>
        ) : null}
        <Text style={styles.hint}>{onPress ? (notification.sessionId ? '点击打开对应会话' : '点击打开主机') : '点击关闭'}</Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    zIndex: 1000,
    elevation: 12,
  },
  card: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    gap: 2,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
  },
  title: {
    ...typography.body,
    fontSize: 15,
    fontWeight: '700',
  },
  body: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 2,
  },
  hint: {
    color: colors.textFaint,
    fontSize: 11,
    marginTop: spacing.xs,
  },
});
