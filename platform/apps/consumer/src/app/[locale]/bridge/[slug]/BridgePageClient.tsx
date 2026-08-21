"use client";

import Link from "next/link";
import { Calendar, MapPin, Ticket } from "lucide-react";
import { useTranslations } from "next-intl";

interface BridgePageEvent {
  id: string;
  title: string;
  image_url: string | null;
  venue_name: string | null;
  event_date: string | null;
  min_price: number | null;
  max_price: number | null;
  status: string;
  subdomain: string | null;
}

interface BridgePageData {
  id: string;
  title: string;
  slug: string;
  content: string | null;
  images: string | null;
  is_active: boolean;
  events: BridgePageEvent[];
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "";
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString("ko-KR", {
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "short",
    });
  } catch {
    return dateStr;
  }
}

function formatPrice(min: number | null, max: number | null): string {
  if (min == null && max == null) return "";
  const fmt = (n: number) => n.toLocaleString("ko-KR");
  if (min != null && max != null && min !== max) {
    return `${fmt(min)} ~ ${fmt(max)}원`;
  }
  if (min != null) return `${fmt(min)}원`;
  if (max != null) return `~${fmt(max)}원`;
  return "";
}

function getEventLink(event: BridgePageEvent): string {
  if (event.subdomain) {
    return `/s/${event.subdomain}`;
  }
  return `/events/${event.id}`;
}

export function BridgePageClient({
  bridgePage,
}: {
  bridgePage: BridgePageData;
}) {
  const t = useTranslations("bridge.page");
  // Parse images JSON if present
  let headerImages: string[] = [];
  if (bridgePage.images) {
    try {
      headerImages = JSON.parse(bridgePage.images);
    } catch {
      // ignore
    }
  }

  return (
    <div className="min-h-screen bg-background pt-20">
      {/* Header */}
      <section className="relative overflow-hidden bg-gradient-to-br from-indigo-600/80 via-violet-600/70 to-fuchsia-500/60">
        {/* Header image */}
        {headerImages.length > 0 && (
          <div
            className="absolute inset-0 bg-cover bg-center opacity-30"
            style={{ backgroundImage: `url(${headerImages[0]})` }}
          />
        )}
        <div className="relative z-10 max-w-4xl mx-auto px-6 py-16 md:py-24 text-center">
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/10 backdrop-blur-sm text-xs-plus font-bold tracking-widest text-white/70 uppercase mb-6">
            Pickket Collection
          </span>
          <h1 className="text-3xl md:text-5xl font-extrabold text-white leading-tight mb-4">
            {bridgePage.title}
          </h1>
          {bridgePage.content && (
            <p className="text-base md:text-lg text-white/60 max-w-2xl mx-auto leading-relaxed">
              {bridgePage.content}
            </p>
          )}
        </div>
        <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-background to-transparent" />
      </section>

      {/* Events grid */}
      <section className="max-w-5xl mx-auto px-6 py-12">
        {bridgePage.events.length === 0 ? (
          <div className="text-center py-20">
            <Ticket className="w-12 h-12 text-muted-foreground/40 mx-auto mb-4" />
            <p className="text-muted-foreground">
              {t("noEvents")}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {bridgePage.events.map((event) => (
              <Link
                key={event.id}
                href={getEventLink(event)}
                className="group block rounded-2xl overflow-hidden bg-card border border-border hover:shadow-xl hover:-translate-y-1 transition-all duration-300"
              >
                {/* Image */}
                <div className="aspect-[4/3] relative bg-muted overflow-hidden">
                  {event.image_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={event.image_url}
                      alt={event.title}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-indigo-500/20 to-violet-500/20">
                      <Ticket className="w-10 h-10 text-muted-foreground/30" />
                    </div>
                  )}
                  {/* Status badge */}
                  {event.status === "bidding_open" && (
                    <span className="absolute top-3 right-3 px-2.5 py-0.5 rounded-full bg-emerald-500/90 text-white text-xs-plus font-bold">
                      {t("statusBiddingOpen")}
                    </span>
                  )}
                </div>

                {/* Info */}
                <div className="p-5 space-y-3">
                  <h3 className="text-base font-bold text-foreground leading-snug line-clamp-2 group-hover:text-primary transition-colors">
                    {event.title}
                  </h3>

                  {event.event_date && (
                    <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                      <Calendar className="w-3.5 h-3.5 shrink-0" />
                      <span>{formatDate(event.event_date)}</span>
                    </div>
                  )}

                  {event.venue_name && (
                    <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                      <MapPin className="w-3.5 h-3.5 shrink-0" />
                      <span className="truncate">{event.venue_name}</span>
                    </div>
                  )}

                  {(event.min_price != null || event.max_price != null) && (
                    <p className="text-sm font-semibold text-primary">
                      {formatPrice(event.min_price, event.max_price)}
                    </p>
                  )}

                  {/* CTA */}
                  <div className="pt-1">
                    <span className="inline-flex items-center gap-1 text-sm font-medium text-primary group-hover:underline">
                      <Ticket className="w-3.5 h-3.5" />
                      {t("viewDetails")}
                    </span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* Footer */}
      <footer className="max-w-5xl mx-auto px-6 pb-12 text-center">
        <p className="text-xs text-muted-foreground/50">Powered by Pickket</p>
      </footer>
    </div>
  );
}
