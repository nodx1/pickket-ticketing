"use client";

import { useEffect, useState, useCallback } from "react";
import { motion } from "motion/react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Loader2, Search, RotateCcw } from "lucide-react";
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
  getAdminOrders,
  adminRefundOrder,
  bulkRefundOrders,
  isApiCanceled,
  type AdminOrderItem,
} from "@pickket/lib/api";
import { formatDate, formatKRW, maskEmail } from "@pickket/lib";
import DateRangeFilter, {
  getDateRange,
  type DateRangeKey,
} from "../../components/DateRangeFilter";
import ExportButton from "../../components/ExportButton";

const STATUS_COLOR: Record<string, string> = {
  pending:
    "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
  payment_required:
    "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
  authorized:
    "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400",
  paid: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  confirmed:
    "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
  refunded:
    "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
  partially_refunded:
    "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400",
  cancelled: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
  expired: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
  deposit_held:
    "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  deposit_refunded:
    "bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400",
  deposit_forfeited:
    "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300",
};

// i18n: 모든 사용자 표시 문자열은 next-intl messages/(ko|en).json 경유.
export default function AdminOrdersPage() {
  const tCommon = useTranslations("common");
  const tActions = useTranslations("actions");
  const tTable = useTranslations("table");
  const tPage = useTranslations("pages.orders");
  const [orders, setOrders] = useState<AdminOrderItem[]>([]);
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
  const [showBulkRefundConfirm, setShowBulkRefundConfirm] = useState(false);

  // Sheet detail
  const [detailOrder, setDetailOrder] = useState<AdminOrderItem | null>(null);
  const [refundTarget, setRefundTarget] = useState<AdminOrderItem | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

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
      params.date_to = range.to.toISOString().slice(0, 10);
      const data = await getAdminOrders(
        params as Parameters<typeof getAdminOrders>[0],
      );
      setOrders(data.orders);
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

  const handleRefund = async (order: AdminOrderItem) => {
    setActionLoading(`refund-${order.id}`);
    try {
      await adminRefundOrder(order.id);
      toast.success(tPage("refundSuccess"));
      setRefundTarget(null);
      setDetailOrder(null);
      load();
    } catch {
      toast.error(tPage("refundFail"));
    } finally {
      setActionLoading(null);
    }
  };

  const handleBulkRefund = async () => {
    if (actionLoading) return; // 중복제출 방지
    setActionLoading("bulk-refund");
    try {
      const result = await bulkRefundOrders(Array.from(selected));
      toast.success(
        result.detail ||
          tPage("bulkRefundSuccess", { count: result.success_count }),
      );
      setSelected(new Set());
      load();
      setShowBulkRefundConfirm(false);
    } catch {
      toast.error(tPage("bulkRefundFail"));
    } finally {
      setActionLoading(null);
    }
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
    if (selected.size === orders.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(orders.map((o) => o.id)));
    }
  };

  const totalPages = Math.ceil(total / limit);

  const statusLabel = (s: string) =>
    tPage.has(`status.${s}`) ? tPage(`status.${s}` as never) : s;

  const exportData = orders.map((o) => ({
    [tPage("exportColumns.orderId")]: o.id,
    [tPage("exportColumns.email")]: maskEmail(o.user_email || ""),
    [tPage("exportColumns.event")]: o.event_title || o.event_id,
    [tPage("exportColumns.type")]: o.order_type,
    [tPage("exportColumns.status")]: statusLabel(o.status),
    [tPage("exportColumns.quantity")]: o.quantity,
    [tPage("exportColumns.amount")]: o.total_amount,
    [tPage("exportColumns.paymentId")]: o.payment_id || "",
    [tPage("exportColumns.date")]: o.created_at,
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
            <SelectItem value="all">{tCommon("all")}</SelectItem>
            <SelectItem value="pending">{tPage("status.pending")}</SelectItem>
            <SelectItem value="payment_required">{tPage("status.payment_required")}</SelectItem>
            <SelectItem value="authorized">{tPage("status.authorized")}</SelectItem>
            <SelectItem value="paid">{tPage("status.paid")}</SelectItem>
            <SelectItem value="confirmed">
              {tPage("status.confirmed")}
            </SelectItem>
            <SelectItem value="refunded">{tPage("status.refunded")}</SelectItem>
            <SelectItem value="partially_refunded">{tPage("status.partially_refunded")}</SelectItem>
            <SelectItem value="cancelled">
              {tPage("status.cancelled")}
            </SelectItem>
            <SelectItem value="expired">{tPage("status.expired")}</SelectItem>
            <SelectItem value="deposit_held">{tPage("status.deposit_held")}</SelectItem>
            <SelectItem value="deposit_refunded">{tPage("status.deposit_refunded")}</SelectItem>
            <SelectItem value="deposit_forfeited">{tPage("status.deposit_forfeited")}</SelectItem>
          </SelectContent>
        </Select>
        <DateRangeFilter value={dateRange} onChange={setDateRange} />
        <ExportButton data={exportData} filename="orders" />
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
              variant="destructive"
              className="rounded-full"
              onClick={() => setShowBulkRefundConfirm(true)}
            >
              <RotateCcw className="h-3.5 w-3.5 mr-1" />
              {tPage("bulkRefund")}
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
        ) : orders.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            {tPage("empty")}
          </div>
        ) : (
          <>
            <div className="hidden md:grid grid-cols-8 gap-2 px-5 py-3 text-xs font-medium text-muted-foreground border-b border-border">
              <span className="flex items-center">
                <input
                  type="checkbox"
                  checked={selected.size === orders.length && orders.length > 0}
                  onChange={toggleSelectAll}
                  className="h-3.5 w-3.5 rounded border-muted-foreground"
                />
              </span>
              <span>{tPage("columns.event")}</span>
              <span>{tPage("columns.user")}</span>
              <span>{tPage("columns.type")}</span>
              <span>{tTable("status")}</span>
              <span className="text-right">{tTable("quantity")}</span>
              <span className="text-right">{tTable("amount")}</span>
              <span className="text-right">{tTable("date")}</span>
            </div>
            <div className="divide-y divide-border">
              {orders.map((o, idx) => (
                <motion.div
                  key={o.id}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: idx * 0.02 }}
                  className="grid grid-cols-2 md:grid-cols-8 gap-2 px-5 py-3.5 text-sm items-center hover:bg-muted/50 transition-colors cursor-pointer"
                  onClick={(ev) => {
                    const target = ev.target as HTMLElement;
                    if (target.tagName === "INPUT" || target.closest("button"))
                      return;
                    setDetailOrder(o);
                  }}
                >
                  <span
                    className="flex items-center"
                    onClick={(ev) => ev.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(o.id)}
                      onChange={() => toggleSelect(o.id)}
                      className="h-3.5 w-3.5 rounded border-muted-foreground"
                    />
                  </span>
                  <span className="font-medium truncate">
                    {o.event_title || o.event_id.slice(0, 8)}
                  </span>
                  <span
                    className="text-muted-foreground truncate hidden md:block"
                    title={tPage("detail.emailTooltip")}
                  >
                    {o.user_email
                      ? maskEmail(o.user_email)
                      : o.user_name || o.user_id.slice(0, 8)}
                  </span>
                  <span className="text-muted-foreground hidden md:block">
                    {o.order_type}
                  </span>
                  <span className="hidden md:block">
                    <Badge
                      className={`rounded-full ${STATUS_COLOR[o.status] || ""}`}
                      variant="secondary"
                    >
                      {statusLabel(o.status)}
                    </Badge>
                  </span>
                  <span className="text-right hidden md:block font-tabular">
                    {o.quantity}
                  </span>
                  <span className="text-right hidden md:block font-tabular">
                    {formatKRW(o.total_amount)}
                  </span>
                  <span className="text-right hidden md:block text-xs text-muted-foreground">
                    {formatDate(o.created_at)}
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

      {/* Order Detail Sheet */}
      <Sheet
        open={!!detailOrder}
        onOpenChange={(open) => {
          if (!open) setDetailOrder(null);
        }}
      >
        <SheetContent className="overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{tPage("detail.title")}</SheetTitle>
            <SheetDescription>{tPage("detail.description")}</SheetDescription>
          </SheetHeader>
          {detailOrder && (
            <div className="space-y-4 mt-6 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">
                  {tPage("detail.orderId")}
                </span>
                <span className="font-mono text-xs truncate max-w-[200px]">
                  {detailOrder.id}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">
                  {tPage("detail.event")}
                </span>
                <span className="truncate max-w-[200px]">
                  {detailOrder.event_title || detailOrder.event_id}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">
                  {tPage("detail.user")}
                </span>
                <span>
                  {detailOrder.user_email
                    ? maskEmail(detailOrder.user_email)
                    : detailOrder.user_name || detailOrder.user_id}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">
                  {tPage("detail.orderType")}
                </span>
                <span>{detailOrder.order_type}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">
                  {tPage("detail.status")}
                </span>
                <Badge
                  className={`rounded-full ${STATUS_COLOR[detailOrder.status] || ""}`}
                  variant="secondary"
                >
                  {statusLabel(detailOrder.status)}
                </Badge>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">
                  {tPage("detail.quantity")}
                </span>
                <span className="font-tabular">{detailOrder.quantity}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">
                  {tPage("detail.amount")}
                </span>
                <span className="font-tabular">
                  {formatKRW(detailOrder.total_amount)}
                </span>
              </div>
              {detailOrder.payment_id && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">
                    {tPage("detail.paymentId")}
                  </span>
                  <span className="font-mono text-xs truncate max-w-[200px]">
                    {detailOrder.payment_id}
                  </span>
                </div>
              )}
              {detailOrder.pg_transaction_id && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">
                    {tPage("detail.pgTransactionId")}
                  </span>
                  <span className="font-mono text-xs truncate max-w-[200px]">
                    {detailOrder.pg_transaction_id}
                  </span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-muted-foreground">
                  {tPage("detail.date")}
                </span>
                <span>{formatDate(detailOrder.created_at)}</span>
              </div>

              {detailOrder.status !== "refunded" &&
                detailOrder.status !== "partially_refunded" &&
                detailOrder.status !== "cancelled" &&
                detailOrder.status !== "expired" && (
                  <div className="pt-4 border-t border-border">
                    <Button
                      variant="destructive"
                      size="sm"
                      className="rounded-full w-full"
                      disabled={actionLoading === `refund-${detailOrder.id}`}
                      onClick={() => setRefundTarget(detailOrder)}
                    >
                      {actionLoading === `refund-${detailOrder.id}` ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                      ) : (
                        <RotateCcw className="h-3.5 w-3.5 mr-1" />
                      )}
                      {tPage("refundAction")}
                    </Button>
                  </div>
                )}
            </div>
          )}
        </SheetContent>
      </Sheet>

      {/* Bulk Refund Confirm Dialog */}
      <AlertDialog
        open={showBulkRefundConfirm}
        onOpenChange={setShowBulkRefundConfirm}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tPage("bulkRefundTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {tPage("bulkRefundDescription", { count: selected.size })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionLoading === "bulk-refund"}>{tActions("cancel")}</AlertDialogCancel>
            <AlertDialogAction disabled={actionLoading === "bulk-refund"} onClick={handleBulkRefund}>
              {tPage("refundConfirmAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Refund Confirm */}
      <AlertDialog
        open={!!refundTarget}
        onOpenChange={(open) => !open && setRefundTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tPage("refundConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {tPage("refundConfirmDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tActions("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (refundTarget) handleRefund(refundTarget);
              }}
            >
              {tPage("refundConfirmAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
