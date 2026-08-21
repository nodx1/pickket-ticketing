"use client";

import { formatKRW } from "@/lib/format";

interface KpiCard {
  label: string;
  value: number;
  kind: "currency" | "number" | "percent";
}

export function KpiCards({ items }: { items: KpiCard[] }) {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {items.map((item) => (
        <div key={item.label} className="rounded-lg border border-border bg-card/95 p-5">
          <p className="text-sm text-muted-foreground">{item.label}</p>
          <p className="mt-3 text-3xl font-black tracking-[-0.04em] text-foreground">
            {item.kind === "currency"
              ? formatKRW(item.value)
              : item.kind === "percent"
                ? `${item.value}%`
                : item.value.toLocaleString("ko-KR")}
          </p>
        </div>
      ))}
    </div>
  );
}
