"use client";

import { useEffect, useState, useCallback } from "react";
import { motion } from "motion/react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Loader2, Search, CheckCircle, XCircle } from "lucide-react";
import {
  Button,
  Badge,
  Input,
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
} from "@pickket/ui";
import {
  getAdminPendingRefunds,
  approveRefund,
  rejectRefund,
  isApiCanceled,
  type AdminRefundItem,
} from "@pickket/lib/api";
import { formatDate, formatKRW } from "@pickket/lib";
import DateRangeFilter, {
  getDateRange,
  type DateRangeKey,
} from "../../components/DateRangeFilter";
import ExportButton from "../../components/ExportButton";

const STATUS_COLOR: Record<string, string> = {
  pending:
    "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
  approved:
    "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
  processing:
    "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  completed:
    "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  failed: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
  rejected: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
};

// i18n: 모든 사용자 표시 문자열은 next-intl messages/(ko|en).json 경유.
export default function AdminRefundsPage() {
  const tCommon = useTranslations("common");
  const tActions = useTranslations("actions");
  const tPage = useTranslations("pages.refunds");
  const [refunds, setRefunds] = useState<AdminRefundItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [dateRange, setDateRange] = useState<DateRangeKey>("all");
  const [skip, setSkip] = useState(0);
  const limit = 50;

  // Bulk
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showBulkApproveConfirm, setShowBulkApproveConfirm] = useState(false);
  const [showBulkRejectConfirm, setShowBulkRejectConfirm] = useState(false);
  const [bulkRejectReason, setBulkRejectReason] = useState("");

  // Sheet detail
  const [detailRefund, setDetailRefund] = useState<AdminRefundItem | null>(
    null,
  );

  // Single reject
  const [rejectTarget, setRejectTarget] = useState<AdminRefundItem | null>(
    null,
  );
  const [rejectReason, setRejectReason] = useState("");
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  // 일괄 승인 중복제출 방지 (P2-C7) — 인플라이트 중 재클릭 차단
  const [bulkActionLoading, setBulkActionLoading] = useState(false);

  // Single approve confirm (H14 보강)
  const [approveTarget, setApproveTarget] = useState<AdminRefundItem | null>(
    null,
  );

  const statusLabel = (s: string) =>
    tPage.has(`status.${s}`) ? tPage(`status.${s}` as never) : s;
  const refundTypeLabel = (t: string) =>
    tPage.has(`refundType.${t}`) ? tPage(`refundType.${t}` as never) : t;

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    setSkip(0);
  }, [debouncedSearch, statusFilter, dateRange]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const range = getDateRange(dateRange);
      const params: Record<string, unknown> = { skip, limit };
      if (debouncedSearch) params.q = debouncedSearch;
      if (statusFilter !== "all") params.status = statusFilter;
      if (range.from) params.date_from = range.from.toISOString().slice(0, 10);
      // date_to 는 inclusive 하루 끝 (23:59:59) 기준으로 보내야 오늘 만든 환불도 포함됨
      const endOfDay = new Date(range.to);
      endOfDay.setHours(23, 59, 59, 999);
      params.date_to = endOfDay.toISOString();
      const data = await getAdminPendingRefunds(
        params as Parameters<typeof getAdminPendingRefunds>[0],
      );
      setRefunds(data.refunds);
      setTotal(data.total);
    } catch (err) {
      if (isApiCanceled(err)) return;
      toast.error(tPage("loadError"));
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, statusFilter, dateRange, skip, tPage]);

  useEffect(() => {
    load();
  }, [load]);

  const handleApprove = async (refund: AdminRefundItem) => {
    setActionLoading(`approve-${refund.refund_id}`);
    try {
      await approveRefund(refund.refund_id);
      toast.success(tPage("approveSuccess"));
      setDetailRefund(null);
      load();
    } catch {
      toast.error(tPage("approveFail"));
    } finally {
      setActionLoading(null);
    }
  };

  const handleReject = async () => {
    if (!rejectTarget || !rejectReason.trim()) return;
    setActionLoading(`reject-${rejectTarget.refund_id}`);
    try {
      await rejectRefund(rejectTarget.refund_id, rejectReason.trim());
      toast.success(tPage("rejectSuccess"));
      setRejectTarget(null);
      setRejectReason("");
      setDetailRefund(null);
      load();
    } catch {
      toast.error(tPage("rejectFail"));
    } finally {
      setActionLoading(null);
    }
  };

  const handleBulkApprove = async () => {
    if (bulkActionLoading) return; // 동기 가드: 인플라이트 중 재진입 차단
    setBulkActionLoading(true);
    try {
      const ids = Array.from(selected);
      const results = await Promise.allSettled(
        ids.map((id) => approveRefund(id)),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      const succeeded = ids.length - failed;
      if (succeeded > 0)
        toast.success(tPage("bulkApproveSuccess", { count: succeeded }));
      if (failed > 0) toast.error(tPage("bulkApproveFail", { count: failed }));
      setSelected(new Set());
      setShowBulkApproveConfirm(false);
      load();
    } finally {
      setBulkActionLoading(false);
    }
  };

  const handleBulkReject = async () => {
    if (!bulkRejectReason.trim()) return;
    const ids = Array.from(selected);
    const results = await Promise.allSettled(
      ids.map((id) => rejectRefund(id, bulkRejectReason.trim())),
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    const succeeded = ids.length - failed;
    if (succeeded > 0)
      toast.success(tPage("bulkRejectSuccess", { count: succeeded }));
    if (failed > 0) toast.error(tPage("bulkRejectFail", { count: failed }));
    setSelected(new Set());
    setBulkRejectReason("");
    setShowBulkRejectConfirm(false);
    load();
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selected.size === refunds.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(refunds.map((r) => r.refund_id)));
    }
  };

  const totalPages = Math.ceil(total / limit);

  const exportData = refunds.map((r) => ({
    [tPage("exportColumns.refundId")]: r.refund_id,
    [tPage("exportColumns.orderId")]: r.order_id,
    [tPage("exportColumns.type")]: refundTypeLabel(r.refund_type),
    [tPage("exportColumns.amount")]: r.amount,
    [tPage("exportColumns.currency")]: r.currency,
    [tPage("exportColumns.reason")]: r.reason,
    [tPage("exportColumns.requester")]: r.initiated_by,
    [tPage("exportColumns.requestedAt")]: r.requested_at,
    [tPage("exportColumns.status")]: statusLabel(r.status),
  }));

  return (
    <div className="space-y-5 p-4 md:p-6">
      <h1 className="sr-only">{tPage("title")}</h1>

      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={tPage("searchPlaceholder")}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="pl-9 rounded-full"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[140px] rounded-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{tPage("filterAllStatus")}</SelectItem>
            <SelectItem value="pending">{tPage("filterPending")}</SelectItem>
            <SelectItem value="approved">{tPage("filterApproved")}</SelectItem>
            <SelectItem value="rejected">{tPage("filterRejected")}</SelectItem>
          </SelectContent>
        </Select>
        <DateRangeFilter value={dateRange} onChange={setDateRange} />
        <ExportButton data={exportData} filename="refunds" />
      </div>

      {/* Bulk Action Bar */}
      {selected.size > 0 && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-4 py-2.5"
        >
          <span className="text-sm font-medium">
            {tCommon("selectedCount", { count: selected.size })}
          </span>
          <div className="flex gap-2 ml-auto">
            <Button
              size="sm"
              variant="default"
              className="rounded-full"
              onClick={() => setShowBulkApproveConfirm(true)}
            >
              <CheckCircle className="h-3.5 w-3.5 mr-1" />
              {tPage("bulkApprove")}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              className="rounded-full"
              onClick={() => setShowBulkRejectConfirm(true)}
            >
              <XCircle className="h-3.5 w-3.5 mr-1" />
              {tPage("bulkReject")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="rounded-full"
              onClick={() => setSelected(new Set())}
            >
              {tActions("deselect")}
            </Button>
          </div>
        </motion.div>
      )}

      <div className="rounded-lg border border-border bg-card">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : refunds.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            {tPage("empty")}
          </div>
        ) : (
          <>
            <div className="hidden md:grid grid-cols-9 gap-2 px-5 py-3 text-xs font-medium text-muted-foreground border-b border-border">
              <span className="flex items-center">
                <input
                  type="checkbox"
                  checked={
                    selected.size === refunds.length && refunds.length > 0
                  }
                  onChange={toggleSelectAll}
                  className="h-3.5 w-3.5 rounded border-muted-foreground"
                />
              </span>
              <span>{tPage("columns.refundId")}</span>
              <span>{tPage("columns.orderId")}</span>
              <span>{tPage("columns.type")}</span>
              <span className="text-right">{tPage("columns.amount")}</span>
              <span>{tPage("columns.reason")}</span>
              <span>{tPage("columns.requester")}</span>
              <span>{tPage("columns.requestedAt")}</span>
              <span>{tPage("columns.status")}</span>
            </div>
            <div className="divide-y divide-border">
              {refunds.map((r, idx) => (
                <motion.div
                  key={r.refund_id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: idx * 0.02 }}
                  className="grid grid-cols-2 md:grid-cols-9 gap-2 px-5 py-3.5 text-sm items-center hover:bg-muted/50 transition-colors cursor-pointer"
                  onClick={(ev) => {
                    const target = ev.target as HTMLElement;
                    if (target.tagName === "INPUT" || target.closest("button"))
                      return;
                    setDetailRefund(r);
                  }}
                >
                  <span
                    className="flex items-center"
                    onClick={(ev) => ev.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(r.refund_id)}
                      onChange={() => toggleSelect(r.refund_id)}
                      className="h-3.5 w-3.5 rounded border-muted-foreground"
                    />
                  </span>
                  <span className="font-mono text-xs truncate">
                    {r.refund_id.slice(0, 8)}
                  </span>
                  <span className="font-mono text-xs truncate hidden md:block">
                    {r.order_id.slice(0, 8)}
                  </span>
                  <span className="hidden md:block">
                    <Badge variant="secondary" className="rounded-full text-xs">
                      {refundTypeLabel(r.refund_type)}
                    </Badge>
                  </span>
                  <span className="text-right hidden md:block font-tabular">
                    {formatKRW(r.amount)}
                  </span>
                  <span className="text-muted-foreground truncate hidden md:block">
                    {r.reason}
                  </span>
                  <span className="text-muted-foreground truncate hidden md:block">
                    {r.initiated_by}
                  </span>
                  <span className="text-right hidden md:block text-xs text-muted-foreground">
                    {formatDate(r.requested_at)}
                  </span>
                  <span className="hidden md:block">
                    <Badge
                      className={`rounded-full ${STATUS_COLOR[r.status] || ""}`}
                      variant="secondary"
                    >
                      {statusLabel(r.status)}
                    </Badge>
                  </span>
                </motion.div>
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
                  {tCommon("prev")}
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
                  {tCommon("next")}
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Refund Detail Sheet */}
      <Sheet
        open={!!detailRefund}
        onOpenChange={(open) => {
          if (!open) setDetailRefund(null);
        }}
      >
        <SheetContent className="overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{tPage("detail.title")}</SheetTitle>
            <SheetDescription>{tPage("detail.description")}</SheetDescription>
          </SheetHeader>
          {detailRefund && (
            <div className="space-y-4 mt-6 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">
                  {tPage("detail.refundId")}
                </span>
                <span className="font-mono text-xs truncate max-w-[200px]">
                  {detailRefund.refund_id}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">
                  {tPage("detail.orderId")}
                </span>
                <span className="font-mono text-xs truncate max-w-[200px]">
                  {detailRefund.order_id}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">
                  {tPage("detail.type")}
                </span>
                <span>{refundTypeLabel(detailRefund.refund_type)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">
                  {tPage("detail.status")}
                </span>
                <Badge
                  className={`rounded-full ${STATUS_COLOR[detailRefund.status] || ""}`}
                  variant="secondary"
                >
                  {statusLabel(detailRefund.status)}
                </Badge>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">
                  {tPage("detail.amount")}
                </span>
                <span className="font-tabular">
                  {detailRefund.original_amount != null ? (
                    <>
                      {formatKRW(detailRefund.amount)} /{" "}
                      {formatKRW(detailRefund.original_amount)}{" "}
                      <span className="text-xs text-muted-foreground">
                        (
                        {detailRefund.amount >= detailRefund.original_amount
                          ? "전체 환불"
                          : "부분 환불"}
                        )
                      </span>
                    </>
                  ) : (
                    <>
                      {formatKRW(detailRefund.amount)} {detailRefund.currency}
                    </>
                  )}
                </span>
              </div>
              {detailRefund.original_amount != null && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">원주문 총액</span>
                  <span className="font-tabular">
                    {formatKRW(detailRefund.original_amount)}
                  </span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-muted-foreground">
                  {tPage("detail.reason")}
                </span>
                <span className="text-right max-w-[200px]">
                  {detailRefund.reason}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">
                  {tPage("detail.requester")}
                </span>
                <span>{detailRefund.initiated_by}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">
                  {tPage("detail.requestedAt")}
                </span>
                <span>{formatDate(detailRefund.requested_at)}</span>
              </div>

              {/* Ticket IDs */}
              {detailRefund.ticket_ids.length > 0 && (
                <div className="pt-4 border-t border-border space-y-2">
                  <span className="text-xs font-medium text-muted-foreground">
                    {tPage("detail.relatedTickets", {
                      count: detailRefund.ticket_ids.length,
                    })}
                  </span>
                  <div className="space-y-1">
                    {detailRefund.ticket_ids.map((tid) => (
                      <div
                        key={tid}
                        className="rounded-md bg-muted px-3 py-1.5 font-mono text-xs truncate"
                      >
                        {tid}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Timeline */}
              <div className="pt-4 border-t border-border space-y-3">
                <span className="text-xs font-medium text-muted-foreground">
                  {tPage("detail.timeline")}
                </span>
                <div className="relative pl-4 border-l-2 border-border space-y-3">
                  <div className="relative">
                    <div className="absolute -left-[calc(0.5rem+1px)] top-1 h-2 w-2 rounded-full bg-yellow-500" />
                    <div className="text-xs">
                      <span className="font-medium">
                        {tPage("detail.timelineRequested")}
                      </span>
                      <span className="text-muted-foreground ml-2">
                        {formatDate(detailRefund.requested_at)}
                      </span>
                    </div>
                  </div>
                  {detailRefund.status !== "pending" && (
                    <div className="relative">
                      <div
                        className={`absolute -left-[calc(0.5rem+1px)] top-1 h-2 w-2 rounded-full ${detailRefund.status === "rejected" || detailRefund.status === "failed" ? "bg-red-500" : "bg-green-500"}`}
                      />
                      <div className="text-xs">
                        <span className="font-medium">
                          {statusLabel(detailRefund.status)}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Actions */}
              {detailRefund.status === "pending" && (
                <div className="pt-4 border-t border-border flex gap-2">
                  <Button
                    variant="default"
                    size="sm"
                    className="rounded-full flex-1"
                    disabled={
                      actionLoading === `approve-${detailRefund.refund_id}`
                    }
                    onClick={() => setApproveTarget(detailRefund)}
                  >
                    {actionLoading === `approve-${detailRefund.refund_id}` ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                    ) : (
                      <CheckCircle className="h-3.5 w-3.5 mr-1" />
                    )}
                    {tPage("approveAction")}
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="rounded-full flex-1"
                    onClick={() => {
                      setRejectTarget(detailRefund);
                      setRejectReason("");
                    }}
                  >
                    <XCircle className="h-3.5 w-3.5 mr-1" />
                    {tPage("rejectAction")}
                  </Button>
                </div>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>

      {/* Bulk Approve Confirm Dialog */}
      <AlertDialog
        open={showBulkApproveConfirm}
        onOpenChange={setShowBulkApproveConfirm}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tPage("bulkApproveTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {tPage("bulkApproveDescription", { count: selected.size })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tActions("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleBulkApprove}
              disabled={bulkActionLoading}
            >
              {tPage("bulkApproveConfirmAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk Reject Dialog (with reason) */}
      <AlertDialog
        open={showBulkRejectConfirm}
        onOpenChange={(open) => {
          if (!open) {
            setShowBulkRejectConfirm(false);
            setBulkRejectReason("");
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tPage("bulkRejectTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {tPage("bulkRejectDescription", { count: selected.size })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <textarea
            value={bulkRejectReason}
            onChange={(e) => setBulkRejectReason(e.target.value)}
            placeholder={tPage("rejectReasonPlaceholder")}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm min-h-[80px] resize-none focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setBulkRejectReason("")}>
              {tActions("cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleBulkReject}
              disabled={!bulkRejectReason.trim()}
            >
              {tPage("bulkRejectConfirmAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Single Approve Confirm Dialog (H14 보강) */}
      <AlertDialog
        open={!!approveTarget}
        onOpenChange={(open) => {
          if (!open) setApproveTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tPage("singleApproveTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {tPage("singleApproveDescription")}
              {approveTarget && (
                <>
                  <br />
                  <span className="mt-2 inline-block text-foreground font-medium">
                    {tPage("singleApproveAmountLabel", {
                      amount: formatKRW(approveTarget.amount),
                      currency: approveTarget.currency,
                    })}
                  </span>
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tActions("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const target = approveTarget;
                setApproveTarget(null);
                if (target) handleApprove(target);
              }}
            >
              {tPage("singleApproveConfirmAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Single Reject Dialog (with reason) */}
      <AlertDialog
        open={!!rejectTarget}
        onOpenChange={(open) => {
          if (!open) {
            setRejectTarget(null);
            setRejectReason("");
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tPage("singleRejectTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {tPage("singleRejectDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder={tPage("rejectReasonPlaceholder")}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm min-h-[80px] resize-none focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setRejectReason("")}>
              {tActions("cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleReject}
              disabled={!rejectReason.trim()}
            >
              {tPage("singleRejectConfirmAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
