/**
 * Discover Spotlight — 피처드 이벤트 카드 1~3장 (280px)
 * "모두 보기" → /discover/feed
 */
import { useCallback } from "react";
import { View, Text, TouchableOpacity, StyleSheet,  } from "react-native";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing } from "@/config/theme";
import { useFeaturedEvents } from "@/hooks/useEvents";
import { DiscoverCard } from "@/components/discover/DiscoverCard";
import type { Event } from "@/config/api";

const SPOTLIGHT_HEIGHT = 320;

/** API 실패 시 데모 데이터 */
const MOCK_FEATURED: Event[] = [
  {
    id: "sp-1",
    title: "IVE THE 1ST WORLD TOUR",
    category: "music",
    venue: "KSPO DOME",
    event_date: "2026-06-15T18:00:00Z",
    image_url: "https://picsum.photos/seed/ive-sp/800/1200",
    min_price: 132000,
    status: "open",
    sale_status: "on_sale",
    recommendation_reason: "이 아티스트의 직전 공연에서 매진",
  },
];

export function DiscoverSpotlight() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const { data: featured,  } = useFeaturedEvents();

  const events = featured?.length ? featured.slice(0, 1) : MOCK_FEATURED;

  const handleSeeAll = useCallback(() => {
    router.push("/discover/feed");
  }, [router]);

  return (
    <View style={styles.container}>
      {/* 헤더 */}
      <View style={styles.header}>
        <Text style={[typography.h3, { color: colors.foreground }]}>
          {t("home.discoverSpotlight")}
        </Text>
        <TouchableOpacity onPress={handleSeeAll}>
          <Text style={[typography.bodySmall, { color: colors.primary }]}>
            {t("home.seeAll")} →
          </Text>
        </TouchableOpacity>
      </View>

      {/* 피처드 카드 */}
      {events.map((event) => (
        <View key={event.id} style={styles.cardWrap}>
          <DiscoverCard event={event} height={SPOTLIGHT_HEIGHT} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.sm,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: spacing.xl,
  },
  cardWrap: {
    marginHorizontal: spacing.xl,
    borderRadius: 20,
    overflow: "hidden",
  },
});
