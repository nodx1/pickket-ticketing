/**
 * SourceFilterChips — 일정 데이터 소스 필터 (텐아시아 연동 강화)
 * ScheduleFilterChips와 병행 사용 (2단 필터)
 */
import { useCallback } from "react";
import { ScrollView, TouchableOpacity, Text, StyleSheet } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";
import * as haptics from "@/lib/haptics";
import type { ScheduleSource } from "@/types/schedule";

export type SourceOption = "all" | ScheduleSource;

const SOURCES: {
  key: SourceOption;
  label: string;
  icon: React.ComponentProps<typeof Ionicons>["name"];
}[] = [
  { key: "all", label: "전체", icon: "grid" },
  { key: "pickket", label: "Pickket", icon: "shield-checkmark" },
  { key: "tenasia", label: "텐아시아", icon: "newspaper" },
  { key: "broadcast", label: "방송사", icon: "tv" },
  { key: "bandsintown", label: "Bandsintown", icon: "globe" },
  { key: "ugc", label: "팬 제보", icon: "person" },
];

interface Props {
  selected: SourceOption;
  onSelect: (source: SourceOption) => void;
}

export function SourceFilterChips({ selected, onSelect }: Props) {
  const { colors } = useTheme();

  const handlePress = useCallback(
    (source: SourceOption) => {
      haptics.selectionFeedback();
      onSelect(source);
    },
    [onSelect],
  );

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.container}
    >
      {SOURCES.map((s) => {
        const active = s.key === selected;
        return (
          <TouchableOpacity
            key={s.key}
            onPress={() => handlePress(s.key)}
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
            <Ionicons
              name={s.icon}
              size={14}
              color={active ? colors.primaryForeground : colors.foreground}
            />
            <Text
              style={[
                typography.bodySmall,
                {
                  color: active ? colors.primaryForeground : colors.foreground,
                  marginLeft: 4,
                },
              ]}
            >
              {s.label}
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
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    height: 36,
    paddingHorizontal: spacing.md,
    borderRadius: radius.full,
    borderWidth: 1,
  },
});
