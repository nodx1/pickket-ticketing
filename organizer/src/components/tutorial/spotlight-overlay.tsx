"use client";

import { useEffect, useEffectEvent, useRef } from "react";

interface SpotlightRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SpotlightOverlayProps {
  rect: SpotlightRect | null;
  padding?: number;
  borderRadius?: number;
  onOverlayClick?: () => void;
  reducedMotion?: boolean;
}

export function SpotlightOverlay({
  rect,
  padding = 8,
  borderRadius = 20,
  onOverlayClick,
  reducedMotion = false,
}: SpotlightOverlayProps) {
  const currentRef = useRef<SpotlightRect | null>(null);
  const animatedRef = useRef<SpotlightRect | null>(null);
  const rafRef = useRef<number>(0);
  const svgRef = useRef<SVGSVGElement>(null);

  const updateSVG = useEffectEvent((r: SpotlightRect) => {
    const svg = svgRef.current;
    if (!svg) return;
    const path = svg.querySelector("path");
    if (!path) return;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const p = padding;
    const br = borderRadius;

    const x = r.x - p;
    const y = r.y - p;
    const w = r.width + p * 2;
    const h = r.height + p * 2;

    const d = [
      `M0,0 H${vw} V${vh} H0 Z`,
      `M${x + br},${y}`,
      `H${x + w - br}`,
      `Q${x + w},${y} ${x + w},${y + br}`,
      `V${y + h - br}`,
      `Q${x + w},${y + h} ${x + w - br},${y + h}`,
      `H${x + br}`,
      `Q${x},${y + h} ${x},${y + h - br}`,
      `V${y + br}`,
      `Q${x},${y} ${x + br},${y}`,
      "Z",
    ].join(" ");

    path.setAttribute("d", d);
  });

  useEffect(() => {
    currentRef.current = rect;

    if (!rect) {
      animatedRef.current = null;
      return;
    }

    if (!animatedRef.current || reducedMotion) {
      animatedRef.current = { ...rect };
      updateSVG(rect);
      return;
    }

    const start = { ...animatedRef.current };
    const startTime = performance.now();
    const duration = 300;

    function animate(now: number) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);

      const current: SpotlightRect = {
        x: start.x + (rect!.x - start.x) * eased,
        y: start.y + (rect!.y - start.y) * eased,
        width: start.width + (rect!.width - start.width) * eased,
        height: start.height + (rect!.height - start.height) * eased,
      };

      animatedRef.current = current;
      updateSVG(current);

      if (progress < 1) {
        rafRef.current = requestAnimationFrame(animate);
      }
    }

    rafRef.current = requestAnimationFrame(animate);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [rect, reducedMotion]);

  if (!rect) return null;

  return (
    <svg
      ref={svgRef}
      className="pointer-events-auto fixed inset-0 z-[9998]"
      style={{
        width: "100vw",
        height: "100vh",
        filter: reducedMotion
          ? undefined
          : "drop-shadow(0 0 16px rgba(108,92,231,0.5))",
        animation: reducedMotion ? undefined : "spotlight-pulse 2s ease-in-out infinite",
      }}
      onClick={onOverlayClick}
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        fill="rgba(0,0,0,0.75)"
        d={`M0,0 H${window.innerWidth} V${window.innerHeight} H0 Z`}
      />
    </svg>
  );
}
