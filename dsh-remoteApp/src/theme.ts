/**
 * Shared visual tokens for DSH Remote screens.
 * The POC intentionally keeps the styling local (no UI kit) so the shell stays
 * small; long-term the WebView carries the real DSH UI.
 */

import { Platform, StyleSheet } from 'react-native';

export const colors = {
  background: '#0B1220',
  surface: '#111A2C',
  surfaceRaised: '#16233B',
  border: '#243452',
  borderStrong: '#33507A',
  text: '#E6EDF7',
  textMuted: '#94A6C4',
  textFaint: '#61749A',
  accent: '#4F8DF7',
  accentPressed: '#3C74D6',
  success: '#3FD48C',
  warning: '#F5B84C',
  danger: '#F2637A',
  overlay: 'rgba(4, 9, 18, 0.72)',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radii = {
  sm: 8,
  md: 12,
  lg: 18,
  pill: 999,
} as const;

export const typography = {
  title: { fontSize: 24, fontWeight: '700', color: colors.text },
  subtitle: { fontSize: 15, color: colors.textMuted },
  body: { fontSize: 14, color: colors.text },
  label: { fontSize: 12, letterSpacing: 0.8, textTransform: 'uppercase', color: colors.textFaint },
  mono: {
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    fontSize: 12,
    color: colors.text,
  },
} as const;

export const sharedStyles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.lg,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  primaryButton: {
    backgroundColor: colors.accent,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
  },
  primaryButtonText: {
    color: '#04101F',
    fontSize: 16,
    fontWeight: '700',
  },
  secondaryButton: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
  },
  secondaryButtonText: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '600',
  },
  disabledButton: {
    opacity: 0.45,
  },
  input: {
    backgroundColor: colors.background,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    color: colors.text,
    fontSize: 15,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginVertical: spacing.md,
  },
});
