"use client";

import { TrendingDown, TrendingUp } from "lucide-react";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { Card } from "@/components/ui/card";
import { formatKRW } from "@/lib/format";

interface WeekData {
  revenueTotal: number;
  orderTotal: number;
  revenueVsLastWeek: string;
}

export function WeekSummary({ data }: { data: WeekData }) {
  const isPositive = data.revenueVsLastWeek.startsWith("+");
  const isNeutral = data.revenueVsLastWeek === "0%";

  return (
    <Card className="p-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            이번 주 매출
          </p>
          <p className="mt-2 text-3xl font-black tracking-[-0.04em] text-foreground">
            <AnimatedNumber value={data.revenueTotal} formatter={formatKRW} />
          </p>
        </div>
        {!isNeutral ? (
          <div
            className={`flex items-center gap-1 rounded-full px-3 py-1.5 text-sm font-semibold ${
              isPositive ? "bg-success/15 text-success" : "bg-warning/15 text-warning"
            }`}
          >
            {isPositive ? <TrendingUp className="size-4" /> : <TrendingDown className="size-4" />}
            {data.revenueVsLastWeek}
          </div>
        ) : null}
      </div>
      <div className="mt-4 flex gap-6 text-sm text-muted-foreground">
        <span>
          주문{" "}
          <AnimatedNumber
            value={data.orderTotal}
            className="font-semibold text-foreground"
          />
          건
        </span>
      </div>
    </Card>
  );
}
