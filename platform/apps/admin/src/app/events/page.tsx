"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState, useCallback } from "react";
import { motion } from "motion/react";
import { toast } from "sonner";
import {
  Loader2,
  Star,
  XCircle,
  Search,
  CheckCircle,
  RotateCcw,
  ArrowLeft,
} from "lucide-react";
import {
  Button,
  Badge,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Separator,
  Textarea,
} from "@pickket/ui";
import {
  getAdminEvents,
  getEvent,
  toggleEventFeatured,
  adminCancelEvent,
  adminReviewEvent,
  bulkCancelEvents,
  bulkFeatureEvents,
  bulkReviewEvents,
  isApiCanceled,
  type AdminEvent,
} from "@pickket/lib/api";
import { CATEGORIES, getCategoryBySlug, formatDate } from "@pickket/lib";
import {
  EventDetailView,
  Section,
  type EventDetail,
} from "./_components/EventDetailView";

const STATUS_KEYS: Record<string, string> = {
  draft: "statusDraft",
  pending_review: "statusPendingReview",
  under_review: "statusUnderReview",
  approved: "statusApproved",
  bidding_open: "statusBiddingOpen",
  bidding_closed: "statusBiddingClosed",
  allocating: "statusAllocating",
  allocated: "statusAllocated",
  completed: "statusCompleted",
  cancelled: "statusCancelled",
  revision_requested: "statusRevisionRequested",
};

export default function AdminEventsPage() {
  const t = useTranslations("event.adminList");
  const [events, setEvents] = useState<AdminEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<AdminEvent | null>(null);
  const [skip, setSkip] = useState(0);
  const limit = 50;

  // Bulk selection
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showBulkCancelConfirm, setShowBulkCancelConfirm] = useState(false);
  const [showBulkRejectConfirm, setShowBulkRejectConfirm] = useState(false);

  // 풀 페이지 detail
  const [detailEvent, setDetailEvent] = useState<AdminEvent | null>(null);
  const [detailData, setDetailData] = useState<EventDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [reviewComment, setReviewComment] = useState("");

  const openDetail = async (event: AdminEvent) => {
    setDetailEvent(event);
    setDetailLoading(true);
    try {
      const res = await getEvent(event.id);
      setDetailData(res.data);
    } catch {
      setDetailData(null);
      toast.error(t("toastDetailLoadFail"));
    } finally {
      setDetailLoading(false);
    }
  };

  const backToList = () => {
    setDetailEvent(null);
    setDetailData(null);
    setReviewComment("");
  };

  // Debounce
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    setSkip(0);
  }, [debouncedSearch]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, unknown> = { skip, limit };
      if (statusFilter !== "all") params.status = statusFilter;
      if (categoryFilter !== "all") params.category = categoryFilter;
      if (debouncedSearch) params.q = debouncedSearch;
      const data = await getAdminEvents(
        params as Parameters<typeof getAdminEvents>[0],
      );
      setEvents(data.events);
      setTotal(data.total);
    } catch (err) {
      if (isApiCanceled(err)) return;
      toast.error(t("toastListLoadFail"));
    } finally {
      setLoading(false);
    }
  }, [statusFilter, categoryFilter, skip, debouncedSearch]);

  useEffect(() => {
    load();
  }, [load]);

  const handleFeature = async (e: AdminEvent) => {
    setActionLoading(`feature-${e.id}`);
    try {
      await toggleEventFeatured(e.id);
      toast.success(t(e.is_featured ? "toastFeatureRemoved" : "toastFeatureSet", { title: e.title ?? "" }));
      load();
    } catch {
      toast.error(t("toastFeatureFail"));
    } finally {
      setActionLoading(null);
    }
  };

  const handleCancel = async (e: AdminEvent) => {
    setActionLoading(`cancel-${e.id}`);
    try {
      await adminCancelEvent(e.id);
      toast.success(t("toastCancelSuccess"));
      load();
    } catch {
      toast.error(t("toastCancelFail"));
    } finally {
      setActionLoading(null);
    }
  };

  const handleReview = async (eventId: string, action: string) => {
    setActionLoading(`review-${eventId}`);
    try {
      await adminReviewEvent(eventId, action, reviewComment || undefined);
      toast.success(
        t(
          action === "approve"
            ? "toastReviewApproved"
            : action === "reject"
              ? "toastReviewRejected"
              : "toastReviewRevisionRequested",
        ),
      );
      backToList();
      load();
    } catch {
      toast.error(t("toastReviewFail"));
    } finally {
      setActionLoading(null);
    }
  };

  // Bulk actions
  const handleBulkFeature = async (featured: boolean) => {
    try {
      const result = await bulkFeatureEvents(Array.from(selected), featured);
      toast.success(result.detail || t("toastBulkDone", { count: result.success_count ?? 0 }));
      setSelected(new Set());
      load();
    } catch {
      toast.error(t("toastBulkFeatureFail"));
    }
  };

  const handleBulkCancel = async () => {
    try {
      const result = await bulkCancelEvents(Array.from(selected));
      toast.success(result.detail || t("toastBulkCancelDone", { count: result.success_count ?? 0 }));
      setSelected(new Set());
      load();
      setShowBulkCancelConfirm(false);
    } catch {
      toast.error(t("toastBulkCancelFail"));
    }
  };

  const handleBulkReview = async (action: string) => {
    try {
      const result = await bulkReviewEvents(Array.from(selected), action);
      toast.success(result.detail || t("toastBulkDone", { count: result.success_count ?? 0 }));
      setSelected(new Set());
      load();
    } catch {
      toast.error(t("toastBulkReviewFail"));
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
    if (selected.size === events.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(events.map((e) => e.id)));
    }
  };

  const totalPages = Math.ceil(total / limit);

  /* ── DETAIL VIEW (events 심사 상세와 동일한 풀 페이지 패턴) ── */
  if (detailEvent) {
    const isReviewable =
      detailEvent.status === "pending_review" ||
      detailEvent.status === "under_review" ||
      detailEvent.status === "draft";
    return (
      <div className="space-y-6 p-6 lg:p-10">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={backToList}
            className="gap-1.5"
          >
            <ArrowLeft className="h-4 w-4" />
            {t("backToList")}
          </Button>
          <Separator orientation="vertical" className="h-5" />
          <Badge variant="secondary" className="text-xs px-2.5 py-1">
            {STATUS_KEYS[detailEvent.status] ? t(STATUS_KEYS[detailEvent.status]) : detailEvent.status}
          </Badge>
        </div>

        {detailLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <EventDetailView
            selectedEvent={detailEvent}
            detail={detailData}
            rightPanel={
              <div className="rounded-2xl border border-border/50 bg-background px-6 py-7 shadow-sm sticky top-6">
                <Section title={t("sectionOps")}>
                  <div className="text-xs text-muted-foreground space-y-1.5 mb-5 px-1">
                    <p>ID: {detailEvent.id}</p>
                    <p>
                      {t("detailBidCount", { count: detailEvent.bid_count?.toLocaleString() ?? 0 })}
                    </p>
                    <p>{t("detailCreatedAt", { date: formatDate(detailEvent.created_at) ?? "" })}</p>
                    <p>{t("detailFeatured", { value: detailEvent.is_featured ? t("yes") : t("no") })}</p>
                  </div>

                  {isReviewable && (
                    <div className="space-y-3 pb-4 border-b border-border mb-4">
                      <p className="text-xs font-semibold text-muted-foreground">
                        {t("sectionReview")}
                      </p>
                      <Textarea
                        placeholder={t("reviewCommentPlaceholder")}
                        value={reviewComment}
                        onChange={(e) => setReviewComment(e.target.value)}
                        rows={3}
                      />
                      <div className="grid grid-cols-3 gap-2">
                        <Button
                          size="sm"
                          className="bg-green-600 hover:bg-green-700 text-white"
                          disabled={!!actionLoading}
                          onClick={() =>
                            handleReview(detailEvent.id, "approve")
                          }
                        >
                          {actionLoading === `review-${detailEvent.id}` ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <CheckCircle className="h-3.5 w-3.5" />
                          )}
                          <span className="ml-1">{t("actionApprove")}</span>
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="border-red-300 text-red-600"
                          disabled={!!actionLoading}
                          onClick={() => handleReview(detailEvent.id, "reject")}
                        >
                          <XCircle className="h-3.5 w-3.5" />
                          <span className="ml-1">{t("actionReject")}</span>
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!!actionLoading}
                          onClick={() =>
                            handleReview(detailEvent.id, "revision_requested")
                          }
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                          <span className="ml-1">{t("actionRevision")}</span>
                        </Button>
                      </div>
                    </div>
                  )}

                  <div className="space-y-2">
                    <Button
                      variant="outline"
                      className="w-full"
                      onClick={() => handleFeature(detailEvent)}
                      disabled={actionLoading === `feature-${detailEvent.id}`}
                    >
                      {actionLoading === `feature-${detailEvent.id}` ? (
                        <Loader2 className="h-4 w-4 animate-spin mr-2" />
                      ) : (
                        <Star
                          className={`h-4 w-4 mr-2 ${
                            detailEvent.is_featured
                              ? "fill-amber-500 text-amber-500"
                              : ""
                          }`}
                        />
                      )}
                      {detailEvent.is_featured ? t("featureRemove") : t("featureSet")}
                    </Button>
                    {detailEvent.status !== "cancelled" && (
                      <Button
                        variant="outline"
                        className="w-full border-red-300 text-red-600"
                        onClick={() => setCancelTarget(detailEvent)}
                        disabled={!!actionLoading}
                      >
                        <XCircle className="h-4 w-4 mr-2" />
                        {t("actionCancelEvent")}
                      </Button>
                    )}
                  </div>
                </Section>
              </div>
            }
          />
        )}

        {/* Cancel dialog (detail에서도 사용) */}
        <AlertDialog
          open={!!cancelTarget}
          onOpenChange={(open) => !open && setCancelTarget(null)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("dialogCancelTitle")}</AlertDialogTitle>
              <AlertDialogDescription>
                &quot;{cancelTarget?.title}&quot; {t("dialogCancelDetailDesc")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("btnCancel")}</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  if (cancelTarget) handleCancel(cancelTarget);
                  setCancelTarget(null);
                  backToList();
                }}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {t("btnConfirmCancel")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    );
  }

  return (
    <div className="space-y-5 p-4 md:p-6">
      <h1 className="sr-only">{t("pageTitle")}</h1>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t("searchPlaceholder")}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="pl-9 rounded-full"
          />
        </div>
        <Select
          value={statusFilter}
          onValueChange={(v) => {
            setStatusFilter(v);
            setSkip(0);
          }}
        >
          <SelectTrigger className="w-[140px] rounded-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("filterStatusAll")}</SelectItem>
            <SelectItem value="draft">{t("statusDraft")}</SelectItem>
            <SelectItem value="pending_review">{t("statusPendingReview")}</SelectItem>
            <SelectItem value="bidding_open">{t("statusBiddingOpen")}</SelectItem>
            <SelectItem value="bidding_closed">{t("statusBiddingClosed")}</SelectItem>
            <SelectItem value="allocated">{t("statusAllocated")}</SelectItem>
            <SelectItem value="completed">{t("statusCompleted")}</SelectItem>
            <SelectItem value="cancelled">{t("statusCancelled")}</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={categoryFilter}
          onValueChange={(v) => {
            setCategoryFilter(v);
            setSkip(0);
          }}
        >
          <SelectTrigger className="w-[140px] rounded-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("filterCategoryAll")}</SelectItem>
            {CATEGORIES.map((cat) => (
              <SelectItem key={cat.slug} value={cat.slug}>
                {cat.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Bulk Action Bar */}
      {selected.size > 0 && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-4 py-2.5"
        >
          <span className="text-sm font-medium">{t("selectedCount", { count: selected.size })}</span>
          <div className="flex gap-2 ml-auto">
            <Button
              size="sm"
              variant="outline"
              className="rounded-full"
              onClick={() => handleBulkFeature(true)}
            >
              <Star className="h-3.5 w-3.5 mr-1" />
              {t("bulkFeature")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="rounded-full"
              onClick={() => handleBulkReview("approve")}
            >
              <CheckCircle className="h-3.5 w-3.5 mr-1" />
              {t("bulkApprove")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="rounded-full"
              onClick={() => setShowBulkRejectConfirm(true)}
            >
              <XCircle className="h-3.5 w-3.5 mr-1" />
              {t("bulkReject")}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              className="rounded-full"
              onClick={() => setShowBulkCancelConfirm(true)}
            >
              <XCircle className="h-3.5 w-3.5 mr-1" />
              {t("bulkCancel")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="rounded-full"
              onClick={() => setSelected(new Set())}
            >
              {t("deselectAll")}
            </Button>
          </div>
        </motion.div>
      )}

      <div className="rounded-lg border border-border bg-card">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : events.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            {t("emptyEvents")}
          </div>
        ) : (
          <>
            <div className="hidden md:grid grid-cols-9 gap-2 px-5 py-3 text-xs font-medium text-muted-foreground border-b border-border">
              <span className="flex items-center">
                <input
                  type="checkbox"
                  checked={selected.size === events.length && events.length > 0}
                  onChange={toggleSelectAll}
                  aria-label={t("ariaSelectAll")}
                  className="h-3.5 w-3.5 rounded border-muted-foreground"
                />
              </span>
              <span className="col-span-2">{t("colTitle")}</span>
              <span>{t("colCategory")}</span>
              <span>{t("colStatus")}</span>
              <span className="text-right">{t("colSeats")}</span>
              <span className="text-right">{t("colBids")}</span>
              <span className="text-right">{t("colDate")}</span>
              <span className="text-right">{t("colActions")}</span>
            </div>
            <div className="divide-y divide-border">
              {events.map((e, idx) => (
                <motion.div
                  key={e.id}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: idx * 0.02 }}
                  className="grid grid-cols-2 md:grid-cols-9 gap-2 px-5 py-3.5 text-sm items-center hover:bg-muted/50 transition-colors cursor-pointer"
                  onClick={(ev) => {
                    const target = ev.target as HTMLElement;
                    if (target.tagName === "INPUT" || target.closest("button"))
                      return;
                    openDetail(e);
                  }}
                >
                  <span
                    className="flex items-center"
                    onClick={(ev) => ev.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(e.id)}
                      onChange={() => toggleSelect(e.id)}
                      aria-label={t("ariaSelectEvent", { title: e.title ?? "" })}
                      className="h-3.5 w-3.5 rounded border-muted-foreground"
                    />
                  </span>
                  <span className="col-span-2 font-medium truncate flex items-center gap-1.5">
                    {e.is_featured && (
                      <Star className="h-3.5 w-3.5 text-amber-500 fill-amber-500 shrink-0" />
                    )}
                    {e.title}
                  </span>
                  <span className="hidden md:block text-muted-foreground">
                    {getCategoryBySlug(e.category)?.label ?? e.category}
                  </span>
                  <span className="hidden md:block">
                    <Badge className="rounded-full" variant="secondary">
                      {STATUS_KEYS[e.status] ? t(STATUS_KEYS[e.status]) : e.status}
                    </Badge>
                  </span>
                  <span className="text-right hidden md:block font-tabular">
                    {e.total_seats.toLocaleString()}
                  </span>
                  <span className="text-right hidden md:block font-tabular">
                    {e.bid_count.toLocaleString()}
                  </span>
                  <span className="text-right hidden md:block text-xs text-muted-foreground">
                    {formatDate(e.event_date)}
                  </span>
                  <span
                    className="text-right flex gap-1 justify-end"
                    onClick={(ev) => ev.stopPropagation()}
                  >
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9"
                      aria-label={e.is_featured ? t("ariaFeatureRemove", { title: e.title ?? "" }) : t("ariaFeatureSet", { title: e.title ?? "" })}
                      disabled={
                        e.status === "cancelled" ||
                        actionLoading === `feature-${e.id}`
                      }
                      onClick={() => handleFeature(e)}
                    >
                      {actionLoading === `feature-${e.id}` ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Star
                          className={`h-4 w-4 ${e.is_featured ? "text-amber-500 fill-amber-500" : "text-muted-foreground"}`}
                        />
                      )}
                    </Button>
                    {e.status !== "cancelled" && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9"
                        aria-label={t("ariaCancelEvent", { title: e.title ?? "" })}
                        disabled={actionLoading === `cancel-${e.id}`}
                        onClick={() => setCancelTarget(e)}
                      >
                        {actionLoading === `cancel-${e.id}` ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <XCircle className="h-4 w-4 text-red-500" />
                        )}
                      </Button>
                    )}
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
                  {t("btnPrev")}
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
                  {t("btnNext")}
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Bulk Cancel Confirm Dialog */}
      <AlertDialog
        open={showBulkCancelConfirm}
        onOpenChange={setShowBulkCancelConfirm}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("dialogBulkCancelTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("dialogBulkCancelDesc", { count: selected.size })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("btnCancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleBulkCancel}>
              {t("btnConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk Reject Confirm Dialog */}
      <AlertDialog
        open={showBulkRejectConfirm}
        onOpenChange={setShowBulkRejectConfirm}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("dialogBulkRejectTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("dialogBulkRejectDesc", { count: selected.size })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("btnCancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                handleBulkReview("reject");
                setShowBulkRejectConfirm(false);
              }}
            >
              {t("btnConfirmReject")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Cancel Confirm Dialog */}
      <AlertDialog
        open={!!cancelTarget}
        onOpenChange={(open) => !open && setCancelTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("dialogCancelTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("dialogCancelDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("btnCancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (cancelTarget) handleCancel(cancelTarget);
                setCancelTarget(null);
              }}
            >
              {t("btnConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
