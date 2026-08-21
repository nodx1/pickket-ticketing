/**
 * 티어 선택 컴포넌트
 * v2 SeatTier 기반: sale_mode, seating_type, remaining 등 표시
 */
import { useCallback } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";
import { formatKRW } from "@/lib/format";
import { calcAllInPrice } from "@/lib/all-in-pricing";
import type { SeatTier } from "@/config/api";
import { SeatViewPreview } from "@/components/event/SeatViewPreview";
import { toCanonicalSaleMode, CANONICAL_SALE_MODE_LABELS } from "@pickket/lib/contracts/sale-mode";

interface TierSelectorProps {
  tiers: SeatTier[];
  selectedTierId: string | null;
  onSelect: (tierId: string) => void;
  /** 이벤트 서비스 수수료율 — all-in 가격 카드 표시에 사용(P2-C1). 미전달 시 base_price만 표시. */
  serviceFeeRate?: number;
}

function getSaleModeLabel(mode: string, locale: "ko" | "en" = "ko"): string {
  const canonical = toCanonicalSaleMode(mode);
  return CANONICAL_SALE_MODE_LABELS[canonical][locale];
}

export function TierSelector({ tiers, selectedTierId, onSelect, serviceFeeRate }: TierSelectorProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();

  const renderTier = useCallback(
    (tier: SeatTier) => {
      const isSelected = tier.id === selectedTierId;
      const isSoldOut = tier.remaining <= 0;
      const isDisabled = isSoldOut;
      // all-in 가격 계산 — 이벤트 상세·하단바와 3곳 일치(P2-C1)
      const { total: allInPrice, serviceFee } = calcAllInPrice(tier.base_price, serviceFeeRate);
      const displayPrice = allInPrice;

      return (
        <TouchableOpacity
          key={tier.id}
          style={[
            styles.tierCard,
            {
              borderColor: isSelected ? colors.primary : colors.border,
              backgroundColor: isSelected ? colors.muted : colors.card,
              opacity: isDisabled ? 0.5 : 1,
            },
          ]}
          onPress={() => !isDisabled && onSelect(tier.id)}
          disabled={isDisabled}
          accessibilityLabel={`${tier.name} ${formatKRW(displayPrice)}`}
          accessibilityRole="radio"
          accessibilityState={{ selected: isSelected, disabled: isDisabled }}
        >
          <View style={styles.tierHeader}>
            <Text style={[typography.h4, { color: colors.foreground, flex: 1 }]}>
              {tier.name}
            </Text>
            <View>
              <Text style={[typography.h4, { color: colors.primary }]}>
                {formatKRW(displayPrice)}
              </Text>
              {serviceFee > 0 && (
                <Text style={[typography.micro, { color: colors.mutedForeground, textAlign: "right" }]}>
                  {t("event.allInPrice")}
                </Text>
              )}
            </View>
          </View>

          <View style={styles.tierMeta}>
            {/* Sale mode */}
            <Text style={[typography.micro, { color: colors.violet }]}>
              {getSaleModeLabel(tier.sale_mode)}
            </Text>

            {/* Seating type */}
            <Text style={[typography.micro, { color: colors.mutedForeground, marginLeft: spacing.sm }]}>
              {tier.seating_type === "assigned"
                ? t("booking.seatingAssigned")
                : t("booking.seatingFree")}
            </Text>

            {/* Remaining */}
            <Text
              style={[
                typography.micro,
                {
                  color: isSoldOut ? colors.destructive : tier.remaining < 50 ? colors.warning : colors.mutedForeground,
                  marginLeft: "auto",
                },
              ]}
            >
              {isSoldOut
                ? t("booking.soldOut")
                : t("booking.remaining", { remaining: tier.remaining })}
            </Text>
          </View>

          {/* 좌석 시야 미리보기 (Phase D.2) — 선택 시만 노출 */}
          {isSelected && <SeatViewPreview tier={tier} />}
        </TouchableOpacity>
      );
    },
    [selectedTierId, colors, t],
  );

  return <View style={styles.container}>{tiers.map(renderTier)}</View>;
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.md,
  },
  tierCard: {
    padding: spacing.lg,
    borderRadius: radius.xl,
    borderWidth: 2,
  },
  tierHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  tierMeta: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: spacing.sm,
  },
});
