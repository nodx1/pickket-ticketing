"use client";

import Link from "next/link";
import Image from "next/image";
import { ArrowRight, Ticket } from "lucide-react";
import { formatKRW } from "@pickket/lib";
import { formatDateShort } from "@pickket/lib";
import { getCategoryBySlug } from "@pickket/lib";
import type { Event } from "@pickket/lib/api";
import { useTranslations } from "next-intl";

/* ── Category gradients for ad banner fallback ───────────────────────── */
const AD_GRADIENTS: Record<string, string> = {
  concert: "linear-gradient(135deg, #FF416C 0%, #FF4B2B 100%)",
  musical: "linear-gradient(135deg, #11998E 0%, #38EF7D 100%)",
  sports: "linear-gradient(135deg, #4568DC 0%, #B06AB3 100%)",
  classical: "linear-gradient(135deg, #36D1DC 0%, #5B86E5 100%)",
  exhibition: "linear-gradient(135deg, #F7971E 0%, #FFD200 100%)",
  festival: "linear-gradient(135deg, #ED4264 0%, #FFEDBC 100%)",
};

interface PromoCardsProps {
  featuredEvents?: Event[];
}

function EventBanner({ event }: { event: Event }) {
  const t = useTranslations("marketing.promoCards");
  const adGradient =
    AD_GRADIENTS[event.category] ||
    "linear-gradient(135deg, #0A0E1A 0%, #0a0a0a 100%)";
  const categoryLabel =
    getCategoryBySlug(event.category)?.label || event.category;
  const isHot = event.bid_count > 1000;

  return (
    <Link
      href={`/events/${event.id}`}
      className="relative h-[260px] rounded-2xl overflow-hidden flex flex-col justify-between group"
    >
      {/* Background — image or gradient */}
      {event.image_url ? (
        <Image
          src={event.image_url}
          alt={event.title}
          fill
          sizes="(max-width: 768px) 100vw, 58vw"
          priority
          className="object-cover group-hover:scale-105 transition-transform duration-500"
        />
      ) : (
        <div className="absolute inset-0" style={{ background: adGradient }} />
      )}

      {/* Overlay */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/30 to-black/10" />

      {/* Top-left: category pill badge + optional HOT badge */}
      <div className="relative z-10 p-6 pb-0 flex items-center gap-2">
        <span className="inline-flex items-center px-3 py-1 rounded-full bg-white/20 backdrop-blur-sm text-white text-xs font-semibold border border-white/10">
          {categoryLabel}
        </span>
        {isHot && (
          <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-destructive text-white text-xs font-bold">
            <Ticket className="h-3 w-3" />
            HOT
          </span>
        )}
      </div>

      {/* Bottom content */}
      <div className="relative z-10 p-6 pt-0 flex items-end justify-between">
        {/* Bottom-left: artist name, venue, date */}
        <div className="flex-1 min-w-0">
          <h3 className="text-2xl font-bold text-white mb-1 leading-tight truncate">
            {event.subject_name || event.artist_name || event.title}
          </h3>
          <p className="text-white/70 text-sm mb-1">
            {event.venue}
            {event.location_city && ` · ${event.location_city}`}
          </p>
          <p className="text-white/50 text-xs">
            {formatDateShort(event.event_date)}
          </p>
        </div>

        {/* Bottom-right: price CTA + fee pill */}
        <div className="flex items-center gap-2 shrink-0 ml-4">
          <span className="text-xs-plus font-semibold text-cyan bg-cyan/20 px-2.5 py-1 rounded-full whitespace-nowrap">
            {t("transparentPrice")}
          </span>
          <span className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-full bg-white text-foreground text-sm font-semibold group-hover:bg-white/90 transition-colors whitespace-nowrap font-tabular">
            {t("priceFrom", { price: formatKRW(event.min_price ?? 0) })}
            <ArrowRight className="h-4 w-4" />
          </span>
        </div>
      </div>
    </Link>
  );
}

export default function PromoCards({ featuredEvents = [] }: PromoCardsProps) {
  if (featuredEvents.length === 0) return null;

  return (
    <section className="py-8">
      <div className="max-w-7xl mx-auto section-px">
        {featuredEvents.length >= 2 ? (
          <div className="grid grid-cols-1 md:grid-cols-[5fr_7fr] gap-5">
            <EventBanner event={featuredEvents[0]} />
            <EventBanner event={featuredEvents[1]} />
          </div>
        ) : (
          <EventBanner event={featuredEvents[0]} />
        )}
      </div>
    </section>
  );
}
