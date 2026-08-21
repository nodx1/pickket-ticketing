"use client";

import { useTranslations } from "next-intl";
import { cn } from "@pickket/lib";

export type DateRangeKey = "this_month" | "last_month" | "3_months" | "all";

interface DateRangeFilterProps {
  value: DateRangeKey;
  onChange: (key: DateRangeKey) => void;
  className?: string;
}

const DATE_RANGE_KEYS: DateRangeKey[] = ["this_month", "last_month", "3_months", "all"];

export function getDateRange(key: DateRangeKey): { from: Date | null; to: Date } {
  const now = new Date();
  const to = now;

  switch (key) {
    case "this_month":
      return { from: new Date(now.getFullYear(), now.getMonth(), 1), to };
    case "last_month": {
      const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      return { from, to };
    }
    case "3_months":
      return { from: new Date(now.getFullYear(), now.getMonth() - 3, 1), to };
    case "all":
      return { from: null, to };
  }
}

export default function DateRangeFilter({ value, onChange, className }: DateRangeFilterProps) {
  const t = useTranslations("common.dateRangeFilter");

  return (
    <div className={cn("flex items-center gap-1", className)}>
      {DATE_RANGE_KEYS.map((key) => (
        <button
          key={key}
          type="button"
          aria-pressed={value === key}
          onClick={() => onChange(key)}
          className={cn(
            "px-3 py-1.5 text-xs rounded-md transition-colors",
            value === key
              ? "bg-primary text-primary-foreground font-medium"
              : "text-muted-foreground hover:text-foreground hover:bg-muted"
          )}
        >
          {t(key)}
        </button>
      ))}
    </div>
  );
}
