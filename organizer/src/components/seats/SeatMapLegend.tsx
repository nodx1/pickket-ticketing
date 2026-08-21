"use client";

/**
 * SeatMapLegend — 좌석 등급·상태 범례 (Phase 6 포팅)
 *
 * v2 SeatMapLegend.tsx를 GO 타입(SeatTier, formatKRW)으로 포팅.
 */

import React from "react";
import { cn } from "@/lib/utils";
import { formatKRW } from "@/lib/format";
import type { SeatTier } from "@/lib/seats/types";

const GRADE_COLORS: Record<string, string> = {
  R: "#8b5cf6",
  S: "#6366f1",
  A: "#3b82f6",
  B: "#06b6d4",
  C: "#10b981",
};

interface SeatMapLegendProps {
  tiers: SeatTier[];
  className?: string;
}

export function SeatMapLegend({ tiers, className }: SeatMapLegendProps) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground",
        className,
      )}
    >
      {tiers.map((tier) => {
        const grade = tier.name.charAt(0).toUpperCase();
        const color = tier.colorHex ?? GRADE_COLORS[grade] ?? "#6366f1";
        const price = tier.facePrice ?? tier.basePrice;
        return (
          <span key={tier.id} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="h-3 w-3 shrink-0 rounded-full"
              style={{ backgroundColor: color }}
            />
            <span className="font-medium text-foreground/80">{tier.name}</span>
            <span>{formatKRW(price)}</span>
          </span>
        );
      })}

      <span aria-hidden className="h-4 w-px bg-border" />

      <span className="flex items-center gap-1.5">
        <span aria-hidden className="h-3 w-3 rounded-full bg-success" />
        여유
      </span>
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="h-3 w-3 rounded-full bg-warning" />
        적음
      </span>
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="h-3 w-3 rounded-full bg-destructive" />
        매진 임박
      </span>

      <span aria-hidden className="h-4 w-px bg-border" />

      <span className="flex items-center gap-1.5">
        <span
          aria-hidden
          className="h-3 w-3 rounded-full border-2 border-dashed border-muted-foreground/50 opacity-60"
        />
        시야 방해석
      </span>
    </div>
  );
}
