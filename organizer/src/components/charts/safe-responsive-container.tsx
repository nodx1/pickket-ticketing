"use client";

import { useEffect, useState, type ReactElement } from "react";
import { ResponsiveContainer } from "recharts";

/**
 * ResponsiveContainer를 SSR-safe하게 감싸는 래퍼.
 * 클라이언트 마운트 전에는 스켈레톤을 보여주고,
 * 마운트 후에만 ResponsiveContainer를 렌더하여
 * width/height -1 경고를 근본적으로 방지.
 */
export function SafeResponsiveContainer({
  children,
  height,
}: {
  children: ReactElement;
  height?: number | string;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { requestAnimationFrame(() => setMounted(true)); }, []);

  if (!mounted) {
    return <div className="animate-pulse rounded bg-bg-muted" style={{ height: height ?? "100%" }} />;
  }

  return (
    <ResponsiveContainer width="100%" height="100%">
      {children}
    </ResponsiveContainer>
  );
}
