"use client";

import { ShoppingCart } from "lucide-react";
import Link from "next/link";
import { Card } from "@/components/ui/card";

interface ActivityItem {
  type: string;
  message: string;
  time: string;
  eventId: string;
}

export function RecentActivity({ items }: { items: ActivityItem[] }) {
  if (items.length === 0) {
    return (
      <Card className="p-6">
        <p className="text-sm text-muted-foreground">아직 활동 내역이 없습니다.</p>
      </Card>
    );
  }

  return (
    <Card className="divide-y divide-border p-0">
      <div className="p-5 pb-3">
        <h3 className="text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          최근 활동
        </h3>
      </div>
      {items.map((item, index) => (
        <Link
          key={`${item.eventId}-${index}`}
          href={`/events/${item.eventId}/orders`}
          className="flex items-center gap-3 px-5 py-3 transition hover:bg-bg-muted"
        >
          <div className="flex size-8 items-center justify-center rounded-xl bg-primary/15">
            <ShoppingCart className="size-4 text-primary" />
          </div>
          <p className="flex-1 text-sm text-foreground">{item.message}</p>
          <span className="text-xs text-muted-foreground">{item.time}</span>
        </Link>
      ))}
    </Card>
  );
}
