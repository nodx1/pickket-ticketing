"use client";

import { useTranslations } from "next-intl";
import { motion } from "motion/react";

interface CompetitionGaugeProps {
  ratio: number;
  showLabel?: boolean;
  size?: "sm" | "md";
}

function getGaugeColor(ratio: number) {
  if (ratio >= 0.8)
    return {
      bar: "#DC2626",
      glow: "rgba(220,38,38,0.10))",
    };
  if (ratio >= 0.5)
    return {
      bar: "var(--primary)",
      glow: "color-mix(in srgb, var(--primary) 15%, transparent))",
    };
  return {
    bar: "#00A882",
    glow: "rgba(0,168,130,0.12))",
  };
}

export function CompetitionGauge({
  ratio,
  showLabel = true,
  size = "sm",
}: CompetitionGaugeProps) {
  const t = useTranslations("event.competitionGauge");
  const clamped = Math.max(0, Math.min(1, ratio));
  const color = getGaugeColor(clamped);
  const h = size === "md" ? "h-2" : "h-1.5";
  const displayRatio = clamped > 0 ? Math.max(clamped, 1).toFixed(1) : "0";

  return (
    <div className="flex items-center gap-2">
      <div className={`flex-1 ${h} rounded-full bg-border overflow-hidden`}>
        <motion.div
          className={`${h} rounded-full`}
          style={{ background: color.bar, boxShadow: `0 0 8px ${color.glow}` }}
          initial={{ width: 0 }}
          animate={{ width: `${clamped * 100}%` }}
          transition={{ duration: 0.8, ease: "easeOut" }}
        />
      </div>
      {showLabel && (
        <span
          className="text-xs font-medium whitespace-nowrap"
          style={{ color: color.bar }}
        >
          {t("ratio", { ratio: displayRatio ?? "0" })}
        </span>
      )}
    </div>
  );
}
