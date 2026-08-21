import { View, Text, StyleSheet } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing } from "@/config/theme";
import { Button } from "@/components/ui/Button";

type IoniconsName = React.ComponentProps<typeof Ionicons>["name"];

interface Props {
  title: string;
  message?: string;
  actionLabel?: string;
  onAction?: () => void;
  icon?: IoniconsName;
  testID?: string;
  /** CTA 버튼에 부여할 testID (E2E에서 텍스트 매칭 ambiguity 방지) */
  actionTestID?: string;
}

/**
 * 빈 상태 표시 — 데이터가 없을 때 사용
 * 아이콘 + 제목 + 설명 + CTA 버튼
 */
export function EmptyState({ title, message, actionLabel, onAction, icon, testID, actionTestID }: Props) {
  const { colors } = useTheme();

  return (
    <View testID={testID} style={styles.container} accessibilityRole="alert" accessibilityLabel={`${title}${message ? `, ${message}` : ""}`}>
      {icon && (
        <View style={[styles.iconCircle, { backgroundColor: colors.muted }]}>
          <Ionicons name={icon} size={48} color={colors.primary} />
        </View>
      )}
      <Text style={[typography.h3, { color: colors.foreground, textAlign: "center" }]}>
        {title}
      </Text>
      {message && (
        <Text
          style={[
            typography.body,
            { color: colors.mutedForeground, textAlign: "center", marginTop: spacing.sm },
          ]}
        >
          {message}
        </Text>
      )}
      {actionLabel && onAction && (
        <View style={{ marginTop: spacing.xl }}>
          <Button title={actionLabel} onPress={onAction} variant="primary" size="lg" testID={actionTestID} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: spacing.xl,
  },
  iconCircle: {
    width: 96,
    height: 96,
    borderRadius: 48,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.lg,
  },
});
