"use client";

import { useId } from "react";

interface MiniSparklineProps {
  data: number[];
  width?: number;
  height?: number;
  className?: string;
}

export default function MiniSparkline({
  data,
  width = 80,
  height = 24,
  className,
}: MiniSparklineProps) {
  const rawId = useId();
  const gradientId = `sparkline${rawId.replace(/:/g, "")}`;

  if (data.length < 2) return null;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;

  const first = data[0];
  const last = data[data.length - 1];
  const color = last > first ? "#00C9A7" : last < first ? "#EF4444" : "#9CA3AF";

  const padX = 2;
  const padY = 2;
  const drawWidth = width - padX * 2;
  const drawHeight = height - padY * 2;

  const points = data
    .map((value, i) => {
      const x = padX + (i / (data.length - 1)) * drawWidth;
      const y = padY + drawHeight - ((value - min) / range) * drawHeight;
      return `${x},${y}`;
    })
    .join(" ");

  const fillPoints = [
    ...data.map((value, i) => {
      const x = padX + (i / (data.length - 1)) * drawWidth;
      const y = padY + drawHeight - ((value - min) / range) * drawHeight;
      return `${x},${y}`;
    }),
    `${padX + drawWidth},${padY + drawHeight}`,
    `${padX},${padY + drawHeight}`,
  ].join(" ");

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.1} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <polygon points={fillPoints} fill={`url(#${gradientId})`} />
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
