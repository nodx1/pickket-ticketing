/**
 * 풀스크린 Discover 피드 — TikTok 스타일 수직 스와이프
 * "모두 보기"에서 진입하는 Stack 라우트
 */
import { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  ActivityIndicator,
  StyleSheet,
  StatusBar,
  TouchableOpacity,
  ScrollView,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Stack } from "expo-router";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { spacing, radius } from "@/config/theme";
import { useDiscoverFeed } from "@/hooks/useDiscoverFeed";
import { DiscoverFeed } from "@/components/discover/DiscoverFeed";
import { trackScreenView } from "@/lib/analytics";
import { light as hapticLight } from "@/lib/haptics";
import type { Event } from "@/config/api";

const MOCK_EVENTS: Event[] = [
  {
    id: "mock-1",
    title: "IVE THE 1ST WORLD TOUR",
    category: "music",
    venue: "KSPO DOME",
    event_date: "2026-06-15T18:00:00Z",
    image_url: "https://picsum.photos/seed/ive/800/1200",
    min_price: 132000,
    status: "open",
    sale_status: "on_sale",
    recommendation_reason: "이 아티스트의 직전 공연에서 매진 — 얼리버드 추천",
  },
  {
    id: "mock-2",
    title: "WATERBOMB SEOUL 2026",
    category: "festival",
    venue: "잠실종합운동장",
    event_date: "2026-07-20T14:00:00Z",
    image_url: "https://picsum.photos/seed/waterbomb/800/1200",
    min_price: 88000,
    status: "open",
    sale_status: "upcoming",
    recommendation_reason: "작년 10만 관객 동원 — 올해 최대 페스티벌",
  },
  {
    id: "mock-3",
    title: "aespa LIVE TOUR",
    category: "music",
    venue: "고척스카이돔",
    event_date: "2026-05-28T19:00:00Z",
    image_url: "https://picsum.photos/seed/aespa/800/1200",
    min_price: 110000,
    status: "open",
    sale_mode: "point_lottery",
    sale_status: "on_sale",
    recommendation_reason: "추첨 진행 중 — 팬 레벨 높을수록 당첨 확률 UP",
    waitlist_enabled: true,
  },
  {
    id: "mock-4",
    title: "WORLD DJ FESTIVAL",
    category: "club",
    venue: "난지한강공원",
    event_date: "2026-08-10T20:00:00Z",
    image_url: "https://picsum.photos/seed/wdjf/800/1200",
    min_price: 66000,
    status: "open",
    sale_status: "on_sale",
  },
  {
    id: "mock-5",
    title: "FRIEZE SEOUL 2026",
    category: "art",
    venue: "코엑스",
    event_date: "2026-09-05T10:00:00Z",
    image_url: "https://picsum.photos/seed/frieze/800/1200",
    min_price: 35000,
    status: "open",
    sale_status: "upcoming",
    recommendation_reason: "세계 3대 아트페어 — 서울 에디션",
  },
];

const CATEGORIES = ["all", "music", "festival", "club", "art", "sports"] as const;
type Category = (typeof CATEGORIES)[number];

export default function DiscoverFeedScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [selectedCategory, setSelectedCategory] = useState<Category>("all");

  const categoryParam = selectedCategory === "all" ? undefined : selectedCategory;

  const {
    events,
    isLoading,
    isError,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useDiscoverFeed(10, categoryParam);

  useEffect(() => {
    trackScreenView("discover_feed");
  }, []);

  const handleCategoryPress = useCallback((cat: Category) => {
    hapticLight();
    setSelectedCategory(cat);
  }, []);

  const handleEndReached = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  if (isLoading && !isError) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <StatusBar barStyle="light-content" />
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  // AUDIT 2026-04-20 §5 P0: 프로덕션에서 MOCK fallback 금지
  const mockFallback = __DEV__
    ? (categoryParam
        ? MOCK_EVENTS.filter((e) => e.category === categoryParam)
        : MOCK_EVENTS)
    : ([] as Event[]);
  const displayEvents =
    isError || events.length === 0 ? mockFallback : events;

  return (
    <View testID="discover.feed.screen" style={styles.container}>
      <Stack.Screen options={{ headerShown: false }} />
      <StatusBar barStyle="light-content" />

      {/* 카테고리 필터 칩 */}
      <View style={[styles.filterContainer, { paddingTop: insets.top + spacing.sm }]}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterContent}
        >
          {CATEGORIES.map((cat) => {
            const isActive = cat === selectedCategory;
            return (
              <TouchableOpacity
                testID={`discover.category.${cat}`}
                key={cat}
                style={[
                  styles.chip,
                  isActive
                    ? { backgroundColor: colors.primary }
                    : { backgroundColor: "rgba(255,255,255,0.15)" },
                ]}
                onPress={() => handleCategoryPress(cat)}
                accessibilityRole="button"
                accessibilityState={{ selected: isActive }}
              >
                <Text
                  style={[
                    styles.chipText,
                    isActive
                      ? { color: colors.primaryForeground }
                      : { color: "rgba(255,255,255,0.85)" },
                  ]}
                >
                  {t(`discover.category.${cat}`)}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      <DiscoverFeed events={displayEvents} onEndReached={handleEndReached} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xl,
  },
  filterContainer: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    paddingBottom: spacing.sm,
  },
  filterContent: {
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
  },
  chip: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
  },
  chipText: {
    fontSize: 14,
    fontWeight: "600",
  },
});
