"use client";

import Link from "next/link";
import Image from "next/image";
import { ChevronRight as ChevronR, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { formatKRW } from "@pickket/lib";
import type { Event } from "@pickket/lib/api";
import SectionEmptyState from "@/components/ui/SectionEmptyState";

/* ── Gradient palette for avatar placeholders ────────────────────────── */
const AVATAR_GRADIENTS = [
  "from-primary to-brand-lighter",
  "from-[#00C9A7] to-[#00877A]",
  "from-[#FF6B6B] to-[#EE5A24]",
  "from-[#404040] to-[#6D28D9]",
  "from-[#F59E0B] to-[#D97706]",
  "from-[#EC4899] to-[#BE185D]",
  "from-[#06B6D4] to-[#0891B2]",
  "from-[#10B981] to-[#059669]",
];

function getGradient(index: number): string {
  return AVATAR_GRADIENTS[index % AVATAR_GRADIENTS.length];
}

/* ── Badge logic ─────────────────────────────────────────────────────── */
function getBadge(
  event: Event,
  t: ReturnType<typeof useTranslations<"event.suggestedArtists">>
): { label: string; className: string } | null {
  if (event.bid_count > 10) {
    return { label: t("badgeTrending"), className: "text-emerald-600 dark:text-emerald-400" };
  }
  if (event.is_featured) {
    return { label: t("badgeFeatured"), className: "text-primary" };
  }
  if (event.bid_count > 5) {
    return { label: t("badgePopular"), className: "text-orange-600 dark:text-orange-400" };
  }
  const opensAt = new Date(event.bidding_opens_at).getTime();
  const now = Date.now();
  const fortyEightHours = 48 * 60 * 60 * 1000;
  if (Math.abs(now - opensAt) < fortyEightHours) {
    return { label: t("badgeNew"), className: "text-blue-600 dark:text-blue-400" };
  }
  return { label: t("badgeTrending"), className: "text-emerald-600 dark:text-emerald-400" };
}

/* ── Component — TickPick style horizontal cards ─────────────────────── */

interface SuggestedArtistsProps {
  events: Event[];
}

export default function SuggestedArtists({ events }: SuggestedArtistsProps) {
  const t = useTranslations("event.suggestedArtists");

  if (events.length === 0) {
    return (
      <section className="py-10">
        <div className="max-w-7xl mx-auto section-px">
          <SectionEmptyState
            icon={Sparkles}
            message={t("emptyMessage")}
            hint={t("emptyHint")}
          />
        </div>
      </section>
    );
  }

  return (
    <section className="py-10">
      <div className="max-w-7xl mx-auto section-px">
        {/* Header — "추천 아티스트" with AI badge */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <h2 className="text-3xl font-serif font-bold text-foreground">
              {t("sectionTitle")}
            </h2>
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-primary/8 text-primary text-xs-plus font-semibold">
              <svg className="h-3 w-3" viewBox="0 0 16 16" fill="none">
                <path
                  d="M8 1l1.8 3.6L14 5.3l-3 2.9.7 4.1L8 10.4l-3.7 1.9.7-4.1-3-2.9 4.2-.7L8 1z"
                  fill="currentColor"
                />
              </svg>
              {t("aiBadge")}
            </span>
          </div>
        </div>

        {/* 4-column grid of horizontal cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {events.slice(0, 8).map((event, index) => {
            const badge = getBadge(event, t);
            const displayName =
              event.subject_name || event.artist_name || event.title;
            const firstLetter = displayName.charAt(0).toUpperCase();

            return (
              <Link
                key={event.id}
                href={`/events/${event.id}`}
                className="flex items-center gap-3 px-4 py-3 rounded-xl shadow-[0_2px_8px_rgba(0,0,0,0.06)] border-0 bg-card hover:shadow-md transition-all group cursor-pointer"
              >
                {/* Circular photo — left */}
                <div className="w-12 h-12 rounded-full overflow-hidden shrink-0">
                  {event.image_url ? (
                    <Image
                      src={event.image_url}
                      alt={displayName}
                      width={48}
                      height={48}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div
                      className={`w-full h-full bg-gradient-to-br ${getGradient(index)} flex items-center justify-center`}
                    >
                      <span className="text-lg font-bold text-white">
                        {firstLetter}
                      </span>
                    </div>
                  )}
                </div>

                {/* Name + price + badge — center */}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-foreground truncate group-hover:text-primary transition-colors">
                    {displayName}
                  </p>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    {badge && (
                      <span
                        className={`text-xs font-medium ${badge.className}`}
                      >
                        {badge.label}
                      </span>
                    )}
                    {badge && event.min_price > 0 && (
                      <span className="text-muted-foreground">&middot;</span>
                    )}
                    {event.min_price > 0 && (
                      <span className="text-xs text-muted-foreground font-tabular">
                        {formatKRW(event.min_price)}~
                      </span>
                    )}
                  </div>
                </div>

                {/* Chevron arrow — right */}
                <ChevronR className="h-4 w-4 text-muted-foreground shrink-0 group-hover:text-primary transition-colors" />
              </Link>
            );
          })}
        </div>
      </div>
    </section>
  );
}
