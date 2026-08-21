"use client";

import { DEMAND_LEVELS, getDemandLevel } from "@pickket/lib";
import { cn } from "@pickket/lib";

interface DemandBadgeProps {
  bidCount: number;
  totalSeats: number;
  className?: string;
}

export default function DemandBadge({
  bidCount,
  totalSeats,
  className,
}: DemandBadgeProps) {
  const level = getDemandLevel(bidCount, totalSeats);
  const config = DEMAND_LEVELS[level];

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-2xs font-semibold text-white",
        config.color,
        level === "HIGH" && "animate-pulse",
        className,
      )}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-white/80" />
      {config.label}
    </span>
  );
}
