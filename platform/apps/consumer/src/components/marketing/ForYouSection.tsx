"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { ChevronLeft, ChevronRight, Sparkles, ArrowRight } from "lucide-react";
import EventCard from "@/components/event/EventCard";
import {
  getRecommendedEvents,
  getTrendingEvents,
  type Event,
} from "@pickket/lib/api";
import { useAuthStore } from "@pickket/store";

/* ── Shimmer placeholder cards ──────────────────────────────────────── */
function ShimmerCard() {
  return (
    <div className="w-[280px] shrink-0 h-[380px] rounded-2xl bg-card card-premium overflow-hidden">
      <div className="aspect-[4/3] relative bg-muted">
        <div className="absolute inset-0 shimmer" />
      </div>
      <div className="p-4 space-y-3">
        <div className="h-5 bg-muted rounded-lg w-3/4 relative overflow-hidden">
          <div className="absolute inset-0 shimmer" />
        </div>
        <div className="h-4 bg-muted rounded-lg w-1/2 relative overflow-hidden">
          <div className="absolute inset-0 shimmer" />
        </div>
        <div className="h-4 bg-muted rounded-lg w-2/3 relative overflow-hidden">
          <div className="absolute inset-0 shimmer" />
        </div>
      </div>
    </div>
  );
}

/* ── Branded empty state ────────────────────────────────────────────── */
function ForYouEmptyState() {
  const t = useTranslations("marketing.forYouSection");
  return (
    <div className="flex flex-col items-center justify-center py-12 px-4">
      <div className="relative mb-5">
        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-[#0a0a0a]/10 to-[#404040]/10 flex items-center justify-center">
          <Sparkles className="h-7 w-7 text-primary/40" />
        </div>
        <div className="absolute -inset-2 rounded-2xl border border-primary/5 animate-pulse-soft" />
      </div>
      <p className="text-sm font-medium text-muted-foreground text-center">
        {t("emptyTitle")}
      </p>
      <p className="text-xs text-muted-foreground/60 mt-1">
        {t("emptyDescription")}
      </p>
    </div>
  );
}

export default function ForYouSection() {
  const t = useTranslations("marketing.forYouSection");
  const { user } = useAuthStore();
  const [events, setEvents] = useState<Event[]>([]);
  const [subtitle, setSubtitle] = useState("");
  const [loading, setLoading] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const fetchEvents = async () => {
      try {
        if (user) {
          const res = await getRecommendedEvents();
          if (!cancelled) {
            setEvents(res.data);
            setSubtitle(t("subtitlePersonalized"));
          }
        } else {
          const res = await getTrendingEvents(10);
          if (!cancelled) {
            setEvents(res.data);
            setSubtitle(t("subtitleTrending"));
          }
        }
      } catch {
        // Fallback: show nothing or empty state
        if (!cancelled) setEvents([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchEvents();
    return () => {
      cancelled = true;
    };
  }, [user]);

  const scroll = useCallback((direction: "left" | "right") => {
    if (!scrollRef.current) return;
    const scrollAmount = 320;
    scrollRef.current.scrollBy({
      left: direction === "left" ? -scrollAmount : scrollAmount,
      behavior: "smooth",
    });
  }, []);

  if (loading) {
    return (
      <section className="space-y-5">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-primary" />
          <h2 className="text-2xl font-bold">For You</h2>
        </div>
        <div className="flex gap-4 overflow-hidden">
          {[1, 2, 3, 4].map((i) => (
            <ShimmerCard key={i} />
          ))}
        </div>
      </section>
    );
  }

  if (events.length === 0) {
    return (
      <section className="space-y-5">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-primary" />
          <h2 className="text-2xl font-bold">For You</h2>
        </div>
        <ForYouEmptyState />
      </section>
    );
  }

  return (
    <section className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            <h2 className="text-2xl font-bold">For You</h2>
          </div>
          {subtitle && (
            <p className="text-sm text-muted-foreground mt-1">{subtitle}</p>
          )}
        </div>
        <Link
          href={user ? "/events?tab=recommended" : "/events?tab=trending"}
          className="text-sm text-primary hover:text-primary/80 font-medium transition-colors flex items-center gap-1"
        >
          {t("viewMore")}
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>

      {/* Scrollable cards */}
      <div className="relative group">
        {/* Left arrow */}
        <button
          type="button"
          onClick={() => scroll("left")}
          className="absolute left-0 top-1/2 -translate-y-1/2 z-10 h-10 w-10 rounded-full bg-background/90 border border-border shadow-lg flex items-center justify-center hover:bg-background transition-all opacity-0 group-hover:opacity-100"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>

        <div
          ref={scrollRef}
          className="flex gap-4 overflow-x-auto scrollbar-hide scroll-smooth pb-2"
        >
          {events.map((event) => (
            <div key={event.id} className="w-[280px] shrink-0">
              <EventCard event={event} />
            </div>
          ))}
        </div>

        {/* Right arrow */}
        <button
          type="button"
          onClick={() => scroll("right")}
          className="absolute right-0 top-1/2 -translate-y-1/2 z-10 h-10 w-10 rounded-full bg-background/90 border border-border shadow-lg flex items-center justify-center hover:bg-background transition-all opacity-0 group-hover:opacity-100"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </section>
  );
}
