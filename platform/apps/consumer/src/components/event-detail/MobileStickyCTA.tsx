"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Button } from "@pickket/ui";
import type { SeatTier } from "@pickket/lib/api";
import { formatKRW, normalizeSaleMode } from "@pickket/lib";
import { getOrganizerLabels } from "@pickket/lib";

interface MobileStickyCTAProps {
  event: {
    title: string;
    min_price: number;
    status: string;
    category?: string;
  };
  tier: SeatTier | null;
  isHeroVisible: boolean;
  onCTAClick: () => void;
}

type TFn = ReturnType<typeof useTranslations<"event.mobileStickyCta">>;

function getCTALabel(t: TFn, tier: SeatTier | null, category?: string): string {
  const labels = getOrganizerLabels(category);
  if (!tier) return `${labels.ticketNoun} ${labels.ctaVerb}`;

  switch (normalizeSaleMode(tier.sale_mode)) {
    case "fixed_fcfs":
      return t("ctaFixed", { verb: labels.ctaVerb ?? "" });
    case "lottery":
      return t("ctaLottery");
    case "fanclub":
      return t("ctaFanclub", { verb: labels.ctaVerb ?? "" });
    default:
      return `${labels.ticketNoun} ${labels.ctaVerb}`;
  }
}

function getDisplayPrice(
  event: { min_price: number },
  tier: SeatTier | null,
): string {
  if (tier) {
    return formatKRW(tier.base_price);
  }
  return formatKRW(event.min_price);
}

export default function MobileStickyCTA({
  event,
  tier,
  isHeroVisible,
  onCTAClick,
}: MobileStickyCTAProps) {
  const t = useTranslations("event.mobileStickyCta");
  return (
    <div
      role="complementary"
      aria-label={t("ariaLabel")}
      className={[
        "fixed bottom-0 inset-x-0 z-50 lg:hidden",
        "transform transition-transform duration-300 motion-reduce:transition-none",
        !isHeroVisible ? "translate-y-0" : "translate-y-full",
      ].join(" ")}
    >
      <div className="bg-card/95 backdrop-blur-xl border-t border-border shadow-[0_-4px_20px_rgba(0,0,0,0.08)] dark:shadow-[0_-4px_20px_rgba(0,0,0,0.3)] px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
        <div className="flex items-center justify-between gap-3">
          {/* Left side: event info */}
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted-foreground truncate">
              {event.title}
            </p>
            <p className="text-lg font-bold text-primary font-tabular">
              {getDisplayPrice(event, tier)}
              <span className="text-xs font-normal text-muted-foreground ml-0.5">
                {t("priceFrom")}
              </span>
            </p>
          </div>

          {/* Right side: CTA button */}
          <Button
            onClick={onCTAClick}
            className="rounded-full bg-primary hover:bg-primary/90 text-primary-foreground shrink-0 px-6 shadow-[0_4px_16px_rgba(30,42,120,0.3)] dark:shadow-[0_4px_16px_rgba(0,0,0,0.4)]"
          >
            {getCTALabel(t, tier, event.category)}
          </Button>
        </div>
      </div>
    </div>
  );
}
