import { View, Text, TextInput, StyleSheet, type TextInputProps } from "react-native";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";

interface Props extends TextInputProps {
  label?: string;
  error?: string;
}

export function Input({ label, error, style, ...rest }: Props) {
  const { colors } = useTheme();

  return (
    <View>
      {label && (
        <Text style={[typography.h5, { color: colors.foreground, marginBottom: spacing.xs }]}>
          {label}
        </Text>
      )}
      <TextInput
        style={[
          styles.input,
          {
            backgroundColor: colors.secondary,
            borderColor: error ? colors.destructive : colors.border,
            color: colors.foreground,
            borderRadius: radius.md,
            paddingHorizontal: spacing.lg,
          },
          style,
        ]}
        placeholderTextColor={colors.mutedForeground}
        {...rest}
      />
      {error && (
        <Text style={[typography.bodySmall, { color: colors.destructive, marginTop: spacing.xs }]}>
          {error}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  input: {
    height: 48,
    borderWidth: 1,
    fontSize: 14,
  },
});
