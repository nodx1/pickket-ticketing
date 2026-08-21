"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { formatDate, formatKRW } from "@/lib/format";

interface UpcomingEvent {
  id: string;
  title: string;
  status: string;
  startsAt: string;
  orderCount: number;
  revenue: number;
}

export function UpcomingEvents({ events }: { events: UpcomingEvent[] }) {
  if (events.length === 0) {
    return null;
  }

  return (
    <Card className="divide-y divide-border p-0">
      <div className="p-5 pb-3">
        <h3 className="text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          다가오는 이벤트
        </h3>
      </div>
      {events.map((event) => (
        <Link
          key={event.id}
          href={`/events/${event.id}/dashboard`}
          className="flex items-center justify-between gap-4 px-5 py-3 transition hover:bg-bg-muted"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="truncate text-sm font-medium text-foreground">{event.title}</p>
              <Badge
                variant={event.status === "live" ? "success" : "secondary"}
                className="shrink-0"
              >
                {event.status === "live" ? "진행중" : "초안"}
              </Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{formatDate(event.startsAt)}</p>
          </div>
          <div className="text-right">
            <p className="text-sm font-semibold text-foreground">{formatKRW(event.revenue)}</p>
            <p className="text-xs text-muted-foreground">{event.orderCount}건</p>
          </div>
        </Link>
      ))}
    </Card>
  );
}
