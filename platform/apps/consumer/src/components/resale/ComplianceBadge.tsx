"use client";

import { useTranslations } from "next-intl";
import { Scale } from "lucide-react";
import { cn } from "@pickket/lib";

interface ComplianceBadgeProps {
  variant?: "inline" | "banner";
  maxMarkupPct?: number;
  className?: string;
}

export default function ComplianceBadge({
  variant = "inline",
  maxMarkupPct,
  className,
}: ComplianceBadgeProps) {
  const t = useTranslations("resale");

  if (variant === "inline") {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700",
          className
        )}
      >
        <Scale className="h-3 w-3" />
        <span>{t("fairTrade")}</span>
        {maxMarkupPct != null && (
          <span className="text-emerald-500">&middot; {t("priceCeiling", { pct: maxMarkupPct })}</span>
        )}
      </span>
    );
  }

  // Banner variant
  return (
    <div
      className={cn(
        "w-full rounded-md border-l-[3px] border-l-emerald-500 bg-gradient-to-r from-emerald-50 to-teal-50 px-4 py-3",
        className
      )}
    >
      <div className="flex items-start gap-2">
        <Scale className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-600 dark:text-emerald-400" />
        <div className="min-w-0">
          <p className="text-sm font-bold text-emerald-800">
            {t("antiScalpingCompliant")}
          </p>
          <p className="mt-0.5 text-xs text-emerald-600 dark:text-emerald-400">
            {t("complianceDetail")}
            {maxMarkupPct != null && (
              <span> &middot; {t("maxCeiling", { pct: maxMarkupPct })}</span>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
