"use client";

import Link from "next/link";
import { formatDate, formatKRW } from "@/lib/format";

interface RecentOrder {
  id: string;
  orderNumber: string;
  buyerName: string;
  paidAmount: number;
  orderedAt: string;
  status: string;
}

export function RecentOrders({
  eventId,
  items,
}: {
  eventId: string;
  items: RecentOrder[];
}) {
  return (
    <div className="rounded-lg border border-border bg-card/95 p-5">
      <h3 className="text-lg font-bold text-foreground">최근 주문</h3>
      <div className="mt-4 space-y-3">
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">아직 들어온 주문이 없습니다.</p>
        ) : items.map((item) => (
          <Link key={item.id} href={`/events/${eventId}/orders/${item.id}`} className="block rounded-lg border border-border bg-muted px-4 py-4 transition hover:border-primary/40 hover:bg-muted/35">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="font-semibold text-foreground">{item.buyerName}</p>
                <p className="mt-1 text-sm text-muted-foreground">{item.orderNumber}</p>
              </div>
              <div className="text-right">
                <p className="font-semibold text-foreground">{formatKRW(item.paidAmount)}</p>
                <p className="mt-1 text-sm text-muted-foreground">{formatDate(item.orderedAt)}</p>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
