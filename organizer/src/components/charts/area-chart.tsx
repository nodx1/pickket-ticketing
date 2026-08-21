"use client";

import {
  Area,
  AreaChart as RechartsAreaChart,
  CartesianGrid,
  
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { SafeResponsiveContainer } from "@/components/charts/safe-responsive-container";
import { Card } from "@/components/ui/card";
import { CHART_COLORS } from "./chart-theme";

interface AreaChartProps {
  title: string;
  data: Array<Record<string, unknown>>;
  xKey: string;
  yKey: string;
  yFormatter?: (value: number) => string;
  height?: number;
  color?: string;
}

export function AreaChart({
  title,
  data,
  xKey,
  yKey,
  yFormatter = (v) => String(v),
  height = 280,
  color = CHART_COLORS[0],
}: AreaChartProps) {
  return (
    <Card className="p-5">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {data.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">데이터가 없습니다.</p>
      ) : (
        <div
          className="mt-4"
          style={{ height }}
          role="img"
          aria-label={`${title} 영역 차트`}
        >
          <SafeResponsiveContainer>
            <RechartsAreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -16 }}>
              <defs>
                <linearGradient id={`area-fill-${yKey}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity={0.2} />
                  <stop offset="100%" stopColor={color} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" vertical={false} />
              <XAxis
                dataKey={xKey}
                tick={{ fontSize: 11, fill: "var(--content-muted)" }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tick={{ fontSize: 11, fill: "var(--content-muted)" }}
                axisLine={false}
                tickLine={false}
                tickFormatter={yFormatter}
              />
              <Tooltip
                contentStyle={{
                  background: "var(--card)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  fontSize: 12,
                }}
                formatter={(value) => [yFormatter(Number(value)), ""]}
              />
              <Area
                type="monotone"
                dataKey={yKey}
                stroke={color}
                strokeWidth={2}
                fill={`url(#area-fill-${yKey})`}
              />
            </RechartsAreaChart>
          </SafeResponsiveContainer>
        </div>
      )}
    </Card>
  );
}
