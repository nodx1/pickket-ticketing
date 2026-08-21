"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { type SeatTier } from "@pickket/lib/api";
import { formatKRW } from "@pickket/lib";
import { cn } from "@pickket/lib";

const GRADE_COLORS: Record<string, string> = {
  R: "#404040",
  S: "#6366f1",
  A: "#3b82f6",
  B: "#06b6d4",
  C: "#10b981",
};

interface SeatMapLegendProps {
  tiers: SeatTier[];
  className?: string;
}

export default function SeatMapLegend({
  tiers,
  className,
}: SeatMapLegendProps) {
  const t = useTranslations("booking.seatMapLegend");
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground",
        className,
      )}
    >
      {/* Grade colors */}
      {tiers.map((tier) => {
        const grade = tier.name.charAt(0).toUpperCase();
        const color = GRADE_COLORS[grade] ?? "#6366f1";
        return (
          <span key={tier.id} className="flex items-center gap-1.5">
            <span
              className="w-3 h-3 rounded-full shrink-0"
              style={{ backgroundColor: color }}
            />
            <span className="font-medium text-foreground/80">{tier.name}</span>
            <span>{formatKRW(tier.face_price ?? tier.base_price)}</span>
          </span>
        );
      })}

      {/* Divider */}
      <span className="w-px h-4 bg-border" />

      {/* Status indicators */}
      <span className="flex items-center gap-1.5">
        <span className="w-3 h-3 rounded-full bg-emerald-500" />
        {t("available")}
      </span>
      <span className="flex items-center gap-1.5">
        <span className="w-3 h-3 rounded-full bg-amber-400" />
        {t("limited")}
      </span>
      <span className="flex items-center gap-1.5">
        <span className="w-3 h-3 rounded-full bg-red-500" />
        {t("almostSoldOut")}
      </span>

      {/* Divider */}
      <span className="w-px h-4 bg-border" />

      {/* Obstructed */}
      <span className="flex items-center gap-1.5">
        <span className="w-3 h-3 rounded-full border-2 border-dashed border-muted-foreground/50 opacity-60" />
        {t("obstructedView")}
      </span>
    </div>
  );
}
