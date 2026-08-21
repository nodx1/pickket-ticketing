"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { motion } from "motion/react";
import { toast } from "sonner";
import { Loader2, RefreshCw, Users, TrendingUp, Calendar } from "lucide-react";
import { Button, Badge } from "@pickket/ui";
import api from "@pickket/lib/api";
import { isApiCanceled } from "@pickket/lib/api";

// ── Types ───────────────────────────────────────────────────────────────────

interface RetentionCell {
  cohort_month: string;
  period_months: number;
  retention_rate: number;
  sample_size: number;
}

interface RetentionHeatmapData {
  cohorts: string[];
  periods: number[];
  cells: RetentionCell[];
}

interface LTVDataPoint {
  cohort_month: string;
  period_months: number;
  ltv: number;
  sample_size: number;
}

interface LTVTrendData {
  cohorts: string[];
  data: LTVDataPoint[];
}

// ── Color Helpers ───────────────────────────────────────────────────────────

function retentionColor(rate: number): string {
  if (rate >= 0.8) return "bg-emerald-600 text-white";
  if (rate >= 0.6) return "bg-emerald-500 text-white";
  if (rate >= 0.4) return "bg-emerald-400 text-white";
  if (rate >= 0.2) return "bg-emerald-300 text-emerald-900";
  if (rate >= 0.1) return "bg-emerald-200 text-emerald-800";
  if (rate > 0) return "bg-emerald-100 text-emerald-700";
  return "bg-muted/30 text-muted-foreground";
}

function formatPct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function formatKRW(amount: number): string {
  if (amount >= 10000) return `${(amount / 10000).toFixed(1)}만`;
  return amount.toLocaleString();
}

// ── Retention Heatmap Component ─────────────────────────────────────────────

function RetentionHeatmap({ data }: { data: RetentionHeatmapData }) {
  const t = useTranslations("cohort");
  if (!data.cohorts.length) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <p>{t("retentionEmpty")}</p>
      </div>
    );
  }

  const cellMap = new Map<string, RetentionCell>();
  for (const cell of data.cells) {
    cellMap.set(`${cell.cohort_month}:${cell.period_months}`, cell);
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/30">
            <th className="px-3 py-2 text-left font-medium text-muted-foreground whitespace-nowrap">
              {t("cohort")}
            </th>
            <th className="px-3 py-2 text-right font-medium text-muted-foreground whitespace-nowrap">
              {t("users")}
            </th>
            {data.periods.map((p) => (
              <th
                key={p}
                className="px-2 py-2 text-center font-medium text-muted-foreground whitespace-nowrap min-w-[60px]"
              >
                {p === 0 ? t("joinMonth") : t("plusMonths", { n: p })}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.cohorts.map((cohort, ci) => (
            <motion.tr
              key={cohort}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: ci * 0.03 }}
              className="border-b border-border last:border-0 hover:bg-muted/10 transition-colors"
            >
              <td className="px-3 py-2 font-medium whitespace-nowrap">
                {cohort}
              </td>
              <td className="px-3 py-2 text-right font-mono text-xs text-muted-foreground whitespace-nowrap">
                {cellMap.get(`${cohort}:0`)?.sample_size?.toLocaleString() ??
                  "-"}
              </td>
              {data.periods.map((p) => {
                const cell = cellMap.get(`${cohort}:${p}`);
                if (!cell) {
                  return (
                    <td key={p} className="px-2 py-2 text-center">
                      <div className="h-8 rounded bg-muted/10" />
                    </td>
                  );
                }
                return (
                  <td key={p} className="px-1 py-1 text-center">
                    <div
                      className={`h-8 rounded flex items-center justify-center text-xs font-medium ${retentionColor(cell.retention_rate)}`}
                      title={t("retentionCellTitle", { cohort, n: p, pct: formatPct(cell.retention_rate), size: cell.sample_size ?? 0 })}
                    >
                      {formatPct(cell.retention_rate)}
                    </div>
                  </td>
                );
              })}
            </motion.tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── LTV Trend Component ─────────────────────────────────────────────────────

function LTVTrend({ data }: { data: LTVTrendData }) {
  const t = useTranslations("cohort");
  if (!data.cohorts.length) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <p>{t("ltvEmpty")}</p>
      </div>
    );
  }

  // Group by cohort
  const cohortData = new Map<string, LTVDataPoint[]>();
  for (const point of data.data) {
    const arr = cohortData.get(point.cohort_month) ?? [];
    arr.push(point);
    cohortData.set(point.cohort_month, arr);
  }

  // Find max LTV for normalization
  const maxLTV = Math.max(...data.data.map((d) => d.ltv), 1);

  // Consistent colors for cohorts
  const COHORT_COLORS = [
    "bg-indigo-500",
    "bg-blue-500",
    "bg-cyan-500",
    "bg-emerald-500",
    "bg-amber-500",
    "bg-rose-500",
    "bg-purple-500",
    "bg-teal-500",
    "bg-orange-500",
    "bg-pink-500",
    "bg-lime-500",
    "bg-sky-500",
  ];

  return (
    <div className="space-y-4">
      {/* Legend */}
      <div className="flex flex-wrap gap-3">
        {data.cohorts.map((cohort, i) => (
          <div key={cohort} className="flex items-center gap-1.5">
            <div
              className={`h-2.5 w-2.5 rounded-full ${COHORT_COLORS[i % COHORT_COLORS.length]}`}
            />
            <span className="text-xs text-muted-foreground">{cohort}</span>
          </div>
        ))}
      </div>

      {/* Simple bar chart per cohort */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/30">
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                {t("cohort")}
              </th>
              <th className="px-3 py-2 text-right font-medium text-muted-foreground">
                {t("latestLtv")}
              </th>
              <th className="px-3 py-2 font-medium text-muted-foreground text-left">
                {t("cumulativeTrend")}
              </th>
            </tr>
          </thead>
          <tbody>
            {data.cohorts.map((cohort, ci) => {
              const points = cohortData.get(cohort) ?? [];
              const latestLTV = points.length
                ? points[points.length - 1].ltv
                : 0;
              const barColor = COHORT_COLORS[ci % COHORT_COLORS.length];

              return (
                <motion.tr
                  key={cohort}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: ci * 0.05 }}
                  className="border-b border-border last:border-0 hover:bg-muted/10 transition-colors"
                >
                  <td className="px-3 py-3 font-medium whitespace-nowrap">
                    {cohort}
                  </td>
                  <td className="px-3 py-3 text-right font-mono whitespace-nowrap">
                    {t("ltvAmount", { amount: formatKRW(latestLTV) })}
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-1">
                      {points.map((p, pi) => {
                        const h = Math.max((p.ltv / maxLTV) * 32, 2);
                        return (
                          <div
                            key={pi}
                            className={`w-5 rounded-sm ${barColor}`}
                            style={{ height: `${h}px` }}
                            title={t("ltvBarTitle", { n: p.period_months, amount: formatKRW(p.ltv) })}
                          />
                        );
                      })}
                    </div>
                  </td>
                </motion.tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Main Page ───────────────────────────────────────────────────────────────

export default function CohortPage() {
  const t = useTranslations("cohort");
  const [retentionData, setRetentionData] =
    useState<RetentionHeatmapData | null>(null);
  const [ltvData, setLTVData] = useState<LTVTrendData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [months, setMonths] = useState(12);
  const [activeTab, setActiveTab] = useState<"retention" | "ltv">("retention");

  const loadData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [retRes, ltvRes] = await Promise.all([
        api.get(`/admin/cohort/retention`, { params: { months } }),
        api.get(`/admin/cohort/ltv`, { params: { months } }),
      ]);
      setRetentionData(retRes.data);
      setLTVData(ltvRes.data);
    } catch (err) {
      if (isApiCanceled(err)) return;
      const message =
        err instanceof Error ? err.message : t("loadError");
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, [months]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const monthPresets = [
    { label: t("months", { n: 6 }), value: 6 },
    { label: t("months", { n: 12 }), value: 12 },
    { label: t("months", { n: 24 }), value: 24 },
  ];

  return (
    <div className="space-y-6 p-4 md:p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Users className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold text-foreground">{t("pageTitle")}</h1>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="rounded-full"
          onClick={loadData}
        >
          <RefreshCw className="h-4 w-4 mr-1.5" />
          {t("refresh")}
        </Button>
      </div>

      {/* Controls */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-lg border border-border bg-card p-4"
      >
        <div className="flex flex-wrap items-center gap-4">
          {/* Tab Selector */}
          <div className="flex items-center gap-1 rounded-lg bg-muted/50 p-1">
            <button
              type="button"
              onClick={() => setActiveTab("retention")}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                activeTab === "retention"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Users className="h-3.5 w-3.5 inline-block mr-1.5" />
              {t("tabRetention")}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("ltv")}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                activeTab === "ltv"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <TrendingUp className="h-3.5 w-3.5 inline-block mr-1.5" />
              LTV
            </button>
          </div>

          {/* Month Selector */}
          <div className="flex items-center gap-1.5">
            <Calendar className="h-4 w-4 text-muted-foreground" />
            {monthPresets.map((p) => (
              <Button
                key={p.value}
                variant={months === p.value ? "default" : "outline"}
                size="sm"
                className="rounded-full text-xs h-8"
                onClick={() => setMonths(p.value)}
              >
                {p.label}
              </Button>
            ))}
          </div>
        </div>
      </motion.div>

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <div className="flex flex-col items-center justify-center gap-4 py-16 text-muted-foreground">
          <p>{error}</p>
          <Button
            variant="outline"
            size="sm"
            className="rounded-full"
            onClick={loadData}
          >
            <RefreshCw className="h-4 w-4 mr-2" />
            {t("retry")}
          </Button>
        </div>
      )}

      {/* Content */}
      {!loading && !error && (
        <>
          {/* Summary Cards */}
          {retentionData && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 }}
              className="grid grid-cols-2 lg:grid-cols-4 gap-4"
            >
              <div className="rounded-lg border border-border bg-card p-4">
                <p className="text-xs text-muted-foreground mb-1">
                  {t("statCohortCount")}
                </p>
                <p className="text-2xl font-bold text-foreground">
                  {retentionData.cohorts.length}
                </p>
              </div>
              <div className="rounded-lg border border-border bg-card p-4">
                <p className="text-xs text-muted-foreground mb-1">
                  {t("statMaxPeriod")}
                </p>
                <p className="text-2xl font-bold text-foreground">
                  {retentionData.periods.length > 0
                    ? t("months", { n: Math.max(...retentionData.periods) })
                    : "-"}
                </p>
              </div>
              <div className="rounded-lg border border-border bg-card p-4">
                <p className="text-xs text-muted-foreground mb-1">
                  {t("statLatestCohort")}
                </p>
                <p className="text-lg font-bold text-foreground">
                  {retentionData.cohorts[retentionData.cohorts.length - 1] ??
                    "-"}
                </p>
              </div>
              <div className="rounded-lg border border-border bg-card p-4">
                <p className="text-xs text-muted-foreground mb-1">
                  {t("statDataPoints")}
                </p>
                <p className="text-2xl font-bold text-primary">
                  {retentionData.cells.length.toLocaleString()}
                </p>
              </div>
            </motion.div>
          )}

          {/* Retention Heatmap */}
          {activeTab === "retention" && retentionData && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="rounded-lg border border-border bg-card overflow-hidden"
            >
              <div className="px-6 py-4 border-b border-border flex items-center justify-between">
                <h2 className="text-sm font-semibold">{t("retentionHeatmapTitle")}</h2>
                <Badge variant="secondary" className="rounded-full text-xs">
                  {t("retentionHeatmapBadge")}
                </Badge>
              </div>
              <div className="p-4">
                <RetentionHeatmap data={retentionData} />
              </div>
            </motion.div>
          )}

          {/* LTV Trend */}
          {activeTab === "ltv" && ltvData && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="rounded-lg border border-border bg-card overflow-hidden"
            >
              <div className="px-6 py-4 border-b border-border flex items-center justify-between">
                <h2 className="text-sm font-semibold">{t("ltvTrendTitle")}</h2>
                <Badge variant="secondary" className="rounded-full text-xs">
                  {t("ltvTrendBadge")}
                </Badge>
              </div>
              <div className="p-4">
                <LTVTrend data={ltvData} />
              </div>
            </motion.div>
          )}
        </>
      )}
    </div>
  );
}
