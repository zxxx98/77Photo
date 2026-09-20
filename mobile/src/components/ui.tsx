import React, { type PropsWithChildren } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, spacing } from './theme';

export function Screen({ children }: PropsWithChildren) {
  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

export function Field({ label, ...props }: TextInputProps & { label: string }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        {...props}
        accessibilityLabel={label}
        placeholderTextColor={colors.muted}
        style={styles.input}
      />
    </View>
  );
}

export function PrimaryButton({
  label,
  loading = false,
  disabled = false,
  onPress,
}: {
  label: string;
  loading?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ busy: loading, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        pressed && !disabled ? styles.buttonPressed : undefined,
        disabled ? styles.buttonDisabled : undefined,
      ]}
    >
      {loading ? <ActivityIndicator color={colors.surface} /> : <Text style={styles.buttonText}>{label}</Text>}
    </Pressable>
  );
}

export function Message({ children, warning = false }: PropsWithChildren<{ warning?: boolean }>) {
  return <Text style={warning ? styles.warning : styles.error}>{children}</Text>;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  screen: {
    flexGrow: 1,
    backgroundColor: colors.background,
    padding: spacing.lg,
    gap: spacing.md,
  },
  field: { gap: spacing.xs },
  label: { color: colors.ink, fontSize: 15, fontWeight: '600' },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    backgroundColor: colors.surface,
    color: colors.ink,
    paddingHorizontal: spacing.md,
    fontSize: 16,
  },
  button: {
    minHeight: 48,
    borderRadius: 12,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  buttonPressed: { backgroundColor: colors.accentPressed },
  buttonDisabled: { opacity: 0.45 },
  buttonText: { color: colors.surface, fontSize: 16, fontWeight: '700' },
  warning: {
    color: colors.warningInk,
    backgroundColor: colors.warningBackground,
    borderRadius: 12,
    padding: spacing.md,
    lineHeight: 21,
  },
  error: { color: colors.error, lineHeight: 21 },
});
