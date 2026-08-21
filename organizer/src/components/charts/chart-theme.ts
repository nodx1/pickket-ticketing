export const CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
  "var(--chart-7)",
] as const;

export const CHART_COMMON = {
  fontSize: 12,
  fontFamily: "var(--font-pretendard), sans-serif",
  tickColor: "var(--content-muted)",
  gridColor: "var(--border-subtle)",
  tooltipBg: "var(--card)",
  tooltipBorder: "var(--border)",
} as const;
