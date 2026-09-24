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
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, radii, spacing } from './theme';

export function Screen({ children, contentStyle }: PropsWithChildren<{ contentStyle?: StyleProp<ViewStyle> }>) {
  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={[styles.screen, contentStyle]} keyboardShouldPersistTaps="handled">
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

export function Field({
  label, hint, error, trailing, style, ...props
}: TextInputProps & { label: string; hint?: string; error?: string; trailing?: React.ReactNode }) {
  const [focused, setFocused] = React.useState(false);
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <View style={[styles.inputRow, focused && styles.inputFocused, !!error && styles.inputError]}>
        <TextInput
          {...props}
          accessibilityLabel={label}
          accessibilityState={{ disabled: props.editable === false }}
          placeholderTextColor={colors.muted}
          onFocus={(event) => { setFocused(true); props.onFocus?.(event); }}
          onBlur={(event) => { setFocused(false); props.onBlur?.(event); }}
          style={[styles.input, style]}
        />
        {trailing}
      </View>
      {error ? <Text style={styles.inlineError}>{error}</Text> : hint ? <Text style={styles.hint}>{hint}</Text> : null}
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
    paddingHorizontal: 20,
    paddingVertical: spacing.lg,
    gap: spacing.md,
  },
  field: { gap: spacing.xs },
  label: { color: colors.ink, fontSize: 15, fontWeight: '600' },
  inputRow: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.control,
    backgroundColor: colors.input,
    flexDirection: 'row',
    alignItems: 'center',
  },
  inputFocused: { borderColor: colors.accent },
  inputError: { borderColor: colors.error },
  input: {
    flex: 1,
    minHeight: 48,
    color: colors.ink,
    paddingHorizontal: spacing.md,
    fontSize: 16,
  },
  button: {
    minHeight: 48,
    borderRadius: radii.control,
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
  inlineError: { color: colors.error, fontSize: 13, lineHeight: 18 },
  hint: { color: colors.muted, fontSize: 13 },
});
