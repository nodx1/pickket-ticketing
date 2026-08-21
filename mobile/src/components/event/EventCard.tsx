import { memo } from "react";
import { View, Text, TouchableOpacity, StyleSheet, Dimensions } from "react-native";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import Animated, { FadeInUp } from "react-native-reanimated";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing } from "@/config/theme";
import { Skeleton } from "@/components/ui/Skeleton";
import { FriendsInterested } from "@/components/event/FriendsInterested";
import { PromiseBadges } from "@/components/event/PromiseBadges";
import { formatPriceRange, formatShortDate, resolveEventImage } from "@/lib/format";
import { calcAllInPrice } from "@/lib/all-in-pricing";
import type { Event } from "@/config/api";

const SCREEN_WIDTH = Dimensions.get("window").width;
const CARD_HORIZONTAL_PADDING = 24;

interface Props {
  event: Event;
  variant?: "large" | "compact";
}

/** 이벤트 카드 — large(풀블리드 히어로) / compact(가로 스크롤) */
export const EventCard = memo(function EventCard({ event, variant = "large" }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();

  const handlePress = () => {
    router.push(`/event/${event.id}`);
  };

  const imageUri = resolveEventImage(event);

  // All-In 가격 계산 — 이벤트별 service_fee_rate 를 넘겨야 카드↔상세↔결제 가격이 일치한다.
  // 인자 생략 시 하드코딩 11% 가 적용돼 무료/제휴 이벤트에서 표시가 어긋났다(P2-C16).
  const allInPrice = event.min_price
    ? calcAllInPrice(event.min_price, event.service_fee_rate)
    : null;

  if (variant === "compact") {
    return (
      <TouchableOpacity
        testID={`event.card.compact.${event.id}`}
        style={styles.compactCard}
        onPress={handlePress}
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityLabel={`${event.title}, ${event.event_date ? formatShortDate(event.event_date) : ""}`}
      >
        <Image
          source={{ uri: imageUri }}
          style={styles.compactImage}
          contentFit="cover"
          placeholder={{ blurhash: "L6PZfSi_.AyE_3t7t7R**0o#DgR4" }}
          transition={200}
          cachePolicy="memory-disk"
          recyclingKey={event.id}
        />
        <LinearGradient
          colors={["transparent", "rgba(0,0,0,0.7)"]}
          style={styles.compactGradient}
        />
        <View style={styles.compactOverlay}>
          <Text style={[typography.h5, styles.whiteText]} numberOfLines={2}>
            {event.title}
          </Text>
          {event.event_date && (
            <Text style={[typography.bodySmall, styles.whiteMuted, { marginTop: spacing.xs }]}>
              {formatShortDate(event.event_date)}
            </Text>
          )}
          {allInPrice && (
            <Text style={[typography.h5, { color: colors.primary, marginTop: spacing.xs }]}>
              {formatPriceRange(allInPrice.total, allInPrice.total)}
              <Text style={[typography.bodySmall, styles.whiteMuted]}> {t("event.allInPrice")}</Text>
            </Text>
          )}
        </View>
      </TouchableOpacity>
    );
  }

  // large variant — fullbleed
  return (
    <Animated.View entering={FadeInUp.springify()}>
      <TouchableOpacity
        testID={`event.card.large.${event.id}`}
        style={styles.largeCard}
        onPress={handlePress}
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityLabel={`${event.title}, ${event.venue ?? ""}, ${event.event_date ? formatShortDate(event.event_date) : ""}`}
      >
        <Image
          source={{ uri: imageUri }}
          style={styles.largeImage}
          contentFit="cover"
          placeholder={{ blurhash: "L6PZfSi_.AyE_3t7t7R**0o#DgR4" }}
          transition={200}
          cachePolicy="memory-disk"
          recyclingKey={event.id}
        />
        <LinearGradient
          colors={["transparent", "rgba(0,0,0,0.7)"]}
          style={styles.largeGradient}
        />
        <View style={styles.largeOverlay}>
          {/* Category + Venue */}
          <View style={styles.row}>
            {event.category && (
              <Text style={[typography.bodySmall, styles.categoryVenueText]}>
                {event.category}
              </Text>
            )}
            {event.venue && (
              <Text style={[typography.bodySmall, styles.categoryVenueText, { marginLeft: spacing.sm }]}>
                {event.venue}
              </Text>
            )}
          </View>

          {/* Title — DICE 36pt display */}
          <Text style={[typography.display, styles.titleText, { marginTop: spacing.sm }]} numberOfLines={2}>
            {event.title}
          </Text>

          {/* Date + All-In Price */}
          <View style={[styles.row, { marginTop: spacing.sm }]}>
            {event.event_date && (
              <Text style={[typography.bodySmall, styles.whiteMuted]}>
                {formatShortDate(event.event_date)}
              </Text>
            )}
            {allInPrice && (
              <View style={[styles.row, { marginLeft: "auto" }]}>
                <Text style={[typography.h4, { color: colors.primary }]}>
                  {formatPriceRange(allInPrice.total, allInPrice.total)}
                </Text>
                <Text style={[typography.bodySmall, styles.whiteMuted, { marginLeft: spacing.xs }]}>
                  {t("event.allInPrice")}
                </Text>
              </View>
            )}
          </View>

          {/* Promise Badges */}
          <PromiseBadges
            showP1
            showP2
            showP3={!!event.waitlist_enabled}
            showP4
            style={{ marginTop: spacing.md }}
          />

          {/* AI recommendation reason */}
          {event.recommendation_reason && (
            <View style={[styles.reasonBadge, { marginTop: spacing.md }]}>
              <Text style={styles.reasonSparkle}>✨</Text>
              <Text style={[typography.bodySmall, styles.reasonText]} numberOfLines={2}>
                {event.recommendation_reason}
              </Text>
            </View>
          )}

          <FriendsInterested friends={event.friends_interested} />
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
});

/** EventCard 스켈레톤 로더 */
export function EventCardSkeleton({ variant = "large" }: { variant?: "large" | "compact" }) {
  const { colors } = useTheme();

  if (variant === "compact") {
    return (
      <View style={[styles.compactCard, { backgroundColor: colors.card }]}>
        <Skeleton width={200} height={200 * (9 / 16)} borderRadius={24} />
      </View>
    );
  }

  return (
    <View style={{ borderRadius: 24, overflow: "hidden" }}>
      <Skeleton
        width={SCREEN_WIDTH - CARD_HORIZONTAL_PADDING * 2}
        height={(SCREEN_WIDTH - CARD_HORIZONTAL_PADDING * 2) * (4 / 3)}
        borderRadius={24}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // Large — fullbleed
  largeCard: {
    borderRadius: 24,
    overflow: "hidden",
    position: "relative",
  },
  largeImage: {
    width: "100%",
    aspectRatio: 3 / 4,
  },
  largeGradient: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: "40%",
  },
  largeOverlay: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    padding: spacing.xl,
    paddingBottom: spacing.xxl,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
  },
  categoryVenueText: {
    color: "rgba(255,255,255,0.8)",
    fontFamily: "Pretendard-Medium",
  },
  titleText: {
    color: "#FFFFFF",
    fontWeight: "700",
  },
  whiteText: {
    color: "#FFFFFF",
  },
  whiteMuted: {
    color: "rgba(255,255,255,0.8)",
  },

  // Compact — overlay pattern
  compactCard: {
    width: 200,
    borderRadius: 24,
    overflow: "hidden",
    position: "relative",
  },
  compactImage: {
    width: 200,
    aspectRatio: 16 / 9,
  },
  compactGradient: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: "60%",
  },
  compactOverlay: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    padding: spacing.md,
  },

  // Reason badge (AI recommendation)
  reasonBadge: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: spacing.xs,
  },
  reasonSparkle: {
    fontSize: 12,
    marginRight: spacing.xs,
  },
  reasonText: {
    flex: 1,
    fontStyle: "italic",
    color: "rgba(255,255,255,0.9)",
  },
});
