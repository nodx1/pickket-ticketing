"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useTranslations } from "next-intl";
import { motion } from "motion/react";
import { toast } from "sonner";
import { Users, Zap, Gauge, RefreshCw, Loader2, Inbox } from "lucide-react";
import {
  Button,
  Badge,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@pickket/ui";
import {
  getAdminEvents,
  getQueueStats,
  isApiCanceled,
  type QueueStatsResponse,
} from "@pickket/lib/api";
import KpiCard from "../../components/KpiCard";

const REFRESH_INTERVAL = 30;

export default function AdminQueuePage() {
  const t = useTranslations("queue.monitor");
  const [events, setEvents] = useState<{ id: string; title: string }[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string>("");
  const [stats, setStats] = useState<QueueStatsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [countdown, setCountdown] = useState(REFRESH_INTERVAL);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load bidding_open events
  useEffect(() => {
    (async () => {
      try {
        const data = await getAdminEvents({
          status: "bidding_open",
          limit: 100,
        });
        setEvents(data.events.map((e) => ({ id: e.id, title: e.title })));
      } catch (err) {
        if (isApiCanceled(err)) return;
        toast.error(t("errorLoadEvents"));
      }
    })();
  }, []);

  // Fetch queue stats
  const fetchStats = useCallback(async () => {
    if (!selectedEventId) return;
    setLoading(true);
    try {
      const { data } = await getQueueStats(selectedEventId);
      setStats(data);
    } catch (err) {
      if (isApiCanceled(err)) return;
      toast.error(t("errorLoadStats"));
    } finally {
      setLoading(false);
    }
  }, [selectedEventId]);

  // Auto-refresh with countdown
  useEffect(() => {
    if (!selectedEventId) {
      setStats(null);
      setCountdown(REFRESH_INTERVAL);
      return;
    }

    fetchStats();
    setCountdown(REFRESH_INTERVAL);

    timerRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          fetchStats();
          return REFRESH_INTERVAL;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [selectedEventId, fetchStats]);

  const handleManualRefresh = () => {
    fetchStats();
    setCountdown(REFRESH_INTERVAL);
  };

  const utilization =
    stats && stats.max_active > 0
      ? Math.min((stats.active_count / stats.max_active) * 100, 100)
      : 0;

  return (
    <div className="space-y-5 p-4 md:p-6">
      <h1 className="sr-only">{t("title")}</h1>

      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
        <Select value={selectedEventId} onValueChange={setSelectedEventId}>
          <SelectTrigger className="w-full sm:w-[320px] rounded-full">
            <SelectValue placeholder={t("selectEventPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            {events.length === 0 ? (
              <SelectItem value="_none" disabled>
                {t("noActiveEvents")}
              </SelectItem>
            ) : (
              events.map((e) => (
                <SelectItem key={e.id} value={e.id}>
                  {e.title}
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>

        {selectedEventId && (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="rounded-full"
              onClick={handleManualRefresh}
              disabled={loading}
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-1" />
              )}
              {t("refresh")}
            </Button>
            <Badge variant="secondary" className="rounded-full tabular-nums">
              {countdown}s
            </Badge>
          </div>
        )}
      </div>

      {/* Content */}
      {!selectedEventId || !stats ? (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col items-center justify-center py-24 text-muted-foreground"
        >
          <Inbox className="h-10 w-10 mb-3" />
          <p className="text-sm">{t("emptyTitle")}</p>
          <p className="text-xs mt-1">{t("emptyHint")}</p>
        </motion.div>
      ) : (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-5"
        >
          {/* KPI Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0 }}
            >
              <KpiCard
                label={t("kpiWaiting")}
                value={stats.total_waiting.toLocaleString()}
                icon={Users}
                iconColor="text-blue-500"
              />
            </motion.div>
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 }}
            >
              <KpiCard
                label={t("kpiActiveSessions")}
                value={stats.active_count.toLocaleString()}
                icon={Zap}
                iconColor="text-emerald-500"
                accent={stats.active_count >= stats.max_active}
              />
            </motion.div>
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
            >
              <KpiCard
                label={t("kpiMaxConcurrent")}
                value={stats.max_active.toLocaleString()}
                icon={Gauge}
                iconColor="text-amber-500"
              />
            </motion.div>
          </div>

          {/* Utilization Progress Bar */}
          <div className="rounded-lg border border-border bg-card p-5 space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">{t("utilizationLabel")}</span>
              <span className="font-medium font-tabular">
                {utilization.toFixed(1)}%
              </span>
            </div>
            <div className="h-3 w-full rounded-full bg-muted overflow-hidden">
              <motion.div
                className={`h-full rounded-full ${
                  utilization >= 90
                    ? "bg-red-500"
                    : utilization >= 70
                      ? "bg-amber-500"
                      : "bg-emerald-500"
                }`}
                initial={{ width: 0 }}
                animate={{ width: `${utilization}%` }}
                transition={{ duration: 0.5, ease: "easeOut" }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {t("sessionUsage", {
                active: stats.active_count.toLocaleString(),
                max: stats.max_active.toLocaleString(),
              })}
            </p>
          </div>
        </motion.div>
      )}
    </div>
  );
}
