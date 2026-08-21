"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Bot, TrendingUp, Users, Zap } from "lucide-react";
import { Progress } from "@pickket/ui";
import { getPriceAdvice, type PriceAdvice } from "@pickket/lib/api";
import { formatKRW } from "@pickket/lib";
import { useAuthStore } from "@pickket/store";
import { DEMAND_LEVELS } from "@pickket/lib/constants";

interface PriceAdvisorProps {
  eventId: string;
}

function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse bg-muted rounded ${className}`} />;
}

function competitionLabel(level: number): keyof typeof DEMAND_LEVELS {
  if (level >= 0.7) return "HIGH";
  if (level >= 0.4) return "MEDIUM";
  if (level >= 0.15) return "LOW";
  return "HIDDEN_GEM";
}

function CompetitionBadge({ level }: { level: number }) {
  const key = competitionLabel(level);
  const config = DEMAND_LEVELS[key];

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold text-white ${config.color}`}
    >
      {config.label}
    </span>
  );
}

export default function PriceAdvisor({ eventId }: PriceAdvisorProps) {
  const t = useTranslations("event.priceAdvisor");
  const { user } = useAuthStore();
  const [advice, setAdvice] = useState<PriceAdvice | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const loadAdvice = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);

    getPriceAdvice(eventId)
      .then((res) => {
        if (!cancelled) setAdvice(res.data);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [eventId]);

  useEffect(() => {
    if (!user) return;
    let cleanup: (() => void) | undefined;
    const timeoutId = window.setTimeout(() => {
      cleanup = loadAdvice();
    }, 0);
    return () => {
      window.clearTimeout(timeoutId);
      cleanup?.();
    };
  }, [user, loadAdvice]);

  if (!user) return null;

  if (loading) {
    return (
      <div className="rounded-xl border border-border p-5 space-y-4 glass">
        <div className="flex items-center gap-2">
          <Skeleton className="h-5 w-5 rounded" />
          <Skeleton className="h-5 w-32" />
        </div>
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-8 w-full rounded-full" />
      </div>
    );
  }

  if (error || !advice) {
    return (
      <div className="rounded-xl border border-border p-5 glass">
        <div className="flex items-center gap-2 mb-2">
          <Bot className="h-5 w-5 text-primary" />
          <h3 className="font-semibold text-sm">{t("title")}</h3>
        </div>
        <p className="text-sm text-muted-foreground">
          {t("loadError")}
        </p>
      </div>
    );
  }

  const winProbability = advice.estimated_win_probability ?? 0;

  return (
    <div className="rounded-xl border border-border p-5 space-y-5 glass">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Bot className="h-5 w-5 text-primary" />
          <h3 className="font-semibold text-sm">{t("title")}</h3>
        </div>
        <CompetitionBadge level={advice.competition_level} />
      </div>

      {/* Suggested bid range */}
      <div className="space-y-2">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <TrendingUp className="h-3.5 w-3.5" />
          {t("suggestedRange")}
        </div>
        <div className="relative h-8 bg-muted rounded-lg overflow-hidden">
          <div
            className="absolute top-0 h-full bg-primary/20 rounded"
            style={{ left: "20%", width: "60%" }}
          />
          <div
            className="absolute top-0 h-full w-0.5 bg-primary"
            style={{ left: "50%" }}
          />
        </div>
        <div className="flex justify-between text-2xs text-muted-foreground">
          <span className="font-tabular">
            {formatKRW(advice.suggested_min_bid)}
          </span>
          {advice.avg_historical_price != null && (
            <span className="text-primary font-medium font-tabular">
              {t("avgPrice", { price: formatKRW(advice.avg_historical_price ?? 0) })}
            </span>
          )}
          <span className="font-tabular">
            {formatKRW(advice.suggested_max_bid)}
          </span>
        </div>
      </div>

      {/* Fan weight */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <Users className="h-3.5 w-3.5" />{t("fanWeight")}
          </span>
          <span className="font-medium">
            {t("topPercentile", { pct: Math.round(100 - (advice.weight_percentile ?? 0)) })}
          </span>
        </div>
        <Progress value={advice.weight_percentile} className="h-2" />
      </div>

      {/* Win probability */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <Zap className="h-3.5 w-3.5" />
            {t("winProbability")}
          </span>
          <span className="font-bold text-primary">
            {Math.round(winProbability)}%
          </span>
        </div>
        <Progress value={winProbability} className="h-2.5" />
      </div>

      {/* Suggestion */}
      <div className="p-3 rounded-lg bg-primary/5 border border-primary/10">
        <p className="text-sm text-foreground leading-relaxed">
          {advice.suggestion_text}
        </p>
      </div>
    </div>
  );
}
