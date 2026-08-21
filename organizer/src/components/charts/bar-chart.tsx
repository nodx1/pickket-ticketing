"use client";

import {
  Bar,
  BarChart as RechartsBarChart,
  CartesianGrid,
  
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { SafeResponsiveContainer } from "@/components/charts/safe-responsive-container";
import { Card } from "@/components/ui/card";
import { CHART_COLORS } from "./chart-theme";

interface BarChartProps {
  title: string;
  data: Array<Record<string, unknown>>;
  xKey: string;
  yKey: string;
  yFormatter?: (value: number) => string;
  height?: number;
  color?: string;
}

export function BarChart({
  title,
  data,
  xKey,
  yKey,
  yFormatter = (v) => String(v),
  height = 280,
  color = CHART_COLORS[0],
}: BarChartProps) {
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
          aria-label={`${title} 막대 차트`}
        >
          <SafeResponsiveContainer>
            <RechartsBarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -16 }}>
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
              <Bar
                dataKey={yKey}
                fill={color}
                radius={[4, 4, 0, 0]}
                maxBarSize={40}
              />
            </RechartsBarChart>
          </SafeResponsiveContainer>
        </div>
      )}
    </Card>
  );
}
