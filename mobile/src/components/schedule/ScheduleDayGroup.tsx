/**
 * 날짜별 일정 그룹 — 날짜 헤더 + ScheduleCard 리스트
 */
import { View, Text, StyleSheet } from "react-native";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing } from "@/config/theme";
import { ScheduleCard } from "./ScheduleCard";
import type { ScheduleDayGroupData } from "@/types/schedule";

interface Props {
  group: ScheduleDayGroupData;
}

export function ScheduleDayGroup({ group }: Props) {
  const { colors } = useTheme();

  return (
    <View style={styles.container}>
      <Text style={[typography.h3, styles.dateLabel, { color: colors.foreground }]}>
        {group.label}
      </Text>
      <View style={styles.cards}>
        {group.items.map((item) => (
          <ScheduleCard key={item.id} item={item} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: spacing.xxl,
  },
  dateLabel: {
    paddingHorizontal: spacing.xl,
    marginBottom: spacing.md,
  },
  cards: {
    paddingHorizontal: spacing.xl,
    gap: spacing.md,
  },
});
