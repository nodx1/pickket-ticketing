"use client";

import { useEffect, useState, useCallback } from "react";
import { motion } from "motion/react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Loader2, ChevronDown, ChevronRight } from "lucide-react";
import {
  Button,
  Badge,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@pickket/ui";
import {
  getAdminAuditLog,
  isApiCanceled,
  type AuditEntry,
} from "@pickket/lib/api";
import { formatDate } from "@pickket/lib";
import DateRangeFilter, {
  getDateRange,
  type DateRangeKey,
} from "../../components/DateRangeFilter";
import ExportButton from "../../components/ExportButton";

const ACTION_OPTION_VALUES = [
  "all",
  "create",
  "update",
  "delete",
  "ban",
  "unban",
  "approve",
  "reject",
  "refund",
  "cancel",
  "login",
  "weight_template_change_request",
  "weight_template_change_approved",
  "weight_template_change_rejected",
  "lottery_draw",
  "lottery_apply",
] as const;

export default function AdminAuditPage() {
  const t = useTranslations("audit");

  const ACTION_OPTIONS = ACTION_OPTION_VALUES.map((value) => ({
    value,
    label: t(`action.${value}`),
  }));

  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [eventIdFilter, setEventIdFilter] = useState("");
  const [actionFilter, setActionFilter] = useState("all");
  const [dateRange, setDateRange] = useState<DateRangeKey>("all");
  const [skip, setSkip] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const limit = 50;

  useEffect(() => {
    setSkip(0);
  }, [actionFilter, dateRange]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, unknown> = { skip, limit };
      if (eventIdFilter) params.event_id = eventIdFilter;
      if (actionFilter !== "all") params.action = actionFilter;
      const range = getDateRange(dateRange);
      if (range.from) params.date_from = range.from.toISOString().slice(0, 10);
      params.date_to = range.to.toISOString().slice(0, 10);
      const data = await getAdminAuditLog(
        params as Parameters<typeof getAdminAuditLog>[0],
      );
      setEntries(data.entries);
      setTotal(data.total);
    } catch (err) {
      if (isApiCanceled(err)) return;
      toast.error(t("loadError"));
    } finally {
      setLoading(false);
    }
  }, [eventIdFilter, actionFilter, dateRange, skip]);

  useEffect(() => {
    load();
  }, [load]);

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const totalPages = Math.ceil(total / limit);

  const exportData = entries.map((e) => ({
    시간: e.created_at,
    액션: e.action,
    이벤트ID: e.event_id || "",
    사용자ID: e.user_id || "",
    관리자ID: e.admin_id || "",
    결과: e.result,
    상세: e.details ? JSON.stringify(e.details) : "",
  }));

  return (
    <div className="space-y-5 p-4 md:p-6">
      <h1 className="sr-only">{t("title")}</h1>

      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
        <Input
          placeholder={t("eventIdPlaceholder")}
          aria-label={t("eventIdAriaLabel")}
          value={eventIdFilter}
          onChange={(e) => {
            setEventIdFilter(e.target.value);
            setSkip(0);
          }}
          className="max-w-xs rounded-full"
        />
        <Select value={actionFilter} onValueChange={setActionFilter}>
          <SelectTrigger className="w-[140px] rounded-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ACTION_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <DateRangeFilter value={dateRange} onChange={setDateRange} />
        <ExportButton data={exportData} filename="audit_log" />
      </div>

      <div className="rounded-lg border border-border bg-card">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : entries.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            {t("empty")}
          </div>
        ) : (
          <>
            <div className="hidden md:grid grid-cols-7 gap-2 px-5 py-3 text-xs font-medium text-muted-foreground border-b border-border">
              <span>{t("col.time")}</span>
              <span>{t("col.action")}</span>
              <span>{t("col.eventId")}</span>
              <span>{t("col.userId")}</span>
              <span>{t("col.admin")}</span>
              <span>{t("col.result")}</span>
              <span className="text-right">{t("col.details")}</span>
            </div>
            <div className="divide-y divide-border">
              {entries.map((e, idx) => (
                <div key={e.id}>
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: idx * 0.02 }}
                    className="grid grid-cols-2 md:grid-cols-7 gap-2 px-5 py-3.5 text-sm items-center hover:bg-muted/50 transition-colors cursor-pointer"
                    onClick={() => e.details && toggleExpand(e.id)}
                  >
                    <span className="text-xs text-muted-foreground">
                      {formatDate(e.created_at)}
                    </span>
                    <span>
                      <Badge className="rounded-full" variant="secondary">
                        {e.action}
                      </Badge>
                    </span>
                    <span
                      className="text-xs text-muted-foreground truncate hidden md:block"
                      title={e.event_id || ""}
                    >
                      {e.event_id ? `${e.event_id.slice(0, 8)}...` : "-"}
                    </span>
                    <span
                      className="text-xs text-muted-foreground truncate hidden md:block"
                      title={e.user_id || ""}
                    >
                      {e.user_id ? `${e.user_id.slice(0, 8)}...` : "-"}
                    </span>
                    <span
                      className="text-xs text-muted-foreground truncate hidden md:block"
                      title={e.admin_id || ""}
                    >
                      {e.admin_id ? `${e.admin_id.slice(0, 8)}...` : "-"}
                    </span>
                    <span className="hidden md:block">
                      <Badge
                        className={`rounded-full ${e.result === "success" ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300" : "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300"}`}
                        variant="secondary"
                      >
                        {e.result}
                      </Badge>
                    </span>
                    <span className="text-right">
                      {e.details &&
                        (expanded.has(e.id) ? (
                          <ChevronDown className="h-4 w-4 inline text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-4 w-4 inline text-muted-foreground" />
                        ))}
                    </span>
                  </motion.div>
                  {expanded.has(e.id) && e.details && (
                    <div className="px-5 pb-4">
                      <pre className="bg-muted/50 rounded-xl p-3 text-xs overflow-auto max-h-48 font-mono">
                        {JSON.stringify(e.details, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              ))}
            </div>
            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-4 py-4 border-t border-border">
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-full"
                  disabled={skip === 0}
                  onClick={() => setSkip((s) => Math.max(0, s - limit))}
                >
                  {t("prev")}
                </Button>
                <span className="text-xs text-muted-foreground">
                  {Math.floor(skip / limit) + 1} / {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-full"
                  disabled={skip + limit >= total}
                  onClick={() => setSkip((s) => s + limit)}
                >
                  {t("next")}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
