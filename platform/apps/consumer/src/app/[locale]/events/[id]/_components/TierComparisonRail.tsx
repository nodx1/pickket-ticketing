"use client";

import { useTranslations } from "next-intl";
import { motion } from "motion/react";
import type { SeatTier } from "@pickket/lib/api";

interface TierComparisonRailProps {
  tiers: SeatTier[];
  selectedTierId?: string | null;
  onSelect: (tierId: string) => void;
}

const TIER_COLORS = [
  "#7B61FF",
  "#FFD700",
  "#01f5a0",
  "#00D1FF",
  "#FF00FF",
  "#FF6B6B",
];

export function TierComparisonRail({
  tiers,
  selectedTierId,
  onSelect,
}: TierComparisonRailProps) {
  const t = useTranslations("event.tierComparison");

  if (tiers.length === 0) return null;

  return (
    <div className="lg:hidden px-4 py-1">
      <div
        className="grid grid-cols-2 gap-2"
        role="listbox"
        aria-label={t("ariaLabel")}
      >
        {tiers.map((tier, i) => {
          const color = TIER_COLORS[i % TIER_COLORS.length];
          const isSelected = selectedTierId === tier.id;
          const isSoldOut = tier.remaining <= 0;
          const fillPct =
            tier.capacity > 0
              ? ((tier.capacity - tier.remaining) / tier.capacity) * 100
              : 0;
          // face_price 미설정(0)이면 base_price 사용 — ?? 는 0 을 유효값으로 봐 0원 표시되던 버그.
          const price = tier.face_price || tier.base_price;

          return (
            <motion.button
              key={tier.id}
              role="option"
              aria-selected={isSelected}
              aria-disabled={isSoldOut}
              whileTap={isSoldOut ? undefined : { scale: 0.97 }}
              onClick={() => !isSoldOut && onSelect(tier.id)}
              disabled={isSoldOut}
              className={`rounded-xl border p-3 text-left transition-all ${
                isSoldOut
                  ? "border-border/40 bg-muted/30 opacity-40 cursor-not-allowed"
                  : isSelected
                    ? "border-primary bg-primary/5 shadow-sm"
                    : "border-border bg-card"
              }`}
              style={{
                borderColor: isSelected && !isSoldOut ? color : undefined,
                boxShadow:
                  isSelected && !isSoldOut ? `0 0 16px ${color}40` : undefined,
              }}
            >
              {/* Tier name with color dot */}
              <div className="flex items-center gap-2 mb-2">
                <span
                  className="h-2.5 w-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: color }}
                />
                <span className="text-xs font-semibold text-foreground truncate">
                  {tier.name}
                </span>
              </div>

              {/* Price */}
              <p className="text-base font-black text-foreground font-tabular mb-2">
                {price.toLocaleString("ko-KR")}
                <span className="text-xs font-normal text-muted-foreground ml-0.5">
                  {t("currencyUnit")}
                </span>
              </p>

              {/* Fill progress */}
              <div className="h-1.5 w-full rounded-full bg-border overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{
                    width: `${fillPct}%`,
                    backgroundColor: color,
                  }}
                />
              </div>
              <p className="text-2xs text-muted-foreground mt-1">
                {isSoldOut ? t("soldOut") : t("remainingSeats", { count: tier.remaining ?? 0 })}
              </p>
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}
