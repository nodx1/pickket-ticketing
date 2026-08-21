/**
 * InlineBookingCard — 챗 내 인라인 예매 (Phase 2)
 * 티어 선택 + 수량 + AP 투자를 챗 버블 내에서 처리
 * 피처플래그 CHAT_INLINE_BOOKING으로 제어
 * 디자인 정책: radius.xl(16), 44pt 터치, spring 애니메이션
 */
import { useCallback, useMemo, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useRouter } from "expo-router";
import { useTheme } from "@/hooks/useTheme";
import { useTranslation } from "react-i18next";
import { typography, spacing, radius } from "@/config/theme";
import { isFeatureEnabled } from "@/config/features";
import { useEventTiers } from "@/hooks/useEvents";
import { formatKRW } from "@/lib/format";
import * as haptics from "@/lib/haptics";
import type { Event, SeatTier } from "@/config/api";

interface Props {
  event: Event;
}

export function InlineBookingCard({ event }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const { data: tiers, isLoading } = useEventTiers(event.id);

  const [selectedTierId, setSelectedTierId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);

  if (!isFeatureEnabled("CHAT_INLINE_BOOKING")) return null;

  const selectedTier = useMemo(
    () => tiers?.find((t) => t.id === selectedTierId) ?? null,
    [tiers, selectedTierId],
  );

  const maxQty = useMemo(() => {
    if (!selectedTier) return 4;
    return Math.min(selectedTier.max_group_size ?? 4, selectedTier.remaining, 4);
  }, [selectedTier]);

  const total = selectedTier ? selectedTier.base_price * quantity : 0;

  const handleTierSelect = useCallback((tier: SeatTier) => {
    haptics.selectionFeedback();
    setSelectedTierId(tier.id);
    setQuantity(1);
  }, []);

  const handleQtyChange = useCallback(
    (delta: number) => {
      haptics.selectionFeedback();
      setQuantity((q) => Math.max(1, Math.min(q + delta, maxQty)));
    },
    [maxQty],
  );

  const handleProceed = useCallback(() => {
    if (!selectedTier) return;
    haptics.impactFeedback();
    // Phase 2: 기존 예매 플로우로 딥링크 (티어 사전 선택)
    router.push({
      pathname: "/event/[id]/booking",
      params: {
        id: event.id,
        preselectedTier: selectedTier.id,
        preselectedQty: String(quantity),
      },
    });
  }, [selectedTier, quantity, event.id, router]);

  if (isLoading) {
    return (
      <Animated.View entering={FadeIn.springify()}>
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[typography.bodySmall, { color: colors.mutedForeground }]}>
            {t("common.loading")}
          </Text>
        </View>
      </Animated.View>
    );
  }

  if (!tiers || tiers.length === 0) return null;

  return (
    <Animated.View entering={FadeIn.springify().damping(18)}>
      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        {/* 헤더 */}
        <Text style={[typography.h4, { color: colors.foreground }]}>
          {t("booking.selectTier")}
        </Text>

        {/* 티어 리스트 (compact) */}
        <View style={styles.tierList}>
          {tiers.map((tier) => {
            const isSelected = tier.id === selectedTierId;
            const isSoldOut = tier.remaining <= 0;

            return (
              <TouchableOpacity
                key={tier.id}
                onPress={() => !isSoldOut && handleTierSelect(tier)}
                disabled={isSoldOut}
                style={[
                  styles.tierRow,
                  {
                    borderColor: isSelected ? colors.primary : colors.border,
                    backgroundColor: isSelected ? colors.muted : colors.background,
                    opacity: isSoldOut ? 0.5 : 1,
                  },
                ]}
                accessibilityRole="radio"
                accessibilityState={{ selected: isSelected }}
                accessibilityLabel={`${tier.name} ${formatKRW(tier.base_price)}`}
              >
                <View style={styles.tierInfo}>
                  <Text style={[typography.h5, { color: colors.foreground }]}>{tier.name}</Text>
                  <Text style={[typography.bodySmall, { color: colors.mutedForeground }]}>
                    {isSoldOut
                      ? t("booking.soldOut")
                      : t("booking.remaining", { remaining: tier.remaining })}
                  </Text>
                </View>
                <Text style={[typography.h5, { color: isSelected ? colors.primary : colors.foreground }]}>
                  {formatKRW(tier.base_price)}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* 수량 + 합계 (티어 선택 시) */}
        {selectedTier && (
          <View style={styles.qtySection}>
            <View style={styles.qtyRow}>
              <Text style={[typography.body, { color: colors.foreground }]}>
                {t("booking.quantity")}
              </Text>
              <View style={styles.qtyControls}>
                <TouchableOpacity
                  onPress={() => handleQtyChange(-1)}
                  disabled={quantity <= 1}
                  style={[styles.qtyBtn, { borderColor: colors.border }]}
                  accessibilityRole="button"
                  accessibilityLabel={t("booking.decreaseQuantity")}
                >
                  <Ionicons name="remove" size={18} color={quantity <= 1 ? colors.mutedForeground : colors.foreground} />
                </TouchableOpacity>
                <Text style={[typography.h4, styles.qtyValue, { color: colors.foreground }]}>
                  {quantity}
                </Text>
                <TouchableOpacity
                  onPress={() => handleQtyChange(1)}
                  disabled={quantity >= maxQty}
                  style={[styles.qtyBtn, { borderColor: colors.border }]}
                  accessibilityRole="button"
                  accessibilityLabel={t("booking.increaseQuantity")}
                >
                  <Ionicons name="add" size={18} color={quantity >= maxQty ? colors.mutedForeground : colors.foreground} />
                </TouchableOpacity>
              </View>
            </View>

            {/* 합계 */}
            <View style={styles.totalRow}>
              <Text style={[typography.h4, { color: colors.foreground }]}>
                {t("booking.total")}
              </Text>
              <Text style={[typography.h3, { color: colors.primary }]}>
                {formatKRW(total)}
              </Text>
            </View>

            {/* 예매 버튼 */}
            <TouchableOpacity
              onPress={handleProceed}
              style={[styles.bookBtn, { backgroundColor: colors.primary }]}
              activeOpacity={0.8}
              accessibilityRole="button"
            >
              <Ionicons name="ticket-outline" size={18} color={colors.primaryForeground} />
              <Text style={[typography.h5, { color: colors.primaryForeground, marginLeft: spacing.sm }]}>
                {t("event.booking")}
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.xl,
    borderWidth: 1,
    padding: spacing.md,
    marginTop: spacing.sm,
  },
  tierList: {
    marginTop: spacing.md,
    gap: spacing.sm,
  },
  tierRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: spacing.md,
    borderRadius: radius.xl,
    borderWidth: 1,
    minHeight: 44,
  },
  tierInfo: {
    flex: 1,
    marginRight: spacing.md,
  },
  qtySection: {
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: "rgba(0,0,0,0.06)",
  },
  qtyRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  qtyControls: {
    flexDirection: "row",
    alignItems: "center",
  },
  qtyBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  qtyValue: {
    width: 40,
    textAlign: "center",
  },
  totalRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: spacing.md,
  },
  bookBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    height: 44,
    borderRadius: radius.xl,
    marginTop: spacing.md,
  },
});
