"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  CalendarDays,
  MapPin,
  MessageCircle,
  Clock,
  Share2,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { blurhashToDataURL } from "@pickket/lib";
import { SALE_MODE_LABELS } from "@pickket/lib/constants";
import type { Event } from "@pickket/lib/api";
import { getSampleThumb } from "@/lib/sample-posters";
import { useCurrentPhase } from "@/hooks/useCurrentPhase";

function getSaleModeBadge(
  mode: string | null | undefined,
  fairDistLabel: string,
) {
  if (!mode) return { label: fairDistLabel, color: "#0a0a0a" };
  return SALE_MODE_LABELS[mode] ?? { label: mode, color: "#0a0a0a" };
}

/** pickket.go sale_phase.mode → 카드 배지 색상 (라벨은 컴포넌트 내 t()로) */
const GO_PHASE_BADGE_COLOR: Record<string, string> = {
  membership_presale: "#4ECDC4",
  lottery: "#6c5ce7",
  queue_sale: "#fdcb6e",
  fcfs_residual: "#00d2a0",
};

function fmt(n: number) {
  return n >= 10000
    ? `${(n / 10000).toFixed(n % 10000 === 0 ? 0 : 1)}만`
    : n >= 1000
      ? `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}천`
      : String(n);
}

function formatDate(dateStr: string, locale: string): string {
  // Intl.DateTimeFormat with KST timezone for locale-aware formatting
  return new Intl.DateTimeFormat(locale, {
    timeZone: "Asia/Seoul",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(new Date(dateStr));
}

type TimeRemaining =
  | { type: "days"; days: number; hours: number }
  | { type: "hours"; hours: number; minutes: number };

function getTimeRemaining(
  closesAt: string | null | undefined,
): TimeRemaining | null {
  if (!closesAt) return null;
  const diff = new Date(closesAt).getTime() - Date.now();
  if (diff <= 0) return null;
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return { type: "days", days, hours: hours % 24 };
  }
  return { type: "hours", hours, minutes };
}

export default function EventCardUnified({ event }: { event: Event }) {
  const locale = useLocale();
  const t = useTranslations("event.card");
  // pickket.go 현재 phase 조회 (있으면 우선, 없으면 기존 saleMode 폴백)
  const { data: phaseData } = useCurrentPhase(event.id);
  const goCurrent = phaseData?.current;
  const goBadge =
    goCurrent && goCurrent.status === "open"
      ? {
          label: t(`goPhase.${goCurrent.mode}`),
          color: GO_PHASE_BADGE_COLOR[goCurrent.mode] ?? "#0a0a0a",
        }
      : null;
  const saleBadge =
    goBadge ?? getSaleModeBadge(event.primary_sale_mode ?? event.sale_mode, t("fairDist"));
  const competitionPercent =
    event.total_seats > 0
      ? Math.min(100, Math.round((event.bid_count / event.total_seats) * 100))
      : 0;
  const gaugeColor =
    competitionPercent >= 80
      ? "#ef4444"
      : competitionPercent >= 50
        ? "#0a0a0a"
        : "#047857";

  const imageUrl = event.image_variants?.thumb_md ?? event.image_url;
  const blurDataURL = blurhashToDataURL(event.blurhash);
  // mounted 후에만 카운트다운 계산 — Date.now() SSR vs client mismatch 방지 (#418).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const timeRemaining =
    mounted && event.status === "bidding_open"
      ? getTimeRemaining(event.bidding_closes_at)
      : null;

  return (
    <Link
      href={`/events/${event.id}`}
      data-testid="event-card"
      className="group overflow-hidden rounded-2xl border border-border dark:border-white/10 bg-background shadow-sm transition-all duration-300 hover:-translate-y-1 hover:shadow-md"
      aria-label={`${event.title} — ${formatDate(event.event_date, locale)}`}
    >
      {/* Image */}
      <div className="relative aspect-[16/10] overflow-hidden">
        <Image
          src={imageUrl || getSampleThumb(event.id)}
          alt={event.title}
          fill
          sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
          className="object-cover transition-transform duration-500 group-hover:scale-105"
          {...(blurDataURL
            ? { placeholder: "blur" as const, blurDataURL }
            : {})}
        />
        <div className="absolute inset-0 bg-linear-to-t from-black/60 to-transparent" />

        {/* Top badges */}
        <div className="absolute top-3 left-3 right-3 z-[2] flex items-start justify-between gap-2">
          <span
            className="inline-flex items-center gap-1 py-1 px-2.5 rounded-full text-xs font-bold backdrop-blur-sm"
            style={{
              backgroundColor: `${saleBadge.color}22`,
              borderColor: `${saleBadge.color}44`,
              color: saleBadge.color,
              border: `1px solid ${saleBadge.color}44`,
            }}
          >
            {saleBadge.label}
          </span>
          {event.bid_count > 0 && (
            <span className="inline-flex items-center gap-1.5 py-1 px-2.5 rounded-full bg-black/40 text-white text-xs font-bold backdrop-blur-sm">
              <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
              {t('participating', { count: fmt(event.bid_count ?? 0) })}
            </span>
          )}
        </div>

        {/* Bottom: date + countdown */}
        <div className="absolute bottom-3 left-3 right-3 z-[2] flex items-end justify-between">
          <span className="text-white/80 text-xs font-semibold">
            {formatDate(event.event_date, locale)}
          </span>
          {timeRemaining && (
            <span
              className="py-1 px-2 rounded-md bg-white/15 text-white text-xs font-bold tabular-nums backdrop-blur-sm flex items-center gap-1"
              suppressHydrationWarning
            >
              <Clock className="h-3 w-3" />
              {timeRemaining.type === "days"
                ? t("countdown.days", { days: timeRemaining.days, hours: timeRemaining.hours })
                : t("countdown.hours", { hours: timeRemaining.hours, minutes: timeRemaining.minutes })}
            </span>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="p-4 space-y-3">
        <h3 className="text-lg font-bold leading-snug tracking-tight text-foreground truncate">
          {event.title}
        </h3>

        {/* Meta */}
        <div className="grid gap-1.5 text-muted-foreground text-xs">
          <span className="inline-flex items-center gap-1.5">
            <CalendarDays className="h-3.5 w-3.5 text-primary" />
            {formatDate(event.event_date, locale)}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <MapPin className="h-3.5 w-3.5 text-red-500" />
            {event.venue}
            {event.location_city ? ` · ${event.location_city}` : ""}
          </span>
        </div>

        {/* Competition gauge */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">{t('competitionRate')}</span>
            <span
              className="font-bold tabular-nums"
              style={{ color: gaugeColor }}
            >
              {competitionPercent}%
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-700"
              style={{
                width: `${competitionPercent}%`,
                backgroundColor: gaugeColor,
              }}
            />
          </div>
        </div>

        {/* Community bar */}
        <div className="flex items-center justify-between pt-1">
          <div className="inline-flex items-center gap-2">
            <span className="text-muted-foreground text-xs">
              {t('interested', { count: fmt(event.bid_count ?? 0) })}
            </span>
          </div>
          <div className="flex items-center gap-2 text-muted-foreground text-xs">
            <span className="inline-flex items-center gap-1 hover:text-foreground transition-colors">
              <MessageCircle className="h-3.5 w-3.5" />
              {event.comment_count ?? 0}
            </span>
            <span className="inline-flex items-center gap-1 hover:text-foreground transition-colors">
              <Share2 className="h-3.5 w-3.5" />
            </span>
          </div>
        </div>

        <p className="text-xs text-muted-foreground pt-1">
          {t('tagline')}
        </p>
      </div>
    </Link>
  );
}
