"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  ArrowLeft,
  Save,
  Loader2,
  Sparkles,
  Calendar,
  Image as ImageIcon,
  Shield,
  Lock,
  AlertTriangle,
} from "lucide-react";
import { Button } from "@pickket/ui";
import { Input } from "@pickket/ui";
import { Label } from "@pickket/ui";
import { useAuthStore } from "@pickket/store";
import { getEvent, updateEvent } from "@pickket/lib/api";
import {
  AGE_RESTRICTIONS,
  CATEGORIES,
  CITIES,
  GO_URL,
  getDomainLabels,
} from "@pickket/lib";

/* ── Types ──────────────────────────────────────────────────────────────────── */

interface EventData {
  id: string;
  title: string;
  description: string | null;
  venue: string;
  event_date: string;
  bidding_opens_at: string;
  bidding_closes_at: string;
  total_seats: number;
  status: string;
  category?: string;
  sub_category?: string;
  image_url?: string;
  thumbnail_url?: string;
  location_city?: string;
  artist_name?: string;
  age_restriction?: string;
  tags?: string;
  resale_enabled?: boolean;
  min_price: number;
  max_price: number | null;
}

interface EditFormValues {
  title: string;
  description: string;
  artist_name: string;
  venue: string;
  location_city: string;
  category: string;
  event_date: string;
  bidding_opens_at: string;
  bidding_closes_at: string;
  image_url: string;
  thumbnail_url: string;
  tags: string;
  resale_enabled: boolean;
  age_restriction: string;
}

/* ── Field restriction helpers ──────────────────────────────────────────────── */

type FieldName = keyof EditFormValues;

const ALWAYS_EDITABLE: FieldName[] = [
  "description",
  "image_url",
  "thumbnail_url",
];

const BIDDING_OPEN_EDITABLE: FieldName[] = [
  ...ALWAYS_EDITABLE,
  "tags",
  "artist_name",
  "age_restriction",
];

const ALL_FIELDS: FieldName[] = [
  "title",
  "description",
  "artist_name",
  "venue",
  "location_city",
  "category",
  "event_date",
  "bidding_opens_at",
  "bidding_closes_at",
  "image_url",
  "thumbnail_url",
  "tags",
  "resale_enabled",
  "age_restriction",
];

function getEditableFields(status: string): FieldName[] {
  switch (status) {
    case "DRAFT":
      return ALL_FIELDS;
    case "BIDDING_OPEN":
      return BIDDING_OPEN_EDITABLE;
    default:
      return ALWAYS_EDITABLE;
  }
}

function getRestrictionNotice(
  status: string,
  t: ReturnType<typeof useTranslations>,
): string | null {
  switch (status) {
    case "BIDDING_OPEN":
      return t("restrictionBiddingOpen");
    case "DRAFT":
      return null;
    default:
      return t("restrictionDefault");
  }
}

/* ── Skeleton ───────────────────────────────────────────────────────────────── */

function LoadingSkeleton() {
  return (
    <div className="max-w-3xl mx-auto pt-20 pb-8 px-4 space-y-6">
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-full bg-muted animate-pulse" />
        <div className="h-8 w-48 bg-muted rounded animate-pulse" />
      </div>
      {[1, 2, 3, 4].map((i) => (
        <div
          key={`event-edit-skeleton-${i}`}
          className="bg-card/90 backdrop-blur-sm rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] p-5 lg:p-6 space-y-4"
        >
          <div className="h-6 w-32 bg-muted rounded animate-pulse" />
          <div className="space-y-3">
            <div className="h-10 bg-muted rounded-xl animate-pulse" />
            <div className="h-10 bg-muted rounded-xl animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── Locked Field Wrapper ───────────────────────────────────────────────────── */

function FieldWrapper({
  children,
  locked,
  notice,
}: {
  children: React.ReactNode;
  locked: boolean;
  notice: string | null;
}) {
  if (!locked) return <>{children}</>;
  return (
    <div className="relative">
      <div className="opacity-50 pointer-events-none">{children}</div>
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="flex items-center gap-1.5 bg-muted/90 backdrop-blur-sm rounded-lg px-3 py-1.5 text-xs text-muted-foreground shadow-sm">
          <Lock className="h-3 w-3" />
          {notice}
        </div>
      </div>
    </div>
  );
}

/* ── Select class (shared styling) ──────────────────────────────────────────── */

const selectClass =
  "flex h-10 w-full rounded-xl bg-surface-dim px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

const textareaClass =
  "flex w-full rounded-xl bg-surface-dim px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

/* ── Main Component ─────────────────────────────────────────────────────────── */

export default function EventEditPage() {
  const t = useTranslations("event.edit");
  const params = useParams();
  const eventId = params.id as string;
  const router = useRouter();
  const { user } = useAuthStore();
  const goUrl = GO_URL;
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [eventData, setEventData] = useState<EventData | null>(null);

  // Auth guard
  useEffect(() => {
    if (!user) {
      router.push("/auth");
      return;
    }
    if (!user.is_organizer) {
      router.push("/events");
      return;
    }
  }, [user, router]);

  // Form setup
  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors, isDirty },
  } = useForm<EditFormValues>({
    defaultValues: {
      title: "",
      description: "",
      artist_name: "",
      venue: "",
      location_city: "",
      category: "",
      event_date: "",
      bidding_opens_at: "",
      bidding_closes_at: "",
      image_url: "",
      thumbnail_url: "",
      tags: "",
      resale_enabled: false,
      age_restriction: "",
    },
  });

  // Load event data
  useEffect(() => {
    if (!eventId || !user?.is_organizer) return;
    getEvent(eventId)
      .then((res) => {
        const data = res.data as EventData;
        setEventData(data);
        reset({
          title: data.title,
          description: data.description || "",
          venue: data.venue,
          event_date: data.event_date?.slice(0, 16) || "",
          bidding_opens_at: data.bidding_opens_at?.slice(0, 16) || "",
          bidding_closes_at: data.bidding_closes_at?.slice(0, 16) || "",
          image_url: data.image_url || "",
          thumbnail_url: data.thumbnail_url || "",
          artist_name: data.artist_name || "",
          age_restriction: data.age_restriction || "",
          tags: data.tags || "",
          category: data.category || "",
          location_city: data.location_city || "",
          resale_enabled: data.resale_enabled ?? false,
        });
        setLoading(false);
      })
      .catch(() => {
        toast.error(t("errorNotFound"));
        window.location.href = goUrl;
      });
  }, [eventId, user, reset, goUrl]);

  // Submit handler
  const onSubmit = async (formData: EditFormValues) => {
    setSaving(true);
    try {
      // Build payload: only send editable & changed fields
      const payload: Record<string, unknown> = {};
      const editable = getEditableFields(eventData?.status || "");

      for (const key of editable) {
        const value = formData[key];
        // Convert datetime-local back to ISO
        if (
          (key === "event_date" ||
            key === "bidding_opens_at" ||
            key === "bidding_closes_at") &&
          typeof value === "string" &&
          value
        ) {
          payload[key] = new Date(value).toISOString();
        } else if (key === "tags" && typeof value === "string" && value) {
          payload[key] = JSON.stringify(
            value
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean),
          );
        } else if (value !== "" && value !== undefined) {
          payload[key] = value;
        }
      }

      await updateEvent(eventId, payload);
      toast.success(t("successUpdated"));
      window.location.href = goUrl;
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail || t("errorUpdateFailed");
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  // Derived state
  const STATUS_LABEL: Record<string, string> = {
    DRAFT: t("statusDraft"),
    BIDDING_OPEN: t("statusBiddingOpen"),
    BIDDING_CLOSED: t("statusBiddingClosed"),
    ALLOCATION_DONE: t("statusAllocationDone"),
    PAYMENT_OPEN: t("statusPaymentOpen"),
    COMPLETED: t("statusCompleted"),
    CANCELLED: t("statusCancelled"),
  };

  const status = eventData?.status || "DRAFT";
  const editableFields = getEditableFields(status);
  const restrictionNotice = getRestrictionNotice(status, t);
  const formCategory = watch("category");
  const domainLabels = getDomainLabels(formCategory);
  const resaleEnabled = watch("resale_enabled");

  const isFieldLocked = (field: FieldName) => !editableFields.includes(field);

  // Loading state
  if (loading) {
    return <LoadingSkeleton />;
  }

  // No user guard (render fallback while redirecting)
  if (!user?.is_organizer) {
    return null;
  }

  return (
    <div className="max-w-3xl mx-auto pt-20 pb-8 px-4 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => (window.location.href = goUrl)}
            className="rounded-full"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold">{t("pageTitle")}</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {eventData?.title}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
              status === "DRAFT"
                ? "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200"
                : status === "BIDDING_OPEN"
                  ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
                  : "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200"
            }`}
          >
            {STATUS_LABEL[status] || status}
          </span>
        </div>
      </div>

      {/* Restriction notice */}
      {restrictionNotice && (
        <div className="bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded-xl px-4 py-3 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
          <p className="text-sm text-amber-800 dark:text-amber-200">
            {restrictionNotice} &mdash; {t("lockedFieldsBefore")}
            <Lock className="h-3 w-3 inline" />{t("lockedFieldsAfter")}
          </p>
        </div>
      )}

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        {/* ──────── Section 1: 기본 정보 ──────── */}
        <div className="bg-card/90 backdrop-blur-sm rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] p-5 lg:p-6 space-y-5">
          <h2 className="text-lg font-bold flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            {t("sectionBasic")}
          </h2>

          {/* 제목 */}
          <FieldWrapper
            locked={isFieldLocked("title")}
            notice={restrictionNotice}
          >
            <div>
              <Label htmlFor="title" className="mb-1.5 block">
                {t("labelTitle")}
              </Label>
              <Input
                id="title"
                {...register("title", {
                  required: t("validationTitleRequired"),
                  minLength: { value: 2, message: t("validationTitleMinLength") },
                })}
                disabled={isFieldLocked("title")}
                className="rounded-xl bg-surface-dim"
              />
              {errors.title && (
                <p className="text-xs text-red-500 mt-1">
                  {errors.title.message}
                </p>
              )}
            </div>
          </FieldWrapper>

          {/* 설명 */}
          <FieldWrapper
            locked={isFieldLocked("description")}
            notice={restrictionNotice}
          >
            <div>
              <Label htmlFor="description" className="mb-1.5 block">
                {t("labelDescription")}
              </Label>
              <textarea
                id="description"
                {...register("description")}
                rows={4}
                disabled={isFieldLocked("description")}
                className={textareaClass}
              />
            </div>
          </FieldWrapper>

          {/* 아티스트 */}
          <FieldWrapper
            locked={isFieldLocked("artist_name")}
            notice={restrictionNotice}
          >
            <div>
              <Label htmlFor="artist_name" className="mb-1.5 block">
                {domainLabels.subjectLabel}
              </Label>
              <Input
                id="artist_name"
                {...register("artist_name")}
                placeholder={domainLabels.placeholderName}
                disabled={isFieldLocked("artist_name")}
                className="rounded-xl bg-surface-dim"
              />
            </div>
          </FieldWrapper>

          {/* 장소 & 지역 */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <FieldWrapper
              locked={isFieldLocked("venue")}
              notice={restrictionNotice}
            >
              <div>
                <Label htmlFor="venue" className="mb-1.5 block">
                  {t("labelVenue")}
                </Label>
                <Input
                  id="venue"
                  {...register("venue", { required: t("validationVenueRequired") })}
                  disabled={isFieldLocked("venue")}
                  className="rounded-xl bg-surface-dim"
                />
                {errors.venue && (
                  <p className="text-xs text-red-500 mt-1">
                    {errors.venue.message}
                  </p>
                )}
              </div>
            </FieldWrapper>

            <FieldWrapper
              locked={isFieldLocked("location_city")}
              notice={restrictionNotice}
            >
              <div>
                <Label htmlFor="location_city" className="mb-1.5 block">
                  {t("labelCity")}
                </Label>
                <select
                  id="location_city"
                  {...register("location_city")}
                  disabled={isFieldLocked("location_city")}
                  className={selectClass}
                >
                  <option value="">{t("placeholderCitySelect")}</option>
                  {CITIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
            </FieldWrapper>
          </div>

          {/* 카테고리 */}
          <FieldWrapper
            locked={isFieldLocked("category")}
            notice={restrictionNotice}
          >
            <div>
              <Label htmlFor="category" className="mb-1.5 block">
                {t("labelCategory")}
              </Label>
              <select
                id="category"
                {...register("category")}
                disabled={isFieldLocked("category")}
                className={selectClass}
              >
                <option value="">{t("placeholderCategorySelect")}</option>
                {CATEGORIES.map((c) => (
                  <option key={c.slug} value={c.slug}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
          </FieldWrapper>
        </div>

        {/* ──────── Section 2: 일정 ──────── */}
        <div className="bg-card/90 backdrop-blur-sm rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] p-5 lg:p-6 space-y-5">
          <h2 className="text-lg font-bold flex items-center gap-2">
            <Calendar className="h-5 w-5 text-primary" />
            {t("sectionSchedule")}
          </h2>

          <FieldWrapper
            locked={isFieldLocked("event_date")}
            notice={restrictionNotice}
          >
            <div>
              <Label htmlFor="event_date" className="mb-1.5 block">
                {t("labelEventDate")}
              </Label>
              <Input
                id="event_date"
                type="datetime-local"
                {...register("event_date", {
                  required: t("validationEventDateRequired"),
                })}
                disabled={isFieldLocked("event_date")}
                className="rounded-xl bg-surface-dim"
              />
              {errors.event_date && (
                <p className="text-xs text-red-500 mt-1">
                  {errors.event_date.message}
                </p>
              )}
            </div>
          </FieldWrapper>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <FieldWrapper
              locked={isFieldLocked("bidding_opens_at")}
              notice={restrictionNotice}
            >
              <div>
                <Label htmlFor="bidding_opens_at" className="mb-1.5 block">
                  {t("labelBiddingOpens")}
                </Label>
                <Input
                  id="bidding_opens_at"
                  type="datetime-local"
                  {...register("bidding_opens_at", {
                    required: t("validationBiddingOpensRequired"),
                  })}
                  disabled={isFieldLocked("bidding_opens_at")}
                  className="rounded-xl bg-surface-dim"
                />
                {errors.bidding_opens_at && (
                  <p className="text-xs text-red-500 mt-1">
                    {errors.bidding_opens_at.message}
                  </p>
                )}
              </div>
            </FieldWrapper>

            <FieldWrapper
              locked={isFieldLocked("bidding_closes_at")}
              notice={restrictionNotice}
            >
              <div>
                <Label htmlFor="bidding_closes_at" className="mb-1.5 block">
                  {t("labelBiddingCloses")}
                </Label>
                <Input
                  id="bidding_closes_at"
                  type="datetime-local"
                  {...register("bidding_closes_at", {
                    required: t("validationBiddingClosesRequired"),
                  })}
                  disabled={isFieldLocked("bidding_closes_at")}
                  className="rounded-xl bg-surface-dim"
                />
                {errors.bidding_closes_at && (
                  <p className="text-xs text-red-500 mt-1">
                    {errors.bidding_closes_at.message}
                  </p>
                )}
              </div>
            </FieldWrapper>
          </div>
        </div>

        {/* ──────── Section 3: 미디어 ──────── */}
        <div className="bg-card/90 backdrop-blur-sm rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] p-5 lg:p-6 space-y-5">
          <h2 className="text-lg font-bold flex items-center gap-2">
            <ImageIcon className="h-5 w-5 text-primary" />
            {t("sectionMedia")}
          </h2>

          <FieldWrapper
            locked={isFieldLocked("image_url")}
            notice={restrictionNotice}
          >
            <div>
              <Label htmlFor="image_url" className="mb-1.5 block">
                {t("labelImageUrl")}
              </Label>
              <Input
                id="image_url"
                type="url"
                {...register("image_url")}
                placeholder="https://example.com/image.jpg"
                disabled={isFieldLocked("image_url")}
                className="rounded-xl bg-surface-dim"
              />
            </div>
          </FieldWrapper>

          <FieldWrapper
            locked={isFieldLocked("thumbnail_url")}
            notice={restrictionNotice}
          >
            <div>
              <Label htmlFor="thumbnail_url" className="mb-1.5 block">
                {t("labelThumbnailUrl")}
              </Label>
              <Input
                id="thumbnail_url"
                type="url"
                {...register("thumbnail_url")}
                placeholder="https://example.com/thumb.jpg"
                disabled={isFieldLocked("thumbnail_url")}
                className="rounded-xl bg-surface-dim"
              />
            </div>
          </FieldWrapper>

          <FieldWrapper
            locked={isFieldLocked("tags")}
            notice={restrictionNotice}
          >
            <div>
              <Label htmlFor="tags" className="mb-1.5 block">
                {t("labelTags")}
              </Label>
              <Input
                id="tags"
                {...register("tags")}
                placeholder={t("placeholderTags")}
                disabled={isFieldLocked("tags")}
                className="rounded-xl bg-surface-dim"
              />
              <p className="text-xs text-muted-foreground mt-1">
                {t("hintTags")}
              </p>
            </div>
          </FieldWrapper>
        </div>

        {/* ──────── Section 4: 정책 ──────── */}
        <div className="bg-card/90 backdrop-blur-sm rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] p-5 lg:p-6 space-y-5">
          <h2 className="text-lg font-bold flex items-center gap-2">
            <Shield className="h-5 w-5 text-primary" />
            {t("sectionPolicy")}
          </h2>

          <FieldWrapper
            locked={isFieldLocked("resale_enabled")}
            notice={restrictionNotice}
          >
            <div className="flex items-center justify-between">
              <div>
                <Label htmlFor="resale_enabled" className="block">
                  {t("labelResaleEnabled")}
                </Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {t("hintResaleEnabled")}
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  id="resale_enabled"
                  type="checkbox"
                  {...register("resale_enabled")}
                  disabled={isFieldLocked("resale_enabled")}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-muted rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary" />
              </label>
            </div>
          </FieldWrapper>

          {resaleEnabled && (
            <p className="text-xs text-muted-foreground bg-muted/50 rounded-lg px-3 py-2">
              {t("resaleEnabledInfo")}
            </p>
          )}

          <FieldWrapper
            locked={isFieldLocked("age_restriction")}
            notice={restrictionNotice}
          >
            <div>
              <Label htmlFor="age_restriction" className="mb-1.5 block">
                {t("labelAgeRestriction")}
              </Label>
              <select
                id="age_restriction"
                {...register("age_restriction")}
                disabled={isFieldLocked("age_restriction")}
                className={selectClass}
              >
                <option value="">{t("placeholderAgeNone")}</option>
                {AGE_RESTRICTIONS.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </div>
          </FieldWrapper>
        </div>

        {/* ──────── Actions ──────── */}
        <div className="flex items-center justify-between pt-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => (window.location.href = goUrl)}
            className="rounded-full px-6"
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            {t("btnBack")}
          </Button>
          <Button
            type="submit"
            disabled={saving || !isDirty}
            className="rounded-full bg-primary hover:bg-brand-hover px-8 min-w-[160px]"
          >
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                {t("btnSaving")}
              </>
            ) : (
              <>
                <Save className="h-4 w-4 mr-2" />
                {t("btnSave")}
              </>
            )}
          </Button>
        </div>
      </form>
    </div>
  );
}
