import { View, Text, StyleSheet, type ViewStyle } from "react-native";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";

type Variant = "default" | "success" | "warning" | "destructive" | "outline";

interface Props {
  label: string;
  variant?: Variant;
  style?: ViewStyle;
}

export function Badge({ label, variant = "default", style }: Props) {
  const { colors } = useTheme();

  const variantStyles: Record<Variant, { bg: string; text: string; border?: string }> = {
    default: { bg: colors.secondary, text: colors.secondaryForeground },
    success: { bg: colors.success + "20", text: colors.success },
    warning: { bg: colors.warning + "20", text: colors.warning },
    destructive: { bg: colors.destructive + "20", text: colors.destructive },
    outline: { bg: "transparent", text: colors.mutedForeground, border: colors.border },
  };

  const v = variantStyles[variant];

  return (
    <View
      style={[
        styles.badge,
        {
          backgroundColor: v.bg,
          borderWidth: v.border ? 1 : 0,
          borderColor: v.border,
        },
        style,
      ]}
    >
      <Text style={[styles.text, { color: v.text }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs / 2,
    borderRadius: radius.full,
    alignSelf: "flex-start",
  },
  text: {
    ...typography.micro,
    fontWeight: "600",
  },
});
