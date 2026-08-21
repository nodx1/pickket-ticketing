import Image from "next/image";
import Link from "next/link";
import { CalendarDays, MapPin, Users } from "lucide-react";
import type { HomePageEvent } from "@/components/home/types";
import { fmt, fmtPrice } from "@/components/home/types";
import { SALE_MODE_LABELS } from "@pickket/lib/constants";
import { getTranslations } from "next-intl/server";

function getSaleModeBadge(mode: string | null, fallbackLabel: string) {
  if (!mode) return { label: fallbackLabel, color: "#0a0a0a" };
  return SALE_MODE_LABELS[mode] ?? { label: mode, color: "#0a0a0a" };
}

export default async function EventFeedCard({ event }: { event: HomePageEvent }) {
  const t = await getTranslations("event.feedCard");
  const saleBadge = getSaleModeBadge(event.primary_sale_mode, t("fairDistribution"));

  return (
    <Link
      href={`/events/${event.id}`}
      className="group overflow-hidden rounded-2xl border border-border dark:border-white/10 bg-background shadow-sm transition-all duration-300 hover:-translate-y-1 hover:shadow-md"
    >
      {/* Image */}
      <div className="relative aspect-[16/10] overflow-hidden">
        <Image
          src={event.thumbnail_url || "/placeholder.svg"}
          alt={event.title}
          fill
          sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
          className="object-cover transition-transform duration-500 group-hover:scale-105"
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
              <Users className="h-3 w-3" />
              {t("bidCount", { count: event.bid_count ?? 0, formatted: fmt(event.bid_count) })}
            </span>
          )}
        </div>

        {/* Bottom date */}
        <div className="absolute bottom-3 left-3 right-3 z-[2] flex items-end justify-between">
          <span className="text-white/80 text-xs font-semibold">
            {event.event_date_label}
          </span>
          {event.countdown_label && (
            <span className="py-1 px-2 rounded-md bg-white/15 text-white text-xs font-bold tabular-nums backdrop-blur-sm">
              {event.countdown_label}
            </span>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="p-4 space-y-3">
        <h3 className="text-lg font-bold leading-snug tracking-tight text-foreground line-clamp-2">
          {event.title}
        </h3>

        {/* Meta */}
        <div className="hidden md:grid gap-1.5 text-muted-foreground text-xs">
          <span className="inline-flex items-center gap-1.5">
            <CalendarDays className="h-3.5 w-3.5 text-primary" />
            {event.event_date_label}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <MapPin className="h-3.5 w-3.5 text-red-500" />
            {event.venue_name}
          </span>
        </div>

        {/* Price */}
        <div className="flex items-center justify-between gap-2 p-3 rounded-xl bg-muted/50 dark:bg-muted/20 border border-border dark:border-white/10">
          <div>
            <span className="block text-2xs text-muted-foreground font-semibold uppercase tracking-wider mb-0.5">
              {t("ticketPrice")}
            </span>
            <span className="text-xl font-black tracking-tight tabular-nums text-foreground">
              {fmtPrice(event.min_price)}
            </span>
          </div>
          <span
            className="text-xs font-bold px-2.5 py-1 rounded-full"
            style={{
              backgroundColor: `${saleBadge.color}15`,
              color: saleBadge.color,
            }}
          >
            {saleBadge.label}
          </span>
        </div>

        {/* Bid / seat info (only from real API data) */}
        {event.total_seats > 0 && (
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {t("participants", { formatted: fmt(event.bid_count ?? 0) })}
            </span>
            <span>
              {t("totalSeats", { formatted: fmt(event.total_seats ?? 0) })}
            </span>
          </div>
        )}
      </div>
    </Link>
  );
}
