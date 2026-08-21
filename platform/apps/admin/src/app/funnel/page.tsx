"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { motion } from "motion/react";
import { toast } from "sonner";
import { Loader2, RefreshCw, Search, TrendingDown, Filter } from "lucide-react";
import { Button, Badge, Input } from "@pickket/ui";
import {
  getAdminFunnelOverview,
  getAdminFunnelByEvent,
  getAdminFunnelEvents,
  isApiCanceled,
  type FunnelStage,
  type FunnelOverviewResponse,
  type FunnelEventOption,
} from "@pickket/lib/api";

// ── Funnel Stage Colors ─────────────────────────────────────────────────────

const STAGE_COLORS = [
  { bg: "bg-indigo-500", text: "text-indigo-500", light: "bg-indigo-500/10" },
  { bg: "bg-blue-500", text: "text-blue-500", light: "bg-blue-500/10" },
  { bg: "bg-cyan-500", text: "text-cyan-500", light: "bg-cyan-500/10" },
  {
    bg: "bg-emerald-500",
    text: "text-emerald-500",
    light: "bg-emerald-500/10",
  },
  { bg: "bg-amber-500", text: "text-amber-500", light: "bg-amber-500/10" },
  { bg: "bg-rose-500", text: "text-rose-500", light: "bg-rose-500/10" },
];

// ── Funnel Bar Component ────────────────────────────────────────────────────

function FunnelBar({
  stage,
  index,
  maxCount,
}: {
  stage: FunnelStage;
  index: number;
  maxCount: number;
}) {
  const t = useTranslations("funnel");
  const color = STAGE_COLORS[index % STAGE_COLORS.length];
  const widthPct =
    maxCount > 0 ? Math.max((stage.count / maxCount) * 100, 4) : 4;

  return (
    <motion.div
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: index * 0.08 }}
      className="group"
    >
      <div className="flex items-center gap-4">
        {/* Label */}
        <div className="w-24 shrink-0 text-right">
          <span className="text-sm font-medium text-foreground">
            {stage.name}
          </span>
        </div>

        {/* Bar */}
        <div className="flex-1 relative">
          <div className="h-12 rounded-lg bg-muted/30 overflow-hidden">
            <motion.div
              className={`h-full rounded-lg ${color.bg} relative flex items-center justify-end pr-3`}
              initial={{ width: 0 }}
              animate={{ width: `${widthPct}%` }}
              transition={{
                duration: 0.6,
                delay: index * 0.08,
                ease: "easeOut",
              }}
            >
              <span className="text-sm font-semibold text-white drop-shadow-sm whitespace-nowrap">
                {stage.count.toLocaleString()}
              </span>
            </motion.div>
          </div>
        </div>

        {/* Conversion Rate */}
        <div className="w-20 shrink-0 text-right">
          <Badge
            className={`rounded-full text-xs font-medium ${
              index === 0
                ? "bg-muted text-muted-foreground"
                : stage.conversion_rate >= 80
                  ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                  : stage.conversion_rate >= 50
                    ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                    : "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400"
            }`}
            variant="secondary"
          >
            {index === 0 ? "-" : `${stage.conversion_rate}%`}
          </Badge>
        </div>
      </div>

      {/* Drop-off indicator */}
      {index > 0 && stage.conversion_rate < 100 && (
        <div className="ml-28 flex items-center gap-1 mt-0.5 mb-1">
          <TrendingDown className="h-3 w-3 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">
            {t("dropoff", { rate: (100 - stage.conversion_rate).toFixed(1) })}
          </span>
        </div>
      )}
    </motion.div>
  );
}

// ── Date Helpers ────────────────────────────────────────────────────────────

function toISODate(d: Date): string {
  return d.toISOString().split("T")[0];
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return toISODate(d);
}

// ── Main Page ───────────────────────────────────────────────────────────────

export default function FunnelPage() {
  const t = useTranslations("funnel");
  const [data, setData] = useState<FunnelOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Filters
  const [dateFrom, setDateFrom] = useState(daysAgo(30));
  const [dateTo, setDateTo] = useState(toISODate(new Date()));
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);

  // Event selector
  const [events, setEvents] = useState<FunnelEventOption[]>([]);
  const [eventSearch, setEventSearch] = useState("");
  const [showEventDropdown, setShowEventDropdown] = useState(false);
  const [selectedEventTitle, setSelectedEventTitle] = useState("");

  // Load event list
  useEffect(() => {
    getAdminFunnelEvents({ q: eventSearch || undefined, limit: 30 })
      .then((res) => setEvents(res.events))
      .catch(() => {});
  }, [eventSearch]);

  const loadFunnel = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = { date_from: dateFrom, date_to: dateTo };
      const result = selectedEventId
        ? await getAdminFunnelByEvent(selectedEventId, params)
        : await getAdminFunnelOverview(params);
      setData(result);
    } catch (err) {
      if (isApiCanceled(err)) return;
      const message =
        err instanceof Error ? err.message : t("loadError");
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo, selectedEventId]);

  useEffect(() => {
    void loadFunnel();
  }, [loadFunnel]);

  const maxCount = data ? Math.max(...data.stages.map((s) => s.count), 1) : 1;

  // Preset date ranges
  const presets = [
    { label: t("preset7d"), days: 7 },
    { label: t("preset30d"), days: 30 },
    { label: t("preset90d"), days: 90 },
  ];

  return (
    <div className="space-y-5 p-4 md:p-6">
      <h1 className="sr-only">{t("title")}</h1>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Filter className="h-5 w-5 text-primary" />
          <span className="text-lg font-semibold text-foreground">
            {t("title")}
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="rounded-full"
          onClick={loadFunnel}
        >
          <RefreshCw className="h-4 w-4 mr-1.5" />
          {t("refresh")}
        </Button>
      </div>

      {/* Filters */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-lg border border-border bg-card p-4"
      >
        <div className="flex flex-wrap items-end gap-4">
          {/* Date Range */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              {t("filterPeriod")}
            </label>
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <span className="text-muted-foreground text-sm">~</span>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>

          {/* Date Presets */}
          <div className="flex items-center gap-1.5 pb-0.5">
            {presets.map((p) => (
              <Button
                key={p.days}
                variant="outline"
                size="sm"
                className="rounded-full text-xs h-8"
                onClick={() => {
                  setDateFrom(daysAgo(p.days));
                  setDateTo(toISODate(new Date()));
                }}
              >
                {p.label}
              </Button>
            ))}
          </div>

          {/* Event Selector */}
          <div className="flex flex-col gap-1.5 relative min-w-[240px]">
            <label className="text-xs font-medium text-muted-foreground">
              {t("filterEvent")}
            </label>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder={selectedEventTitle || t("allPlatform")}
                value={eventSearch}
                onChange={(e) => {
                  setEventSearch(e.target.value);
                  setShowEventDropdown(true);
                }}
                onFocus={() => setShowEventDropdown(true)}
                className="pl-8 h-9 text-sm"
              />
              {selectedEventId && (
                <button
                  type="button"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setSelectedEventId(null);
                    setSelectedEventTitle("");
                    setEventSearch("");
                  }}
                  aria-label={t("clearEvent")}
                >
                  &times;
                </button>
              )}
            </div>
            {showEventDropdown && events.length > 0 && (
              <div className="absolute top-full left-0 right-0 z-50 mt-1 max-h-56 overflow-y-auto rounded-md border border-border bg-popover shadow-md">
                <button
                  type="button"
                  className="w-full px-3 py-2 text-left text-sm hover:bg-muted/50 text-muted-foreground"
                  onClick={() => {
                    setSelectedEventId(null);
                    setSelectedEventTitle("");
                    setEventSearch("");
                    setShowEventDropdown(false);
                  }}
                >
                  {t("allPlatform")}
                </button>
                {events.map((evt) => (
                  <button
                    key={evt.id}
                    type="button"
                    className="w-full px-3 py-2 text-left text-sm hover:bg-muted/50 truncate"
                    onClick={() => {
                      setSelectedEventId(evt.id);
                      setSelectedEventTitle(evt.title);
                      setEventSearch("");
                      setShowEventDropdown(false);
                    }}
                  >
                    {evt.title}
                  </button>
                ))}
              </div>
            )}
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
            onClick={loadFunnel}
          >
            <RefreshCw className="h-4 w-4 mr-2" />
            {t("retry")}
          </Button>
        </div>
      )}

      {/* Funnel Content */}
      {!loading && !error && data && (
        <>
          {/* Summary Cards */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.05 }}
            className="grid grid-cols-2 lg:grid-cols-4 gap-4"
          >
            <div className="rounded-lg border border-border bg-card p-4">
              <p className="text-xs text-muted-foreground mb-1">{t("cardSignup")}</p>
              <p className="text-2xl font-bold text-foreground">
                {(data.stages[0]?.count ?? 0).toLocaleString()}
              </p>
            </div>
            <div className="rounded-lg border border-border bg-card p-4">
              <p className="text-xs text-muted-foreground mb-1">{t("cardIssued")}</p>
              <p className="text-2xl font-bold text-foreground">
                {(
                  data.stages[data.stages.length - 1]?.count ?? 0
                ).toLocaleString()}
              </p>
            </div>
            <div className="rounded-lg border border-border bg-card p-4">
              <p className="text-xs text-muted-foreground mb-1">{t("cardOverallConversion")}</p>
              <p className="text-2xl font-bold text-primary">
                {data.overall_conversion}%
              </p>
            </div>
            <div className="rounded-lg border border-border bg-card p-4">
              <p className="text-xs text-muted-foreground mb-1">{t("filterPeriod")}</p>
              <p className="text-sm font-medium text-foreground">
                {data.period.start} ~ {data.period.end}
              </p>
            </div>
          </motion.div>

          {/* Funnel Visualization */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="rounded-lg border border-border bg-card p-6"
          >
            <h2 className="text-sm font-semibold mb-6">{t("sectionFunnel")}</h2>
            <div className="space-y-2">
              {data.stages.map((stage, i) => (
                <FunnelBar
                  key={stage.name}
                  stage={stage}
                  index={i}
                  maxCount={maxCount}
                />
              ))}
            </div>
          </motion.div>

          {/* Stage-by-Stage Table */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 }}
            className="rounded-lg border border-border bg-card overflow-hidden"
          >
            <div className="px-5 py-3 border-b border-border">
              <h2 className="text-sm font-semibold">{t("sectionStageDetail")}</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="px-5 py-3 text-left text-xs font-medium text-muted-foreground">
                      {t("colStage")}
                    </th>
                    <th className="px-5 py-3 text-right text-xs font-medium text-muted-foreground">
                      {t("colCount")}
                    </th>
                    <th className="px-5 py-3 text-right text-xs font-medium text-muted-foreground">
                      {t("colConversion")}
                    </th>
                    <th className="px-5 py-3 text-right text-xs font-medium text-muted-foreground">
                      {t("colDropoff")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.stages.map((stage, i) => {
                    const dropoff = i === 0 ? 0 : 100 - stage.conversion_rate;
                    const color = STAGE_COLORS[i % STAGE_COLORS.length];
                    return (
                      <tr
                        key={stage.name}
                        className="border-b border-border last:border-0 hover:bg-muted/20 transition-colors"
                      >
                        <td className="px-5 py-3.5">
                          <div className="flex items-center gap-2">
                            <div
                              className={`h-2.5 w-2.5 rounded-full ${color.bg}`}
                            />
                            <span className="font-medium">{stage.name}</span>
                          </div>
                        </td>
                        <td className="px-5 py-3.5 text-right font-mono">
                          {stage.count.toLocaleString()}
                        </td>
                        <td className="px-5 py-3.5 text-right">
                          {i === 0 ? (
                            <span className="text-muted-foreground">-</span>
                          ) : (
                            <Badge
                              className={`rounded-full text-xs ${
                                stage.conversion_rate >= 80
                                  ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                                  : stage.conversion_rate >= 50
                                    ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                                    : "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400"
                              }`}
                              variant="secondary"
                            >
                              {stage.conversion_rate}%
                            </Badge>
                          )}
                        </td>
                        <td className="px-5 py-3.5 text-right">
                          {i === 0 ? (
                            <span className="text-muted-foreground">-</span>
                          ) : (
                            <span
                              className={
                                dropoff > 50
                                  ? "text-rose-500"
                                  : dropoff > 20
                                    ? "text-amber-500"
                                    : "text-muted-foreground"
                              }
                            >
                              {dropoff.toFixed(1)}%
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </motion.div>
        </>
      )}
    </div>
  );
}
