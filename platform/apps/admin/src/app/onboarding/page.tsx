"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { motion } from "motion/react";
import { toast } from "sonner";
import {
  Loader2,
  CheckCircle,
  XCircle,
  Building2,
  Phone,
  Mail,
  MapPin,
  FileText,
  Globe,
} from "lucide-react";
import { Button, Badge } from "@pickket/ui";
import {
  getOrganizerProfiles,
  approveOrganizerProfile,
  bulkApproveOrganizers,
  bulkRejectOrganizers,
  isApiCanceled,
  type OrganizerProfile,
} from "@pickket/lib/api";
import { formatDate, getCategoryBySlug } from "@pickket/lib";

function parseDomains(raw?: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [raw];
  } catch {
    return raw ? [raw] : [];
  }
}

const LOCAL_DOMAIN_FALLBACK: Record<string, string> = {
  esports: "e스포츠",
};

function domainLabel(slug: string): string {
  return getCategoryBySlug(slug)?.label ?? LOCAL_DOMAIN_FALLBACK[slug] ?? slug;
}

export default function AdminOnboardingPage() {
  const t = useTranslations("onboarding.approval");
  const [profiles, setProfiles] = useState<OrganizerProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [rejectTarget, setRejectTarget] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("pending");
  const [skip, setSkip] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const limit = 20;

  // Bulk selection
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getOrganizerProfiles({
        status: statusFilter || undefined,
        skip,
        limit,
      });
      setProfiles(data);
      setHasMore(data.length === limit);
    } catch (err) {
      if (isApiCanceled(err)) return;
      toast.error(t("errorLoadProfiles"));
    } finally {
      setLoading(false);
    }
  }, [statusFilter, skip]);

  useEffect(() => {
    load();
  }, [load]);

  const handleStatusChange = (s: string) => {
    setStatusFilter(s);
    setSkip(0);
    setSelected(new Set());
  };

  const handleApprove = async (profileId: string) => {
    setActionLoading(profileId);
    try {
      await approveOrganizerProfile(profileId, true);
      toast.success(t("successApprove"));
      load();
    } catch {
      toast.error(t("errorApprove"));
    } finally {
      setActionLoading(null);
    }
  };

  const handleReject = async (profileId: string) => {
    setActionLoading(profileId);
    try {
      await approveOrganizerProfile(profileId, false, rejectReason);
      toast.success(t("successReject"));
      setRejectTarget(null);
      setRejectReason("");
      load();
    } catch {
      toast.error(t("errorReject"));
    } finally {
      setActionLoading(null);
    }
  };

  // Bulk actions
  const handleBulkApprove = async () => {
    try {
      const result = await bulkApproveOrganizers(Array.from(selected));
      toast.success(result.detail || t("successBulkApprove", { count: result.success_count ?? 0 }));
      setSelected(new Set());
      load();
    } catch {
      toast.error(t("errorBulkApprove"));
    }
  };

  const handleBulkReject = async () => {
    try {
      const result = await bulkRejectOrganizers(Array.from(selected));
      toast.success(result.detail || t("successBulkReject", { count: result.success_count ?? 0 }));
      setSelected(new Set());
      load();
    } catch {
      toast.error(t("errorBulkReject"));
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
    const pendingProfiles = profiles.filter((p) => p.status === "pending");
    if (
      selected.size === pendingProfiles.length &&
      pendingProfiles.length > 0
    ) {
      setSelected(new Set());
    } else {
      setSelected(new Set(pendingProfiles.map((p) => p.id)));
    }
  };

  const currentPage = Math.floor(skip / limit) + 1;
  const pendingProfiles = profiles.filter((p) => p.status === "pending");

  return (
    <div className="space-y-5 p-4 md:p-6">
      <div className="flex items-center justify-between">
        <h1 className="sr-only">{t("pageTitle")}</h1>
        <div className="flex gap-2">
          {["pending", "approved", "rejected", ""].map((s) => (
            <Button
              key={s || "all"}
              variant={statusFilter === s ? "default" : "outline"}
              size="sm"
              className="rounded-full"
              onClick={() => handleStatusChange(s)}
            >
              {s === "pending"
                ? t("statusPending")
                : s === "approved"
                  ? t("statusApproved")
                  : s === "rejected"
                    ? t("statusRejected")
                    : t("statusAll")}
            </Button>
          ))}
        </div>
      </div>

      {/* Bulk Selection for Pending */}
      {statusFilter === "pending" && pendingProfiles.length > 0 && (
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={
                selected.size === pendingProfiles.length &&
                pendingProfiles.length > 0
              }
              onChange={toggleSelectAll}
              className="h-3.5 w-3.5 rounded border-muted-foreground"
            />
            {t("selectAll", { count: pendingProfiles.length })}
          </label>
        </div>
      )}

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
              className="rounded-full bg-green-600 hover:bg-green-700 text-white"
              onClick={handleBulkApprove}
            >
              <CheckCircle className="h-3.5 w-3.5 mr-1" />
              {t("bulkApprove")}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              className="rounded-full"
              onClick={handleBulkReject}
            >
              <XCircle className="h-3.5 w-3.5 mr-1" />
              {t("bulkReject")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="rounded-full"
              onClick={() => setSelected(new Set())}
            >
              {t("deselect")}
            </Button>
          </div>
        </motion.div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : profiles.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-16 text-center text-muted-foreground">
          {statusFilter === "pending"
            ? t("emptyPending")
            : t("emptyOther")}
        </div>
      ) : (
        <>
          <div className="grid gap-4">
            {profiles.map((profile, idx) => {
              const domains = parseDomains(profile.primary_domains);
              const isPending = profile.status === "pending";

              return (
                <motion.div
                  key={profile.id}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: idx * 0.04, duration: 0.3 }}
                  className="rounded-lg border border-border bg-card overflow-hidden"
                >
                  <div className="p-5 space-y-4">
                    {/* Header */}
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3">
                        {isPending && (
                          <input
                            type="checkbox"
                            checked={selected.has(profile.id)}
                            onChange={() => toggleSelect(profile.id)}
                            className="h-4 w-4 rounded border-muted-foreground mt-1 shrink-0"
                          />
                        )}
                        <div className="h-10 w-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                          <Building2 className="h-5 w-5 text-primary" />
                        </div>
                        <div>
                          <h3 className="font-semibold text-lg leading-tight">
                            {profile.company_name}
                          </h3>
                          <p className="text-sm text-muted-foreground">
                            {profile.representative_name}
                          </p>
                        </div>
                      </div>
                      <Badge
                        className={`rounded-full ${
                          profile.status === "pending"
                            ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400"
                            : profile.status === "approved"
                              ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                              : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                        }`}
                        variant="secondary"
                      >
                        {profile.status === "pending"
                          ? t("statusPending")
                          : profile.status === "approved"
                            ? t("statusApproved")
                            : t("statusRejected")}
                      </Badge>
                    </div>

                    {/* Info grid */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <FileText className="h-4 w-4 shrink-0" />
                        <span>{t("businessNumber", { number: profile.business_number ?? "" })}</span>
                      </div>
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <Phone className="h-4 w-4 shrink-0" />
                        <span>{profile.contact_phone}</span>
                      </div>
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <Mail className="h-4 w-4 shrink-0" />
                        <span className="truncate">
                          {profile.contact_email}
                        </span>
                      </div>
                      {profile.address && (
                        <div className="flex items-center gap-2 text-muted-foreground">
                          <MapPin className="h-4 w-4 shrink-0" />
                          <span className="truncate">{profile.address}</span>
                        </div>
                      )}
                    </div>

                    {/* Domains */}
                    {domains.length > 0 && (
                      <div className="flex items-center gap-2 flex-wrap">
                        <Globe className="h-4 w-4 text-muted-foreground shrink-0" />
                        {domains.map((d) => (
                          <Badge
                            key={d}
                            variant="secondary"
                            className="rounded-full bg-primary/5 text-primary"
                          >
                            {domainLabel(d)}
                          </Badge>
                        ))}
                      </div>
                    )}

                    {/* Rejection reason display */}
                    {profile.status === "rejected" &&
                      profile.rejection_reason && (
                        <div className="rounded-xl bg-red-50 dark:bg-red-900/10 p-3 text-sm text-red-700 dark:text-red-400">
                          <span className="font-medium">{t("rejectionReasonLabel")}</span>{" "}
                          {profile.rejection_reason}
                        </div>
                      )}

                    {/* Submitted date */}
                    <p className="text-xs text-muted-foreground">
                      {t("submittedDate")}:{" "}
                      {profile.created_at
                        ? formatDate(profile.created_at)
                        : "-"}
                    </p>

                    {/* Action buttons */}
                    {isPending && (
                      <div className="flex items-center gap-2 pt-1">
                        <Button
                          size="sm"
                          className="rounded-full bg-green-600 hover:bg-green-700 text-white gap-1.5"
                          disabled={actionLoading === profile.id}
                          onClick={() => handleApprove(profile.id)}
                        >
                          {actionLoading === profile.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <CheckCircle className="h-3.5 w-3.5" />
                          )}
                          {t("approve")}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="rounded-full border-red-300 text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/20 gap-1.5"
                          disabled={actionLoading === profile.id}
                          onClick={() =>
                            setRejectTarget(
                              rejectTarget === profile.id ? null : profile.id,
                            )
                          }
                        >
                          <XCircle className="h-3.5 w-3.5" />
                          {t("reject")}
                        </Button>
                      </div>
                    )}

                    {/* Rejection reason input */}
                    {rejectTarget === profile.id && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        className="space-y-2"
                      >
                        <textarea
                          className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/30"
                          rows={3}
                          placeholder={t("rejectionPlaceholder")}
                          value={rejectReason}
                          onChange={(e) => setRejectReason(e.target.value)}
                        />
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="destructive"
                            className="rounded-full gap-1.5"
                            disabled={actionLoading === profile.id}
                            onClick={() => handleReject(profile.id)}
                          >
                            {actionLoading === profile.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <XCircle className="h-3.5 w-3.5" />
                            )}
                            {t("rejectConfirm")}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="rounded-full"
                            onClick={() => {
                              setRejectTarget(null);
                              setRejectReason("");
                            }}
                          >
                            {t("cancel")}
                          </Button>
                        </div>
                      </motion.div>
                    )}
                  </div>
                </motion.div>
              );
            })}
          </div>

          {/* Pagination */}
          {(skip > 0 || hasMore) && (
            <div className="flex items-center justify-center gap-4 py-4">
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
                {t("page", { page: currentPage })}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="rounded-full"
                disabled={!hasMore}
                onClick={() => setSkip((s) => s + limit)}
              >
                {t("next")}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
