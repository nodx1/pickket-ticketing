"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useTranslations } from "next-intl";
import { motion } from "motion/react";
import { toast } from "sonner";
import Link from "next/link";
import {
  Loader2,
  DollarSign,
  TrendingDown,
  Wallet,
  CreditCard,
  RotateCcw,
  Landmark,
} from "lucide-react";
import { Button } from "@pickket/ui";
import { formatKRW } from "@pickket/lib";
import {
  getFinanceSummary,
  getFinanceByEvent,
  getFinanceByOrganizer,
  getAdminPendingRefunds,
  getAdminSettlements,
  isApiCanceled,
  type FinanceSummary,
  type FinanceByEventItem,
  type FinanceByOrganizerItem,
} from "@pickket/lib/api";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import KpiCard from "../../components/KpiCard";
import DateRangeFilter, {
  getDateRange,
  type DateRangeKey,
} from "../../components/DateRangeFilter";
import ExportButton from "../../components/ExportButton";

export default function AdminFinancePage() {
  const t = useTranslations("finance.page");
  const requestIdRef = useRef(0);
  const [summary, setSummary] = useState<FinanceSummary | null>(null);
  const [eventData, setEventData] = useState<FinanceByEventItem[]>([]);
  const [eventTotal, setEventTotal] = useState(0);
  const [orgData, setOrgData] = useState<FinanceByOrganizerItem[]>([]);
  const [orgTotal, setOrgTotal] = useState(0);
  const [pendingRefundCount, setPendingRefundCount] = useState(0);
  const [pendingSettlementCount, setPendingSettlementCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [dateRange, setDateRange] = useState<DateRangeKey>("this_month");
  const [eventSkip, setEventSkip] = useState(0);
  const [orgSkip, setOrgSkip] = useState(0);
  const [eventSort, setEventSort] = useState<{
    key: keyof FinanceByEventItem;
    dir: "asc" | "desc";
  }>({ key: "gross_revenue", dir: "desc" });
  const itemLimit = 20;

  const load = useCallback(async () => {
    const reqId = ++requestIdRef.current;
    setLoading(true);
    try {
      const range = getDateRange(dateRange);
      const dateParams: Record<string, string> = {};
      if (range.from)
        dateParams.date_from = range.from.toISOString().slice(0, 10);
      dateParams.date_to = range.to.toISOString().slice(0, 10);

      const [summaryData, eventRes, orgRes, refundRes, settlementRes] =
        await Promise.allSettled([
          getFinanceSummary({ ...dateParams }),
          getFinanceByEvent({
            ...dateParams,
            skip: eventSkip,
            limit: itemLimit,
          }),
          getFinanceByOrganizer({
            ...dateParams,
            skip: orgSkip,
            limit: itemLimit,
          }),
          getAdminPendingRefunds({ limit: 1 }),
          getAdminSettlements({ status: "pending_review", limit: 1 }),
        ]);

      if (reqId !== requestIdRef.current) return; // 구 요청 무시 (경합 방지)

      if (
        summaryData.status === "rejected" &&
        isApiCanceled(summaryData.reason)
      )
        return;
      if (summaryData.status === "fulfilled") setSummary(summaryData.value);
      if (eventRes.status === "fulfilled") {
        setEventData(eventRes.value.events);
        setEventTotal(eventRes.value.total);
      }
      if (orgRes.status === "fulfilled") {
        setOrgData(orgRes.value.organizers);
        setOrgTotal(orgRes.value.total);
      }
      if (refundRes.status === "fulfilled")
        setPendingRefundCount(refundRes.value.total);
      if (settlementRes.status === "fulfilled")
        setPendingSettlementCount(settlementRes.value.total);
    } catch (err) {
      if (isApiCanceled(err)) return;
      if (reqId !== requestIdRef.current) return;
      toast.error(t("loadError"));
    } finally {
      if (reqId === requestIdRef.current) setLoading(false);
    }
  }, [dateRange, eventSkip, orgSkip]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    setEventSkip(0);
    setOrgSkip(0);
  }, [dateRange]);

  const sortedEventData = [...eventData].sort((a, b) => {
    const aVal = a[eventSort.key] as number;
    const bVal = b[eventSort.key] as number;
    return eventSort.dir === "desc" ? bVal - aVal : aVal - bVal;
  });

  const handleEventSort = (key: keyof FinanceByEventItem) => {
    setEventSort((prev) => ({
      key,
      dir: prev.key === key && prev.dir === "desc" ? "asc" : "desc",
    }));
  };

  const chartData =
    summary?.daily_revenue?.map((d) => ({
      date: d.date.slice(5),
      amount: d.amount,
    })) ?? [];

  const eventExportData = eventData.map((e) => ({
    이벤트: e.event_title,
    분야: e.category,
    매출: e.gross_revenue,
    수수료: e.platform_fee,
    PG수수료: e.pg_fee ?? 0,
    환불: e.refund_total,
    정산: e.net_settlement,
    티켓수: e.ticket_count,
  }));

  const orgExportData = orgData.map((o) => ({
    주최자: o.organizer_name,
    이메일: o.organizer_email,
    이벤트수: o.event_count,
    매출: o.gross_revenue,
    수수료: o.platform_fee,
    PG수수료: o.pg_fee ?? 0,
    정산: o.net_settlement,
  }));

  const eventPages = Math.ceil(eventTotal / itemLimit);
  const orgPages = Math.ceil(orgTotal / itemLimit);

  if (loading && !summary) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-5 p-4 md:p-6">
      <h1 className="sr-only">{t("pageTitle")}</h1>

      <div className="flex items-center justify-between">
        <DateRangeFilter value={dateRange} onChange={setDateRange} />
      </div>

      {/* KPI Cards */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="grid grid-cols-2 lg:grid-cols-3 gap-4"
      >
        <KpiCard
          icon={DollarSign}
          label={t("kpi.grossRevenue")}
          value={formatKRW(summary?.gross_revenue ?? 0)}
          iconColor="text-emerald-500"
          accent
        />
        <KpiCard
          icon={CreditCard}
          label={t("kpi.platformFee")}
          value={formatKRW(summary?.platform_fees ?? 0)}
          iconColor="text-blue-500"
        />
        <KpiCard
          icon={TrendingDown}
          label={t("kpi.totalRefunds")}
          value={formatKRW(summary?.total_refunds ?? 0)}
          iconColor="text-red-500"
        />
        <KpiCard
          icon={Wallet}
          label={t("kpi.netSettlement")}
          value={formatKRW(summary?.net_settlement ?? 0)}
          iconColor="text-purple-500"
        />
        <Link href="/refunds">
          <KpiCard
            icon={RotateCcw}
            label={t("kpi.pendingRefund")}
            value={t("kpi.countUnit", { count: pendingRefundCount ?? 0 })}
            iconColor="text-orange-500"
            subtitle={t("kpi.goToRefunds")}
            accent={pendingRefundCount > 0}
          />
        </Link>
        <Link href="/settlements">
          <KpiCard
            icon={Landmark}
            label={t("kpi.pendingSettlement")}
            value={t("kpi.countUnit", { count: pendingSettlementCount ?? 0 })}
            iconColor="text-amber-500"
            subtitle={t("kpi.goToSettlements")}
            accent={pendingSettlementCount > 0}
          />
        </Link>
      </motion.div>

      {/* Revenue Bar Chart */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="rounded-lg border border-border bg-card p-5"
      >
        <h2 className="text-sm font-semibold mb-4">{t("chart.title")}</h2>
        {chartData.length > 0 ? (
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={chartData}>
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
                formatter={(value) => [formatKRW(Number(value)), t("chart.tooltipLabel")]}
              />
              <Bar dataKey="amount" fill="#6366f1" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex items-center justify-center h-[260px] text-muted-foreground text-sm">
            {t("noData")}
          </div>
        )}
      </motion.div>

      {/* Event Revenue Table */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15 }}
        className="rounded-lg border border-border bg-card"
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h3 className="text-sm font-semibold">
            {t("eventTable.title", { total: eventTotal ?? 0 })}
          </h3>
          <ExportButton data={eventExportData} filename="finance_by_event" />
        </div>
        {sortedEventData.length === 0 ? (
          <div className="text-center py-10 text-sm text-muted-foreground">
            {t("noData")}
          </div>
        ) : (
          <>
            <div className="hidden md:grid grid-cols-8 gap-2 px-5 py-2.5 text-xs font-medium text-muted-foreground border-b border-border">
              <span className="col-span-2">{t("col.event")}</span>
              <button
                type="button"
                className="text-right hover:text-foreground"
                onClick={() => handleEventSort("gross_revenue")}
              >
                {t("col.revenue")}{" "}
                {eventSort.key === "gross_revenue"
                  ? eventSort.dir === "desc"
                    ? "v"
                    : "^"
                  : ""}
              </button>
              <button
                type="button"
                className="text-right hover:text-foreground"
                onClick={() => handleEventSort("platform_fee")}
              >
                {t("col.fee")}{" "}
                {eventSort.key === "platform_fee"
                  ? eventSort.dir === "desc"
                    ? "v"
                    : "^"
                  : ""}
              </button>
              <span className="text-right">{t("col.pgFee")}</span>
              <button
                type="button"
                className="text-right hover:text-foreground"
                onClick={() => handleEventSort("refund_total")}
              >
                {t("col.refund")}{" "}
                {eventSort.key === "refund_total"
                  ? eventSort.dir === "desc"
                    ? "v"
                    : "^"
                  : ""}
              </button>
              <button
                type="button"
                className="text-right hover:text-foreground"
                onClick={() => handleEventSort("net_settlement")}
              >
                {t("col.settlement")}{" "}
                {eventSort.key === "net_settlement"
                  ? eventSort.dir === "desc"
                    ? "v"
                    : "^"
                  : ""}
              </button>
              <button
                type="button"
                className="text-right hover:text-foreground"
                onClick={() => handleEventSort("ticket_count")}
              >
                {t("col.ticket")}{" "}
                {eventSort.key === "ticket_count"
                  ? eventSort.dir === "desc"
                    ? "v"
                    : "^"
                  : ""}
              </button>
            </div>
            <div className="divide-y divide-border">
              {sortedEventData.map((e) => (
                <div
                  key={e.event_id}
                  className="grid grid-cols-2 md:grid-cols-8 gap-2 px-5 py-3 text-sm items-center"
                >
                  <span className="col-span-2 font-medium truncate">
                    {e.event_title}
                  </span>
                  <span className="text-right hidden md:block font-tabular">
                    {formatKRW(e.gross_revenue)}
                  </span>
                  <span className="text-right hidden md:block font-tabular">
                    {formatKRW(e.platform_fee)}
                  </span>
                  <span className="text-right hidden md:block font-tabular">
                    {e.pg_fee != null ? formatKRW(e.pg_fee) : "-"}
                  </span>
                  <span className="text-right hidden md:block font-tabular">
                    {formatKRW(e.refund_total)}
                  </span>
                  <span className="text-right hidden md:block font-tabular">
                    {formatKRW(e.net_settlement)}
                  </span>
                  <span className="text-right hidden md:block font-tabular">
                    {e.ticket_count.toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
            {eventPages > 1 && (
              <div className="flex items-center justify-center gap-4 py-3 border-t border-border">
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-full"
                  disabled={eventSkip === 0}
                  onClick={() =>
                    setEventSkip((s) => Math.max(0, s - itemLimit))
                  }
                >
                  {t("pagination.prev")}
                </Button>
                <span className="text-xs text-muted-foreground">
                  {Math.floor(eventSkip / itemLimit) + 1} / {eventPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-full"
                  disabled={eventSkip + itemLimit >= eventTotal}
                  onClick={() => setEventSkip((s) => s + itemLimit)}
                >
                  {t("pagination.next")}
                </Button>
              </div>
            )}
          </>
        )}
      </motion.div>

      {/* Organizer Settlement Table */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        className="rounded-lg border border-border bg-card"
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h3 className="text-sm font-semibold">{t("orgTable.title", { total: orgTotal ?? 0 })}</h3>
          <ExportButton data={orgExportData} filename="finance_by_organizer" />
        </div>
        {orgData.length === 0 ? (
          <div className="text-center py-10 text-sm text-muted-foreground">
            {t("noData")}
          </div>
        ) : (
          <>
            <div className="hidden md:grid grid-cols-7 gap-2 px-5 py-2.5 text-xs font-medium text-muted-foreground border-b border-border">
              <span>{t("col.organizer")}</span>
              <span>{t("col.email")}</span>
              <span className="text-right">{t("col.eventCount")}</span>
              <span className="text-right">{t("col.revenue")}</span>
              <span className="text-right">{t("col.fee")}</span>
              <span className="text-right">{t("col.pgFee")}</span>
              <span className="text-right">{t("col.settlement")}</span>
            </div>
            <div className="divide-y divide-border">
              {orgData.map((o) => (
                <div
                  key={o.organizer_id}
                  className="grid grid-cols-2 md:grid-cols-7 gap-2 px-5 py-3 text-sm items-center"
                >
                  <span className="font-medium truncate">
                    {o.organizer_name}
                  </span>
                  <span className="text-muted-foreground truncate hidden md:block">
                    {o.organizer_email}
                  </span>
                  <span className="text-right hidden md:block font-tabular">
                    {o.event_count}
                  </span>
                  <span className="text-right hidden md:block font-tabular">
                    {formatKRW(o.gross_revenue)}
                  </span>
                  <span className="text-right hidden md:block font-tabular">
                    {formatKRW(o.platform_fee)}
                  </span>
                  <span className="text-right hidden md:block font-tabular">
                    {o.pg_fee != null ? formatKRW(o.pg_fee) : "-"}
                  </span>
                  <span className="text-right hidden md:block font-tabular">
                    {formatKRW(o.net_settlement)}
                  </span>
                </div>
              ))}
            </div>
            {orgPages > 1 && (
              <div className="flex items-center justify-center gap-4 py-3 border-t border-border">
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-full"
                  disabled={orgSkip === 0}
                  onClick={() => setOrgSkip((s) => Math.max(0, s - itemLimit))}
                >
                  {t("pagination.prev")}
                </Button>
                <span className="text-xs text-muted-foreground">
                  {Math.floor(orgSkip / itemLimit) + 1} / {orgPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-full"
                  disabled={orgSkip + itemLimit >= orgTotal}
                  onClick={() => setOrgSkip((s) => s + itemLimit)}
                >
                  {t("pagination.next")}
                </Button>
              </div>
            )}
          </>
        )}
      </motion.div>
    </div>
  );
}
