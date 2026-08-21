"use client";

import { useEffect, useState } from "react";
import { api } from "@pickket/lib";
import { useTranslations } from "next-intl";

interface SLOSummary {
  period_days: number;
  slo_target: number;
  summary: {
    total_requests: number;
    total_errors: number;
    availability: number;
    availability_pct: string;
    avg_latency_ms: number;
    slow_requests_2s: number;
    slo_met: boolean;
  };
  error_budget: {
    allowed_errors: number;
    consumed_errors: number;
    remaining: number;
    remaining_pct: number;
  };
  hourly: Array<{
    date: string;
    hour: number;
    total: number;
    errors: number;
    availability: number;
    avg_latency_ms: number;
  }>;
}

function MetricCard({
  label,
  value,
  sub,
  status,
}: {
  label: string;
  value: string;
  sub?: string;
  status?: "good" | "warning" | "critical";
}) {
  const colors = {
    good: "text-emerald-600 dark:text-emerald-400",
    warning: "text-amber-600 dark:text-amber-400",
    critical: "text-red-600 dark:text-red-400",
  };

  return (
    <div className="rounded-xl border bg-card p-5">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
        {label}
      </p>
      <p
        className={`mt-2 text-2xl font-bold ${status ? colors[status] : "text-foreground"}`}
      >
        {value}
      </p>
      {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

function BudgetBar({ remaining_pct }: { remaining_pct: number }) {
  const t = useTranslations("slo.dashboard");
  const color =
    remaining_pct > 50
      ? "bg-emerald-500"
      : remaining_pct > 20
        ? "bg-amber-500"
        : "bg-red-500";

  return (
    <div className="rounded-xl border bg-card p-5">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
        {t("errorBudgetRemaining")}
      </p>
      <div className="mt-3 h-3 w-full rounded-full bg-muted">
        <div
          className={`h-full rounded-full transition-all ${color}`}
          style={{ width: `${Math.min(100, remaining_pct)}%` }}
        />
      </div>
      <p className="mt-2 text-lg font-bold text-foreground">
        {remaining_pct.toFixed(1)}%
      </p>
    </div>
  );
}

export default function SLODashboard() {
  const t = useTranslations("slo.dashboard");
  const [data, setData] = useState<SLOSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get("/api/v1/admin/slo?days=30")
      .then((res) => setData(res.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="p-8 text-center text-muted-foreground">
        {t("loadFailed")}
      </div>
    );
  }

  const { summary, error_budget } = data;
  const availStatus = summary.slo_met
    ? "good"
    : summary.availability >= 0.995
      ? "warning"
      : "critical";

  return (
    <div className="space-y-8 p-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("periodTarget", { days: data.period_days ?? 0 })}{" "}
          {(data.slo_target * 100).toFixed(1)}%
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label={t("availability")}
          value={summary.availability_pct}
          sub={`${summary.total_errors.toLocaleString()} errors / ${summary.total_requests.toLocaleString()} requests`}
          status={availStatus}
        />
        <MetricCard
          label={t("avgLatency")}
          value={`${summary.avg_latency_ms.toFixed(0)}ms`}
          sub={t("slowRequests", { count: summary.slow_requests_2s ?? 0 })}
          status={
            summary.avg_latency_ms < 200
              ? "good"
              : summary.avg_latency_ms < 500
                ? "warning"
                : "critical"
          }
        />
        <MetricCard
          label={t("totalRequests")}
          value={summary.total_requests.toLocaleString()}
          sub={t("errors", { count: summary.total_errors ?? 0 })}
        />
        <BudgetBar remaining_pct={error_budget.remaining_pct} />
      </div>

      {/* 시간별 추이 테이블 */}
      <div className="rounded-xl border bg-card">
        <div className="border-b px-5 py-3">
          <h2 className="text-sm font-semibold text-foreground">
            {t("hourlyTrend")}
          </h2>
        </div>
        <div className="max-h-96 overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card">
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="px-4 py-2">{t("colDate")}</th>
                <th className="px-4 py-2">{t("colHour")}</th>
                <th className="px-4 py-2 text-right">{t("colRequests")}</th>
                <th className="px-4 py-2 text-right">{t("colErrors")}</th>
                <th className="px-4 py-2 text-right">{t("availability")}</th>
                <th className="px-4 py-2 text-right">Avg (ms)</th>
              </tr>
            </thead>
            <tbody>
              {data.hourly.map((h, i) => (
                <tr key={i} className="border-b last:border-0">
                  <td className="px-4 py-1.5">{h.date}</td>
                  <td className="px-4 py-1.5">{h.hour}:00</td>
                  <td className="px-4 py-1.5 text-right">
                    {h.total.toLocaleString()}
                  </td>
                  <td className="px-4 py-1.5 text-right">
                    <span className={h.errors > 0 ? "text-red-500" : ""}>
                      {h.errors}
                    </span>
                  </td>
                  <td className="px-4 py-1.5 text-right">
                    {(h.availability * 100).toFixed(2)}%
                  </td>
                  <td className="px-4 py-1.5 text-right">
                    {h.avg_latency_ms.toFixed(0)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
