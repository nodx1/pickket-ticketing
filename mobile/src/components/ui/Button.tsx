import {
  TouchableOpacity,
  Text,
  ActivityIndicator,
  StyleSheet,
  type ViewStyle,
  type TextStyle,
} from "react-native";
import { useTheme } from "@/hooks/useTheme";
import { typography, radius, buttonHeights, spacing } from "@/config/theme";

type Variant = "primary" | "secondary" | "outline" | "ghost" | "destructive";
type Size = "xs" | "sm" | "md" | "lg" | "xl";

interface Props {
  title: string;
  onPress: () => void;
  variant?: Variant;
  size?: Size;
  disabled?: boolean;
  loading?: boolean;
  style?: ViewStyle;
  textStyle?: TextStyle;
  accessibilityLabel?: string;
  testID?: string;
}

export function Button({
  title,
  onPress,
  variant = "primary",
  size = "lg",
  disabled = false,
  loading = false,
  style,
  textStyle,
  accessibilityLabel,
  testID,
}: Props) {
  const { colors } = useTheme();

  const variantStyles: Record<Variant, { bg: string; text: string; border?: string }> = {
    primary: { bg: colors.primary, text: colors.primaryForeground },
    secondary: { bg: colors.secondary, text: colors.secondaryForeground },
    outline: { bg: "transparent", text: colors.foreground, border: colors.border },
    ghost: { bg: "transparent", text: colors.foreground },
    destructive: { bg: colors.destructive, text: "#FFFFFF" },
  };

  const sizeTextStyles: Record<Size, TextStyle> = {
    xs: typography.micro,
    sm: typography.bodySmall,
    md: typography.h5,
    lg: typography.h4,
    xl: typography.h4,
  };

  const v = variantStyles[variant];

  return (
    <TouchableOpacity
      style={[
        styles.base,
        {
          backgroundColor: v.bg,
          height: buttonHeights[size],
          borderRadius: radius.full,
          borderWidth: v.border ? 1 : 0,
          borderColor: v.border,
          opacity: disabled || loading ? 0.6 : 1,
          paddingHorizontal: size === "xs" ? spacing.sm : spacing.xl,
        },
        style,
      ]}
      onPress={onPress}
      disabled={disabled || loading}
      activeOpacity={0.8}
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityRole="button"
      testID={testID}
    >
      {loading ? (
        <ActivityIndicator color={v.text} size="small" />
      ) : (
        <Text style={[sizeTextStyles[size], { color: v.text }, textStyle]}>
          {title}
        </Text>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: "center",
    justifyContent: "center",
  },
});
