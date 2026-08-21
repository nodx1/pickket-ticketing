"use client";

import { useState, useMemo } from "react";
import { useTranslations } from "next-intl";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { formatKRW } from "@pickket/lib";
import type { PriceCandle } from "@/hooks/useMarketStream";

interface PriceChartProps {
  candles: PriceCandle[];
}

function formatTime(ts: string): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function PriceChart({ candles }: PriceChartProps) {
  const t = useTranslations("resale");
  const [range, setRange] = useState(24);
  const [renderTime] = useState(() => Date.now());

  const TIME_RANGES = useMemo(
    () => [
      { label: "6H", hours: 6 },
      { label: "24H", hours: 24 },
      { label: "7D", hours: 168 },
      { label: t("all"), hours: 0 },
    ],
    [t],
  );

  const filtered = useMemo(() => {
    if (range === 0 || candles.length === 0) return candles;
    const cutoff = new Date(renderTime - range * 3600 * 1000).toISOString();
    return candles.filter((c) => c.timestamp >= cutoff);
  }, [candles, range, renderTime]);

  const chartData = useMemo(
    () =>
      filtered.map((c) => ({
        time: formatTime(c.timestamp),
        price: c.close,
        volume: c.volume,
        high: c.high,
        low: c.low,
      })),
    [filtered],
  );

  const isUp =
    chartData.length >= 2 &&
    chartData[chartData.length - 1].price >= chartData[0].price;

  const gradientColor = isUp ? "#10B981" : "#EF4444";
  const lineColor = isUp ? "#10B981" : "#EF4444";

  return (
    <div className="bg-card rounded-xl border border-border overflow-hidden h-full flex flex-col">
      {/* Header */}
      <div className="px-4 py-2.5 border-b border-border bg-muted/50 flex items-center justify-between">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          {t("priceChart")}
        </h3>
        <div className="flex gap-1">
          {TIME_RANGES.map((r) => (
            <button
              key={r.label}
              onClick={() => setRange(r.hours)}
              className={`px-2.5 py-1 text-2xs font-medium rounded-md transition-colors ${
                range === r.hours
                  ? "bg-primary text-white"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {/* Chart */}
      <div className="flex-1 p-3 min-h-[280px]">
        {chartData.length === 0 ? (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
            {t("noTradeData")}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={chartData}
              margin={{ top: 5, right: 5, bottom: 5, left: 5 }}
            >
              <defs>
                <linearGradient id="priceGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="0%"
                    stopColor={gradientColor}
                    stopOpacity={0.2}
                  />
                  <stop
                    offset="100%"
                    stopColor={gradientColor}
                    stopOpacity={0}
                  />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis
                dataKey="time"
                tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                domain={["auto", "auto"]}
                tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v) => formatKRW(v)}
                width={65}
              />
              <RechartsTooltip
                contentStyle={{
                  borderRadius: "8px",
                  border: "1px solid var(--color-border)",
                  background: "var(--color-card)",
                  fontSize: "12px",
                }}
                formatter={(value: number | undefined) => [
                  formatKRW(value ?? 0),
                  t("priceLabel"),
                ]}
              />
              <Area
                type="monotone"
                dataKey="price"
                stroke={lineColor}
                strokeWidth={2}
                fill="url(#priceGradient)"
                dot={false}
                activeDot={{
                  r: 4,
                  stroke: lineColor,
                  strokeWidth: 2,
                  fill: "var(--color-card)",
                }}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
