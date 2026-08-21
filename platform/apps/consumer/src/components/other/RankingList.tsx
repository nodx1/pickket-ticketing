"use client";

import Link from "next/link";
import { Badge } from "@pickket/ui";
import { BarChart3 } from "lucide-react";
import { getStatusLabel } from "@pickket/lib";
import type { RankingEvent } from "@pickket/lib/api";
import { useTranslations } from "next-intl";

function RankChangeIndicator({
  change,
  isNew,
}: {
  change: number | null;
  isNew: boolean;
}) {
  if (isNew) {
    return (
      <span className="text-2xs font-bold text-primary bg-primary/10 px-1.5 py-0.5 rounded">
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
      <span className="text-2xs font-bold text-green-600 dark:text-green-400 flex items-center gap-0.5">
        <span className="text-2xs">&#9650;</span>
        {change}
      </span>
    );
  }

  return (
    <span className="text-2xs font-bold text-red-500 flex items-center gap-0.5">
      <span className="text-2xs">&#9660;</span>
      {Math.abs(change)}
    </span>
  );
}

/* ── Branded empty state for ranking ────────────────────────────────── */
function RankingEmptyState() {
  const t = useTranslations("event.rankingList");
  return (
    <div className="flex flex-col items-center justify-center py-10 px-4">
      <div className="relative mb-4">
        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-primary/10 to-brand-lighter/10 flex items-center justify-center">
          <BarChart3 className="h-7 w-7 text-primary/40" />
        </div>
        {/* Animated decorative rings */}
        <div className="absolute -inset-2 rounded-2xl border border-primary/5 animate-pulse-soft" />
        <div
          className="absolute -inset-4 rounded-3xl border border-primary/3 animate-pulse-soft"
          style={{ animationDelay: "0.5s" }}
        />
      </div>
      <p className="text-sm font-medium text-muted-foreground text-center">
        {t("emptyTitle")}
      </p>
      <p className="text-xs text-muted-foreground/60 mt-1">
        {t("emptySubtitle")}
      </p>
    </div>
  );
}

/* Rank number styling — top 3 get special treatment */
function RankNumber({ rank }: { rank: number }) {
  if (rank <= 3) {
    const colors = [
      "from-[#FFD700] to-[#FFA500]", // Gold
      "from-[#C0C0C0] to-[#A0A0A0]", // Silver
      "from-[#CD7F32] to-[#B8651A]", // Bronze
    ];
    return (
      <span
        className={`w-7 h-7 rounded-lg bg-gradient-to-br ${colors[rank - 1]} flex items-center justify-center text-white text-xs font-bold shrink-0 shadow-sm`}
      >
        {rank}
      </span>
    );
  }

  return (
    <span className="w-7 h-7 flex items-center justify-center text-sm font-bold text-muted-foreground shrink-0">
      {rank}
    </span>
  );
}

interface RankingListProps {
  events: RankingEvent[];
  showStatus?: boolean;
}

export default function RankingList({
  events,
  showStatus = true,
}: RankingListProps) {
  const t = useTranslations("event.rankingList");

  if (events.length === 0) {
    return <RankingEmptyState />;
  }

  return (
    <div className="divide-y divide-border/60">
      {events.map((event) => (
        <Link
          key={event.id}
          href={`/events/${event.id}`}
          className="flex items-center gap-3 py-3.5 px-2 hover:bg-accent/50 rounded-lg transition-colors group"
        >
          {/* Rank number */}
          <RankNumber rank={event.rank} />

          {/* Rank change */}
          <div className="w-10 text-center shrink-0">
            <RankChangeIndicator
              change={event.rank_change}
              isNew={event.is_new}
            />
          </div>

          {/* Event info */}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate group-hover:text-primary transition-colors">
              {event.title}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("participantCount", { count: event.bid_count ?? 0 })}
            </p>
          </div>

          {/* Status badge */}
          {showStatus && (
            <Badge variant="outline" className="shrink-0 text-2xs">
              {getStatusLabel(event.status)}
            </Badge>
          )}
        </Link>
      ))}
    </div>
  );
}
