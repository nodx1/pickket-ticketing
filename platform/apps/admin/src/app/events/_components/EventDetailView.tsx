"use client";

import { useTranslations } from "next-intl";
import {
  CalendarDays,
  MapPin,
  Globe,
  Users,
  DollarSign,
  Tag,
  Shield,
  Image as ImageIcon,
  AlertTriangle,
  Mail,
  Phone,
  Eye,
  Ticket,
  CheckCircle,
} from "lucide-react";
import { Badge } from "@pickket/ui";
import { formatDate } from "@pickket/lib";
import type { AdminEvent } from "@pickket/lib/api";

const CATEGORY_LABEL: Record<string, string> = {
  CONCERT: "콘서트",
  SPORTS: "스포츠",
  FESTIVAL: "페스티벌",
  EXHIBITION: "전시",
  CLASSICAL: "클래식",
  MUSICAL: "뮤지컬",
  ESPORTS: "e스포츠",
  EDUCATION: "교육",
  CIVIC: "시민/네트워킹",
};

const SALE_MODE_LABEL: Record<string, string> = {
  fixed_fcfs: "선착순",
  point_lottery: "포인트 추첨",
  fanclub_presale: "팬클럽 선예매",
  queue: "대기열",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EventDetail = any;

export function InfoRow({
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
  const t = useTranslations("event.detailView");
  return (
    <div className="flex items-start gap-3 rounded-lg px-3 py-3 hover:bg-muted/30 transition-colors">
      <span className="text-muted-foreground mt-0.5 shrink-0">{icon}</span>
      <div className="flex-1 min-w-0">
        <p className="text-xs text-muted-foreground mb-0.5">{label}</p>
        <p className={`text-sm font-medium ${warn ? "text-destructive" : ""}`}>
          {value || (
            <span className="text-muted-foreground/50 italic">{t("notEntered")}</span>
          )}
        </p>
      </div>
    </div>
  );
}

export function Section({
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

export function CheckItem({
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

interface EventDetailViewProps {
  selectedEvent: AdminEvent;
  detail: EventDetail | null;
  /** 우측 사이드바 — 액션 버튼/심사 체크리스트/추가 패널 등 페이지별 커스텀 */
  rightPanel: React.ReactNode;
}

/** 이벤트 상세 풀 페이지 — events 목록과 심사 상세 양쪽에서 공통 사용. */
export function EventDetailView({
  selectedEvent,
  detail: d,
  rightPanel,
}: EventDetailViewProps) {
  const t = useTranslations("event.detailView");
  const tiers = d?.seat_tiers || [];
  const hasImage = !!d?.image_url;
  const hasDescription = !!d?.description?.trim();
  const hasVenue = !!d?.venue?.trim();
  const hasTiers = tiers.length > 0;
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
                {CATEGORY_LABEL[selectedEvent.category] ||
                  selectedEvent.category}
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
                <h1 className="text-2xl font-bold">{selectedEvent.title}</h1>
                <p className="text-sm text-muted-foreground mt-1">
                  {CATEGORY_LABEL[selectedEvent.category] ||
                    selectedEvent.category}
                  <span className="mx-1.5">·</span>
                  <span className="text-amber-500">{t("noHeroImage")}</span>
                </p>
              </div>
            </div>
          </div>
        )}

        {/* 기본 정보 */}
        <div className="rounded-2xl border border-border/50 bg-background px-7 py-6 shadow-sm">
          <Section title={t("sectionBasicInfo")}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
              <InfoRow
                icon={<CalendarDays className="h-4 w-4" />}
                label={t("labelEventDate")}
                value={formatDate(d?.event_date)}
              />
              {d?.event_date_end && (
                <InfoRow
                  icon={<CalendarDays className="h-4 w-4" />}
                  label={t("labelEventDateEnd")}
                  value={formatDate(d.event_date_end)}
                />
              )}
              <InfoRow
                icon={<MapPin className="h-4 w-4" />}
                label={t("labelVenue")}
                value={d?.venue}
                warn={!hasVenue}
              />
              <InfoRow
                icon={<Globe className="h-4 w-4" />}
                label={t("labelCityTimezone")}
                value={`${d?.location_city ?? t("unspecified")} · ${d?.event_timezone || "Asia/Seoul"}`}
              />
              <InfoRow
                icon={<Users className="h-4 w-4" />}
                label={t("labelTotalSeats")}
                value={t("seatCount", { count: d?.total_seats?.toLocaleString() ?? 0 })}
              />
              <InfoRow
                icon={<DollarSign className="h-4 w-4" />}
                label={t("labelPriceRange")}
                value={
                  priceRange
                    ? t("priceRange", { min: priceRange.min.toLocaleString(), max: priceRange.max.toLocaleString() })
                    : d?.is_free
                      ? t("free")
                      : t("notSet")
                }
              />
              <InfoRow
                icon={<Tag className="h-4 w-4" />}
                label={t("labelCurrencyFee")}
                value={t("currencyFee", { currency: d?.currency ?? "KRW", rate: ((d?.service_fee_rate || 0.11) * 100).toFixed(0) })}
              />
              <InfoRow
                icon={<Shield className="h-4 w-4" />}
                label={t("labelAgeRestriction")}
                value={d?.age_restriction || d?.age_rating || t("allAges")}
              />
            </div>
          </Section>
        </div>

        {/* 설명 */}
        <div className="rounded-2xl border border-border/50 bg-background px-7 py-6 shadow-sm">
          <Section title={t("sectionDescription")}>
            {hasDescription ? (
              <p className="text-sm whitespace-pre-wrap leading-relaxed text-foreground/80 px-1">
                {d.description}
              </p>
            ) : (
              <div className="flex items-center gap-2 text-amber-500 text-sm">
                <AlertTriangle className="h-4 w-4" />
                {t("descriptionMissing")}
              </div>
            )}
          </Section>
          {d?.notice && (
            <div className="mt-4 rounded-lg bg-muted/50 p-4">
              <p className="text-xs text-muted-foreground mb-1">{t("notice")}</p>
              <p className="text-sm whitespace-pre-wrap">{d.notice}</p>
            </div>
          )}
        </div>

        {/* 좌석 등급 */}
        <div className="rounded-2xl border border-border/50 bg-background px-7 py-6 shadow-sm">
          <Section title={t("sectionSeatTiers", { count: tiers.length })}>
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
                            {SALE_MODE_LABEL[tier.sale_mode] || tier.sale_mode}
                          </Badge>
                          <span className="text-xs text-muted-foreground">
                            {tier.seating_type === "assigned"
                              ? t("assignedSeat")
                              : t("freeSeat")}
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
                          {t("priceWon", { amount: tier.base_price?.toLocaleString() ?? 0 })}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {t("seatCount", { count: tier.capacity?.toLocaleString() ?? 0 })}
                        </p>
                      </div>
                    </div>
                  ),
                )}
                <div className="flex justify-between text-sm font-medium pt-3 px-2 border-t mt-4">
                  <span>{t("labelTotalSeats")}</span>
                  <span>{t("seatCount", { count: totalCapacity.toLocaleString() })}</span>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-amber-500 text-sm">
                <AlertTriangle className="h-4 w-4" />
                {t("seatTiersMissing")}
              </div>
            )}
          </Section>
        </div>

        {/* 정책 */}
        <div className="rounded-2xl border border-border/50 bg-background px-7 py-6 shadow-sm">
          <Section title={t("sectionSalesPolicy")}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
              <InfoRow
                icon={<Ticket className="h-4 w-4" />}
                label={t("labelRemainderStrategy")}
                value={
                  d?.remainder_strategy === "discount_fcfs"
                    ? t("discountFcfs")
                    : d?.remainder_strategy || t("notSet")
                }
              />
              <InfoRow
                icon={<Eye className="h-4 w-4" />}
                label={t("labelIdentityVerification")}
                value={d?.require_identity_verification ? t("required") : t("optional")}
              />
              <InfoRow
                icon={<Shield className="h-4 w-4" />}
                label={t("labelResale")}
                value={d?.resale_enabled ? t("allowed") : t("notAllowed")}
              />
              <InfoRow
                icon={<DollarSign className="h-4 w-4" />}
                label={t("labelDeposit")}
                value={
                  d?.deposit_amount
                    ? t("priceWon", { amount: d.deposit_amount.toLocaleString() })
                    : t("none")
                }
              />
              <InfoRow
                icon={<AlertTriangle className="h-4 w-4" />}
                label={t("labelNoShowPolicy")}
                value={
                  d?.no_show_policy === "refund"
                    ? t("noShowRefund")
                    : d?.no_show_policy === "forfeiture"
                      ? t("noShowForfeiture")
                      : d?.no_show_policy || t("notSet")
                }
              />
              <InfoRow
                icon={<Users className="h-4 w-4" />}
                label={t("labelMaxWinsPerUser")}
                value={t("ticketCount", { count: d?.multi_max_wins_per_user ?? 2 })}
              />
            </div>
          </Section>
        </div>

        {/* 주최자 정보 */}
        <div className="rounded-2xl border border-border/50 bg-background px-7 py-6 shadow-sm">
          <Section title={t("sectionOrganizerInfo")}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
              <InfoRow
                icon={<Users className="h-4 w-4" />}
                label={t("labelOrganizerName")}
                value={d?.organizer_name}
              />
              <InfoRow
                icon={<Mail className="h-4 w-4" />}
                label={t("labelContactEmail")}
                value={d?.organizer_contact_email}
                warn={!d?.organizer_contact_email}
              />
              <InfoRow
                icon={<Phone className="h-4 w-4" />}
                label={t("labelContactPhone")}
                value={d?.organizer_contact_phone}
              />
            </div>
            <div className="mt-3 text-xs text-muted-foreground px-3">
              {t("organizerId", { id: selectedEvent.organizer_id ?? "" })}
            </div>
          </Section>
        </div>
      </div>

      {/* ── RIGHT: 페이지별 커스텀 패널 (1/3) ──── */}
      <div className="space-y-6">{rightPanel}</div>
    </div>
  );
}

export { CATEGORY_LABEL, SALE_MODE_LABEL };
export type { EventDetail };
