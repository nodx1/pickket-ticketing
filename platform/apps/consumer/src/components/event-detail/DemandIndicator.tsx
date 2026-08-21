"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { Flame, TrendingUp, Users, Eye } from "lucide-react";
import { motion } from "motion/react";
import { cn } from "@pickket/lib";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface DemandIndicatorProps {
  eventId: string;
  bidCount: number;
  totalSeats: number;
  viewCount?: number;
}

type DemandLevel = "low" | "medium" | "high" | "veryHigh";

interface LevelConfig {
  label: string;
  bg: string;
  text: string;
  barColor: string;
  icon: typeof Flame;
  pulse: boolean;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const LEVEL_MAP: Record<DemandLevel, LevelConfig> = {
  low: {
    label: "levelLow",
    bg: "bg-green-500/15 dark:bg-green-500/20",
    text: "text-green-600 dark:text-green-400",
    barColor: "bg-green-600 dark:bg-green-400",
    icon: TrendingUp,
    pulse: false,
  },
  medium: {
    label: "levelMedium",
    bg: "bg-amber-500/15 dark:bg-amber-500/20",
    text: "text-amber-600 dark:text-amber-400",
    barColor: "bg-amber-600 dark:bg-amber-400",
    icon: TrendingUp,
    pulse: false,
  },
  high: {
    label: "levelHigh",
    bg: "bg-orange-500/15 dark:bg-orange-500/20",
    text: "text-orange-600 dark:text-orange-400",
    barColor: "bg-orange-600 dark:bg-orange-400",
    icon: Flame,
    pulse: false,
  },
  veryHigh: {
    label: "levelVeryHigh",
    bg: "bg-red-500/15 dark:bg-red-500/20",
    text: "text-red-600 dark:text-red-400",
    barColor: "bg-red-600 dark:bg-red-400",
    icon: Flame,
    pulse: true,
  },
};

function resolveLevel(bidCount: number, totalSeats: number): DemandLevel {
  if (totalSeats <= 0) return "low";
  const ratio = bidCount / totalSeats;
  if (ratio >= 0.9) return "veryHigh";
  if (ratio >= 0.7) return "high";
  if (ratio >= 0.3) return "medium";
  return "low";
}

/* ------------------------------------------------------------------ */
/*  Progress bar                                                       */
/* ------------------------------------------------------------------ */

function DemandBar({ ratio, config }: { ratio: number; config: LevelConfig }) {
  const pct = Math.min(ratio * 100, 100);

  return (
    <div className="h-1.5 w-full rounded-full bg-muted/60 overflow-hidden">
      <motion.div
        className={cn("h-full rounded-full", config.barColor)}
        initial={{ width: 0 }}
        animate={{ width: `${pct}%` }}
        transition={{ duration: 0.8, ease: "easeOut" }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function DemandIndicator({
  eventId,
  bidCount,
  totalSeats,
  viewCount,
}: DemandIndicatorProps) {
  const t = useTranslations("event.demandIndicator");
  const level = useMemo(
    () => resolveLevel(bidCount, totalSeats),
    [bidCount, totalSeats],
  );
  const config = LEVEL_MAP[level];
  const Icon = config.icon;
  const ratio = totalSeats > 0 ? bidCount / totalSeats : 0;

  return (
    <motion.div
      data-event-id={eventId}
      className="bg-card/90 backdrop-blur-sm rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] dark:shadow-[0_2px_16px_rgba(0,0,0,0.2)] p-4 space-y-3"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
    >
      {/* Header row: icon + title + badge */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Flame className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold text-foreground">
            {t("title")}
          </span>
        </div>

        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs-plus font-bold",
            config.bg,
            config.text,
            config.pulse && "animate-pulse",
          )}
        >
          <Icon className="h-3 w-3" />
          {t(config.label)}
        </span>
      </div>

      {/* Progress bar */}
      <DemandBar ratio={ratio} config={config} />

      {/* Stats row */}
      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Users className="h-3.5 w-3.5" />
          <span className="font-tabular font-medium text-foreground">
            {bidCount.toLocaleString()}
          </span>
          <span>/ {totalSeats.toLocaleString()}{t("seatSuffix")}</span>
        </span>

        {viewCount !== undefined && (
          <span className="inline-flex items-center gap-1">
            <Eye className="h-3.5 w-3.5" />
            <span className="font-tabular font-medium text-foreground">
              {viewCount.toLocaleString()}
            </span>
            <span>{t("views")}</span>
          </span>
        )}
      </div>

      {/* Interest sentence */}
      <p className="text-xs text-muted-foreground leading-relaxed">
        {t("interestPrefix")}{" "}
        <motion.span
          key={bidCount}
          className="font-tabular font-bold text-foreground"
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
        >
          {bidCount.toLocaleString()}
        </motion.span>
        {t("interestSuffix")}
      </p>
    </motion.div>
  );
}
