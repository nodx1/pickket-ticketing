/**
 * 일정 필터 칩 — 가로 스크롤, 카테고리 필터링
 */
import { useCallback } from "react";
import { ScrollView, TouchableOpacity, Text, StyleSheet } from "react-native";
import { useTheme } from "@/hooks/useTheme";
import { useTranslation } from "react-i18next";
import { typography, spacing, radius } from "@/config/theme";
import * as haptics from "@/lib/haptics";
import type { ScheduleFilter } from "@/types/schedule";

const FILTERS: { key: ScheduleFilter; labelKey: string }[] = [
  { key: "all", labelKey: "schedule.filter.all" },
  { key: "concert", labelKey: "schedule.filter.concert" },
  { key: "fanmeeting", labelKey: "schedule.filter.fanmeeting" },
  { key: "broadcast", labelKey: "schedule.filter.broadcast" },
  { key: "festival", labelKey: "schedule.filter.festival" },
  { key: "bookable", labelKey: "schedule.filter.bookable" },
];

interface Props {
  selected: ScheduleFilter;
  onSelect: (filter: ScheduleFilter) => void;
}

export function ScheduleFilterChips({ selected, onSelect }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();

  const handlePress = useCallback(
    (filter: ScheduleFilter) => {
      haptics.selectionFeedback();
      onSelect(filter);
    },
    [onSelect],
  );

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.container}
    >
      {FILTERS.map((f) => {
        const active = f.key === selected;
        return (
          <TouchableOpacity
            key={f.key}
            onPress={() => handlePress(f.key)}
            style={[
              styles.chip,
              {
                backgroundColor: active ? colors.primary : colors.secondary,
                borderColor: active ? colors.primary : colors.border,
              },
            ]}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
          >
            <Text
              style={[
                typography.h5,
                {
                  color: active ? colors.primaryForeground : colors.foreground,
                },
              ]}
            >
              {t(f.labelKey)}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    gap: spacing.sm,
  },
  chip: {
    height: 44,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.full,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
