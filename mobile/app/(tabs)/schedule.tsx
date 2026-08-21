/**
 * 일정 탭 — 날짜별 공연/행사 일정 피드
 * Phase A Week 1: 목 데이터 기반 UI
 */
export { ErrorBoundary } from "@/components/common/ErrorBoundary";
import { useCallback, useMemo, useState } from "react";
import { RefreshControl, Text, ScrollView, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Animated, { FadeIn } from "react-native-reanimated";
import { Stack } from "expo-router";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing } from "@/config/theme";
import { isFeatureEnabled } from "@/config/features";
import { useScrollDirection } from "@/stores/scrollDirection";
import { ScheduleFilterChips } from "@/components/schedule/ScheduleFilterChips";
import { ScheduleDayGroup } from "@/components/schedule/ScheduleDayGroup";
import { EmptyState } from "@/components/common/EmptyState";
import type { ScheduleFilter, ScheduleItem, ScheduleDayGroupData } from "@/types/schedule";
import type { NativeSyntheticEvent, NativeScrollEvent } from "react-native";

// ── Mock 데이터 ──

const TODAY = new Date();
const tomorrow = new Date(TODAY);
tomorrow.setDate(tomorrow.getDate() + 1);
const dayAfter = new Date(TODAY);
dayAfter.setDate(dayAfter.getDate() + 2);

function toISO(date: Date, hour: number, min = 0): string {
  const d = new Date(date);
  d.setHours(hour, min, 0, 0);
  return d.toISOString();
}

const MOCK_ITEMS: ScheduleItem[] = [
  {
    id: "s-1",
    title: "IVE THE 1ST WORLD TOUR",
    artist_name: "IVE",
    category: "concert",
    start_time: toISO(TODAY, 18, 0),
    venue: "KSPO DOME",
    location: "서울 송파구",
    image_url: "https://picsum.photos/seed/ive-sch/200/200",
    source: "pickket",
    trust_score: 100,
    is_bookable: true,
    event_id: "hm-1",
  },
  {
    id: "s-2",
    title: "아이돌 라디오 시즌4",
    artist_name: "aespa",
    category: "broadcast",
    start_time: toISO(TODAY, 20, 0),
    source: "tenasia",
    trust_score: 90,
    is_bookable: false,
  },
  {
    id: "s-3",
    title: "ENHYPEN FATE+ TOUR",
    artist_name: "ENHYPEN",
    category: "concert",
    start_time: toISO(tomorrow, 19, 0),
    venue: "고척스카이돔",
    location: "서울 구로구",
    image_url: "https://picsum.photos/seed/enhy-sch/200/200",
    source: "pickket",
    trust_score: 100,
    is_bookable: true,
    event_id: "hm-3",
  },
  {
    id: "s-4",
    title: "뮤직뱅크 녹화",
    artist_name: "NewJeans, LE SSERAFIM",
    category: "broadcast",
    start_time: toISO(tomorrow, 17, 30),
    venue: "KBS",
    source: "broadcast",
    trust_score: 85,
    is_bookable: false,
  },
  {
    id: "s-5",
    title: "Stray Kids 팬미팅",
    artist_name: "Stray Kids",
    category: "fanmeeting",
    start_time: toISO(dayAfter, 14, 0),
    venue: "잠실실내체육관",
    location: "서울 송파구",
    image_url: "https://picsum.photos/seed/skz-fm/200/200",
    source: "pickket",
    trust_score: 100,
    is_bookable: true,
    event_id: "hm-5",
  },
  {
    id: "s-6",
    title: "서울뮤직페스티벌 2026",
    artist_name: "Various Artists",
    category: "festival",
    start_time: toISO(dayAfter, 12, 0),
    venue: "난지한강공원",
    location: "서울 마포구",
    image_url: "https://picsum.photos/seed/smf-26/200/200",
    source: "pickket",
    trust_score: 100,
    is_bookable: true,
    event_id: "hm-6",
  },
];

function formatDateLabel(date: Date, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const tomorrowDate = new Date(now);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrowStr = tomorrowDate.toISOString().slice(0, 10);
  const dateStr = date.toISOString().slice(0, 10);

  if (dateStr === todayStr) return t("schedule.todayLabel");
  if (dateStr === tomorrowStr) return t("schedule.tomorrowLabel");

  const m = date.getMonth() + 1;
  const d = date.getDate();
  const w = t(`schedule.weekday_${date.getDay()}`);
  return t("schedule.dateFormat", { month: m, day: d, weekday: w });
}

function groupByDate(items: ScheduleItem[], t: (key: string, opts?: Record<string, unknown>) => string): ScheduleDayGroupData[] {
  const map = new Map<string, ScheduleItem[]>();
  for (const item of items) {
    const key = item.start_time.slice(0, 10);
    const arr = map.get(key) ?? [];
    arr.push(item);
    map.set(key, arr);
  }

  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dateStr, dayItems]) => ({
      date: dateStr,
      label: formatDateLabel(new Date(dateStr + "T00:00:00"), t),
      items: dayItems.sort(
        (a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime(),
      ),
    }));
}

export default function ScheduleScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [filter, setFilter] = useState<ScheduleFilter>("all");
  const [refreshing, setRefreshing] = useState(false);
  const setScrollY = useScrollDirection((s) => s.setScrollY);

  const filtered = useMemo(() => {
    // AUDIT 2026-06-02 P1: 프로덕션에서 MOCK 일정 노출 금지 — dev 환경 한정.
    //   백엔드 /schedule/feed 미존재 (useScheduleFeed.ts TODO Phase B 참조).
    const source = __DEV__ ? MOCK_ITEMS : [];
    if (filter === "all") return source;
    if (filter === "bookable") return source.filter((i) => i.is_bookable);
    return source.filter((i) => i.category === filter);
  }, [filter]);

  const groups = useMemo(() => groupByDate(filtered, t), [filtered, t]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 1000);
  }, []);

  const handleScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      setScrollY(e.nativeEvent.contentOffset.y);
    },
    [setScrollY],
  );

  // 피처게이트: 모든 훅 호출 뒤에 early-return (Rules of Hooks 준수 — Remote Config 토글 시 크래시 방지)
  if (!isFeatureEnabled("SCHEDULE_TAB")) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ headerShown: false }} />
        <EmptyState
          icon="calendar-outline"
          title={t("schedule.comingSoon")}
          message={t("schedule.comingSoonDesc")}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* 헤더 */}
      <Text testID="schedule.header" style={[typography.h2, styles.header, { color: colors.foreground }]}>
        {t("schedule.title")}
      </Text>

      {/* 필터 */}
      <ScheduleFilterChips selected={filter} onSelect={setFilter} />

      {/* 일정 피드 */}
      {groups.length === 0 ? (
        <EmptyState
          icon="calendar-outline"
          title={t("schedule.empty")}
        />
      ) : (
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.scrollContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.primary}
            />
          }
          onScroll={handleScroll}
          scrollEventThrottle={16}
        >
          {groups.map((group) => (
            <Animated.View key={group.date} entering={FadeIn.springify()}>
              <ScheduleDayGroup group={group} />
            </Animated.View>
          ))}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    padding: spacing.xl,
    paddingBottom: 0,
  },
  scrollContent: {
    paddingBottom: spacing.xxl * 3,
  },
});
