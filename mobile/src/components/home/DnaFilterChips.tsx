/**
 * Pickket DNA 필터칩 — DICE 시간필터 + Pickket 고유 판매방식
 */
import { useCallback } from "react";
import { Text, ScrollView, TouchableOpacity, StyleSheet } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { spacing, radius } from "@/config/theme";
import { light as hapticLight } from "@/lib/haptics";

type IoniconsName = React.ComponentProps<typeof Ionicons>["name"];

export type DnaFilter = "forYou" | "tonight" | "thisWeek" | "trending" | "waitlist" | "upcoming";

interface FilterDef {
  key: DnaFilter;
  icon: IoniconsName;
  labelKey: string;
}

const FILTERS: FilterDef[] = [
  { key: "tonight", icon: "moon-outline", labelKey: "home.filter.tonight" },
  { key: "thisWeek", icon: "calendar-outline", labelKey: "home.filter.thisWeek" },
  { key: "trending", icon: "trending-up-outline", labelKey: "home.filter.trending" },
  { key: "waitlist", icon: "hourglass-outline", labelKey: "home.filter.waitlistOpen" },
  { key: "upcoming", icon: "flash-outline", labelKey: "home.filter.openingSoon" },
];

interface DnaFilterChipsProps {
  selected: DnaFilter;
  onSelect: (filter: DnaFilter) => void;
}

export function DnaFilterChips({ selected, onSelect }: DnaFilterChipsProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();

  const handlePress = useCallback(
    (key: DnaFilter) => {
      hapticLight();
      onSelect(key);
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
        const isActive = f.key === selected;
        return (
          <TouchableOpacity
            key={f.key}
            testID={`filter.${f.key}`}
            style={[
              styles.chip,
              isActive
                ? { backgroundColor: colors.primary }
                : { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1 },
            ]}
            onPress={() => handlePress(f.key)}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityState={{ selected: isActive }}
          >
            <Ionicons
              name={f.icon}
              size={14}
              color={isActive ? colors.primaryForeground : colors.mutedForeground}
            />
            <Text
              style={[
                styles.chipText,
                { color: isActive ? colors.primaryForeground : colors.foreground },
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
    gap: spacing.sm,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    gap: spacing.xs,
  },
  chipText: {
    fontSize: 13,
    fontFamily: "Pretendard-SemiBold",
    fontWeight: "600",
  },
});
