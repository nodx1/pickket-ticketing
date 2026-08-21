/**
 * 홈 탭 — DICE 구조 x Pickket DNA (v2)
 *
 * PersonalizedHeader: 인사 + 통합 내비 아이콘 (필터+액션 합침, 가로 스크롤)
 * ContextCard: 캐러셀 메인 카드 + 좌우 화살표 + DICE 액션
 * 섹션: 추첨 중 → 친구 관심 → 스탬프 → 트렌딩 → 추천
 */
export { ErrorBoundary } from "@/components/common/ErrorBoundary";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, RefreshControl, StyleSheet, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { useTheme } from "@/hooks/useTheme";
import { spacing } from "@/config/theme";
import { useAuthStore } from "@/hooks/useAuth";
import { useFeaturedEvents, useTrendingEvents, useRecommendations } from "@/hooks/useEvents";
import { useFanProfile } from "@/hooks/useFanProfile";
import { useScrollDirection } from "@/stores/scrollDirection";
import { trackScreenView } from "@/lib/analytics";
import { PersonalizedHeader } from "@/components/home/PersonalizedHeader";
import { ContextCard } from "@/components/home/ContextCard";
import { LotterySection } from "@/components/home/LotterySection";
import { FriendsInterestSection, type FriendInterestEvent } from "@/components/home/FriendsInterestSection";
import { PicksRing } from "@/components/home/PicksRing";
import type { PickItem } from "@/components/home/PicksRing";
import { usePicks } from "@/hooks/usePicks";
import { TrendingSection, TrendingSkeleton } from "@/components/home/TrendingSection";
import { RecommendationSection, RecommendationSkeleton } from "@/components/home/RecommendationSection";
import { TodayScheduleSection } from "@/components/home/TodayScheduleSection";
import { ChatFAB } from "@/components/discover/ChatFAB";
import { useTodaySchedule } from "@/hooks/useScheduleFeed";
import { getLevelInfo } from "@/types/fan";
import type { DnaFilter } from "@/components/home/DnaFilterChips";
import type { Event } from "@/config/api";
import type { NativeSyntheticEvent, NativeScrollEvent } from "react-native";
import { useTranslation } from "react-i18next";

// ── Mock 데이터 ──

const MOCK_FEATURED: Event[] = [
  {
    id: "hm-1",
    title: "IVE THE 1ST WORLD TOUR",
    category: "music",
    venue: "KSPO DOME",
    event_date: "2026-06-15T18:00:00Z",
    image_url: "https://picsum.photos/seed/ive-hero/800/1200",
    min_price: 132000,
    status: "open",
    is_featured: true,
    sale_status: "on_sale",
    sale_mode: "point_lottery",
  },
  {
    id: "hm-2",
    title: "WATERBOMB SEOUL 2026",
    category: "festival",
    venue: "잠실종합운동장",
    event_date: "2026-07-20T14:00:00Z",
    image_url: "https://picsum.photos/seed/wb-hero/800/1200",
    min_price: 88000,
    status: "open",
    is_featured: true,
    sale_status: "upcoming",
  },
];

const MOCK_LOTTERY: Event[] = [
  {
    id: "lt-1",
    title: "aespa LIVE TOUR — SYNK",
    category: "music",
    venue: "고척스카이돔",
    event_date: "2026-04-14T19:00:00Z",
    image_url: "https://picsum.photos/seed/aespa-lt/400/600",
    min_price: 110000,
    status: "open",
    sale_mode: "point_lottery",
    sale_status: "on_sale",
  },
  {
    id: "lt-2",
    title: "DAY6 CONCERT",
    category: "music",
    venue: "올림픽홀",
    event_date: "2026-04-18T18:00:00Z",
    image_url: "https://picsum.photos/seed/day6-lt/400/600",
    min_price: 99000,
    status: "open",
    sale_mode: "point_lottery",
    sale_status: "on_sale",
  },
  {
    id: "lt-3",
    title: "WORLD DJ FESTIVAL",
    category: "club",
    venue: "난지한강공원",
    event_date: "2026-04-23T20:00:00Z",
    image_url: "https://picsum.photos/seed/wdjf-lt/400/600",
    min_price: 66000,
    status: "open",
    sale_mode: "point_lottery",
    sale_status: "on_sale",
  },
];

const MOCK_FRIENDS_INTEREST: FriendInterestEvent[] = [
  {
    id: "fr-1",
    title: "WATERBOMB SEOUL 2026",
    category: "festival",
    venue: "잠실종합운동장",
    event_date: "2026-07-20T14:00:00Z",
    image_url: "https://picsum.photos/seed/wb-fr/400/600",
    min_price: 88000,
    status: "open",
    sale_status: "upcoming",
    friendCount: 3,
    friendNames: ["민지", "수현", "재현"],
  },
  {
    id: "fr-2",
    title: "FRIEZE SEOUL 2026",
    category: "art",
    venue: "코엑스",
    event_date: "2026-09-05T10:00:00Z",
    image_url: "https://picsum.photos/seed/frieze-fr/400/600",
    min_price: 35000,
    status: "open",
    sale_status: "upcoming",
    friendCount: 1,
    friendNames: ["소연"],
  },
];

const MOCK_TRENDING: Event[] = [
  {
    id: "ht-1",
    title: "aespa LIVE TOUR",
    category: "music",
    venue: "고척스카이돔",
    event_date: "2026-05-28T19:00:00Z",
    image_url: "https://picsum.photos/seed/aespa-t/400/600",
    min_price: 110000,
    status: "open",
    sale_status: "on_sale",
  },
  {
    id: "ht-2",
    title: "WORLD DJ FESTIVAL",
    category: "club",
    venue: "난지한강공원",
    event_date: "2026-08-10T20:00:00Z",
    image_url: "https://picsum.photos/seed/wdjf-t/400/600",
    min_price: 66000,
    status: "open",
    sale_status: "on_sale",
  },
  {
    id: "ht-3",
    title: "FRIEZE SEOUL 2026",
    category: "art",
    venue: "코엑스",
    event_date: "2026-09-05T10:00:00Z",
    image_url: "https://picsum.photos/seed/frieze-t/400/600",
    min_price: 35000,
    status: "open",
    sale_status: "upcoming",
  },
];

// MOCK_PICKS 제거 — usePicks() 훅으로 대체

// ── 필터 로직 ──

function filterEvents(events: Event[], filter: DnaFilter): Event[] {
  switch (filter) {
    case "tonight": {
      const now = new Date();
      const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59).getTime();
      return events.filter((e) => {
        if (!e.event_date) return false;
        const d = new Date(e.event_date).getTime();
        return d >= now.getTime() && d <= endOfDay;
      });
    }
    case "thisWeek": {
      const now = Date.now();
      const weekLater = now + 7 * 24 * 60 * 60 * 1000;
      return events.filter((e) => {
        if (!e.event_date) return false;
        const d = new Date(e.event_date).getTime();
        return d >= now && d <= weekLater;
      });
    }
    case "trending":
      return events;
    case "waitlist":
      return events.filter((e) => !!e.waitlist_enabled);
    case "upcoming":
      return events.filter((e) => e.sale_status === "upcoming" || e.sale_status === "scheduled");
    default:
      return events;
  }
}

// ── 메인 ──

export default function HomeScreen() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const { isGuest } = useAuthStore();
  const setScrollY = useScrollDirection((s) => s.setScrollY);
  const [activeFilter, setActiveFilter] = useState<DnaFilter>("forYou");

  useEffect(() => {
    trackScreenView("home");
  }, []);

  const featured = useFeaturedEvents();
  const trending = useTrendingEvents(10);
  const recommendations = useRecommendations(10, { enabled: !isGuest });
  const { data: fanProfile } = useFanProfile();
  const todaySchedule = useTodaySchedule();
  const { data: stamps } = usePicks();

  const pickItems: PickItem[] = useMemo(
    () =>
      (stamps ?? []).map((s) => ({
        eventId: s.eventId,
        imageUri: s.imageUri,
        label: s.eventId,
        isNew: !s.status || s.status === "completed",
        status: s.status,
      })),
    [stamps],
  );

  const isLoading =
    (featured.isLoading && !featured.isError) ||
    (trending.isLoading && !trending.isError);

  const onRefresh = useCallback(() => {
    featured.refetch();
    trending.refetch();
    if (!isGuest) recommendations.refetch();
  }, [featured, trending, isGuest, recommendations]);

  const isRefreshing = featured.isRefetching || trending.isRefetching;

  // AUDIT 2026-04-20 §5 P0: 프로덕션에서 MOCK 데이터 노출 금지. dev 환경에서만 fallback 허용.
  const featuredData = featured.data?.length
    ? featured.data
    : (__DEV__ ? MOCK_FEATURED : ([] as Event[]));
  const trendingData = trending.data?.length
    ? trending.data
    : (__DEV__ ? MOCK_TRENDING : ([] as Event[]));

  const filteredTrending = useMemo(
    () => filterEvents(trendingData, activeFilter),
    [trendingData, activeFilter],
  );

  // 컨텍스트 라벨
  const contextInfo = useMemo(() => {
    if (fanProfile && fanProfile.level >= 3) {
      const info = getLevelInfo(fanProfile.level);
      return {
        icon: "trophy" as const,
        label: t("home.context.fanLevel", { level: String(fanProfile.level), name: info.name }),
        color: info.color,
      };
    }
    const first = featuredData[0];
    // AUDIT §4 P0: canonical sale_mode만 비교 (legacy "lottery" → "point_lottery")
    if (first?.sale_mode === "point_lottery" || first?.sale_mode === "lottery") {
      return { icon: "dice" as const, label: t("home.context.lotteryOpen"), color: colors.hot };
    }
    return { icon: "sparkles" as const, label: t("home.context.recommended"), color: colors.primary };
  }, [fanProfile, featuredData, colors, t]);

  const handleScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      setScrollY(e.nativeEvent.contentOffset.y);
    },
    [setScrollY],
  );

  const isForYou = activeFilter === "forYou";

  return (
    <View testID="nav.tonight" style={[styles.container, { backgroundColor: colors.background }]}>
      <PersonalizedHeader activeFilter={activeFilter} onFilterSelect={setActiveFilter} />

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={16}
        onScroll={handleScroll}
        refreshControl={
          <RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} tintColor={colors.primary} />
        }
      >
        {/* Picks 스토리 링 — 인사말 바로 아래 (Mock 단계: 항상 표시) */}
        <PicksRing picks={pickItems} />

        {/* 메인 카드 — DICE 캐러셀 + 좌우 화살표 */}
        <Animated.View entering={FadeIn.springify()} style={styles.mainCard}>
          <ContextCard
            events={featuredData}
            contextIcon={contextInfo.icon}
            contextLabel={contextInfo.label}
            contextColor={contextInfo.color}
          />
        </Animated.View>

        {isForYou ? (
          <>
            {/* 오늘 일정 */}
            <TodayScheduleSection items={todaySchedule.data ?? []} />

            {/* 추첨 진행 중 (AUDIT §5 P0: 백엔드 연동 전까지 dev에서만) */}
            {__DEV__ && <LotterySection events={MOCK_LOTTERY} />}

            {/* 친구들도 관심 (로그인 시, AUDIT §5 P0: dev에서만) */}
            {__DEV__ && !isGuest && <FriendsInterestSection events={MOCK_FRIENDS_INTEREST} />}


            {/* 지금 뜨는 */}
            {isLoading ? <TrendingSkeleton /> : <TrendingSection events={trendingData} />}

            {/* 추천 (로그인 시) */}
            {!isGuest &&
              (recommendations.isLoading ? (
                <RecommendationSkeleton />
              ) : recommendations.data?.recommendations ? (
                <RecommendationSection recommendations={recommendations.data.recommendations} />
              ) : null)}
          </>
        ) : (
          <Animated.View key={activeFilter} entering={FadeIn.springify().damping(18)}>
            {isLoading ? <TrendingSkeleton /> : <TrendingSection events={filteredTrending} />}
          </Animated.View>
        )}
      </ScrollView>

      {/* AI 챗 FAB */}
      <ChatFAB />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: {
    paddingTop: 190,
    paddingBottom: 100,
  },
  mainCard: {
    marginTop: spacing.sm,
  },
});
