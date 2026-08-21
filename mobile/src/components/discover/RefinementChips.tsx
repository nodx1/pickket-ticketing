/**
 * RefinementChips — 검색 조건 다듬기 칩 (Phase B.2)
 *
 * AI 응답 아래 표시 → 탭 시 해당 쿼리 세그먼트를 현재 쿼리에 덧붙여 재검색
 */
import { Text, TouchableOpacity, StyleSheet, ScrollView } from "react-native";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";

export interface Chip {
  id: string;
  label: string;
  append: string;
}

interface Props {
  chips: Chip[];
  onPress: (chip: Chip) => void;
}

export function RefinementChips({ chips, onPress }: Props) {
  const { colors } = useTheme();

  if (chips.length === 0) return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.container}
      contentContainerStyle={styles.content}
    >
      {chips.map((chip) => (
        <TouchableOpacity
          key={chip.id}
          onPress={() => onPress(chip)}
          style={[
            styles.chip,
            { backgroundColor: colors.surface, borderColor: colors.border },
          ]}
          accessibilityRole="button"
          accessibilityLabel={chip.label}
        >
          <Text style={[typography.bodySmall, { color: colors.foreground }]}>
            {chip.label}
          </Text>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    marginVertical: spacing.sm,
  },
  content: {
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    borderWidth: 1,
  },
});
