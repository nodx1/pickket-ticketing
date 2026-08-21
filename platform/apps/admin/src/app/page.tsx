"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { motion } from "motion/react";
import { toast } from "sonner";
import {
  Loader2,
  Users,
  Calendar,
  Ticket,
  RefreshCw,
  UserCheck,
  ClipboardList,
  AlertCircle,
  DollarSign,
} from "lucide-react";
import { Button, Badge } from "@pickket/ui";
import { formatDate, formatKRW } from "@pickket/lib";
import {
  getAdminKPI,
  getFinanceSummary,
  getSystemHealth,
  getAdminAuditLog,
  getOrganizerProfiles,
  getAdminEvents,
  isApiCanceled,
  type PlatformKPI,
  type FinanceSummary,
  type SystemHealth,
  type AuditEntry,
} from "@pickket/lib/api";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import KpiCard from "../components/KpiCard";

const PIE_COLORS = [
  "#6366f1",
  "#22c55e",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
];

export default function AdminDashboard() {
  const t = useTranslations("admin.dashboard");
  const [kpi, setKpi] = useState<PlatformKPI | null>(null);
  const [finance, setFinance] = useState<FinanceSummary | null>(null);
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [pendingOrganizers, setPendingOrganizers] = useState(0);
  const [pendingEvents, setPendingEvents] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [kpiData, financeData, healthData, auditData, orgData, eventData] =
        await Promise.allSettled([
          getAdminKPI(),
          getFinanceSummary({ period: "30d" }),
          getSystemHealth(),
          getAdminAuditLog({ limit: 5 }),
          getOrganizerProfiles({ status: "pending", limit: 1 }),
          getAdminEvents({ status: "PENDING_REVIEW", limit: 1 }),
        ]);

      if (kpiData.status === "fulfilled") setKpi(kpiData.value);
      if (financeData.status === "fulfilled") setFinance(financeData.value);
      if (healthData.status === "fulfilled") setHealth(healthData.value);
      if (auditData.status === "fulfilled")
        setAuditEntries(auditData.value.entries);
      if (orgData.status === "fulfilled") {
        const profiles = orgData.value;
        setPendingOrganizers(Array.isArray(profiles) ? profiles.length : 0);
      }
      if (eventData.status === "fulfilled") {
        setPendingEvents(eventData.value.total ?? 0);
      }

      if (kpiData.status === "rejected" && isApiCanceled(kpiData.reason))
        return;
      if (kpiData.status === "rejected") {
        setError(t("errorPartial"));
      }
    } catch (err) {
      if (isApiCanceled(err)) return;
      const message =
        err instanceof Error ? err.message : t("errorLoad");
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (error && !kpi) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-20 text-muted-foreground">
        <p>{error}</p>
        <Button
          variant="outline"
          size="sm"
          className="rounded-full"
          onClick={loadAll}
        >
          <RefreshCw className="h-4 w-4 mr-2" />
          {t("retry")}
        </Button>
      </div>
    );
  }

  const revenueChartData =
    finance?.daily_revenue?.map((d) => ({
      date: d.date.slice(5),
      amount: d.amount,
    })) ?? [];

  const eventPieData = kpi
    ? [
        { name: t("pieActive"), value: kpi.active_events },
        {
          name: t("pieTotal"),
          value: Math.max(0, kpi.total_events - kpi.active_events),
        },
      ].filter((d) => d.value > 0)
    : [];

  return (
    <div className="space-y-5 p-4 md:p-6">
      <div className="flex items-center justify-between">
        <h1 className="sr-only">{t("title")}</h1>
        <Button
          variant="ghost"
          size="sm"
          className="rounded-full ml-auto"
          onClick={loadAll}
        >
          <RefreshCw className="h-4 w-4 mr-1.5" />
          {t("refresh")}
        </Button>
      </div>

      {/* KPI Cards */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="grid grid-cols-2 lg:grid-cols-4 gap-4"
      >
        <KpiCard
          icon={Users}
          label={t("kpiUsers")}
          value={(kpi?.total_users ?? 0).toLocaleString()}
          subtitle={t("kpiUsersSubtitle", { count: kpi?.new_users_7d ?? 0 })}
        />
        <KpiCard
          icon={Calendar}
          label={t("kpiEvents")}
          value={(kpi?.total_events ?? 0).toLocaleString()}
          subtitle={t("kpiEventsSubtitle", { count: kpi?.new_events_7d ?? 0 })}
        />
        <KpiCard
          icon={Ticket}
          label={t("kpiTickets")}
          value={(kpi?.total_tickets ?? 0).toLocaleString()}
        />
        <KpiCard
          icon={DollarSign}
          label={t("kpiRevenue")}
          value={formatKRW(finance?.gross_revenue ?? 0)}
          iconColor="text-emerald-500"
          accent
        />
      </motion.div>

      {/* Today's Tasks */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="rounded-lg border border-border bg-card p-5"
      >
        <h2 className="text-sm font-semibold mb-3">{t("todayTasks")}</h2>
        <div className="flex flex-wrap gap-3">
          <Link href="/onboarding">
            <div className="flex items-center gap-2 rounded-lg border border-border px-4 py-2.5 text-sm hover:bg-muted/50 transition-colors">
              <UserCheck className="h-4 w-4 text-amber-500" />
              <span>{t("pendingOrganizers")}</span>
              <Badge
                className="rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 ml-1"
                variant="secondary"
              >
                {pendingOrganizers}
              </Badge>
            </div>
          </Link>
          <Link href="/events">
            <div className="flex items-center gap-2 rounded-lg border border-border px-4 py-2.5 text-sm hover:bg-muted/50 transition-colors">
              <ClipboardList className="h-4 w-4 text-blue-500" />
              <span>{t("pendingEvents")}</span>
              <Badge
                className="rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 ml-1"
                variant="secondary"
              >
                {pendingEvents}
              </Badge>
            </div>
          </Link>
          <Link href="/orders">
            <div className="flex items-center gap-2 rounded-lg border border-border px-4 py-2.5 text-sm hover:bg-muted/50 transition-colors">
              <AlertCircle className="h-4 w-4 text-red-500" />
              <span>{t("refundRequests")}</span>
              <Badge
                className="rounded-full bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 ml-1"
                variant="secondary"
              >
                {finance?.refund_count ?? 0}
              </Badge>
            </div>
          </Link>
        </div>
      </motion.div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Revenue Trend */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
          className="lg:col-span-2 rounded-lg border border-border bg-card p-5"
        >
          <h2 className="text-sm font-semibold mb-4">{t("revenueChartTitle")}</h2>
          {revenueChartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={220} aria-label={t("revenueChartAria")}>
              <AreaChart data={revenueChartData}>
                <defs>
                  <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="#555" />
                <YAxis
                  tick={{ fontSize: 11 }}
                  stroke="#555"
                  tickFormatter={(v: number) => `${(v / 10000).toFixed(0)}만`}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "#1a1a1a",
                    border: "1px solid #333",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  formatter={(value) => [formatKRW(Number(value)), t("revenueTooltipLabel")]}
                />
                <Area
                  type="monotone"
                  dataKey="amount"
                  stroke="#6366f1"
                  fill="url(#revGrad)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-[220px] text-muted-foreground text-sm">
              {t("noData")}
            </div>
          )}
        </motion.div>

        {/* Event Status Pie */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="rounded-lg border border-border bg-card p-5"
        >
          <h2 className="text-sm font-semibold mb-4">{t("eventStatusTitle")}</h2>
          {eventPieData.length > 0 ? (
            <ResponsiveContainer width="100%" height={220} aria-label={t("eventStatusAria")}>
              <PieChart>
                <Pie
                  data={eventPieData}
                  cx="50%"
                  cy="50%"
                  innerRadius={50}
                  outerRadius={80}
                  paddingAngle={4}
                  dataKey="value"
                >
                  {eventPieData.map((_, index) => (
                    <Cell
                      key={`cell-${index}`}
                      fill={PIE_COLORS[index % PIE_COLORS.length]}
                    />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{
                    backgroundColor: "#1a1a1a",
                    border: "1px solid #333",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-[220px] text-muted-foreground text-sm">
              {t("noData")}
            </div>
          )}
          <div className="flex flex-wrap gap-2 mt-2">
            {eventPieData.map((d, i) => (
              <div
                key={d.name}
                className="flex items-center gap-1.5 text-xs text-muted-foreground"
              >
                <div
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: PIE_COLORS[i % PIE_COLORS.length] }}
                />
                {d.name}: {d.value.toLocaleString()}
              </div>
            ))}
          </div>
        </motion.div>
      </div>

      {/* Bottom Row: System Health + Audit Log */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* System Health */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25 }}
          className="rounded-lg border border-border bg-card p-5"
        >
          <h2 className="text-sm font-semibold mb-3">{t("systemHealthTitle")}</h2>
          {health ? (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <div
                  className={`h-2.5 w-2.5 rounded-full ${health.database.connected ? "bg-green-500" : "bg-red-500"}`}
                />
                <span className="text-sm">Database</span>
                <span className="text-xs text-muted-foreground ml-auto">
                  {health.database.latency_ms}ms
                </span>
              </div>
              <div className="flex items-center gap-3">
                <div
                  className={`h-2.5 w-2.5 rounded-full ${health.redis.connected ? "bg-green-500" : "bg-red-500"}`}
                />
                <span className="text-sm">Redis</span>
                <span className="text-xs text-muted-foreground ml-auto">
                  {health.redis.latency_ms}ms
                </span>
              </div>
              <div className="flex items-center gap-3">
                <div
                  className={`h-2.5 w-2.5 rounded-full ${health.celery.workers > 0 ? "bg-green-500" : "bg-red-500"}`}
                />
                <span className="text-sm">Celery</span>
                <span className="text-xs text-muted-foreground ml-auto">
                  {health.celery.workers}w / {health.celery.active_tasks}t
                </span>
              </div>
              <div className="pt-2 border-t border-border flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  Uptime: {Math.floor(health.uptime_seconds / 3600)}h{" "}
                  {Math.floor((health.uptime_seconds % 3600) / 60)}m
                </span>
                <span>{t("errorCount24h", { count: health.error_count_24h ?? 0 })}</span>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("systemHealthError")}
            </p>
          )}
        </motion.div>

        {/* Recent Audit Log */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="rounded-lg border border-border bg-card p-5"
        >
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold">{t("auditLogTitle")}</h2>
            <Link
              href="/audit"
              className="text-xs text-primary hover:underline"
            >
              {t("viewAll")}
            </Link>
          </div>
          {auditEntries.length > 0 ? (
            <div className="space-y-2">
              {auditEntries.map((entry) => (
                <div key={entry.id} className="flex items-center gap-3 text-sm">
                  <Badge className="rounded-full text-2xs" variant="secondary">
                    {entry.action}
                  </Badge>
                  <span className="text-xs text-muted-foreground truncate flex-1">
                    {entry.user_id ? `${entry.user_id.slice(0, 8)}...` : "-"}
                  </span>
                  <Badge
                    className={`rounded-full text-2xs ${
                      entry.result === "success"
                        ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300"
                        : "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300"
                    }`}
                    variant="secondary"
                  >
                    {entry.result}
                  </Badge>
                  <span className="text-xs-plus text-muted-foreground shrink-0">
                    {formatDate(entry.created_at)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t("noLogs")}</p>
          )}
        </motion.div>
      </div>
    </div>
  );
}
