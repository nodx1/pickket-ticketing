/**
 * 오늘의 일정 섹션 — 홈 화면에 표시되는 오늘 일정 요약
 * 피처플래그 TODAY_SCHEDULE_HOME로 제어
 * 디자인 정책: radius.xl(16), spacing.xxl(32) 상단 간격, spring 애니메이션
 */
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useRouter } from "expo-router";
import { useTheme } from "@/hooks/useTheme";
import { useTranslation } from "react-i18next";
import { typography, spacing, radius } from "@/config/theme";
import { isFeatureEnabled } from "@/config/features";
import * as haptics from "@/lib/haptics";
import type { ScheduleItem } from "@/types/schedule";

interface Props {
  items: ScheduleItem[];
}

function formatTime(isoString: string): string {
  const d = new Date(isoString);
  return d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function TodayScheduleSection({ items }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();

  if (!isFeatureEnabled("TODAY_SCHEDULE_HOME")) return null;
  if (items.length === 0) return null;

  const displayItems = items.slice(0, 3);

  return (
    <Animated.View entering={FadeIn.springify()} testID="today.schedule.section" style={styles.container}>
      {/* 섹션 헤더 */}
      <View style={styles.header}>
        <Text style={[typography.h3, { color: colors.foreground }]}>
          {t("schedule.today.title")}
        </Text>
        <TouchableOpacity
          onPress={() => {
            haptics.lightImpact();
            router.push("/(tabs)/schedule");
          }}
          hitSlop={8}
          style={styles.seeAllBtn}
          accessibilityRole="button"
        >
          <Text style={[typography.bodySmall, { color: colors.primary }]}>
            {t("common.seeAll")}
          </Text>
          <Ionicons name="chevron-forward" size={14} color={colors.primary} />
        </TouchableOpacity>
      </View>

      {/* 일정 미니 카드 */}
      <View style={styles.cards}>
        {displayItems.map((item) => (
          <TouchableOpacity
            key={item.id}
            onPress={() => {
              haptics.lightImpact();
              if (item.is_bookable && item.event_id) {
                router.push(`/event/${item.event_id}`);
              }
            }}
            disabled={!item.is_bookable}
            style={[styles.miniCard, { backgroundColor: colors.card, borderColor: colors.border }]}
            activeOpacity={0.7}
            accessibilityRole="button"
          >
            <View style={[styles.timeBadge, { backgroundColor: colors.secondary }]}>
              <Text style={[typography.h5, { color: colors.foreground }]}>
                {formatTime(item.start_time)}
              </Text>
            </View>
            <View style={styles.miniContent}>
              <Text style={[typography.h5, { color: colors.foreground }]} numberOfLines={1}>
                {item.title}
              </Text>
              <Text style={[typography.bodySmall, { color: colors.mutedForeground }]} numberOfLines={1}>
                {item.artist_name}{item.venue ? ` · ${item.venue}` : ""}
              </Text>
            </View>
            {item.is_bookable && (
              <View style={[styles.bookBadge, { backgroundColor: colors.primary }]}>
                <Text style={[typography.micro, { color: colors.primaryForeground }]}>
                  {t("schedule.bookable")}
                </Text>
              </View>
            )}
          </TouchableOpacity>
        ))}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: spacing.xxl,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.xl,
    marginBottom: spacing.md,
  },
  seeAllBtn: {
    flexDirection: "row",
    alignItems: "center",
    height: 44,
    paddingLeft: spacing.sm,
  },
  cards: {
    paddingHorizontal: spacing.xl,
    gap: spacing.sm,
  },
  miniCard: {
    flexDirection: "row",
    alignItems: "center",
    padding: spacing.md,
    borderRadius: radius.xl,
    borderWidth: 1,
    minHeight: 56,
  },
  timeBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
    marginRight: spacing.md,
  },
  miniContent: {
    flex: 1,
    marginRight: spacing.sm,
  },
  bookBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.full,
  },
});
