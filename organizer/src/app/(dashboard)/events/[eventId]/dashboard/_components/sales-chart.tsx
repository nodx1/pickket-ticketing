"use client";

import { useEffect, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { SafeResponsiveContainer } from "@/components/charts/safe-responsive-container";
import { Card } from "@/components/ui/card";
import { formatKRW } from "@/lib/format";

interface DailySale {
  date: string;
  amount: number;
  count: number;
}

export function SalesChart({ items }: { items: DailySale[] }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { requestAnimationFrame(() => setMounted(true)); }, []);

  const chartData = items.map((item) => ({
    date: item.date.slice(5),
    매출: item.amount,
    건수: item.count,
  }));

  return (
    <Card className="p-5">
      <h3 className="text-sm font-semibold text-foreground">일별 매출</h3>
      {chartData.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">최근 매출 데이터가 없습니다.</p>
      ) : !mounted ? (
        <div className="mt-4 space-y-6">
          <div className="h-52 animate-pulse rounded bg-bg-muted" />
          <div className="h-36 animate-pulse rounded bg-bg-muted" />
        </div>
      ) : (
        <div className="mt-4 space-y-6">
          <div className="h-52">
            <SafeResponsiveContainer>
              <AreaChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: -16 }}>
                <defs>
                  <linearGradient id="sales-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.2} />
                    <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: "var(--content-muted)" }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: "var(--content-muted)" }} axisLine={false} tickLine={false} tickFormatter={(v: number) => formatKRW(v)} />
                <Tooltip
                  contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
                  formatter={(value) => [formatKRW(Number(value)), "매출"]}
                />
                <Area type="monotone" dataKey="매출" stroke="var(--chart-1)" strokeWidth={2} fill="url(#sales-fill)" />
              </AreaChart>
            </SafeResponsiveContainer>
          </div>
          <div className="h-36">
            <SafeResponsiveContainer>
              <BarChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: -16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: "var(--content-muted)" }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: "var(--content-muted)" }} axisLine={false} tickLine={false} />
                <Tooltip
                  contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
                  formatter={(value) => [`${Number(value)}건`, "주문"]}
                />
                <Bar dataKey="건수" fill="var(--chart-2)" radius={[4, 4, 0, 0]} maxBarSize={32} />
              </BarChart>
            </SafeResponsiveContainer>
          </div>
        </div>
      )}
    </Card>
  );
}
