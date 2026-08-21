"use client";

import Link from "next/link";
import { SearchX, Ticket } from "lucide-react";
import { Button } from "@pickket/ui";
import { useQuery } from "@tanstack/react-query";
import { getTrendingEvents, type Event } from "@pickket/lib/api";
import EventCard from "@/components/event/EventCard";
import { useTranslations } from "next-intl";

interface EmptyStateProps {
  hasQuery: boolean;
}

export default function EmptyState({ hasQuery }: EmptyStateProps) {
  const t = useTranslations("event.emptyState");
  const { data: trending } = useQuery({
    queryKey: ["events", "trending"],
    queryFn: async () => {
      const res = await getTrendingEvents(3);
      return res.data;
    },
    staleTime: 5 * 60 * 1000,
  });

  const trendingEvents = (Array.isArray(trending) ? trending : []) as Event[];

  return (
    <div className="text-center py-24">
      {hasQuery ? (
        <>
          <SearchX className="h-12 w-12 text-muted-foreground/30 mx-auto mb-4" />
          <p className="text-lg text-muted-foreground">{t("noResults")}</p>
          <p className="text-sm text-muted-foreground/60 mt-1 mb-6">
            {t("noResultsHint")}
          </p>
          <div className="flex justify-center gap-3">
            <Button variant="outline" className="rounded-full" asChild>
              <Link href="/events">{t("viewAll")}</Link>
            </Button>
          </div>
        </>
      ) : (
        <>
          <Ticket className="h-12 w-12 text-muted-foreground/30 mx-auto mb-4" />
          <p className="text-lg text-muted-foreground">
            {t("noEvents")}
          </p>
          <p className="text-sm text-muted-foreground/60 mt-1">
            {t("noEventsSoon")}
          </p>
        </>
      )}

      {trendingEvents.length > 0 && (
        <div className="mt-12 text-left">
          <h3 className="text-lg font-bold text-foreground mb-4">
            {t("trending")}
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-6">
            {trendingEvents.map((event) => (
              <EventCard key={event.id} event={event} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
