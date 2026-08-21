"use client";

import type { Event } from "@pickket/lib/api";
import EventCardUnified from "@/components/event/EventCardUnified";

function SkeletonCard() {
  return (
    <div className="rounded-2xl border border-border dark:border-white/10 bg-background overflow-hidden">
      <div className="aspect-[16/10] bg-muted animate-pulse" />
      <div className="p-4 space-y-3">
        <div className="h-5 bg-muted rounded animate-pulse w-3/4" />
        <div className="space-y-2">
          <div className="h-3.5 bg-muted rounded animate-pulse w-1/2" />
          <div className="h-3.5 bg-muted rounded animate-pulse w-2/3" />
        </div>
        <div className="h-12 bg-muted rounded-xl animate-pulse" />
        <div className="h-1.5 bg-muted rounded-full animate-pulse" />
      </div>
    </div>
  );
}

interface EventGridProps {
  events: Event[];
  isLoading: boolean;
}

export default function EventGrid({ events, isLoading }: EventGridProps) {
  if (isLoading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-6">
      {events.map((event) => (
        <EventCardUnified key={event.id} event={event} />
      ))}
    </div>
  );
}
