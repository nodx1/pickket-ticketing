"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useTranslations } from "next-intl";
import { motion } from "motion/react";
import { toast } from "sonner";
import {
  Loader2,
  CheckCircle,
  ShieldCheck,
  PauseCircle,
  PlayCircle,
  Banknote,
  Clock,
  ArrowUpDown,
  Plus,
} from "lucide-react";
import {
  Button,
  Badge,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Input,
  Label,
  Textarea,
} from "@pickket/ui";
import {
  getAdminSettlements,
  getAdminSettlementSummary as getSettlementSummary,
  getSettlementDetail,
  reviewSettlement,
  approveSettlement,
  updateSettlementStatus,
  createSettlementAdjustment,
  isApiCanceled,
  type AdminSettlementItem,
  type AdminSettlementDetail,
  type SettlementSummary,
} from "@pickket/lib/api";
import { formatDate, formatKRW } from "@pickket/lib";
import { useAuthStore } from "@pickket/store";
import DateRangeFilter, {
  getDateRange,
  type DateRangeKey,
} from "../../components/DateRangeFilter";
import ExportButton from "../../components/ExportButton";

// ── Status config ────────────────────────────────────────────────

const STATUS_LABEL: Record<string, string> = {
  draft: "초안",
  pending_review: "검토대기",
  reviewed: "검토완료",
  approved: "승인됨",
  paid: "지급완료",
  disputed: "보류/이의",
};

const STATUS_COLOR: Record<string, string> = {
  draft: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
  pending_review:
    "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
  reviewed: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  approved:
    "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
  paid: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  disputed: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
};

type StatusFilter =
  | "all"
  | "draft"
  | "pending_review"
  | "reviewed"
  | "approved"
  | "paid"
  | "disputed";

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "전체 상태" },
  { value: "draft", label: "초안" },
  { value: "pending_review", label: "검토대기" },
  { value: "reviewed", label: "검토완료" },
  { value: "approved", label: "승인됨" },
  { value: "paid", label: "지급완료" },
  { value: "disputed", label: "보류/이의" },
];

const ADJUSTMENT_TYPES = [
  { value: "manual", label: "수동 조정" },
  { value: "correction", label: "정정" },
  { value: "penalty", label: "패널티" },
  { value: "bonus", label: "보너스" },
];

// ── Summary card ─────────────────────────────────────────────────

function SummaryCard({
  label,
  count,
  amount,
  icon: Icon,
  color,
}: {
  label: string;
  count: number;
  amount?: number;
  icon: React.ElementType;
  color: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-lg border border-border bg-card p-4 flex items-start gap-3"
    >
      <div className={`rounded-lg p-2.5 ${color}`}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-lg font-semibold mt-0.5">{count}</p>
        {amount !== undefined && (
          <p className="text-xs text-muted-foreground font-tabular mt-0.5">
            {formatKRW(amount)}
          </p>
        )}
      </div>
    </motion.div>
  );
}

// ── Main page ────────────────────────────────────────────────────

export default function AdminSettlementsPage() {
  const t = useTranslations("settlement");
  const { user } = useAuthStore();
  const requestIdRef = useRef(0);

  // List state
  const [items, setItems] = useState<AdminSettlementItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [dateRange, setDateRange] = useState<DateRangeKey>("this_month");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [skip, setSkip] = useState(0);
  const limit = 20;

  // Summary state
  const [summary, setSummary] = useState<SettlementSummary | null>(null);

  // Detail sheet
  const [detail, setDetail] = useState<AdminSettlementDetail | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);

  // Approve dialog
  const [approveTarget, setApproveTarget] =
    useState<AdminSettlementItem | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  // Hold dialog
  const [holdTarget, setHoldTarget] = useState<AdminSettlementItem | null>(
    null,
  );
  const [holdReason, setHoldReason] = useState("");

  // Adjust dialog
  const [adjustTarget, setAdjustTarget] = useState<AdminSettlementItem | null>(
    null,
  );
  const [adjustAmount, setAdjustAmount] = useState("");
  const [adjustReason, setAdjustReason] = useState("");
  const [adjustType, setAdjustType] = useState("manual");

  // ── Load list ──────────────────────────────────────────────────

  const load = useCallback(async () => {
    const reqId = ++requestIdRef.current;
    setLoading(true);
    try {
      const range = getDateRange(dateRange);
      const params: Record<string, string | number> = { skip, limit };
      if (range.from) params.date_from = range.from.toISOString().slice(0, 10);
      params.date_to = range.to.toISOString().slice(0, 10);
      if (statusFilter !== "all") params.status = statusFilter;

      const res = await getAdminSettlements(params);
      if (reqId !== requestIdRef.current) return; // 구 요청 무시 (경합 방지)
      setItems(res.settlements);
      setTotal(res.total);
    } catch (err) {
      if (isApiCanceled(err)) return;
      if (reqId !== requestIdRef.current) return;
      toast.error(t("toastLoadListError"));
    } finally {
      if (reqId === requestIdRef.current) setLoading(false);
    }
  }, [dateRange, statusFilter, skip]);

  const loadSummary = useCallback(async () => {
    try {
      const res = await getSettlementSummary();
      setSummary(res);
    } catch (err) {
      if (isApiCanceled(err)) return;
      // summary is non-critical
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  useEffect(() => {
    setSkip(0);
  }, [dateRange, statusFilter]);

  // ── Load detail ────────────────────────────────────────────────

  const openDetail = async (item: AdminSettlementItem) => {
    setSheetOpen(true);
    setDetailLoading(true);
    setDetail(null);
    try {
      const res = await getSettlementDetail(item.id);
      setDetail(res);
    } catch {
      toast.error(t("toastLoadDetailError"));
      setSheetOpen(false);
    } finally {
      setDetailLoading(false);
    }
  };

  // ── Actions ────────────────────────────────────────────────────

  const handleReview = async (item: AdminSettlementItem) => {
    setActionLoading(true);
    try {
      await reviewSettlement(item.id);
      toast.success(t("toastReviewSuccess", { name: item.organizer_name ?? "" }));
      load();
      loadSummary();
      if (sheetOpen) await openDetail(item);
    } catch {
      toast.error(t("toastReviewError"));
    } finally {
      setActionLoading(false);
    }
  };

  const handleApprove = async () => {
    if (!approveTarget) return;
    setActionLoading(true);
    try {
      await approveSettlement(approveTarget.id);
      toast.success(t("toastApproveSuccess", { name: approveTarget.organizer_name ?? "" }));
      setApproveTarget(null);
      load();
      loadSummary();
    } catch {
      toast.error(t("toastApproveError"));
    } finally {
      setActionLoading(false);
    }
  };

  const handleHold = async () => {
    if (!holdTarget) return;
    setActionLoading(true);
    try {
      await updateSettlementStatus(holdTarget.id, "hold", holdReason);
      toast.success(t("toastHoldSuccess", { name: holdTarget.organizer_name ?? "" }));
      setHoldTarget(null);
      setHoldReason("");
      load();
      loadSummary();
    } catch {
      toast.error(t("toastHoldError"));
    } finally {
      setActionLoading(false);
    }
  };

  const handleRelease = async (item: AdminSettlementItem) => {
    setActionLoading(true);
    try {
      await updateSettlementStatus(item.id, "release");
      toast.success(t("toastReleaseSuccess", { name: item.organizer_name ?? "" }));
      load();
      loadSummary();
    } catch {
      toast.error(t("toastReleaseError"));
    } finally {
      setActionLoading(false);
    }
  };

  const handleMarkPaid = async (item: AdminSettlementItem) => {
    setActionLoading(true);
    try {
      await updateSettlementStatus(item.id, "mark_paid");
      toast.success(t("toastMarkPaidSuccess", { name: item.organizer_name ?? "" }));
      load();
      loadSummary();
      if (sheetOpen) await openDetail(item);
    } catch {
      toast.error(t("toastMarkPaidError"));
    } finally {
      setActionLoading(false);
    }
  };

  const handleAdjust = async () => {
    if (!adjustTarget) return;
    const amount = parseFloat(adjustAmount);
    if (isNaN(amount) || amount === 0) {
      toast.error(t("toastAdjustInvalidAmount"));
      return;
    }
    if (!adjustReason.trim()) {
      toast.error(t("toastAdjustNoReason"));
      return;
    }
    setActionLoading(true);
    try {
      await createSettlementAdjustment(adjustTarget.id, {
        amount,
        reason: adjustReason,
        adjustment_type: adjustType,
      });
      toast.success(t("toastAdjustSuccess"));
      setAdjustTarget(null);
      setAdjustAmount("");
      setAdjustReason("");
      setAdjustType("manual");
      load();
      if (sheetOpen && detail) await openDetail(detail);
    } catch {
      toast.error(t("toastAdjustError"));
    } finally {
      setActionLoading(false);
    }
  };

  // ── Export data ────────────────────────────────────────────────

  const exportData = items.map((s) => ({
    주최자명: s.organizer_name,
    정산시작: s.period_start,
    정산종료: s.period_end,
    총매출: s.gross_revenue,
    환불액: s.refund_amount,
    플랫폼수수료: s.platform_fee,
    PG수수료: s.pg_fee,
    순지급액: s.net_settlement,
    상태: STATUS_LABEL[s.status] ?? s.status,
  }));

  const pages = Math.ceil(total / limit);

  // ── Render ─────────────────────────────────────────────────────

  if (loading && items.length === 0 && !summary) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-5 p-4 md:p-6">
      <h1 className="sr-only">{t("pageTitle")}</h1>

      {/* Summary cards */}
      {summary && (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <SummaryCard
            label={t("summaryPending")}
            count={summary.total_pending}
            amount={summary.total_pending_amount}
            icon={Clock}
            color="bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400"
          />
          <SummaryCard
            label={t("summaryReviewed")}
            count={summary.total_reviewed}
            amount={summary.total_reviewed_amount}
            icon={CheckCircle}
            color="bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
          />
          <SummaryCard
            label={t("summaryApproved")}
            count={summary.total_approved}
            amount={summary.total_approved_amount}
            icon={ShieldCheck}
            color="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300"
          />
          <SummaryCard
            label={t("summaryPaid")}
            count={summary.total_paid}
            amount={summary.total_paid_amount}
            icon={Banknote}
            color="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
          />
          <SummaryCard
            label={t("summaryThisMonth")}
            count={summary.this_month_count}
            amount={summary.this_month_amount}
            icon={ArrowUpDown}
            color="bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400"
          />
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <DateRangeFilter value={dateRange} onChange={setDateRange} />
          <Select
            value={statusFilter}
            onValueChange={(v) => setStatusFilter(v as StatusFilter)}
          >
            <SelectTrigger className="w-[140px] rounded-full h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {t(`statusOption.${opt.value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <ExportButton data={exportData} filename="settlements" />
      </div>

      {/* Table */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-lg border border-border bg-card"
      >
        <div className="px-5 py-3 border-b border-border">
          <h3 className="text-sm font-semibold">{t("tableTitle", { count: total })}</h3>
        </div>

        {items.length === 0 ? (
          <div className="text-center py-10 text-sm text-muted-foreground">
            {t("tableEmpty")}
          </div>
        ) : (
          <>
            <div className="hidden lg:grid grid-cols-10 gap-2 px-5 py-2.5 text-xs font-medium text-muted-foreground border-b border-border">
              <span className="col-span-2">{t("colOrganizer")}</span>
              <span>{t("colPeriod")}</span>
              <span className="text-right">{t("colGrossRevenue")}</span>
              <span className="text-right">{t("colRefund")}</span>
              <span className="text-right">{t("colPlatformFee")}</span>
              <span className="text-right">{t("colPgFee")}</span>
              <span className="text-right">{t("colNetSettlement")}</span>
              <span className="text-center">{t("colStatus")}</span>
              <span className="text-center">{t("colActions")}</span>
            </div>

            <div className="divide-y divide-border">
              {items.map((item, i) => (
                <motion.div
                  key={item.id}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.03 }}
                  className="grid grid-cols-2 lg:grid-cols-10 gap-2 px-5 py-3 text-sm items-center hover:bg-muted/50 cursor-pointer transition-colors"
                  onClick={() => openDetail(item)}
                >
                  <span className="col-span-2 font-medium truncate">
                    {item.organizer_name}
                  </span>
                  <span className="text-muted-foreground text-xs hidden lg:block">
                    {formatDate(item.period_start)} ~{" "}
                    {formatDate(item.period_end)}
                  </span>
                  <span className="text-right hidden lg:block font-tabular">
                    {formatKRW(item.gross_revenue)}
                  </span>
                  <span className="text-right hidden lg:block font-tabular">
                    {formatKRW(item.refund_amount)}
                  </span>
                  <span className="text-right hidden lg:block font-tabular">
                    {formatKRW(item.platform_fee)}
                  </span>
                  <span className="text-right hidden lg:block font-tabular">
                    {formatKRW(item.pg_fee)}
                  </span>
                  <span className="text-right hidden lg:block font-tabular font-medium">
                    {formatKRW(item.net_settlement)}
                  </span>
                  <span className="hidden lg:flex justify-center">
                    <Badge
                      variant="outline"
                      className={`text-2xs px-2 py-0.5 ${STATUS_COLOR[item.status] ?? ""}`}
                    >
                      {STATUS_LABEL[item.status] != null ? t(`statusLabel.${item.status}`) : item.status}
                    </Badge>
                  </span>
                  <span
                    className="hidden lg:flex justify-center gap-1"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {(item.status === "draft" ||
                      item.status === "pending_review") && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        disabled={actionLoading}
                        onClick={() => handleReview(item)}
                      >
                        <CheckCircle className="h-3 w-3 mr-1" />
                        {t("btnReview")}
                      </Button>
                    )}
                    {item.status === "reviewed" && (() => {
                      const isSelfReviewer = item.reviewed_by != null && user?.id != null && item.reviewed_by === user.id;
                      return (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          disabled={actionLoading || isSelfReviewer}
                          title={isSelfReviewer ? t("fourEyesTitle") : undefined}
                          onClick={() => setApproveTarget(item)}
                        >
                          <ShieldCheck className="h-3 w-3 mr-1" />
                          {isSelfReviewer ? t("btnApproveDenied") : t("btnApprove")}
                        </Button>
                      );
                    })()}
                    {item.status === "disputed" && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        disabled={actionLoading}
                        onClick={() => handleRelease(item)}
                      >
                        <PlayCircle className="h-3 w-3 mr-1" />
                        {t("btnRelease")}
                      </Button>
                    )}
                  </span>
                </motion.div>
              ))}
            </div>

            {pages > 1 && (
              <div className="flex items-center justify-center gap-4 py-3 border-t border-border">
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-full"
                  disabled={skip === 0}
                  onClick={() => setSkip((s) => Math.max(0, s - limit))}
                >
                  {t("btnPrev")}
                </Button>
                <span className="text-xs text-muted-foreground">
                  {Math.floor(skip / limit) + 1} / {pages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-full"
                  disabled={skip + limit >= total}
                  onClick={() => setSkip((s) => s + limit)}
                >
                  {t("btnNext")}
                </Button>
              </div>
            )}
          </>
        )}
      </motion.div>

      {/* ── Detail Sheet ─────────────────────────────────────────── */}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent className="sm:max-w-lg overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{t("sheetTitle", { name: detail?.organizer_name ?? "..." })}</SheetTitle>
            <SheetDescription>
              {detail &&
                `${formatDate(detail.period_start)} ~ ${formatDate(detail.period_end)}`}
            </SheetDescription>
          </SheetHeader>

          {detailLoading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
            </div>
          ) : detail ? (
            <div className="mt-6 space-y-5">
              {/* Status badge */}
              <div className="flex items-center gap-2">
                <Badge
                  variant="outline"
                  className={`text-xs px-2.5 py-1 ${STATUS_COLOR[detail.status] ?? ""}`}
                >
                  {STATUS_LABEL[detail.status] != null ? t(`statusLabel.${detail.status}`) : detail.status}
                </Badge>
                {detail.dispute_reason && (
                  <span className="text-xs text-red-500">
                    {detail.dispute_reason}
                  </span>
                )}
              </div>

              {/* Organizer info */}
              <div className="rounded-lg border border-border p-4 text-sm space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  {t("detailOrganizerInfo")}
                </p>
                <p>
                  <span className="text-muted-foreground">{t("detailOrganizerName")}:</span>{" "}
                  {detail.organizer_name}
                </p>
                {detail.organizer_email && (
                  <p>
                    <span className="text-muted-foreground">{t("detailOrganizerEmail")}:</span>{" "}
                    {detail.organizer_email}
                  </p>
                )}
                <p>
                  <span className="text-muted-foreground">{t("detailOrganizerId")}:</span>{" "}
                  <span className="font-mono text-xs">
                    {detail.organizer_id}
                  </span>
                </p>
              </div>

              {/* Revenue breakdown */}
              <div className="rounded-lg border border-border divide-y divide-border text-sm">
                <div className="flex justify-between px-4 py-2.5">
                  <span className="text-muted-foreground">{t("colGrossRevenue")}</span>
                  <span className="font-tabular font-medium">
                    {formatKRW(detail.gross_revenue)}
                  </span>
                </div>
                <div className="flex justify-between px-4 py-2.5">
                  <span className="text-muted-foreground">{t("colRefund")}</span>
                  <span className="font-tabular text-red-500">
                    -{formatKRW(detail.refund_amount)}
                  </span>
                </div>
                <div className="flex justify-between px-4 py-2.5">
                  <span className="text-muted-foreground">
                    {t("colPlatformFee")}
                    {detail.fee_rate != null && (
                      <span className="ml-1 text-xs text-muted-foreground/70">
                        ({(detail.fee_rate * 100).toFixed(1)}%)
                      </span>
                    )}
                  </span>
                  <span className="font-tabular">
                    -{formatKRW(detail.platform_fee)}
                  </span>
                </div>
                <div className="flex justify-between px-4 py-2.5">
                  <span className="text-muted-foreground">
                    {t("colPgFee")}
                    {detail.pg_fee_rate != null && (
                      <span className="ml-1 text-xs text-muted-foreground/70">
                        ({(detail.pg_fee_rate * 100).toFixed(2)}%)
                      </span>
                    )}
                  </span>
                  <span className="font-tabular">
                    -{formatKRW(detail.pg_fee)}
                  </span>
                </div>
                <div className="flex justify-between px-4 py-2.5 bg-muted/30">
                  <span className="font-semibold">{t("colNetSettlement")}</span>
                  <span className="font-tabular font-semibold text-primary">
                    {formatKRW(detail.net_settlement)}
                  </span>
                </div>
              </div>

              {/* Approval chain */}
              {(detail.reviewed_by || detail.approved_by) && (
                <div className="rounded-lg border border-border p-4 text-xs space-y-2">
                  <p className="font-medium text-muted-foreground uppercase tracking-wide">
                    {t("detailApprovalChain")}
                  </p>
                  {detail.reviewed_by && (
                    <p>
                      {t("detailReviewedBy")}:{" "}
                      <span className="font-medium">
                        {detail.reviewer_name ?? detail.reviewed_by}
                      </span>
                      {detail.reviewed_at && (
                        <span className="text-muted-foreground ml-1">
                          ({formatDate(detail.reviewed_at)})
                        </span>
                      )}
                    </p>
                  )}
                  {detail.approved_by && (
                    <p>
                      {t("detailApprovedBy")}:{" "}
                      <span className="font-medium">
                        {detail.approver_name ?? detail.approved_by}
                      </span>
                      {detail.approved_at && (
                        <span className="text-muted-foreground ml-1">
                          ({formatDate(detail.approved_at)})
                        </span>
                      )}
                    </p>
                  )}
                  {detail.paid_at && (
                    <p>
                      {t("detailPaidAt")}:{" "}
                      <span className="font-medium">
                        {formatDate(detail.paid_at)}
                      </span>
                    </p>
                  )}
                </div>
              )}

              {/* Adjustment history */}
              {detail.adjustments.length > 0 && (
                <div className="rounded-lg border border-border p-4 space-y-3">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    {t("detailAdjustmentHistory", { count: detail.adjustments.length })}
                  </p>
                  <div className="space-y-2">
                    {detail.adjustments.map((adj) => (
                      <div
                        key={adj.id}
                        className="flex items-start justify-between text-xs border-b border-border/50 pb-2 last:border-0 last:pb-0"
                      >
                        <div>
                          <p className="font-medium">{adj.reason}</p>
                          <p className="text-muted-foreground">
                            {adj.created_by_name ?? t("defaultAdminName")} /{" "}
                            {formatDate(adj.created_at)} /{" "}
                            {ADJUSTMENT_TYPES.find(
                              (at) => at.value === adj.adjustment_type,
                            ) != null ? t(`adjustmentType.${adj.adjustment_type}`) : adj.adjustment_type}
                          </p>
                        </div>
                        <span
                          className={`font-tabular font-medium whitespace-nowrap ${adj.amount >= 0 ? "text-green-600" : "text-red-500"}`}
                        >
                          {adj.amount >= 0 ? "+" : ""}
                          {formatKRW(adj.amount)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Meta */}
              <div className="rounded-lg border border-border p-4 text-xs text-muted-foreground space-y-1">
                <p>{t("detailSettlementId")}: {detail.id}</p>
                {detail.fee_schedule_id && (
                  <p>{t("detailFeeScheduleId")}: {detail.fee_schedule_id}</p>
                )}
                <p>{t("detailCreatedAt")}: {formatDate(detail.created_at)}</p>
              </div>

              {/* Action buttons */}
              <div className="flex flex-wrap gap-2 pt-2">
                {(detail.status === "draft" ||
                  detail.status === "pending_review") && (
                  <Button
                    className="flex-1"
                    disabled={actionLoading}
                    onClick={() => {
                      handleReview(detail);
                      setSheetOpen(false);
                    }}
                  >
                    <CheckCircle className="h-4 w-4 mr-1.5" />
                    {t("btnMarkReviewed")}
                  </Button>
                )}
                {detail.status === "reviewed" && (() => {
                  const isSelfReviewer = detail.reviewed_by != null && user?.id != null && detail.reviewed_by === user.id;
                  return (
                    <Button
                      className="flex-1"
                      disabled={actionLoading || isSelfReviewer}
                      title={isSelfReviewer ? t("fourEyesTitle") : undefined}
                      onClick={() => {
                        setApproveTarget(detail);
                        setSheetOpen(false);
                      }}
                    >
                      <ShieldCheck className="h-4 w-4 mr-1.5" />
                      {isSelfReviewer ? t("btnApproveDeniedSelf") : t("btnApproveAction")}
                    </Button>
                  );
                })()}
                {detail.status === "approved" && (
                  <Button
                    className="flex-1"
                    disabled={actionLoading}
                    onClick={() => {
                      handleMarkPaid(detail);
                    }}
                  >
                    <Banknote className="h-4 w-4 mr-1.5" />
                    {t("btnMarkPaid")}
                  </Button>
                )}
                {detail.status === "disputed" && (
                  <Button
                    variant="outline"
                    className="flex-1"
                    disabled={actionLoading}
                    onClick={() => {
                      handleRelease(detail);
                      setSheetOpen(false);
                    }}
                  >
                    <PlayCircle className="h-4 w-4 mr-1.5" />
                    {t("btnReleaseHold")}
                  </Button>
                )}
                {detail.status !== "paid" && detail.status !== "disputed" && (
                  <Button
                    variant="outline"
                    disabled={actionLoading}
                    onClick={() => {
                      setHoldTarget(detail);
                    }}
                  >
                    <PauseCircle className="h-4 w-4 mr-1.5" />
                    {t("btnHold")}
                  </Button>
                )}
                {detail.status !== "paid" && (
                  <Button
                    variant="outline"
                    disabled={actionLoading}
                    onClick={() => {
                      setAdjustTarget(detail);
                    }}
                  >
                    <Plus className="h-4 w-4 mr-1.5" />
                    {t("btnAdjust")}
                  </Button>
                )}
              </div>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>

      {/* ── Approve Confirmation Dialog ──────────────────────────── */}
      <AlertDialog
        open={!!approveTarget}
        onOpenChange={(open) => {
          if (!open) setApproveTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("approveDialogTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{approveTarget?.organizer_name}</strong>{t("approveDialogDescPart1")}{" "}
              <strong>{formatKRW(approveTarget?.net_settlement ?? 0)}</strong>
              {t("approveDialogDescPart2")}
              <br />
              <span className="text-red-500 font-medium">
                {t("approveDialogIrreversible")}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionLoading}>{t("btnCancel")}</AlertDialogCancel>
            <AlertDialogAction disabled={actionLoading} onClick={handleApprove}>
              {actionLoading ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
              ) : (
                <ShieldCheck className="h-4 w-4 mr-1.5" />
              )}
              {t("btnApprove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Hold Dialog ──────────────────────────────────────────── */}
      <Dialog
        open={!!holdTarget}
        onOpenChange={(open) => {
          if (!open) {
            setHoldTarget(null);
            setHoldReason("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("holdDialogTitle")}</DialogTitle>
            <DialogDescription>
              {t("holdDialogDesc", { name: holdTarget?.organizer_name ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <Label htmlFor="holdReason">{t("holdReasonLabel")}</Label>
              <Textarea
                id="holdReason"
                value={holdReason}
                onChange={(e) => setHoldReason(e.target.value)}
                placeholder={t("holdReasonPlaceholder")}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setHoldTarget(null);
                setHoldReason("");
              }}
            >
              {t("btnCancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={actionLoading || !holdReason.trim()}
              onClick={handleHold}
            >
              {actionLoading ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
              ) : (
                <PauseCircle className="h-4 w-4 mr-1.5" />
              )}
              {t("btnHoldAction")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Adjust Dialog ────────────────────────────────────────── */}
      <Dialog
        open={!!adjustTarget}
        onOpenChange={(open) => {
          if (!open) {
            setAdjustTarget(null);
            setAdjustAmount("");
            setAdjustReason("");
            setAdjustType("manual");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("adjustDialogTitle")}</DialogTitle>
            <DialogDescription>
              {t("adjustDialogDesc", { name: adjustTarget?.organizer_name ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label htmlFor="adjustType">{t("adjustTypeLabel")}</Label>
              <Select value={adjustType} onValueChange={setAdjustType}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ADJUSTMENT_TYPES.map((at) => (
                    <SelectItem key={at.value} value={at.value}>
                      {t(`adjustmentType.${at.value}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="adjustAmount">
                {t("adjustAmountLabel")}
              </Label>
              <Input
                id="adjustAmount"
                type="number"
                value={adjustAmount}
                onChange={(e) => setAdjustAmount(e.target.value)}
                placeholder={t("adjustAmountPlaceholder")}
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="adjustReason">{t("adjustReasonLabel")}</Label>
              <Textarea
                id="adjustReason"
                value={adjustReason}
                onChange={(e) => setAdjustReason(e.target.value)}
                placeholder={t("adjustReasonPlaceholder")}
                rows={3}
                className="mt-1"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setAdjustTarget(null);
                setAdjustAmount("");
                setAdjustReason("");
                setAdjustType("manual");
              }}
            >
              {t("btnCancel")}
            </Button>
            <Button
              disabled={
                actionLoading ||
                !adjustAmount ||
                !adjustReason.trim() ||
                parseFloat(adjustAmount) === 0
              }
              onClick={handleAdjust}
            >
              {actionLoading ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
              ) : (
                <Plus className="h-4 w-4 mr-1.5" />
              )}
              {t("btnAdjustApply")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
