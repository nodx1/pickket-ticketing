"use client";

import type { LucideIcon } from "lucide-react";
import { Activity, Clock, ShoppingCart, Zap } from "lucide-react";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { Card } from "@/components/ui/card";
import { formatKRW } from "@/lib/format";

interface LiveData {
  todayRevenue: number;
  todayOrders: number;
  activeCheckIns: number;
  lastOrderMinutesAgo: number | null;
}

export function LivePulse({ data }: { data: LiveData }) {
  const stats: Array<{
    label: string;
    value: number;
    formatter: (value: number) => string;
    icon: LucideIcon;
    color: string;
    bgColor: string;
  }> = [
    {
      label: "오늘 매출",
      value: data.todayRevenue,
      formatter: formatKRW,
      icon: Zap,
      color: "text-success",
      bgColor: "bg-success/15",
    },
    {
      label: "오늘 주문",
      value: data.todayOrders,
      formatter: (value) => `${value}건`,
      icon: ShoppingCart,
      color: "text-primary",
      bgColor: "bg-primary/15",
    },
    {
      label: "오늘 체크인",
      value: data.activeCheckIns,
      formatter: (value) => `${value}명`,
      icon: Activity,
      color: "text-accent",
      bgColor: "bg-accent/15",
    },
    {
      label: "마지막 주문",
      value: data.lastOrderMinutesAgo ?? 0,
      formatter: (value) =>
        data.lastOrderMinutesAgo === null
          ? "없음"
          : value < 1
            ? "방금 전"
            : value < 60
              ? `${value}분 전`
              : `${Math.floor(value / 60)}시간 전`,
      icon: Clock,
      color: "text-gold",
      bgColor: "bg-gold/15",
    },
  ];

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {stats.map((stat) => {
        const Icon = stat.icon;

        return (
          <Card key={stat.label} className="p-5">
            <div className="flex items-center gap-3">
              <div className={`flex size-10 items-center justify-center rounded-lg ${stat.bgColor}`}>
                <Icon className={`size-5 ${stat.color}`} />
              </div>
              <p className="text-sm text-muted-foreground">{stat.label}</p>
            </div>
            <p className="mt-3 text-2xl font-black tracking-[-0.04em] text-foreground">
              <AnimatedNumber value={stat.value} formatter={stat.formatter} />
            </p>
          </Card>
        );
      })}
    </div>
  );
}
