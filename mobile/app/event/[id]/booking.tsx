/**
 * 예매 화면 — 티어 선택 + 수량 + 구매 CTA
 *
 * v2 purchase flow:
 *   1. GET /events/{eventId}/tiers → 전체 SeatTier 목록
 *   2. 유저가 티어 선택 + 수량 선택
 *   3. POST /events/{eventId}/tiers/{tierId}/purchase → PurchaseResult
 *   4. PurchaseResult.order_id → payment prepare → WebView 결제
 */
import { useState, useCallback, useMemo } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Alert,
  StyleSheet,
} from "react-native";
import Animated, { FadeIn, FadeInDown } from "react-native-reanimated";
import { LinearGradient } from "expo-linear-gradient";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";
import { useEvent, useEventTiers } from "@/hooks/useEvents";
import { usePurchaseTicket } from "@/hooks/usePurchase";
import { useThrottledPress } from "@/hooks/useThrottledPress";
import { TierSelector } from "@/components/event/TierSelector";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/common/EmptyState";
import { formatKRW, formatEventDate } from "@/lib/format";
import { calcAllInPrice } from "@/lib/all-in-pricing";

const MAX_QUANTITY = 4;

export default function BookingScreen() {
  const { t } = useTranslation();
  const { colors, isDark } = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string; queueToken?: string }>();
  const eventId = typeof params.id === "string" ? params.id : params.id?.[0] ?? "";
  const queueToken = typeof params.queueToken === "string" ? params.queueToken : undefined;

  const { data: event } = useEvent(eventId);
  const { data: tiers, isLoading: tiersLoading, isError: tiersError, refetch } = useEventTiers(eventId);
  const purchaseMutation = usePurchaseTicket();

  const [selectedTierId, setSelectedTierId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [refundAgreed, setRefundAgreed] = useState(false);

  const selectedTier = useMemo(
    () => tiers?.find((tier) => tier.id === selectedTierId) ?? null,
    [tiers, selectedTierId],
  );

  const maxQty = useMemo(() => {
    if (!selectedTier) return MAX_QUANTITY;
    return Math.min(selectedTier.max_group_size ?? MAX_QUANTITY, selectedTier.remaining, MAX_QUANTITY);
  }, [selectedTier]);

  // 카드/상세 화면과 동일하게 event.service_fee_rate 를 그대로 사용(미지정 시 calcAllInPrice 기본값).
  // 과거 `?? 0` 은 booking 만 수수료를 0 으로 표시해 카드↔상세↔결제 가격이 어긋났다(P2-C16/C17).
  const { unitAllIn, serviceFeeUnit } = useMemo(() => {
    if (!selectedTier) return { unitAllIn: 0, serviceFeeUnit: 0 };
    const { total, serviceFee } = calcAllInPrice(
      selectedTier.base_price,
      event?.service_fee_rate,
    );
    return { unitAllIn: total, serviceFeeUnit: serviceFee };
  }, [selectedTier, event?.service_fee_rate]);
  const totalPrice = unitAllIn * quantity;
  const serviceFeeTotal = serviceFeeUnit * quantity;

  const isLotteryMode = (mode: string) =>
    ["lottery", "point_lottery"].includes(mode);
  const isWaitlistMode = (mode: string) =>
    ["queue"].includes(mode);

  const handleTierSelect = useCallback((tierId: string) => {
    const tier = tiers?.find((t) => t.id === tierId);
    if (!tier) return;

    // 복권 모드 → 복권 화면으로 이동
    if (isLotteryMode(tier.sale_mode)) {
      router.push({
        pathname: "/event/[id]/lottery",
        params: { id: eventId, tierId: tier.id, tierName: tier.name, tierPrice: String(calcAllInPrice(tier.base_price, event?.service_fee_rate).total) },
      });
      return;
    }

    // 대기열 모드 → 대기열 화면으로 이동
    if (isWaitlistMode(tier.sale_mode)) {
      router.push({
        pathname: "/event/[id]/waitlist",
        params: { id: eventId, tierId: tier.id, tierName: tier.name },
      });
      return;
    }

    // 일반 모드 → 수량 선택
    setSelectedTierId(tierId);
    setQuantity(1);
  }, [tiers, eventId, router]);

  const handleQuantityChange = useCallback(
    (delta: number) => {
      setQuantity((prev) => Math.max(1, Math.min(prev + delta, maxQty)));
    },
    [maxQty],
  );

  const handlePurchase = useCallback(() => {
    if (!selectedTierId || !selectedTier) return;

    // 결제 최종 확인 Alert
    Alert.alert(
      t("booking.confirmTitle"),
      t("booking.confirmMessage", {
        tier: selectedTier.name,
        qty: quantity,
        total: formatKRW(totalPrice),
      }),
      [
        { text: t("common.cancel"), style: "cancel" },
        { text: t("booking.pay"), onPress: () => executePurchase() },
      ],
    );
  }, [selectedTierId, selectedTier, quantity, totalPrice, t]);

  const executePurchase = useCallback(() => {
    if (!selectedTierId || !selectedTier) return;

    purchaseMutation.mutate(
      { eventId, tierId: selectedTierId, quantity, queueToken },
      {
        onSuccess: (result) => {
          if (result.processing) {
            Alert.alert(
              t("booking.processingTitle"),
              t("booking.processingMessage"),
              [{ text: t("common.confirm"), onPress: () => router.back() }],
            );
          } else if (result.success && result.order_id) {
            router.push({
              pathname: "/event/[id]/payment",
              params: { id: eventId, orderId: result.order_id },
            });
          } else if (result.waitlist_position != null) {
            Alert.alert(
              t("queue.waiting"),
              result.message,
              [{ text: t("common.confirm"), onPress: () => router.back() }],
            );
          } else {
            Alert.alert(t("booking.purchaseFailed"), result.message);
          }
        },
        onError: (error: Error) => {
          Alert.alert(t("booking.purchaseFailed"), error.message);
        },
      },
    );
  }, [eventId, selectedTierId, selectedTier, quantity, purchaseMutation, router, t]);

  const throttledPurchase = useThrottledPress(handlePurchase, 2000);
  const canPurchase = refundAgreed && !purchaseMutation.isPending;

  return (
    <SafeAreaView testID="booking.screen" style={[styles.container, { backgroundColor: colors.background }]} edges={[]}>
      <Stack.Screen options={{ title: t("booking.selectTier") }} />

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        {/* Event summary */}
        {event && (
          <Animated.View entering={FadeIn.springify()} style={[styles.eventSummary, { backgroundColor: colors.card, borderColor: colors.border, shadowColor: isDark ? "transparent" : "#000" }]}>
            <Text style={[typography.h3, { color: colors.foreground }]} numberOfLines={2}>
              {event.title}
            </Text>
            {event.event_date && (
              <Text style={[typography.bodySmall, { color: colors.mutedForeground, marginTop: spacing.xs }]}>
                {formatEventDate(event.event_date)}
              </Text>
            )}
            {event.venue && (
              <Text style={[typography.bodySmall, { color: colors.mutedForeground, marginTop: spacing.xs }]}>
                {event.venue}
              </Text>
            )}
          </Animated.View>
        )}

        {/* Tier list */}
        <Text testID="booking.selectTier" style={[typography.h3, { color: colors.foreground, marginTop: spacing.xl, marginBottom: spacing.md }]}>
          {t("booking.selectTier")}
        </Text>

        {tiersLoading ? (
          <View style={{ gap: spacing.md }}>
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} width="100%" height={80} borderRadius={radius.xl} />
            ))}
          </View>
        ) : tiersError ? (
          <EmptyState
            title={t("common.error")}
            message={t("common.serverError")}
            actionLabel={t("common.retry")}
            onAction={() => refetch()}
          />
        ) : tiers && tiers.length > 0 ? (
          <TierSelector
            tiers={tiers}
            selectedTierId={selectedTierId}
            onSelect={handleTierSelect}
            serviceFeeRate={event?.service_fee_rate}
          />
        ) : (
          <EmptyState title={t("common.noResults")} />
        )}

        {/* Quantity selector */}
        {selectedTier && (
          <Animated.View entering={FadeInDown.springify()} style={[styles.quantitySection, { borderColor: colors.border }]}>
            <Text style={[typography.h4, { color: colors.foreground }]}>
              {t("booking.quantity")}
            </Text>
            <Text style={[typography.micro, { color: colors.mutedForeground, marginTop: spacing.xs }]}>
              {t("booking.maxTickets", { max: maxQty })}
            </Text>

            <View style={styles.quantityRow}>
              <TouchableOpacity
                style={[styles.qtyBtn, { borderColor: colors.border, backgroundColor: colors.card }]}
                onPress={() => handleQuantityChange(-1)}
                disabled={quantity <= 1}
                accessibilityLabel={t("booking.quantity") + " -1"}
              >
                <Text style={[typography.h3, { color: quantity <= 1 ? colors.muted : colors.foreground }]}>−</Text>
              </TouchableOpacity>

              <Text style={[typography.h2, { color: colors.foreground, minWidth: 48, textAlign: "center" }]}>
                {quantity}
              </Text>

              <TouchableOpacity
                style={[styles.qtyBtn, { borderColor: colors.border, backgroundColor: colors.card }]}
                onPress={() => handleQuantityChange(1)}
                disabled={quantity >= maxQty}
                accessibilityLabel={t("booking.quantity") + " +1"}
              >
                <Text style={[typography.h3, { color: quantity >= maxQty ? colors.muted : colors.foreground }]}>+</Text>
              </TouchableOpacity>
            </View>
          </Animated.View>
        )}

        <View style={{ height: 100 }} />
      </ScrollView>

      {/* Fixed bottom: refund agreement + total + pay button */}
      {selectedTier && (
        <View style={styles.bottomBar}>
          <LinearGradient
            colors={["transparent", colors.background]}
            style={StyleSheet.absoluteFill}
          />
          {/* 환불정책 동의 */}
          <TouchableOpacity
            testID="booking.refundAgree"
            style={styles.refundRow}
            onPress={() => setRefundAgreed((v) => !v)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: refundAgreed }}
            accessibilityLabel={t("booking.refundAgree")}
          >
            <View style={[styles.miniCheckbox, {
              borderColor: refundAgreed ? colors.primary : colors.border,
              backgroundColor: refundAgreed ? colors.primary : "transparent",
            }]}>
              {refundAgreed && <Text style={{ color: colors.primaryForeground, fontSize: 12 }}>✓</Text>}
            </View>
            <Text style={[typography.bodySmall, { color: colors.mutedForeground, flex: 1 }]}>
              {t("booking.refundAgree")}
            </Text>
            <TouchableOpacity
              onPress={() => router.push("/legal/refund-policy")}
              hitSlop={8}
            >
              <Text style={[typography.bodySmall, { color: colors.primary }]}>
                {t("consent.view")}
              </Text>
            </TouchableOpacity>
          </TouchableOpacity>

          {serviceFeeTotal > 0 && (
            <View style={styles.totalRow}>
              <Text style={[typography.micro, { color: colors.mutedForeground }]}>
                {t("booking.serviceFee")}
              </Text>
              <Text style={[typography.micro, { color: colors.mutedForeground }]}>
                {formatKRW(serviceFeeTotal)}
              </Text>
            </View>
          )}
          <View style={styles.totalRow}>
            <Text style={[typography.body, { color: colors.mutedForeground }]}>
              {t("booking.total")}
            </Text>
            <Text style={[typography.h2, { color: colors.primary }]}>
              {formatKRW(totalPrice)}
            </Text>
          </View>
          <Button
            testID="booking.pay"
            title={purchaseMutation.isPending ? t("booking.processing") : t("booking.pay")}
            onPress={throttledPurchase}
            disabled={!canPurchase}
            size="xl"
            style={{ marginTop: spacing.sm }}
          />
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scrollContent: {
    padding: spacing.xl,
  },
  eventSummary: {
    padding: spacing.lg,
    borderRadius: radius.xl,
    borderWidth: 1,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  quantitySection: {
    marginTop: spacing.xl,
    paddingTop: spacing.lg,
    borderTopWidth: 1,
  },
  quantityRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    marginTop: spacing.md,
    gap: spacing.xl,
  },
  qtyBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  bottomBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    paddingBottom: spacing.xl,
  },
  refundRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  miniCheckbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
});
