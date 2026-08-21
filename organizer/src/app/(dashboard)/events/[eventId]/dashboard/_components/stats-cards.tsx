"use client";

import { formatKRW } from "@/lib/format";

export function StatsCards({
  totalRevenue,
  totalOrders,
  totalAttendees,
  checkInRate,
}: {
  totalRevenue: number;
  totalOrders: number;
  totalAttendees: number;
  checkInRate: number;
}) {
  const items = [
    { label: "총 매출", value: formatKRW(totalRevenue) },
    { label: "총 주문", value: totalOrders.toLocaleString("ko-KR") },
    { label: "참석자", value: totalAttendees.toLocaleString("ko-KR") },
    { label: "체크인율", value: `${checkInRate}%` },
  ];

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {items.map((item) => (
        <div key={item.label} className="rounded-lg border border-border bg-card/95 p-5">
          <p className="text-sm text-muted-foreground">{item.label}</p>
          <p className="mt-3 text-3xl font-black tracking-[-0.04em] text-foreground">{item.value}</p>
        </div>
      ))}
    </div>
  );
}
