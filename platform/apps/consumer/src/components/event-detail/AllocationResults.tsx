"use client";

import { useMemo } from "react";
import type { ReactNode } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { formatKRW } from "@pickket/lib";
import { BarChart3, TrendingDown } from "lucide-react";
import { motion } from "motion/react";
import { useTranslations } from "next-intl";

interface AllocationResultsProps {
  allocation: {
    total_bids: number;
    total_allocated: number;
    competition_ratio: number;
    price_min: number | null;
    price_max: number | null;
    price_median: number | null;
    price_p25: number | null;
    price_p75: number | null;
    cutoff_price: number | null;
    computation_time_seconds: number | null;
  };
}

function StatCard({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] dark:shadow-[0_2px_16px_rgba(0,0,0,0.2)] bg-muted p-4 hover:shadow-xl hover:-translate-y-1 transition-all duration-200">
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p
        className={`text-lg font-bold font-tabular ${highlight ? "text-primary" : "text-foreground"}`}
      >
        {value}
      </p>
    </div>
  );
}

export default function AllocationResults({
  allocation,
}: AllocationResultsProps) {
  const t = useTranslations("event.allocationResults");
  const hasPriceData =
    allocation.price_min !== null &&
    allocation.price_max !== null &&
    allocation.price_median !== null;

  const chartData = useMemo(() => {
    if (!hasPriceData) return [];

    return [
      { name: t("priceMin"), price: allocation.price_min! },
      ...(allocation.price_p25 !== null
        ? [{ name: "P25", price: allocation.price_p25 }]
        : []),
      ...(allocation.price_median !== null
        ? [{ name: t("priceMedian"), price: allocation.price_median }]
        : []),
      ...(allocation.price_p75 !== null
        ? [{ name: "P75", price: allocation.price_p75 }]
        : []),
      { name: t("priceMax"), price: allocation.price_max! },
    ];
  }, [allocation, hasPriceData, t]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="bg-card/90 backdrop-blur-sm rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] dark:shadow-[0_2px_16px_rgba(0,0,0,0.2)] p-5 lg:p-6 space-y-5"
    >
      {/* Section header */}
      <div className="flex items-center gap-2">
        <BarChart3 className="h-5 w-5 text-primary" />
        <h3 className="text-lg font-bold text-foreground">{t("title")}</h3>
      </div>

      {/* Bento grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <StatCard label={t("statTotalBids")} value={t("statTotalBidsValue", { count: allocation.total_bids ?? 0 })} />
        <StatCard
          label={t("statAllocated")}
          value={t("statAllocatedValue", { count: allocation.total_allocated ?? 0 })}
          highlight
        />
        <StatCard
          label={t("statCompetition")}
          value={`${allocation.competition_ratio.toFixed(1)}:1`}
        />
        {allocation.cutoff_price !== null && (
          <StatCard
            label={t("statCutoffPrice")}
            value={formatKRW(allocation.cutoff_price)}
            highlight
          />
        )}
        {allocation.price_median !== null && (
          <StatCard
            label={t("statMedianPrice")}
            value={formatKRW(allocation.price_median)}
          />
        )}
        {allocation.computation_time_seconds !== null && (
          <StatCard
            label={t("statComputationTime")}
            value={t("statComputationTimeValue", { seconds: allocation.computation_time_seconds.toFixed(2) ?? "0.00" })}
          />
        )}
      </div>

      {/* Price distribution chart */}
      {hasPriceData && chartData.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <TrendingDown className="h-4 w-4 text-primary" />
            <h4 className="text-sm font-semibold text-foreground">{t("priceDistribution")}</h4>
          </div>

          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  className="stroke-border"
                />
                <XAxis
                  dataKey="name"
                  tick={{ fontSize: 12 }}
                  className="fill-muted-foreground"
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fontSize: 11 }}
                  className="fill-muted-foreground"
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(value: number) => formatKRW(value)}
                />
                <Tooltip
                  formatter={(value: number | undefined) =>
                    value !== undefined
                      ? [formatKRW(value), t("tooltipPrice")]
                      : ["-", t("tooltipPrice")]
                  }
                  contentStyle={{
                    borderRadius: "12px",
                    border: "none",
                    boxShadow: "0 2px 16px rgba(0,0,0,0.1)",
                    fontSize: "13px",
                    background: "var(--color-card, #ffffff)",
                    color: "var(--color-foreground, #000)",
                  }}
                  labelFormatter={(label: ReactNode) => String(label ?? "")}
                />
                <Bar
                  dataKey="price"
                  fill="var(--color-primary, #0a0a0a)"
                  radius={[6, 6, 0, 0]}
                  maxBarSize={48}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <p className="text-xs text-muted-foreground text-center">
            {t("priceDistributionDesc")}
          </p>
        </div>
      )}
    </motion.div>
  );
}
