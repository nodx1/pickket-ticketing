"use client";

import type { LucideIcon } from "lucide-react";
import { TrendingDown, TrendingUp } from "lucide-react";
import { cn } from "@pickket/lib";
import MiniSparkline from "./MiniSparkline";

interface KpiCardProps {
  label: string;
  value: string;
  icon: LucideIcon;
  iconColor?: string;
  change?: number;
  changeLabel?: string;
  sparkData?: number[];
  accent?: boolean;
  subtitle?: string | null;
}

export default function KpiCard({
  label,
  value,
  icon: Icon,
  iconColor = "text-primary",
  change,
  changeLabel,
  sparkData,
  accent,
  subtitle,
}: KpiCardProps) {
  const isPositive = change !== undefined && change > 0;
  const isNegative = change !== undefined && change < 0;

  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-card p-5 flex flex-col gap-3",
        accent && "ring-1 ring-primary/20 bg-gradient-to-br from-primary/5 to-primary/10"
      )}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Icon className={cn("h-4 w-4", iconColor)} />
          {label}
        </div>
        {sparkData && sparkData.length >= 2 && (
          <MiniSparkline data={sparkData} width={64} height={20} />
        )}
      </div>

      <p className="text-2xl lg:text-3xl font-bold font-tabular">{value}</p>

      <div className="flex items-center gap-2 text-xs">
        {change !== undefined && (
          <span
            className={cn(
              "flex items-center gap-0.5 font-medium",
              isPositive && "text-emerald-600",
              isNegative && "text-red-500",
              !isPositive && !isNegative && "text-muted-foreground"
            )}
          >
            {isPositive && <TrendingUp className="h-3 w-3" />}
            {isNegative && <TrendingDown className="h-3 w-3" />}
            {isPositive ? "+" : ""}
            {change.toFixed(1)}%
          </span>
        )}
        {changeLabel && (
          <span className="text-muted-foreground">{changeLabel}</span>
        )}
        {subtitle && !changeLabel && (
          <span className="text-muted-foreground">{subtitle}</span>
        )}
      </div>
    </div>
  );
}
