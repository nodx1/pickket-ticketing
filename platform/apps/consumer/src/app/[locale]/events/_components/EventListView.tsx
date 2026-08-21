"use client";

import Image from "next/image";
import Link from "next/link";
import { CalendarDays, MapPin, Users } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { formatCurrency, blurhashToDataURL } from "@pickket/lib";
import { SALE_MODE_LABELS } from "@pickket/lib/constants";
import type { Event } from "@pickket/lib/api";

function getSaleModeBadge(
  mode: string | null | undefined,
  fallbackLabel: string,
) {
  if (!mode) return { label: fallbackLabel, color: "#0a0a0a" };
  return SALE_MODE_LABELS[mode] ?? { label: mode, color: "#0a0a0a" };
}

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

function SkeletonRow() {
  return (
    <div className="flex gap-4 rounded-2xl border border-border dark:border-white/10 bg-background p-3 animate-pulse">
      <div className="w-40 h-28 rounded-xl bg-muted shrink-0" />
      <div className="flex-1 space-y-2 py-1">
        <div className="h-5 bg-muted rounded w-3/4" />
        <div className="h-3.5 bg-muted rounded w-1/2" />
        <div className="h-3.5 bg-muted rounded w-1/3" />
        <div className="h-5 bg-muted rounded w-1/4" />
      </div>
    </div>
  );
}

interface EventListViewProps {
  events: Event[];
  isLoading: boolean;
}

export default function EventListView({
  events,
  isLoading,
}: EventListViewProps) {
  const locale = useLocale();
  const t = useTranslations("event.listView");

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <SkeletonRow key={i} />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {events.map((event) => {
        const saleBadge = getSaleModeBadge(
          event.primary_sale_mode ?? event.sale_mode,
          event.primary_sale_mode ?? event.sale_mode ?? "",
        );
        const imageUrl = event.image_variants?.thumb_md ?? event.image_url;
        const blurDataURL = blurhashToDataURL(event.blurhash);
        const competitionPercent =
          event.total_seats > 0
            ? Math.min(
                100,
                Math.round((event.bid_count / event.total_seats) * 100),
              )
            : 0;
        const gaugeColor =
          competitionPercent >= 80
            ? "#ef4444"
            : competitionPercent >= 50
              ? "#0a0a0a"
              : "#10b981";

        return (
          <Link
            key={event.id}
            href={`/events/${event.id}`}
            data-testid="event-card"
            className="group flex gap-4 overflow-hidden rounded-2xl border border-border dark:border-white/10 bg-background transition-all duration-300 hover:-translate-y-0.5 hover:shadow-md p-3"
          >
            {/* 썸네일 */}
            <div className="relative w-40 h-28 sm:w-48 sm:h-32 rounded-xl overflow-hidden shrink-0">
              {imageUrl ? (
                <Image
                  src={imageUrl}
                  alt={event.title}
                  fill
                  sizes="200px"
                  className="object-cover group-hover:scale-105 transition-transform duration-500"
                  {...(blurDataURL
                    ? { placeholder: "blur" as const, blurDataURL }
                    : {})}
                />
              ) : (
                <div className="absolute inset-0 bg-gradient-to-br from-primary via-violet-500 to-cyan-500" />
              )}
              <span
                className="absolute top-2 left-2 px-2 py-0.5 rounded-full text-xs font-bold backdrop-blur-sm"
                style={{
                  backgroundColor: `${saleBadge.color}22`,
                  color: saleBadge.color,
                  border: `1px solid ${saleBadge.color}44`,
                }}
              >
                {saleBadge.label}
              </span>
            </div>

            {/* 정보 */}
            <div className="flex-1 min-w-0 flex flex-col justify-between py-0.5">
              <div>
                <h3 className="text-base font-bold text-foreground truncate group-hover:text-primary transition-colors">
                  {event.title}
                </h3>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-1">
                  <CalendarDays className="h-3 w-3 text-primary shrink-0" />
                  {formatDate(event.event_date, locale)}
                </div>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-0.5">
                  <MapPin className="h-3 w-3 text-red-500 shrink-0" />
                  <span className="truncate">
                    {event.venue}
                    {event.location_city ? ` · ${event.location_city}` : ""}
                  </span>
                </div>
              </div>

              <div className="flex items-center justify-between mt-2">
                <div className="flex items-center gap-3">
                  <span className="text-base font-black tabular-nums text-foreground">
                    {event.is_free ||
                    (event.min_price === 0 && event.is_public_sector)
                      ? t("free")
                      : formatCurrency(
                          event.min_price,
                          event.currency || "KRW",
                        )}
                  </span>
                  <div className="hidden sm:flex items-center gap-1.5">
                    <div className="w-16 h-1.5 rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${competitionPercent}%`,
                          backgroundColor: gaugeColor,
                        }}
                      />
                    </div>
                    <span
                      className="text-2xs tabular-nums font-bold"
                      style={{ color: gaugeColor }}
                    >
                      {competitionPercent}%
                    </span>
                  </div>
                </div>
                {event.bid_count > 0 && (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Users className="h-3 w-3" />
                    {t("bidCount", { count: fmt(event.bid_count ?? 0) })}
                  </span>
                )}
              </div>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
