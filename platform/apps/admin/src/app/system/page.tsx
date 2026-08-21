"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useTranslations } from "next-intl";
import { motion } from "motion/react";
import { toast } from "sonner";
import {
  Loader2,
  Database,
  Server,
  Cpu,
  RefreshCw,
  AlertTriangle,
  Clock,
} from "lucide-react";
import { Button } from "@pickket/ui";
import {
  getSystemHealth,
  isApiCanceled,
  type SystemHealth,
} from "@pickket/lib/api";

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <div
      className={`h-3 w-3 rounded-full ${ok ? "bg-green-500" : "bg-red-500"}`}
    />
  );
}

function formatUptime(
  seconds: number,
  t: (key: string, values?: Record<string, number>) => string,
): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(t("uptime.days", { count: days }));
  if (hours > 0) parts.push(t("uptime.hours", { count: hours }));
  parts.push(t("uptime.minutes", { count: minutes }));
  return parts.join(" ");
}

export default function AdminSystemPage() {
  const t = useTranslations("system.monitor");
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await getSystemHealth();
      setHealth(data);
      setLastRefreshed(new Date());
    } catch (err) {
      if (isApiCanceled(err)) return;
      toast.error(t("loadError"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();

    // Auto-refresh every 30 seconds
    intervalRef.current = setInterval(() => {
      void load();
    }, 30000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [load]);

  if (loading && !health) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex items-center justify-between">
        <h1 className="sr-only">{t("title")}</h1>
        <div className="flex items-center gap-3 ml-auto">
          {lastRefreshed && (
            <span className="text-xs text-muted-foreground">
              {t("lastRefreshed", { time: lastRefreshed.toLocaleTimeString("ko-KR") })}
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="rounded-full"
            onClick={load}
          >
            <RefreshCw className="h-4 w-4 mr-1" />
            {t("refresh")}
          </Button>
        </div>
      </div>

      {!health ? (
        <div className="rounded-lg border border-border bg-card p-10 text-center text-muted-foreground">
          {t("loadError")}
        </div>
      ) : (
        <>
          {/* Overall Status */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-lg border border-border bg-card p-5"
          >
            <div className="flex items-center gap-3">
              <div
                className={`h-4 w-4 rounded-full ${health.status === "healthy" ? "bg-green-500" : "bg-red-500"}`}
              />
              <h2 className="text-lg font-semibold">
                {health.status === "healthy"
                  ? t("statusHealthy")
                  : t("statusUnhealthy")}
              </h2>
            </div>
          </motion.div>

          {/* Service Cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Database */}
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 }}
              className="rounded-lg border border-border bg-card p-5 space-y-4"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Database className="h-5 w-5 text-blue-500" />
                  <h3 className="font-semibold">Database</h3>
                </div>
                <StatusDot ok={health.database.connected} />
              </div>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t("status")}</span>
                  <span
                    className={
                      health.database.connected
                        ? "text-green-500"
                        : "text-red-500"
                    }
                  >
                    {health.database.connected ? t("connected") : t("disconnected")}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t("latency")}</span>
                  <span className="font-tabular">
                    {health.database.latency_ms}ms
                  </span>
                </div>
              </div>
            </motion.div>

            {/* Redis */}
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="rounded-lg border border-border bg-card p-5 space-y-4"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Server className="h-5 w-5 text-red-500" />
                  <h3 className="font-semibold">Redis</h3>
                </div>
                <StatusDot ok={health.redis.connected} />
              </div>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t("status")}</span>
                  <span
                    className={
                      health.redis.connected ? "text-green-500" : "text-red-500"
                    }
                  >
                    {health.redis.connected ? t("connected") : t("disconnected")}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t("latency")}</span>
                  <span className="font-tabular">
                    {health.redis.latency_ms}ms
                  </span>
                </div>
              </div>
            </motion.div>

            {/* Celery */}
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15 }}
              className="rounded-lg border border-border bg-card p-5 space-y-4"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Cpu className="h-5 w-5 text-amber-500" />
                  <h3 className="font-semibold">Celery</h3>
                </div>
                <StatusDot ok={health.celery.workers > 0} />
              </div>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t("celery.workers")}</span>
                  <span className="font-tabular">{health.celery.workers}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t("celery.activeTasks")}</span>
                  <span className="font-tabular">
                    {health.celery.active_tasks}
                  </span>
                </div>
              </div>
            </motion.div>
          </div>

          {/* System Info */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
              className="rounded-lg border border-border bg-card p-5"
            >
              <div className="flex items-center gap-2 mb-3">
                <Clock className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold">Uptime</h3>
              </div>
              <p className="text-2xl font-bold font-tabular">
                {formatUptime(health.uptime_seconds ?? 0, t)}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {t("uptime.secondsTotal", { count: health.uptime_seconds ?? 0 })}
              </p>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.25 }}
              className="rounded-lg border border-border bg-card p-5"
            >
              <div className="flex items-center gap-2 mb-3">
                <AlertTriangle className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold">{t("errors24h.title")}</h3>
              </div>
              <p
                className={`text-2xl font-bold font-tabular ${health.error_count_24h > 0 ? "text-red-500" : "text-green-500"}`}
              >
                {health.error_count_24h.toLocaleString()}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {health.error_count_24h === 0
                  ? t("errors24h.none")
                  : t("errors24h.actionRequired")}
              </p>
            </motion.div>
          </div>

          <p className="text-xs text-muted-foreground text-center">
            {t("autoRefresh")}
          </p>
        </>
      )}
    </div>
  );
}
