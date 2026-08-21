"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  Loader2,
  CheckCircle,
  XCircle,
  Clock,
  CalendarDays,
  Users,
  MapPin,
  Tag,
  DollarSign,
  Shield,
  Eye,
  Mail,
  Phone,
  Globe,
  AlertTriangle,
  ChevronRight,
  ImageIcon,
  Ticket,
  ArrowLeft,
} from "lucide-react";
import {
  Button,
  Badge,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Textarea,
  Separator,
} from "@pickket/ui";
import {
  getAdminEvents,
  getEvent,
  adminReviewEvent,
  isApiCanceled,
  type AdminEvent,
} from "@pickket/lib/api";
import { formatDate } from "@pickket/lib";

const CATEGORY_KEYS: Record<string, string> = {
  CONCERT: "category.concert",
  SPORTS: "category.sports",
  FESTIVAL: "category.festival",
  EXHIBITION: "category.exhibition",
  CLASSICAL: "category.classical",
  MUSICAL: "category.musical",
  ESPORTS: "category.esports",
  EDUCATION: "category.education",
  CIVIC: "category.civic",
};

const SALE_MODE_KEYS: Record<string, string> = {
  fixed_fcfs: "saleMode.fixedFcfs",
  point_lottery: "saleMode.pointLottery",
  fanclub_presale: "saleMode.fanclubPresale",
  queue: "saleMode.queue",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EventDetail = any;

/* ────────────────────────────────────────────────────────────── */

function InfoRow({
  icon,
  label,
  value,
  warn,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  warn?: boolean;
}) {
  const tRow = useTranslations("event.pendingReview");
  return (
    <div className="flex items-start gap-3 rounded-lg px-3 py-3 hover:bg-muted/30 transition-colors">
      <span className="text-muted-foreground mt-0.5 shrink-0">{icon}</span>
      <div className="flex-1 min-w-0">
        <p className="text-xs text-muted-foreground mb-0.5">{label}</p>
        <p className={`text-sm font-medium ${warn ? "text-destructive" : ""}`}>
          {value || (
            <span className="text-muted-foreground/50 italic">{tRow("value.notEntered")}</span>
          )}
        </p>
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-4 px-1">
        {title}
      </h3>
      {children}
    </div>
  );
}

function CheckItem({
  label,
  ok,
  detail,
}: {
  label: string;
  ok: boolean;
  detail?: string;
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg px-3 py-2.5 hover:bg-muted/30 transition-colors">
      {ok ? (
        <CheckCircle className="h-4 w-4 text-green-500 shrink-0" />
      ) : (
        <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
      )}
      <span className="text-sm flex-1">{label}</span>
      {detail && (
        <span
          className={`text-xs ${ok ? "text-muted-foreground" : "text-amber-500"} tabular-nums`}
        >
          {detail}
        </span>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────── */

export default function PendingReviewPage() {
  const t = useTranslations("event.pendingReview");
  const [events, setEvents] = useState<AdminEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // Detail view
  const [selectedEvent, setSelectedEvent] = useState<AdminEvent | null>(null);
  const [detail, setDetail] = useState<EventDetail>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Reject dialog
  const [rejectTarget, setRejectTarget] = useState<AdminEvent | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getAdminEvents({
        status: "pending_review",
        limit: 100,
      });
      setEvents(data.events);
    } catch (err) {
      if (isApiCanceled(err)) return;
      toast.error(t("toast.loadListError"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openDetail = async (event: AdminEvent) => {
    setSelectedEvent(event);
    setDetailLoading(true);
    try {
      const res = await getEvent(event.id);
      setDetail(res.data);
    } catch {
      setDetail(null);
      toast.error(t("toast.loadDetailError"));
    } finally {
      setDetailLoading(false);
    }
  };

  const backToList = () => {
    setSelectedEvent(null);
    setDetail(null);
  };

  const handleApprove = async (event: AdminEvent) => {
    setActionLoading(`approve-${event.id}`);
    try {
      await adminReviewEvent(event.id, "approve");
      toast.success(t("toast.approveSuccess", { title: event.title ?? "" }));
      backToList();
      load();
    } catch {
      toast.error(t("toast.approveError"));
    } finally {
      setActionLoading(null);
    }
  };

  const handleReject = async () => {
    if (!rejectTarget) return;
    setActionLoading(`reject-${rejectTarget.id}`);
    try {
      await adminReviewEvent(
        rejectTarget.id,
        "reject",
        rejectReason || undefined,
      );
      toast.success(t("toast.rejectSuccess", { title: rejectTarget.title ?? "" }));
      setRejectTarget(null);
      setRejectReason("");
      backToList();
      load();
    } catch {
      toast.error(t("toast.rejectError"));
    } finally {
      setActionLoading(null);
    }
  };

  /* ── LIST VIEW ──────────────────────────────────────── */
  if (!selectedEvent) {
    return (
      <div className="space-y-6 p-6 lg:p-10">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">{t("list.title")}</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {t("list.subtitle")}
            </p>
          </div>
          <Badge variant="secondary" className="text-sm">
            <Clock className="mr-1 h-3.5 w-3.5" />
            {t("list.pendingCount", { count: events.length ?? 0 })}
          </Badge>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : events.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
            <CheckCircle className="h-10 w-10 mb-3 text-green-500" />
            <p className="text-lg font-medium">{t("list.emptyTitle")}</p>
            <p className="text-sm">{t("list.emptySubtitle")}</p>
          </div>
        ) : (
          <div className="space-y-4">
            {events.map((event) => (
              <div
                key={event.id}
                className="group rounded-2xl border border-border/50 bg-background px-6 py-5 shadow-sm cursor-pointer hover:border-primary/30 hover:shadow-md transition-all"
                onClick={() => openDetail(event)}
              >
                <div className="flex items-center justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <h3 className="text-base font-semibold truncate group-hover:text-primary transition-colors">
                      {event.title}
                    </h3>
                    <div className="mt-2 flex flex-wrap gap-3 text-sm text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <CalendarDays className="h-3.5 w-3.5" />
                        {formatDate(event.event_date)}
                      </span>
                      <span className="flex items-center gap-1">
                        <Users className="h-3.5 w-3.5" />
                        {t("unit.seats", { count: event.total_seats?.toLocaleString() ?? 0 })}
                      </span>
                      <Badge variant="outline" className="text-xs">
                        {CATEGORY_KEYS[event.category] ? t(CATEGORY_KEYS[event.category]) : event.category}
                      </Badge>
                    </div>
                  </div>
                  <ChevronRight className="h-5 w-5 text-muted-foreground/30 group-hover:text-primary transition-colors shrink-0" />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  /* ── DETAIL VIEW ────────────────────────────────────── */
  const d = detail;
  const tiers = d?.seat_tiers || [];
  const hasImage = !!d?.image_url;
  const hasDescription = !!d?.description?.trim();
  const hasVenue = !!d?.venue?.trim();
  const hasTiers = tiers.length > 0;
  const hasOrganizerContact = !!(
    d?.organizer_contact_email || d?.organizer_contact_phone
  );
  const totalCapacity = tiers.reduce(
    (sum: number, t: { capacity: number }) => sum + (t.capacity || 0),
    0,
  );
  const priceRange =
    tiers.length > 0
      ? {
          min: Math.min(
            ...tiers.map((t: { base_price: number }) => t.base_price || 0),
          ),
          max: Math.max(
            ...tiers.map((t: { base_price: number }) => t.base_price || 0),
          ),
        }
      : null;

  return (
    <div className="space-y-6 p-6 lg:p-10">
      {/* Back + title */}
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={backToList}
          className="gap-1.5"
        >
          <ArrowLeft className="h-4 w-4" />
          {t("detail.backToList")}
        </Button>
        <Separator orientation="vertical" className="h-5" />
        <Badge variant="secondary" className="text-xs px-2.5 py-1">
          {t("detail.statusPending")}
        </Badge>
      </div>

      {detailLoading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* ── LEFT: 이벤트 정보 (2/3) ──── */}
          <div className="lg:col-span-2 space-y-6">
            {/* Hero */}
            {hasImage ? (
              <div className="relative rounded-2xl overflow-hidden border shadow-sm">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={d.image_url}
                  alt={selectedEvent.title}
                  className="w-full h-72 object-cover"
                />
                <div className="absolute inset-0 bg-linear-to-t from-black/70 via-black/20 to-transparent" />
                <div className="absolute bottom-0 left-0 right-0 p-8">
                  <h1 className="text-2xl font-bold text-white">
                    {selectedEvent.title}
                  </h1>
                  <p className="text-white/70 text-sm mt-1">
                    {CATEGORY_KEYS[selectedEvent.category] ? t(CATEGORY_KEYS[selectedEvent.category]) : selectedEvent.category}
                  </p>
                </div>
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed bg-muted/20 px-8 py-10">
                <div className="flex items-center gap-4">
                  <div className="h-14 w-14 rounded-xl bg-muted/50 flex items-center justify-center">
                    <ImageIcon className="h-7 w-7 text-muted-foreground/40" />
                  </div>
                  <div>
                    <h1 className="text-2xl font-bold">
                      {selectedEvent.title}
                    </h1>
                    <p className="text-sm text-muted-foreground mt-1">
                      {CATEGORY_KEYS[selectedEvent.category] ? t(CATEGORY_KEYS[selectedEvent.category]) : selectedEvent.category}
                      <span className="mx-1.5">·</span>
                      <span className="text-amber-500">{t("detail.noHeroImage")}</span>
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* 기본 정보 */}
            <div className="rounded-2xl border border-border/50 bg-background px-7 py-6 shadow-sm">
              <Section title={t("section.basicInfo")}>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                  <InfoRow
                    icon={<CalendarDays className="h-4 w-4" />}
                    label={t("field.eventDate")}
                    value={formatDate(d?.event_date)}
                  />
                  {d?.event_date_end && (
                    <InfoRow
                      icon={<CalendarDays className="h-4 w-4" />}
                      label={t("field.eventDateEnd")}
                      value={formatDate(d.event_date_end)}
                    />
                  )}
                  <InfoRow
                    icon={<MapPin className="h-4 w-4" />}
                    label={t("field.venue")}
                    value={d?.venue}
                    warn={!hasVenue}
                  />
                  <InfoRow
                    icon={<Globe className="h-4 w-4" />}
                    label={t("field.cityTimezone")}
                    value={`${d?.location_city || t("value.unspecified")} · ${d?.event_timezone || "Asia/Seoul"}`}
                  />
                  <InfoRow
                    icon={<Users className="h-4 w-4" />}
                    label={t("field.totalSeats")}
                    value={t("unit.seats", { count: d?.total_seats?.toLocaleString() ?? 0 })}
                  />
                  <InfoRow
                    icon={<DollarSign className="h-4 w-4" />}
                    label={t("field.priceRange")}
                    value={
                      priceRange
                        ? t("value.priceRangeFormat", { min: priceRange.min.toLocaleString(), max: priceRange.max.toLocaleString() })
                        : d?.is_free
                          ? t("value.free")
                          : t("value.notSet")
                    }
                  />
                  <InfoRow
                    icon={<Tag className="h-4 w-4" />}
                    label={t("field.currencyFeeRate")}
                    value={t("value.currencyFeeFormat", { currency: d?.currency ?? "KRW", rate: ((d?.service_fee_rate || 0.11) * 100).toFixed(0) })}
                  />
                  <InfoRow
                    icon={<Shield className="h-4 w-4" />}
                    label={t("field.ageRestriction")}
                    value={d?.age_restriction || d?.age_rating || t("value.allAges")}
                  />
                </div>
              </Section>
            </div>

            {/* 설명 */}
            <div className="rounded-2xl border border-border/50 bg-background px-7 py-6 shadow-sm">
              <Section title={t("section.eventDescription")}>
                {hasDescription ? (
                  <p className="text-sm whitespace-pre-wrap leading-relaxed text-foreground/80 px-1">
                    {d.description}
                  </p>
                ) : (
                  <div className="flex items-center gap-2 text-amber-500 text-sm">
                    <AlertTriangle className="h-4 w-4" />
                    {t("detail.noDescription")}
                  </div>
                )}
              </Section>
              {d?.notice && (
                <div className="mt-4 rounded-lg bg-muted/50 p-4">
                  <p className="text-xs text-muted-foreground mb-1">{t("field.notice")}</p>
                  <p className="text-sm whitespace-pre-wrap">{d.notice}</p>
                </div>
              )}
            </div>

            {/* 좌석 등급 / 티어 */}
            <div className="rounded-2xl border border-border/50 bg-background px-7 py-6 shadow-sm">
              <Section title={t("section.seatTiers", { count: tiers.length ?? 0 })}>
                {hasTiers ? (
                  <div className="space-y-2">
                    {tiers.map(
                      (tier: {
                        id: string;
                        name: string;
                        capacity: number;
                        base_price: number;
                        face_price: number;
                        sale_mode: string;
                        seating_type: string;
                        section_name?: string;
                      }) => (
                        <div
                          key={tier.id}
                          className="flex items-center justify-between rounded-xl border px-5 py-4"
                        >
                          <div>
                            <p className="font-medium text-sm">{tier.name}</p>
                            <div className="flex items-center gap-2 mt-1">
                              <Badge variant="outline" className="text-xs">
                                {SALE_MODE_KEYS[tier.sale_mode] ? t(SALE_MODE_KEYS[tier.sale_mode]) : tier.sale_mode}
                              </Badge>
                              <span className="text-xs text-muted-foreground">
                                {tier.seating_type === "assigned"
                                  ? t("value.assignedSeat")
                                  : t("value.freeSeat")}
                              </span>
                              {tier.section_name && (
                                <span className="text-xs text-muted-foreground">
                                  · {tier.section_name}
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="text-right">
                            <p className="text-sm font-semibold">
                              {t("value.krwPrice", { price: tier.base_price?.toLocaleString() ?? "0" })}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {t("unit.seats", { count: tier.capacity?.toLocaleString() ?? 0 })}
                            </p>
                          </div>
                        </div>
                      ),
                    )}
                    <div className="flex justify-between text-sm font-medium pt-3 px-2 border-t mt-4">
                      <span>{t("field.totalSeats")}</span>
                      <span>{t("unit.seats", { count: totalCapacity.toLocaleString() ?? 0 })}</span>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-amber-500 text-sm">
                    <AlertTriangle className="h-4 w-4" />
                    {t("detail.noSeatTiers")}
                  </div>
                )}
              </Section>
            </div>

            {/* 정책 */}
            <div className="rounded-2xl border border-border/50 bg-background px-7 py-6 shadow-sm">
              <Section title={t("section.salePolicy")}>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                  <InfoRow
                    icon={<Ticket className="h-4 w-4" />}
                    label={t("field.remainderStrategy")}
                    value={
                      d?.remainder_strategy === "discount_fcfs"
                        ? t("value.discountFcfs")
                        : d?.remainder_strategy === "price_drop"
                          ? t("value.priceDrop")
                          : d?.remainder_strategy || t("value.notSet")
                    }
                  />
                  <InfoRow
                    icon={<Eye className="h-4 w-4" />}
                    label={t("field.identityVerification")}
                    value={d?.require_identity_verification ? t("value.required") : t("value.optional")}
                  />
                  <InfoRow
                    icon={<Shield className="h-4 w-4" />}
                    label={t("field.resale")}
                    value={d?.resale_enabled ? t("value.allowed") : t("value.notAllowed")}
                  />
                  <InfoRow
                    icon={<DollarSign className="h-4 w-4" />}
                    label={t("field.deposit")}
                    value={
                      d?.deposit_amount
                        ? t("value.krwPrice", { price: d.deposit_amount.toLocaleString() })
                        : t("value.none")
                    }
                  />
                  <InfoRow
                    icon={<AlertTriangle className="h-4 w-4" />}
                    label={t("field.noShowPolicy")}
                    value={
                      d?.no_show_policy === "refund"
                        ? t("value.refund")
                        : d?.no_show_policy === "forfeiture"
                          ? t("value.depositForfeiture")
                          : d?.no_show_policy || t("value.notSet")
                    }
                  />
                  <InfoRow
                    icon={<Users className="h-4 w-4" />}
                    label={t("field.maxWinsPerUser")}
                    value={t("unit.tickets", { count: d?.multi_max_wins_per_user ?? 2 })}
                  />
                </div>
              </Section>
            </div>

            {/* 주최자 정보 */}
            <div className="rounded-2xl border border-border/50 bg-background px-7 py-6 shadow-sm">
              <Section title={t("section.organizerInfo")}>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                  <InfoRow
                    icon={<Users className="h-4 w-4" />}
                    label={t("field.organizerName")}
                    value={d?.organizer_name}
                  />
                  <InfoRow
                    icon={<Mail className="h-4 w-4" />}
                    label={t("field.contactEmail")}
                    value={d?.organizer_contact_email}
                    warn={!d?.organizer_contact_email}
                  />
                  <InfoRow
                    icon={<Phone className="h-4 w-4" />}
                    label={t("field.contactPhone")}
                    value={d?.organizer_contact_phone}
                  />
                </div>
                <div className="mt-3 text-xs text-muted-foreground px-3">
                  {t("detail.organizerId", { id: selectedEvent.organizer_id ?? "" })}
                </div>
              </Section>
            </div>
          </div>

          {/* ── RIGHT: 심사 체크리스트 + 액션 (1/3) ──── */}
          <div className="space-y-6">
            {/* 심사 체크리스트 */}
            <div className="rounded-2xl border border-border/50 bg-background px-6 py-7 shadow-sm sticky top-6">
              <Section title={t("section.checklist")}>
                <div className="space-y-1">
                  <CheckItem
                    label={t("check.heroImage")}
                    ok={hasImage}
                    detail={hasImage ? t("check.registered") : t("value.none")}
                  />
                  <CheckItem
                    label={t("check.eventDescription")}
                    ok={hasDescription}
                    detail={
                      hasDescription ? t("check.charCount", { count: d.description.length ?? 0 }) : t("value.none")
                    }
                  />
                  <CheckItem
                    label={t("check.venueInfo")}
                    ok={hasVenue}
                    detail={hasVenue ? d.venue : t("value.notEntered")}
                  />
                  <CheckItem
                    label={t("check.seatTierConfig")}
                    ok={hasTiers}
                    detail={hasTiers ? t("check.tierCount", { count: tiers.length ?? 0 }) : t("value.none")}
                  />
                  <CheckItem
                    label={t("check.priceConfig")}
                    ok={!!priceRange}
                    detail={
                      priceRange
                        ? t("check.priceRangeDetail", { min: priceRange.min.toLocaleString(), max: priceRange.max.toLocaleString() })
                        : t("value.notSet")
                    }
                  />
                  <CheckItem
                    label={t("check.organizerContact")}
                    ok={hasOrganizerContact}
                    detail={hasOrganizerContact ? t("value.exists") : t("value.none")}
                  />
                  <CheckItem
                    label={t("check.ageRestrictionConfig")}
                    ok={!!(d?.age_restriction || d?.age_rating)}
                    detail={d?.age_restriction || d?.age_rating || t("value.notSet")}
                  />
                </div>
              </Section>

              <Separator className="my-6" />

              {/* 메타 */}
              <div className="text-xs text-muted-foreground space-y-1.5 mb-6 px-1">
                <p>ID: {selectedEvent.id}</p>
                <p>Slug: {d?.slug}</p>
                <p>{t("detail.registeredAt", { date: formatDate(selectedEvent.created_at) ?? "" })}</p>
              </div>

              {/* 액션 버튼 */}
              <div className="space-y-3 pt-1">
                <Button
                  className="w-full"
                  size="lg"
                  onClick={() => handleApprove(selectedEvent)}
                  disabled={actionLoading !== null}
                >
                  {actionLoading === `approve-${selectedEvent.id}` ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <CheckCircle className="mr-2 h-4 w-4" />
                  )}
                  {t("action.approve")}
                </Button>
                <Button
                  variant="outline"
                  className="w-full"
                  size="lg"
                  onClick={() => setRejectTarget(selectedEvent)}
                  disabled={actionLoading !== null}
                >
                  <XCircle className="mr-2 h-4 w-4" />
                  {t("action.reject")}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Reject dialog */}
      <AlertDialog
        open={!!rejectTarget}
        onOpenChange={(open) => !open && setRejectTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("dialog.rejectTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              &quot;{rejectTarget?.title}&quot; {t("dialog.rejectDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            placeholder={t("dialog.rejectPlaceholder")}
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            rows={4}
          />
          <AlertDialogFooter>
            <AlertDialogCancel>{t("action.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleReject}
              disabled={actionLoading !== null}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {actionLoading?.startsWith("reject-") ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : null}
              {t("action.confirmReject")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
