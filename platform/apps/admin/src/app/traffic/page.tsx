"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { motion } from "motion/react";
import { toast } from "sonner";
import {
  Loader2,
  RefreshCw,
  AlertTriangle,
  Activity,
  Bot,
  User,
  Plug,
  Globe,
} from "lucide-react";
import { Button, Badge } from "@pickket/ui";
import api from "@pickket/lib/api";
import { isApiCanceled } from "@pickket/lib/api";

// ── Types ───────────────────────────────────────────────────────────────────

interface TrafficClassCounts {
  human: number;
  agent: number;
  broker: number;
  bot: number;
}

interface TrafficClassRatios {
  human: number;
  agent: number;
  broker: number;
  bot: number;
}

interface TrafficWindowData {
  total: number;
  counts: TrafficClassCounts;
  ratios: TrafficClassRatios;
}

interface TrafficBreakdownResponse {
  windows: Record<string, TrafficWindowData>;
  generated_at: string;
}

interface AnomalyAlert {
  timestamp: number;
  bot_ratio: number;
  bot_count: number;
  total_requests: number;
  window_seconds: number;
  message: string;
}

interface AnomalyAlertsResponse {
  alerts: AnomalyAlert[];
  total: number;
  generated_at: string;
}

// ── Constants ───────────────────────────────────────────────────────────────

const CLASS_CONFIG: Record<
  string,
  { color: string; bgColor: string; icon: typeof User }
> = {
  human: {
    color: "text-emerald-600",
    bgColor: "bg-emerald-500",
    icon: User,
  },
  agent: {
    color: "text-blue-600",
    bgColor: "bg-blue-500",
    icon: Plug,
  },
  broker: {
    color: "text-amber-600",
    bgColor: "bg-amber-500",
    icon: Globe,
  },
  bot: {
    color: "text-red-600",
    bgColor: "bg-red-500",
    icon: Bot,
  },
};

const WINDOW_KEYS = ["5min", "1h", "24h"] as const;

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatPct(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function formatTimestamp(ts: number): string {
  return new Date(ts * 1000).toLocaleString("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// ── Pie Chart (Pure CSS) ────────────────────────────────────────────────────

function TrafficPieChart({ data, t }: { data: TrafficWindowData; t: ReturnType<typeof useTranslations> }) {
  const classes = ["human", "agent", "broker", "bot"] as const;
  const total = data.total || 1;

  let cumulativePct = 0;
  const segments: { key: string; color: string; start: number; end: number }[] =
    [];

  for (const cls of classes) {
    const pct = (data.counts[cls] / total) * 100;
    if (pct > 0) {
      segments.push({
        key: cls,
        color: CLASS_CONFIG[cls].bgColor.replace("bg-", ""),
        start: cumulativePct,
        end: cumulativePct + pct,
      });
      cumulativePct += pct;
    }
  }

  // Build conic-gradient
  const gradientStops = segments
    .map((seg) => {
      const colorMap: Record<string, string> = {
        "emerald-500": "#10b981",
        "blue-500": "#3b82f6",
        "amber-500": "#f59e0b",
        "red-500": "#ef4444",
      };
      const hex = colorMap[seg.color] || "#6b7280";
      return `${hex} ${seg.start}% ${seg.end}%`;
    })
    .join(", ");

  const gradient =
    segments.length > 0
      ? `conic-gradient(${gradientStops})`
      : "conic-gradient(#e5e7eb 0% 100%)";

  return (
    <div className="flex items-center gap-6">
      <div
        className="h-32 w-32 rounded-full shrink-0"
        style={{ background: gradient }}
      />
      <div className="space-y-2">
        {classes.map((cls) => {
          const config = CLASS_CONFIG[cls];
          const Icon = config.icon;
          return (
            <div key={cls} className="flex items-center gap-2 text-sm">
              <div className={`h-3 w-3 rounded-full ${config.bgColor}`} />
              <Icon className={`h-3.5 w-3.5 ${config.color}`} />
              <span className="text-muted-foreground">{t(`class.${cls}`)}</span>
              <span className="font-medium tabular-nums">
                {data.counts[cls].toLocaleString()}
              </span>
              <span className="text-muted-foreground text-xs">
                ({formatPct(data.ratios[cls])})
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Bar Chart ───────────────────────────────────────────────────────────────

function TrafficBarChart({ data, t }: { data: TrafficWindowData; t: ReturnType<typeof useTranslations> }) {
  const classes = ["human", "agent", "broker", "bot"] as const;
  const maxCount = Math.max(...classes.map((c) => data.counts[c]), 1);

  return (
    <div className="space-y-3">
      {classes.map((cls) => {
        const config = CLASS_CONFIG[cls];
        const Icon = config.icon;
        const widthPct = (data.counts[cls] / maxCount) * 100;

        return (
          <div key={cls} className="space-y-1">
            <div className="flex items-center justify-between text-sm">
              <div className="flex items-center gap-2">
                <Icon className={`h-3.5 w-3.5 ${config.color}`} />
                <span>{t(`class.${cls}`)}</span>
              </div>
              <span className="tabular-nums font-medium">
                {data.counts[cls].toLocaleString()}
              </span>
            </div>
            <div className="h-2 w-full rounded-full bg-muted/40">
              <motion.div
                className={`h-full rounded-full ${config.bgColor}`}
                initial={{ width: 0 }}
                animate={{ width: `${widthPct}%` }}
                transition={{ duration: 0.5, ease: "easeOut" }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Anomaly Alert Item ──────────────────────────────────────────────────────

function AnomalyAlertItem({ alert, t }: { alert: AnomalyAlert; t: ReturnType<typeof useTranslations> }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-destructive/20 bg-destructive/5 p-3">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-destructive">
          {t("anomaly.botRatioWarning")}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {formatPct(alert.bot_ratio)} ({alert.bot_count}/{alert.total_requests}{" "}
          {t("anomaly.requests", { windowSeconds: alert.window_seconds ?? 0 })})
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {formatTimestamp(alert.timestamp)}
        </p>
      </div>
    </div>
  );
}

// ── Main Page ───────────────────────────────────────────────────────────────

export default function TrafficMonitorPage() {
  const t = useTranslations("traffic");
  const [breakdown, setBreakdown] = useState<TrafficBreakdownResponse | null>(
    null,
  );
  const [anomalies, setAnomalies] = useState<AnomalyAlertsResponse | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedWindow, setSelectedWindow] = useState<string>("5min");

  const fetchData = useCallback(async (showRefresh = false) => {
    if (showRefresh) setRefreshing(true);
    try {
      const [breakdownRes, anomalyRes] = await Promise.all([
        api.get<TrafficBreakdownResponse>("/admin/traffic/breakdown"),
        api.get<AnomalyAlertsResponse>("/admin/traffic/anomalies"),
      ]);
      setBreakdown(breakdownRes.data);
      setAnomalies(anomalyRes.data);
    } catch (err) {
      if (isApiCanceled(err)) return;
      toast.error(t("fetchError"));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [t]);

  useEffect(() => {
    fetchData();
    // Auto-refresh every 30 seconds
    const interval = setInterval(() => fetchData(), 30_000);
    return () => clearInterval(interval);
  }, [fetchData]);

  if (loading) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const currentWindow = breakdown?.windows[selectedWindow];

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t("pageTitle")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("pageSubtitle")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="gap-1">
            <Activity className="h-3 w-3" />
            {t("realtime")}
          </Badge>
          <Button
            variant="outline"
            size="sm"
            onClick={() => fetchData(true)}
            disabled={refreshing}
          >
            <RefreshCw
              className={`mr-1.5 h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`}
            />
            {t("refresh")}
          </Button>
        </div>
      </div>

      {/* Window selector */}
      <div className="flex gap-2">
        {WINDOW_KEYS.map((key) => (
          <Button
            key={key}
            variant={selectedWindow === key ? "default" : "outline"}
            size="sm"
            onClick={() => setSelectedWindow(key)}
          >
            {t(`window.${key}`)}
            {breakdown?.windows[key] && (
              <span className="ml-1.5 tabular-nums text-xs opacity-70">
                ({breakdown.windows[key].total.toLocaleString()})
              </span>
            )}
          </Button>
        ))}
      </div>

      {/* Summary cards */}
      {currentWindow && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {(["human", "agent", "broker", "bot"] as const).map((cls) => {
            const config = CLASS_CONFIG[cls];
            const Icon = config.icon;
            return (
              <motion.div
                key={cls}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="rounded-xl border bg-card p-4"
              >
                <div className="flex items-center gap-2">
                  <div
                    className={`flex h-8 w-8 items-center justify-center rounded-lg ${config.bgColor}/10`}
                  >
                    <Icon className={`h-4 w-4 ${config.color}`} />
                  </div>
                  <span className="text-sm text-muted-foreground">
                    {t(`class.${cls}`)}
                  </span>
                </div>
                <p className="mt-2 text-2xl font-bold tabular-nums">
                  {currentWindow.counts[cls].toLocaleString()}
                </p>
                <p className="text-xs text-muted-foreground">
                  {formatPct(currentWindow.ratios[cls])}
                </p>
              </motion.div>
            );
          })}
        </div>
      )}

      {/* Charts */}
      {currentWindow && (
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Pie chart */}
          <div className="rounded-xl border bg-card p-6">
            <h2 className="mb-4 text-lg font-semibold">{t("chart.distribution")}</h2>
            <TrafficPieChart data={currentWindow} t={t} />
          </div>

          {/* Bar chart */}
          <div className="rounded-xl border bg-card p-6">
            <h2 className="mb-4 text-lg font-semibold">{t("chart.requestsByClass")}</h2>
            <TrafficBarChart data={currentWindow} t={t} />
          </div>
        </div>
      )}

      {/* Trend across windows */}
      {breakdown && (
        <div className="rounded-xl border bg-card p-6">
          <h2 className="mb-4 text-lg font-semibold">{t("chart.trend")}</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="pb-2 pr-4 font-medium">{t("table.window")}</th>
                  <th className="pb-2 pr-4 font-medium text-right">{t("table.total")}</th>
                  <th className="pb-2 pr-4 font-medium text-right">
                    {t("class.human")}
                  </th>
                  <th className="pb-2 pr-4 font-medium text-right">
                    {t("class.agent")}
                  </th>
                  <th className="pb-2 pr-4 font-medium text-right">
                    {t("class.broker")}
                  </th>
                  <th className="pb-2 font-medium text-right">{t("class.bot")}</th>
                </tr>
              </thead>
              <tbody>
                {WINDOW_KEYS.map((key) => {
                  const w = breakdown.windows[key];
                  if (!w) return null;
                  return (
                    <tr key={key} className="border-b last:border-0">
                      <td className="py-2.5 pr-4 font-medium">{t(`window.${key}`)}</td>
                      <td className="py-2.5 pr-4 text-right tabular-nums">
                        {w.total.toLocaleString()}
                      </td>
                      <td className="py-2.5 pr-4 text-right tabular-nums">
                        {w.counts.human.toLocaleString()}{" "}
                        <span className="text-muted-foreground text-xs">
                          ({formatPct(w.ratios.human)})
                        </span>
                      </td>
                      <td className="py-2.5 pr-4 text-right tabular-nums">
                        {w.counts.agent.toLocaleString()}{" "}
                        <span className="text-muted-foreground text-xs">
                          ({formatPct(w.ratios.agent)})
                        </span>
                      </td>
                      <td className="py-2.5 pr-4 text-right tabular-nums">
                        {w.counts.broker.toLocaleString()}{" "}
                        <span className="text-muted-foreground text-xs">
                          ({formatPct(w.ratios.broker)})
                        </span>
                      </td>
                      <td className="py-2.5 text-right tabular-nums">
                        {w.counts.bot.toLocaleString()}{" "}
                        <span className="text-muted-foreground text-xs">
                          ({formatPct(w.ratios.bot)})
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Anomaly alerts */}
      <div className="rounded-xl border bg-card p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{t("anomaly.title")}</h2>
          {anomalies && anomalies.total > 0 && (
            <Badge variant="destructive">{t("anomaly.count", { count: anomalies.total ?? 0 })}</Badge>
          )}
        </div>

        {!anomalies || anomalies.alerts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <Activity className="mb-2 h-8 w-8 opacity-40" />
            <p className="text-sm">{t("anomaly.empty")}</p>
            <p className="mt-1 text-xs">
              {t("anomaly.emptyHint")}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {anomalies.alerts
              .slice()
              .reverse()
              .map((alert, idx) => (
                <AnomalyAlertItem key={idx} alert={alert} t={t} />
              ))}
          </div>
        )}
      </div>

      {/* Footer info */}
      {breakdown && (
        <p className="text-center text-xs text-muted-foreground">
          {t("footer.lastUpdated")}{" "}
          {new Date(breakdown.generated_at).toLocaleString("ko-KR")} | {t("footer.autoRefresh")}
        </p>
      )}
    </div>
  );
}
