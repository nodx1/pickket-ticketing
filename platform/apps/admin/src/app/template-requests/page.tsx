"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { motion } from "motion/react";
import { toast } from "sonner";
import {
  Loader2,
  FileText,
  Check,
  X,
  Clock,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { Button, Badge } from "@pickket/ui";
import {
  getTemplateChangeRequests,
  approveTemplateChange,
  rejectTemplateChange,
  isApiCanceled,
} from "@pickket/lib/api";
import { formatDate } from "@pickket/lib";

interface TemplateRequest {
  id: string;
  fanclub_id: string;
  old_template: string | null;
  new_template: string;
  reason: string;
  requested_by: string;
  status: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
}

type TFunc = (key: string) => string;

function getStatusTabs(t: TFunc) {
  return [
    { key: "all", label: t("statusTabs.all") },
    { key: "pending", label: t("statusTabs.pending") },
    { key: "approved", label: t("statusTabs.approved") },
    { key: "rejected", label: t("statusTabs.rejected") },
  ] as const;
}

function getStatusBadge(status: string, t: TFunc) {
  switch (status) {
    case "approved":
      return (
        <Badge
          className="rounded-full bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300"
          variant="secondary"
        >
          <Check className="h-3 w-3 mr-1" />
          {t("statusTabs.approved")}
        </Badge>
      );
    case "rejected":
      return (
        <Badge
          className="rounded-full bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300"
          variant="secondary"
        >
          <X className="h-3 w-3 mr-1" />
          {t("statusTabs.rejected")}
        </Badge>
      );
    default:
      return (
        <Badge
          className="rounded-full bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300"
          variant="secondary"
        >
          <Clock className="h-3 w-3 mr-1" />
          {t("statusTabs.pending")}
        </Badge>
      );
  }
}

function SkeletonTable() {
  return (
    <div className="space-y-2 p-5">
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={`template-request-skeleton-${i}`}
          className="h-14 bg-muted/50 rounded-lg animate-pulse"
        />
      ))}
    </div>
  );
}

export default function TemplateRequestsPage() {
  const t = useTranslations("templateRequests");
  const STATUS_TABS = getStatusTabs(t as TFunc);
  const [requests, setRequests] = useState<TemplateRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("all");
  const [rejectReason, setRejectReason] = useState("");
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await getTemplateChangeRequests(
        statusFilter === "all" ? undefined : statusFilter,
      );
      const payload = response.data as
        | TemplateRequest[]
        | {
            items?: TemplateRequest[];
            data?: TemplateRequest[] | { items?: TemplateRequest[] };
          };
      const nestedData =
        payload && !Array.isArray(payload) && "data" in payload
          ? payload.data
          : undefined;
      const items: TemplateRequest[] = Array.isArray(payload)
        ? payload
        : Array.isArray(nestedData)
          ? nestedData
          : (nestedData?.items ?? payload.items ?? []);
      setRequests(items);
    } catch (err) {
      if (isApiCanceled(err)) return;
      toast.error(t("toast.loadError"));
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

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

  const handleApprove = async (id: string) => {
    if (!confirm(t("confirm.approve"))) return;
    setActionLoading(id);
    try {
      await approveTemplateChange(id);
      toast.success(t("toast.approveSuccess"));
      load();
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail || t("toast.approveError");
      toast.error(msg);
    } finally {
      setActionLoading(null);
    }
  };

  const handleReject = async (id: string) => {
    if (!rejectReason.trim()) {
      toast.error(t("toast.rejectReasonRequired"));
      return;
    }
    setActionLoading(id);
    try {
      await rejectTemplateChange(id, rejectReason);
      toast.success(t("toast.rejectSuccess"));
      setRejectingId(null);
      setRejectReason("");
      load();
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail || t("toast.rejectError");
      toast.error(msg);
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div className="space-y-5 p-4 md:p-6">
      <h1 className="sr-only">{t("pageTitle")}</h1>

      {/* Header */}
      <div className="flex items-center gap-3">
        <FileText className="h-6 w-6 text-primary" />
        <div>
          <h2 className="text-xl font-bold">{t("pageTitle")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("pageDescription")}
          </p>
        </div>
      </div>

      {/* Status Filter Tabs */}
      <div className="flex gap-1 bg-muted/50 rounded-full p-1 w-fit">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setStatusFilter(tab.key)}
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
              statusFilter === tab.key
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="rounded-lg border border-border bg-card">
        {loading ? (
          <SkeletonTable />
        ) : requests.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            <FileText className="h-12 w-12 mx-auto mb-3 opacity-30" />
            <p className="text-lg font-medium mb-1">{t("empty.title")}</p>
            <p className="text-sm">
              {statusFilter !== "all"
                ? t("empty.filteredMessage", { label: STATUS_TABS.find((tab) => tab.key === statusFilter)?.label ?? "" })
                : t("empty.allMessage")}
            </p>
          </div>
        ) : (
          <>
            {/* Table Header */}
            <div className="hidden md:grid grid-cols-7 gap-2 px-5 py-3 text-xs font-medium text-muted-foreground border-b border-border">
              <span>{t("table.fanclubId")}</span>
              <span>{t("table.oldToNew")}</span>
              <span>{t("table.reason")}</span>
              <span>{t("table.requestedBy")}</span>
              <span>{t("table.date")}</span>
              <span className="text-center">{t("table.status")}</span>
              <span className="text-right">{t("table.action")}</span>
            </div>

            {/* Table Rows */}
            <div className="divide-y divide-border">
              {requests.map((req, idx) => (
                <div key={req.id}>
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: idx * 0.02 }}
                    className="grid grid-cols-2 md:grid-cols-7 gap-2 px-5 py-3.5 text-sm items-center hover:bg-muted/50 transition-colors cursor-pointer"
                    onClick={() => toggleExpand(req.id)}
                  >
                    <span
                      className="text-xs text-muted-foreground truncate"
                      title={req.fanclub_id}
                    >
                      {req.fanclub_id.slice(0, 8)}...
                    </span>
                    <span className="text-xs truncate hidden md:block">
                      <span className="text-muted-foreground">
                        {req.old_template || t("notSet")}
                      </span>
                      <span className="mx-1">→</span>
                      <span className="font-medium text-foreground">
                        {req.new_template}
                      </span>
                    </span>
                    <span
                      className="text-xs text-muted-foreground truncate hidden md:block"
                      title={req.reason}
                    >
                      {req.reason.length > 30
                        ? `${req.reason.slice(0, 30)}...`
                        : req.reason}
                    </span>
                    <span
                      className="text-xs text-muted-foreground truncate hidden md:block"
                      title={req.requested_by}
                    >
                      {req.requested_by.slice(0, 8)}...
                    </span>
                    <span className="text-xs text-muted-foreground hidden md:block">
                      {formatDate(req.created_at)}
                    </span>
                    <span className="text-center hidden md:block">
                      {getStatusBadge(req.status, t as TFunc)}
                    </span>
                    <span className="text-right flex items-center justify-end gap-1.5">
                      {req.status === "pending" && (
                        <>
                          <Button
                            variant="outline"
                            size="sm"
                            className="rounded-full text-xs h-7 px-2.5 border-green-300 text-green-700 hover:bg-green-50 dark:border-green-800 dark:text-green-400 dark:hover:bg-green-900/30"
                            disabled={actionLoading === req.id}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleApprove(req.id);
                            }}
                          >
                            {actionLoading === req.id ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Check className="h-3 w-3" />
                            )}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="rounded-full text-xs h-7 px-2.5 border-red-300 text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/30"
                            disabled={actionLoading === req.id}
                            onClick={(e) => {
                              e.stopPropagation();
                              setRejectingId(
                                rejectingId === req.id ? null : req.id,
                              );
                            }}
                          >
                            <X className="h-3 w-3" />
                          </Button>
                        </>
                      )}
                      {req.reason &&
                        (expanded.has(req.id) ? (
                          <ChevronDown className="h-4 w-4 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        ))}
                    </span>
                  </motion.div>

                  {/* Expanded Detail */}
                  {expanded.has(req.id) && (
                    <div className="px-5 pb-4">
                      <div className="bg-muted/50 rounded-xl p-3 text-xs space-y-1.5">
                        <p>
                          <span className="font-medium">{t("detail.fanclubId")}</span>{" "}
                          {req.fanclub_id}
                        </p>
                        <p>
                          <span className="font-medium">{t("detail.oldTemplate")}</span>{" "}
                          {req.old_template || t("notSet")}
                        </p>
                        <p>
                          <span className="font-medium">{t("detail.newTemplate")}</span>{" "}
                          {req.new_template}
                        </p>
                        <p>
                          <span className="font-medium">{t("detail.changeReason")}</span>{" "}
                          {req.reason}
                        </p>
                        <p>
                          <span className="font-medium">{t("detail.requestedById")}</span>{" "}
                          {req.requested_by}
                        </p>
                        <p>
                          <span className="font-medium">{t("detail.requestedAt")}</span>{" "}
                          {formatDate(req.created_at)}
                        </p>
                        {req.reviewed_by && (
                          <p>
                            <span className="font-medium">{t("detail.reviewedById")}</span>{" "}
                            {req.reviewed_by}
                          </p>
                        )}
                        {req.reviewed_at && (
                          <p>
                            <span className="font-medium">{t("detail.reviewedAt")}</span>{" "}
                            {formatDate(req.reviewed_at)}
                          </p>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Reject Reason Input */}
                  {rejectingId === req.id && (
                    <div className="px-5 pb-4">
                      <div className="flex gap-2 items-start">
                        <textarea
                          value={rejectReason}
                          onChange={(e) => setRejectReason(e.target.value)}
                          placeholder={t("rejectPlaceholder")}
                          className="flex-1 rounded-lg border border-input bg-background px-3 py-2 text-sm min-h-[60px] resize-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-hidden"
                          onClick={(e) => e.stopPropagation()}
                        />
                        <div className="flex flex-col gap-1.5">
                          <Button
                            size="sm"
                            className="rounded-full text-xs bg-red-600 hover:bg-red-700 text-white"
                            disabled={
                              !rejectReason.trim() || actionLoading === req.id
                            }
                            onClick={(e) => {
                              e.stopPropagation();
                              handleReject(req.id);
                            }}
                          >
                            {actionLoading === req.id ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              t("statusTabs.rejected")
                            )}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="rounded-full text-xs"
                            onClick={(e) => {
                              e.stopPropagation();
                              setRejectingId(null);
                              setRejectReason("");
                            }}
                          >
                            {t("cancel")}
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
