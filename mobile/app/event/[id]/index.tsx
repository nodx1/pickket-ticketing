import { useCallback, useEffect } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  Dimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import Animated, {
  FadeIn,
  useSharedValue,
  useAnimatedStyle,
  useAnimatedScrollHandler,
  interpolate,
  withSpring,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import { light as hapticLight } from "@/lib/haptics";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";
import { useEvent, useSimilarEvents, useToggleFavorite } from "@/hooks/useEvents";
import { useReviewSummary, useEventReviews, useMarkHelpful } from "@/hooks/useReviews";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { EventCard } from "@/components/event/EventCard";
import { EmptyState } from "@/components/common/EmptyState";
import { PromiseBadges } from "@/components/event/PromiseBadges";
import { formatEventDate, formatPriceRange, formatKRW, resolveEventImage } from "@/lib/format";
import { calcAllInPrice } from "@/lib/all-in-pricing";
import { trackEventView, trackShare } from "@/lib/analytics";
import { shareEvent } from "@/lib/sharing";
import { PriceAlertButton } from "@/components/event/PriceAlertButton";
import { PickEventGallery } from "@/components/picks/PickEventGallery";
import { isFeatureEnabled } from "@/config/features";
import type { Event } from "@/config/api";

const { width: SCREEN_WIDTH } = Dimensions.get("window");
const HERO_HEIGHT = 400;

export default function EventDetailScreen() {
  const { t } = useTranslation();
  const { colors, isDark } = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string }>();
  const eventId = typeof params.id === "string" ? params.id : params.id?.[0] ?? "";
  const { requireAuth } = useRequireAuth();

  const { data: event, isLoading, isError, refetch } = useEvent(eventId);
  const { data: similarEvents } = useSimilarEvents(eventId);
  const { data: reviewSummary } = useReviewSummary(eventId);
  const { data: reviewsData } = useEventReviews(eventId);
  const helpfulMutation = useMarkHelpful(eventId);
  const favoriteMutation = useToggleFavorite();

  // ── Parallax scroll tracking ──
  const scrollY = useSharedValue(0);
  const ctaPressed = useSharedValue(0);

  const scrollHandler = useAnimatedScrollHandler({
    onScroll: (e) => {
      scrollY.value = e.contentOffset.y;
    },
  });

  const heroAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: scrollY.value * 0.3 }],
    opacity: interpolate(scrollY.value, [0, HERO_HEIGHT], [1, 0.3]),
  }));

  const ctaAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: withSpring(ctaPressed.value ? 0.96 : 1) }],
  }));

  // 이벤트 조회 트래킹
  useEffect(() => {
    if (eventId) trackEventView(eventId);
  }, [eventId]);

  const handleShare = useCallback(() => {
    if (!event) return;
    shareEvent({
      eventId,
      title: event.title,
      date: event.event_date ? formatEventDate(event.event_date) : undefined,
      venue: event.venue ?? undefined,
    });
    trackShare(eventId, "event_detail_header");
  }, [event, eventId]);

  const handleFavorite = useCallback(() => {
    if (!requireAuth()) return;
    favoriteMutation.mutate(eventId);
  }, [eventId, requireAuth, favoriteMutation]);

  const handleBooking = useCallback(() => {
    if (!requireAuth()) return;
    hapticLight();
    router.push(`/event/${eventId}/booking`);
  }, [eventId, requireAuth, router]);

  // §9 P2: memoized renderItem / keyExtractor for similar events FlatList
  const renderSimilarItem = useCallback(({ item }: { item: Event }) => (
    <View style={{ marginRight: spacing.md }}>
      <EventCard event={item} variant="compact" />
    </View>
  ), []);

  const similarKeyExtractor = useCallback((item: Event) => item.id, []);

  if (isError) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ title: t("event.detail") }} />
        <EmptyState
          title={t("common.error")}
          message={t("common.serverError")}
          actionLabel={t("common.retry")}
          onAction={() => refetch()}
        />
      </SafeAreaView>
    );
  }

  if (isLoading || !event) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ title: "", headerTransparent: true }} />
        <Skeleton width={SCREEN_WIDTH} height={HERO_HEIGHT} borderRadius={0} />
        <View style={styles.body}>
          <Skeleton width="60%" height={24} />
          <Skeleton width="80%" height={18} style={{ marginTop: spacing.md }} />
          <Skeleton width="40%" height={16} style={{ marginTop: spacing.sm }} />
        </View>
      </SafeAreaView>
    );
  }

  // Compute remaining from tiers (v2 has no remaining_capacity field on Event)
  const totalRemaining = event.seat_tiers?.reduce((sum, t) => sum + (t.capacity - t.sold_count), 0) ?? 0;
  const isSoldOut = event.seat_tiers ? totalRemaining === 0 : false;

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={[]}>
      <Stack.Screen
        options={{
          title: "",
          headerTransparent: true,
          headerTintColor: "#FFFFFF",
        }}
      />
      <Animated.ScrollView
        onScroll={scrollHandler}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
      >
        {/* Hero Image + Parallax */}
        <View style={styles.heroContainer}>
          <Animated.View style={[StyleSheet.absoluteFill, heroAnimatedStyle]}>
            <Image
              source={{ uri: resolveEventImage(event) }}
              style={styles.heroImage}
              contentFit="cover"
              placeholder={{ blurhash: "L6PZfSi_.AyE_3t7t7R**0o#DgR4" }}
              transition={300}
            />
          </Animated.View>

          {/* LinearGradient overlay */}
          <LinearGradient
            colors={["transparent", "rgba(0,0,0,0.3)", colors.background]}
            style={StyleSheet.absoluteFill}
          />

          {/* Title overlaid on hero */}
          <View style={styles.heroTitleOverlay}>
            <Text
              style={[
                styles.heroTitleText,
                {
                  textShadowColor: "rgba(0,0,0,0.6)",
                  textShadowOffset: { width: 0, height: 2 },
                  textShadowRadius: 16,
                },
              ]}
              numberOfLines={3}
            >
              {event.title}
            </Text>
          </View>

          {/* Share button → Ionicons */}
          <TouchableOpacity
            style={[styles.heroActionBtn, { top: 56, right: spacing.xl + 52 }]}
            onPress={handleShare}
            accessibilityLabel={t("event.share")}
            accessibilityRole="button"
          >
            <Ionicons name="share-outline" size={20} color="#FFF" />
          </TouchableOpacity>

          {/* Favorite button → Ionicons */}
          <TouchableOpacity
            testID="event.detail.favorite"
            style={[styles.heroActionBtn, { top: 56, right: spacing.xl }]}
            onPress={handleFavorite}
            accessibilityLabel={t("event.favorite")}
            accessibilityRole="button"
          >
            <Ionicons
              name={event.is_favorited ? "heart" : "heart-outline"}
              size={20}
              color={event.is_favorited ? "#FF3366" : "#FFF"}
            />
          </TouchableOpacity>
        </View>

        <Animated.View entering={FadeIn.springify()} style={styles.body}>
          {/* Category + Status */}
          <View style={styles.row}>
            {event.category && <Badge label={event.category} />}
            {isSoldOut && (
              <Badge label={t("event.soldOut")} variant="destructive" style={{ marginLeft: spacing.sm }} />
            )}
          </View>

          {/* Promise Badges (P1 + P2 기본) */}
          <PromiseBadges
            showP1
            showP2
            style={{ marginTop: spacing.md }}
          />

          {/* Date + Venue */}
          <View testID="event.detail.date" style={[styles.infoRow, { marginTop: spacing.lg }]}>
            <Text style={[typography.bodySmall, { color: colors.mutedForeground }]}>
              {t("event.date")}
            </Text>
            <Text style={[typography.body, { color: colors.foreground }]}>
              {event.event_date ? formatEventDate(event.event_date) : "-"}
            </Text>
          </View>

          {event.venue && (
            <View testID="event.detail.venue" style={styles.infoRow}>
              <Text style={[typography.bodySmall, { color: colors.mutedForeground }]}>
                {t("event.venue")}
              </Text>
              <Text style={[typography.body, { color: colors.foreground }]}>
                {event.venue}{event.location_city ? `, ${event.location_city}` : ""}
              </Text>
            </View>
          )}

          <View style={styles.infoRow}>
            <Text style={[typography.bodySmall, { color: colors.mutedForeground }]}>
              {t("event.price")}
            </Text>
            <View style={{ alignItems: "flex-end" }}>
              {/* all-in 가격 범위 — 수수료 포함 표시(P2-C14). min/max all-in 계산 */}
              <Text style={[typography.h4, { color: colors.primary }]}>
                {event.service_fee_rate != null && event.service_fee_rate > 0
                  ? formatPriceRange(
                      event.min_price != null ? calcAllInPrice(event.min_price, event.service_fee_rate).total : null,
                      event.max_price != null ? calcAllInPrice(event.max_price, event.service_fee_rate).total : null,
                    )
                  : formatPriceRange(event.min_price, event.max_price)}
              </Text>
              {event.service_fee_rate != null && event.service_fee_rate > 0 && (
                <Text style={[typography.micro, { color: colors.mutedForeground }]}>
                  {t("event.allInPrice")}
                </Text>
              )}
            </View>
          </View>

          {/* Remaining */}
          {totalRemaining > 0 && (
            <Text style={[typography.bodySmall, { color: colors.warning, marginTop: spacing.sm }]}>
              {t("event.remaining", { count: totalRemaining })}
            </Text>
          )}

          {/* Phase E.2: 가격 알림 등록 */}
          {event.seat_tiers && event.seat_tiers.length > 0 && (
            <View style={{ marginTop: spacing.lg, flexDirection: "row", alignItems: "center", gap: spacing.md }}>
              <PriceAlertButton eventId={event.id} tiers={event.seat_tiers} />
              <Text style={[typography.bodySmall, { color: colors.mutedForeground, flex: 1 }]}>
                {t("priceAlert.cta")}
              </Text>
            </View>
          )}

          {/* Tiers summary — All-In Pricing (수수료 포함) */}
          {event.seat_tiers && event.seat_tiers.length > 0 && (
            <View style={[styles.tiersSection, { backgroundColor: colors.card, borderColor: colors.border, shadowColor: isDark ? "transparent" : "#000" }]}>
              {event.seat_tiers.map((tier) => {
                const allIn = calcAllInPrice(tier.base_price, event.service_fee_rate);
                return (
                  <View key={tier.id} style={styles.tierRow}>
                    <Text style={[typography.body, { color: colors.foreground, flex: 1 }]}>
                      {tier.name}
                    </Text>
                    <View style={{ alignItems: "flex-end" }}>
                      <Text style={[typography.h5, { color: colors.primary }]}>
                        {formatKRW(allIn.total)}
                      </Text>
                      <Text style={[typography.micro, { color: colors.mutedForeground }]}>
                        ({t("event.allInPrice")})
                      </Text>
                    </View>
                    <Text style={[typography.bodySmall, { color: colors.mutedForeground, marginLeft: spacing.md }]}>
                      {tier.capacity - tier.sold_count}/{tier.capacity}
                    </Text>
                  </View>
                );
              })}
            </View>
          )}

          {/* Description */}
          {event.description && (
            <View testID="event.detail.description" style={{ marginTop: spacing.xl }}>
              <Text style={[typography.h3, { color: colors.foreground }]}>
                {t("event.description")}
              </Text>
              <Text style={[typography.body, { color: colors.mutedForeground, marginTop: spacing.sm, lineHeight: 22 }]}>
                {event.description}
              </Text>
            </View>
          )}

          {/* Reviews Section */}
          {reviewSummary && reviewSummary.total_reviews > 0 && (
            <View style={{ marginTop: spacing.xl }}>
              <View style={styles.row}>
                <Text style={[typography.h3, { color: colors.foreground, flex: 1 }]}>
                  {t("review.summary")}
                </Text>
                <Text style={[typography.bodySmall, { color: colors.mutedForeground }]}>
                  ⭐ {reviewSummary.average_rating.toFixed(1)} ({reviewSummary.total_reviews})
                </Text>
              </View>

              {/* Review list (first 3) */}
              {reviewsData?.slice(0, 3).map((review) => (
                <View
                  key={review.id}
                  style={[styles.reviewCard, { backgroundColor: colors.card, borderColor: colors.border }]}
                >
                  <View style={styles.row}>
                    <Text style={[typography.bodySmall, { color: colors.foreground, fontWeight: "600" }]}>
                      {review.reviewer_name ?? "Anonymous"}
                    </Text>
                    <Text style={[typography.micro, { color: colors.warning, marginLeft: spacing.sm }]}>
                      {"⭐".repeat(Math.round(review.rating))}
                    </Text>
                  </View>
                  {review.content && (
                    <Text
                      style={[typography.bodySmall, { color: colors.mutedForeground, marginTop: spacing.xs }]}
                      numberOfLines={2}
                    >
                      {review.content}
                    </Text>
                  )}
                  <TouchableOpacity
                    style={styles.helpfulBtn}
                    onPress={() => helpfulMutation.mutate(review.id)}
                    accessibilityLabel={t("review.helpful")}
                    accessibilityRole="button"
                  >
                    <Text style={[typography.micro, { color: colors.mutedForeground }]}>
                      👍 {t("review.helpful")} {review.helpful_count > 0 ? `(${review.helpful_count})` : ""}
                    </Text>
                  </TouchableOpacity>
                </View>
              ))}

              {/* Write review link */}
              <TouchableOpacity
                onPress={() => {
                  if (!requireAuth()) return;
                  router.push(`/event/${eventId}/review`);
                }}
                accessibilityLabel={t("review.writeReview")}
                accessibilityRole="link"
              >
                <Text style={[typography.bodySmall, { color: colors.primary, marginTop: spacing.sm }]}>
                  {t("review.writeReview")} →
                </Text>
              </TouchableOpacity>
            </View>
          )}

          {/* 이 공연의 픽 갤러리 */}
          {isFeatureEnabled("FAN_STAMP") && (
            <PickEventGallery eventId={eventId} />
          )}

          {/* Going 픽 만들기 CTA */}
          {isFeatureEnabled("FAN_STAMP") && !isSoldOut && (
            <TouchableOpacity
              style={[styles.goingPickCta, { backgroundColor: colors.card, borderColor: colors.border }]}
              onPress={() => {
                if (!requireAuth()) return;
                hapticLight();
                router.push(`/fan-stamp/${eventId}`);
              }}
              accessibilityLabel={t("picks.makePick")}
              accessibilityRole="button"
            >
              <Ionicons name="camera-outline" size={20} color={colors.primary} />
              <Text style={[typography.body, { color: colors.primary, fontWeight: "600" }]}>
                {t("picks.makePick")}
              </Text>
            </TouchableOpacity>
          )}

          {/* Similar Events */}
          {similarEvents && similarEvents.length > 0 && (
            <View style={{ marginTop: spacing.xl }}>
              <Text style={[typography.h3, { color: colors.foreground }]}>
                {t("event.similar")}
              </Text>
              <FlatList
                horizontal
                data={similarEvents}
                keyExtractor={similarKeyExtractor}
                renderItem={renderSimilarItem}
                style={{ marginTop: spacing.md }}
                showsHorizontalScrollIndicator={false}
              />
            </View>
          )}
        </Animated.View>

        {/* Bottom spacer for fixed CTA */}
        <View style={{ height: 80 }} />
      </Animated.ScrollView>

      {/* Fixed CTA — 갈래요 + press animation + haptic */}
      <Animated.View
        style={[
          styles.ctaContainer,
          ctaAnimatedStyle,
        ]}
      >
        <LinearGradient
          colors={["transparent", colors.background]}
          style={StyleSheet.absoluteFill}
        />
        {isSoldOut ? (
          <Button
            title={t("waitlist.joinWaitlist")}
            variant="outline"
            onPress={() => {
              if (!requireAuth()) return;
              // 첫번째 티어로 대기열 진입
              const firstTier = event.seat_tiers?.[0];
              if (firstTier) {
                router.push({
                  pathname: "/event/[id]/waitlist",
                  params: { id: eventId, tierId: firstTier.id, tierName: firstTier.name },
                });
              }
            }}
            size="xl"
            style={{ flex: 1 }}
          />
        ) : (
          <Button
            testID="event.detail.bookNow"
            title={t("event.going")}
            onPress={() => {
              ctaPressed.value = 1;
              handleBooking();
              ctaPressed.value = withDelay(200, withTiming(0, { duration: 0 }));
            }}
            size="xl"
            style={{ flex: 1 }}
          />
        )}
      </Animated.View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  heroContainer: {
    height: HERO_HEIGHT,
    position: "relative",
    overflow: "hidden",
  },
  heroImage: {
    ...StyleSheet.absoluteFillObject,
  },
  heroTitleOverlay: {
    position: "absolute",
    bottom: spacing.xl,
    left: spacing.xl,
    right: spacing.xl,
  },
  heroTitleText: {
    color: "#FFFFFF",
    fontSize: 36,
    fontWeight: "900",
    lineHeight: 42,
    letterSpacing: -1,
  },
  heroActionBtn: {
    position: "absolute",
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(0,0,0,0.3)",
    alignItems: "center",
    justifyContent: "center",
  },
  body: {
    padding: spacing.xl,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
  },
  infoRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: spacing.sm,
  },
  tiersSection: {
    marginTop: spacing.xl,
    borderRadius: radius.xl,
    borderWidth: 1,
    padding: spacing.lg,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  tierRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: spacing.sm,
  },
  ctaContainer: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    paddingBottom: spacing.xl,
  },
  reviewCard: {
    padding: spacing.lg,
    borderRadius: radius.xl,
    borderWidth: 1,
    marginTop: spacing.md,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  helpfulBtn: {
    marginTop: spacing.xs,
    alignSelf: "flex-start",
  },
  goingPickCta: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    marginTop: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.xl,
    borderWidth: 1,
  },
});
