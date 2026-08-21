"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import Image from "next/image";
import { Trophy, Users, ChevronRight, Medal } from "lucide-react";
import { Badge } from "@pickket/ui";
import { getRankingEvents, type RankingEvent } from "@pickket/lib/api";
import { CATEGORIES } from "@pickket/lib";
import { getStatusLabel } from "@pickket/lib";

const PERIOD_VALUES = ["realtime", "weekly", "monthly"] as const;

function RankChangeIndicator({
  change,
  isNew,
}: {
  change: number | null;
  isNew: boolean;
}) {
  if (isNew) {
    return (
      <span className="text-2xs font-bold text-primary/70 bg-primary/10 px-1.5 py-0.5 rounded-full">
        NEW
      </span>
    );
  }

  if (change === null || change === 0) {
    return (
      <span className="text-xs text-muted-foreground font-medium">&mdash;</span>
    );
  }

  if (change > 0) {
    return (
      <span className="text-xs font-bold text-primary/70 flex items-center gap-0.5">
        <span className="text-2xs">&#9650;</span>
        {change}
      </span>
    );
  }

  return (
    <span className="text-xs font-bold text-red-500 flex items-center gap-0.5">
      <span className="text-2xs">&#9660;</span>
      {Math.abs(change)}
    </span>
  );
}

function SkeletonRow() {
  return (
    <div className="rounded-2xl shadow-lg p-4">
      <div className="flex items-center gap-4">
        <div className="w-8 h-6 bg-white/5 rounded animate-pulse" />
        <div className="w-10 h-5 bg-white/5 rounded animate-pulse" />
        <div className="w-12 h-12 bg-white/5 rounded-xl animate-pulse shrink-0" />
        <div className="flex-1 space-y-2">
          <div className="h-4 bg-white/5 rounded animate-pulse w-2/3" />
          <div className="h-3 bg-white/5 rounded animate-pulse w-1/3" />
        </div>
        <div className="w-16 h-5 bg-white/5 rounded animate-pulse" />
      </div>
    </div>
  );
}

function getStatusVariant(
  status: string,
): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "bidding_open":
      return "default";
    case "allocated":
    case "completed":
      return "secondary";
    case "cancelled":
      return "destructive";
    default:
      return "outline";
  }
}

function getMedalColor(rank: number): string {
  if (rank === 1) return "text-amber-500";
  if (rank === 2) return "text-muted-foreground";
  if (rank === 3) return "text-amber-700";
  return "";
}

export default function RankingPage() {
  const t = useTranslations("ranking");
  const [period, setPeriod] = useState("realtime");
  const [category, setCategory] = useState("");
  const [events, setEvents] = useState<RankingEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchRanking = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getRankingEvents(
        period || undefined,
        category || undefined,
      );
      setEvents(Array.isArray(res.data) ? res.data : []);
    } catch {
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, [period, category]);

  useEffect(() => {
    fetchRanking();
  }, [fetchRanking]);

  return (
    <main className="bg-background min-h-screen max-w-4xl mx-auto space-y-6 px-5 pt-20 pb-5 lg:px-6 lg:pb-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <Trophy className="h-7 w-7 text-primary/70" aria-hidden="true" />
          {t("title")}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {t("subtitle")}
        </p>
      </div>

      {/* Period tabs - pill toggle */}
      <div className="flex gap-1 bg-white/5 rounded-full p-1 w-fit">
        {PERIOD_VALUES.map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setPeriod(v)}
            className={`px-4 py-2 rounded-full text-sm font-medium transition-all duration-200 ${
              period === v
                ? "bg-primary text-white shadow-md"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t(`period.${v}`)}
          </button>
        ))}
      </div>

      {/* Category filter tabs - pill button bar */}
      <div className="overflow-x-auto -mx-4 px-4 scrollbar-hide">
        <div className="flex gap-1.5 min-w-max">
          <button
            type="button"
            onClick={() => setCategory("")}
            className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all duration-200 whitespace-nowrap ${
              category === ""
                ? "bg-primary text-white shadow-sm"
                : "bg-white/5 hover:bg-white/10 text-foreground"
            }`}
          >
            {t("categoryAll")}
          </button>
          {CATEGORIES.map((cat) => (
            <button
              key={cat.slug}
              type="button"
              onClick={() => setCategory(cat.slug)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all duration-200 whitespace-nowrap ${
                category === cat.slug
                  ? "bg-primary text-white shadow-sm"
                  : "bg-white/5 hover:bg-white/10 text-foreground"
              }`}
            >
              {cat.label}
            </button>
          ))}
        </div>
      </div>

      {/* Ranking list - individual cards */}
      <div>
        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 10 }).map((_, i) => (
              <SkeletonRow key={i} />
            ))}
          </div>
        ) : events.length > 0 ? (
          <div className="space-y-3">
            {events.map((event) => (
              <Link
                key={event.id}
                href={`/events/${event.id}`}
                className="block rounded-2xl bg-card shadow-sm hover:shadow-xl hover:-translate-y-1 transition-all duration-200 group"
              >
                <div className="flex items-center gap-4 p-4">
                  {/* Rank number with medal for top 3 */}
                  <div className="w-8 text-center shrink-0">
                    {event.rank <= 3 ? (
                      <Medal
                        className={`h-6 w-6 mx-auto ${getMedalColor(event.rank)}`}
                      />
                    ) : (
                      <span className="font-bold text-lg text-muted-foreground">
                        {event.rank}
                      </span>
                    )}
                  </div>

                  {/* Rank change */}
                  <div className="w-10 text-center shrink-0">
                    <RankChangeIndicator
                      change={event.rank_change}
                      isNew={event.is_new}
                    />
                  </div>

                  {/* Thumbnail */}
                  <div className="w-12 h-12 rounded-xl overflow-hidden bg-white/5 shrink-0">
                    {event.image_url || event.thumbnail_url ? (
                      <Image
                        src={(event.thumbnail_url || event.image_url)!}
                        alt={event.title}
                        width={48}
                        height={48}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-muted-foreground text-xs font-bold">
                        {event.title.charAt(0)}
                      </div>
                    )}
                  </div>

                  {/* Event info */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold truncate group-hover:text-primary/70 transition-colors">
                      {event.title}
                    </p>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                      {event.artist_name && <span>{event.artist_name}</span>}
                      {event.artist_name && event.venue && <span>·</span>}
                      <span className="truncate">{event.venue}</span>
                    </div>
                  </div>

                  {/* Participants */}
                  <div className="flex items-center gap-1 text-xs text-muted-foreground shrink-0">
                    <Users className="h-3.5 w-3.5" />
                    <span className="font-medium">
                      {t("bidCount", { count: event.bid_count ?? 0 })}
                    </span>
                  </div>

                  {/* Status */}
                  <Badge
                    variant={getStatusVariant(event.status)}
                    className="shrink-0 text-2xs rounded-full"
                  >
                    {getStatusLabel(event.status)}
                  </Badge>

                  <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <div className="rounded-2xl shadow-lg text-center py-16">
            <Trophy className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">
              {t("empty")}
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
