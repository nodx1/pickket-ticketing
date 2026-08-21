/**
 * 개인화 헤더 — DICE 정확 재현
 *
 * "Make plans, nakwon" 인사 + 알림벨
 * 아래: 큰 아웃라인 아이콘 + 라벨 (세로 배치, 가로 스크롤)
 * 퀵 액션과 필터칩을 하나로 합침 — DICE처럼 한 줄
 */
import { useCallback } from "react";
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { LinearGradient } from "expo-linear-gradient";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/hooks/useTheme";
import { useAuthStore } from "@/hooks/useAuth";
import { useUnreadCount } from "@/hooks/useNotifications";
import { typography, spacing } from "@/config/theme";
import { selectionFeedback } from "@/lib/haptics";
import type { DnaFilter } from "@/components/home/DnaFilterChips";

type IoniconsName = React.ComponentProps<typeof Ionicons>["name"];

interface NavItem {
  key: DnaFilter;
  icon: IoniconsName;
  labelKey: string;
}

/** 순수 필터 아이콘 — 기본 피드(아무것도 선택 안 함) = For You */
const NAV_ITEMS: NavItem[] = [
  { key: "tonight", icon: "moon-outline", labelKey: "home.filter.tonight" },
  { key: "thisWeek", icon: "calendar-outline", labelKey: "home.filter.thisWeek" },
  { key: "trending", icon: "trending-up-outline", labelKey: "home.filter.trending" },
  { key: "waitlist", icon: "hourglass-outline", labelKey: "home.filter.waitlistOpen" },
  { key: "upcoming", icon: "flash-outline", labelKey: "home.filter.openingSoon" },
];

function getGreeting(t: (key: string, opts?: Record<string, string>) => string, name?: string): string {
  const hour = new Date().getHours();
  if (hour < 12) {
    return name ? t("home.greetingMorning", { name }) : t("home.greetingMorningGuest");
  }
  if (hour < 18) {
    return name ? t("home.greetingAfternoon", { name }) : t("home.greetingAfternoonGuest");
  }
  return name ? t("home.greetingEvening", { name }) : t("home.greetingEveningGuest");
}

interface PersonalizedHeaderProps {
  activeFilter: DnaFilter;
  onFilterSelect: (filter: DnaFilter) => void;
}

export function PersonalizedHeader({ activeFilter, onFilterSelect }: PersonalizedHeaderProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  // AUDIT §6 P1: 개별 selector로 불필요한 리렌더 방지
  const user = useAuthStore((s) => s.user);
  const isGuest = useAuthStore((s) => s.isGuest);
  const { data: unreadCount } = useUnreadCount();
  const hasUnread = !isGuest && (unreadCount ?? 0) > 0;

  const greeting = getGreeting(t, isGuest ? undefined : user?.name);

  const handlePress = useCallback(
    (item: NavItem) => {
      selectionFeedback();
      // 토글: 같은 필터 다시 누르면 기본(forYou)으로 복귀
      onFilterSelect(activeFilter === item.key ? "forYou" : item.key);
    },
    [onFilterSelect, activeFilter],
  );

  return (
    <View
      style={[
        styles.container,
        { paddingTop: insets.top + spacing.sm, backgroundColor: colors.background },
      ]}
    >
      {/* 인사 + 알림 — DICE: "Make plans, nakwon" + 🔔 */}
      <View style={styles.greetingRow}>
        <Text style={[typography.h2, { color: colors.foreground, flex: 1 }]} numberOfLines={1}>
          {greeting}
        </Text>
        <TouchableOpacity
          style={styles.notifBtn}
          onPress={() => router.push("/notifications")}
          accessibilityLabel={t("notification.title")}
          accessibilityRole="button"
        >
          <Ionicons name="notifications-outline" size={24} color={colors.foreground} />
          {hasUnread && <View style={[styles.badge, { backgroundColor: colors.primary }]} />}
        </TouchableOpacity>
      </View>

      {/* 내비 아이콘 — DICE: Tonight / This week / Pick dates ... 가로 스크롤 */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.navRow}
        style={styles.navScroll}
      >
        {NAV_ITEMS.map((item) => {
          const isActive = item.key === activeFilter;
          const iconColor = isActive
            ? colors.primary
            : colors.mutedForeground;
          const labelColor = isActive
            ? colors.primary
            : colors.foreground;

          return (
            <TouchableOpacity
              key={item.key}
              testID={`nav.${item.key}`}
              style={styles.navItem}
              onPress={() => handlePress(item)}
              activeOpacity={0.6}
              accessibilityLabel={t(item.labelKey)}
              accessibilityRole="button"
              accessibilityState={isActive ? { selected: true } : {}}
            >
              <Ionicons name={item.icon} size={28} color={iconColor} />
              <Text style={[styles.navLabel, { color: labelColor }]} numberOfLines={1}>
                {t(item.labelKey)}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* 하단 블러 경계 — Progressive Blur 패턴 */}
      <LinearGradient
        colors={[colors.background, "transparent"]}
        style={styles.fadeEdge}
        pointerEvents="none"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 20,
    paddingBottom: spacing.md,
  },
  greetingRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.xl,
    gap: spacing.md,
  },
  notifBtn: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  badge: {
    position: "absolute",
    top: 8,
    right: 8,
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  navScroll: {
    marginTop: spacing.lg,
  },
  navRow: {
    paddingHorizontal: spacing.xl,
    gap: spacing.xl,
  },
  navItem: {
    alignItems: "center",
    width: 64,
  },
  navLabel: {
    fontSize: 11,
    fontFamily: "Pretendard-Regular",
    marginTop: 6,
    textAlign: "center",
  },
  fadeEdge: {
    position: "absolute",
    bottom: -12,
    left: 0,
    right: 0,
    height: 12,
  },
});
