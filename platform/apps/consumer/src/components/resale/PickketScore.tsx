"use client";

import { useTranslations } from "next-intl";
import {
  calculatePickketScore,
  type PickketScoreInput,
} from "@/lib/pickket-score";
import { cn } from "@pickket/lib";

interface PickketScoreProps {
  input: PickketScoreInput;
  variant?: "full" | "compact";
  className?: string;
}

function getBarColor(score: number): string {
  if (score >= 90) return "bg-emerald-500";
  if (score >= 70) return "bg-lime-500";
  if (score >= 50) return "bg-amber-500";
  if (score >= 30) return "bg-orange-500";
  return "bg-red-500";
}

export default function PickketScore({
  input,
  variant = "full",
  className,
}: PickketScoreProps) {
  const t = useTranslations("resale");
  const result = calculatePickketScore(input);

  const translatedLabel = t(result.label);
  const translatedDescription = t(result.description, result.descriptionParams ?? {});

  if (variant === "compact") {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold",
          result.bgColor,
          result.color,
          className
        )}
      >
        <span className="font-bold">{result.score}</span>
        <span>{translatedLabel}</span>
      </span>
    );
  }

  return (
    <div
      className={cn(
        "rounded-2xl border border-border bg-card p-5 space-y-4",
        className
      )}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Pickket Score</h3>
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold",
            result.bgColor,
            result.color
          )}
        >
          {translatedLabel}
        </span>
      </div>
      <div className="space-y-2">
        <div className="relative h-3 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full rounded-full transition-all duration-500 ease-out",
              getBarColor(result.score)
            )}
            style={{ width: `${result.score}%` }}
          />
        </div>
        <div className="flex items-baseline justify-between">
          <span className={cn("text-2xl font-bold font-mono", result.color)}>
            {result.score}
            <span className="text-sm font-normal text-muted-foreground">/100</span>
          </span>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{translatedDescription}</p>
    </div>
  );
}
