"use client";

import React, { useState, useRef, useCallback, useMemo } from "react";
import Image from "next/image";
import { useTranslations } from "next-intl";
import { type VenueData, type VenueSectionData } from "@pickket/lib/api";
import { formatKRW, getFocalPointLabel } from "@pickket/lib";
import { cn } from "@pickket/lib";

interface VenueMapProps {
  venue: VenueData;
  sectionAvailability: Record<
    string,
    { total: number; available: number; tierName: string; price: number }
  >;
  selectedSectionId: string | null;
  onSelectSection: (sectionId: string) => void;
  category?: string;
  homeTeam?: string;
  awayTeam?: string;
  lotteryMode?: boolean;
}

/* ------------------------------------------------------------------ */
/* Concert-hall auto-layout: generates arc (fan-shaped) SVG paths     */
/* when sections lack svg_path from the backend                       */
/* ------------------------------------------------------------------ */

/** Ring config for auto-generated concert layout (index 0 = closest to stage) */
interface RingConfig {
  innerRadius: number;
  outerRadius: number;
  startAngle: number;
  endAngle: number;
  color: string;
}

/** Up to 4 rings: VIP → 1층 → 2층 → 3층 */
const RING_PRESETS: RingConfig[] = [
  {
    innerRadius: 20,
    outerRadius: 100,
    startAngle: -35,
    endAngle: 35,
    color: "#404040",
  }, // 보라 (VIP)
  {
    innerRadius: 115,
    outerRadius: 200,
    startAngle: -50,
    endAngle: 50,
    color: "#3b82f6",
  }, // 파랑
  {
    innerRadius: 215,
    outerRadius: 300,
    startAngle: -60,
    endAngle: 60,
    color: "#22c55e",
  }, // 초록
  {
    innerRadius: 315,
    outerRadius: 390,
    startAngle: -68,
    endAngle: 68,
    color: "#14b8a6",
  }, // 민트
];

/** Convert polar to cartesian (angle 0 = down from center, clockwise) */
function polarToCart(
  cx: number,
  cy: number,
  r: number,
  angleDeg: number,
): { x: number; y: number } {
  // We want 0° = straight down from stage (positive Y), so offset by +90°
  const rad = ((angleDeg + 90) * Math.PI) / 180;
  return {
    x: cx + r * Math.cos(rad),
    y: cy + r * Math.sin(rad),
  };
}

/** Build an arc-segment (annular sector) SVG path */
function buildArcPath(
  cx: number,
  cy: number,
  innerR: number,
  outerR: number,
  startAngle: number,
  endAngle: number,
): string {
  const outerStart = polarToCart(cx, cy, outerR, startAngle);
  const outerEnd = polarToCart(cx, cy, outerR, endAngle);
  const sweep = endAngle - startAngle;
  const largeArc = Math.abs(sweep) > 180 ? 1 : 0;

  if (innerR <= 0) {
    // Pie-slice (VIP): arc + lines to center
    return [
      `M ${cx.toFixed(1)},${cy.toFixed(1)}`,
      `L ${outerStart.x.toFixed(1)},${outerStart.y.toFixed(1)}`,
      `A ${outerR},${outerR} 0 ${largeArc},1 ${outerEnd.x.toFixed(1)},${outerEnd.y.toFixed(1)}`,
      `Z`,
    ].join(" ");
  }

  const innerStart = polarToCart(cx, cy, innerR, endAngle);
  const innerEnd = polarToCart(cx, cy, innerR, startAngle);

  return [
    `M ${outerStart.x.toFixed(1)},${outerStart.y.toFixed(1)}`,
    `A ${outerR},${outerR} 0 ${largeArc},1 ${outerEnd.x.toFixed(1)},${outerEnd.y.toFixed(1)}`,
    `L ${innerStart.x.toFixed(1)},${innerStart.y.toFixed(1)}`,
    `A ${innerR},${innerR} 0 ${largeArc},0 ${innerEnd.x.toFixed(1)},${innerEnd.y.toFixed(1)}`,
    `Z`,
  ].join(" ");
}

/** Centre of an arc segment (for label placement) */
function arcCenter(
  cx: number,
  cy: number,
  innerR: number,
  outerR: number,
  startAngle: number,
  endAngle: number,
): { x: number; y: number } {
  const midAngle = (startAngle + endAngle) / 2;
  const midR = innerR <= 0 ? outerR * 0.5 : (innerR + outerR) / 2;
  return polarToCart(cx, cy, midR, midAngle);
}

interface GeneratedSection {
  id: string;
  svgPath: string;
  centerX: number;
  centerY: number;
  color: string;
}

/**
 * 가격 비싼 순서대로 무대 가까이 배치.
 * 각 섹션을 하나의 아치 링에 1:1 매핑.
 */
function generateConcertLayout(
  sections: VenueSectionData[],
  mapWidth: number,
  _mapHeight: number,
  sectionAvailability: Record<string, { price: number }>,
): Map<string, GeneratedSection> {
  const result = new Map<string, GeneratedSection>();

  // figma-style 배치가 있는 경우 (center_x > 0) auto-arc 건너뛰고 실제 좌표 사용
  const hasCustomLayout = sections.some(
    (s) => s.center_x && s.center_x > 0 && s.center_y && s.center_y > 0,
  );
  if (hasCustomLayout) return result; // 빈 Map 반환 → section.center_x/y 그대로 사용됨

  // 피그마 stage/console 섹션은 자동 배치 대상에서 제외 — 비좌석 블록으로 별도 렌더링됨
  const needsLayout = sections.filter(
    (s) =>
      !s.svg_path &&
      s.name !== "__stage__" &&
      (s.kind ?? "assigned") !== "stage" &&
      (s.kind ?? "assigned") !== "console",
  );
  if (needsLayout.length === 0) return result;

  // 가격 비싼 순 정렬 (비싼 = 무대 가까이)
  const sorted = [...needsLayout].sort((a, b) => {
    const priceA = sectionAvailability[a.id]?.price ?? 0;
    const priceB = sectionAvailability[b.id]?.price ?? 0;
    return priceB - priceA;
  });

  const cx = mapWidth / 2;
  const cy = 60;

  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    const ring = RING_PRESETS[i % RING_PRESETS.length];

    const path = buildArcPath(
      cx,
      cy,
      ring.innerRadius,
      ring.outerRadius,
      ring.startAngle,
      ring.endAngle,
    );
    const center = arcCenter(
      cx,
      cy,
      ring.innerRadius,
      ring.outerRadius,
      ring.startAngle,
      ring.endAngle,
    );

    result.set(s.id, {
      id: s.id,
      svgPath: path,
      centerX: center.x,
      centerY: center.y,
      color: ring.color,
    });
  }

  return result;
}

function getAvailabilityLabel(
  available: number,
  total: number,
  t: (key: string) => string,
): string {
  if (available === 0) return t("soldOut");
  const pctSold = ((total - available) / total) * 100;
  if (pctSold >= 80) return t("almostSoldOut");
  return t("seatsAvailable");
}

export default function VenueMap({
  venue,
  sectionAvailability,
  selectedSectionId,
  onSelectSection,
  category,
  homeTeam,
  awayTeam,
  lotteryMode,
}: VenueMapProps) {
  const t = useTranslations("booking.venueMap");
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoveredSection, setHoveredSection] = useState<string | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

  // Pinch-to-zoom state
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const hasDraggedRef = useRef(false);
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const lastDistRef = useRef<number | null>(null);

  const mapW = venue.map_width || 800;
  const mapH = venue.map_height || 600;

  const viewBox = useMemo(() => `0 0 ${mapW} ${mapH}`, [mapW, mapH]);

  /** Auto-generated concert-hall arcs for sections without svg_path */
  const generatedLayout = useMemo(
    () =>
      generateConcertLayout(venue.sections, mapW, mapH, sectionAvailability),
    [venue.sections, mapW, mapH, sectionAvailability],
  );

  /** 피그마 stage 섹션이 존재하는지 — 존재하면 하드코딩 STAGE 장식 생략 */
  const hasFigmaStage = useMemo(
    () => venue.sections.some((s) => (s.kind ?? "assigned") === "stage"),
    [venue.sections],
  );

  /** Whether we have any auto-generated sections (to decide if we show a stage) */
  const hasAutoStage = useMemo(() => {
    if (generatedLayout.size === 0) return false;
    if (hasFigmaStage) return false;
    // Check if there's already a __stage__ section
    return !venue.sections.some((s) => s.name === "__stage__");
  }, [generatedLayout.size, venue.sections, hasFigmaStage]);

  // 구역 선택 화면에서는 도트 없이 섹션 박스만 — 좌석 선택 단계는 SectionDetail이 담당

  const capturedPointerRef = useRef<{
    element: Element;
    pointerId: number;
  } | null>(null);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === "touch") {
      (e.target as Element).setPointerCapture?.(e.pointerId);
      capturedPointerRef.current = {
        element: e.target as Element,
        pointerId: e.pointerId,
      };
    }
    pointerStartRef.current = { x: e.clientX, y: e.clientY };
    lastPointerRef.current = { x: e.clientX, y: e.clientY };
    hasDraggedRef.current = false;
  }, []);

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!lastPointerRef.current || !pointerStartRef.current) return;
      // Calculate distance from start to apply drag threshold
      const distX = e.clientX - pointerStartRef.current.x;
      const distY = e.clientY - pointerStartRef.current.y;
      const dist = Math.sqrt(distX * distX + distY * distY);
      if (!isPanning && dist > 5) {
        setIsPanning(true);
        hasDraggedRef.current = true;
      }
      if (!isPanning) return;
      const dx = e.clientX - lastPointerRef.current.x;
      const dy = e.clientY - lastPointerRef.current.y;
      lastPointerRef.current = { x: e.clientX, y: e.clientY };
      setTranslate((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
    },
    [isPanning],
  );

  const handlePointerUp = useCallback(() => {
    setIsPanning(false);
    lastPointerRef.current = null;
    pointerStartRef.current = null;
    lastDistRef.current = null;
    // Release pointer capture if set
    if (capturedPointerRef.current) {
      try {
        capturedPointerRef.current.element.releasePointerCapture(
          capturedPointerRef.current.pointerId,
        );
      } catch {
        /* already released */
      }
      capturedPointerRef.current = null;
    }
    // Reset drag flag after a microtask so click handlers see the final value
    setTimeout(() => {
      hasDraggedRef.current = false;
    }, 0);
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    // Only zoom on pinch (ctrl+wheel) — let normal scroll pass through
    if (!e.ctrlKey) return;
    e.preventDefault();
    setScale((prev) => Math.max(0.4, Math.min(3, prev - e.deltaY * 0.005)));
  }, []);

  const handleSectionHover = useCallback(
    (section: VenueSectionData, e: React.MouseEvent) => {
      setHoveredSection(section.id);
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) {
        setTooltipPos({
          x: e.clientX - rect.left,
          y: e.clientY - rect.top - 10,
        });
      }
    },
    [],
  );

  const handleSectionClick = useCallback(
    (section: VenueSectionData) => {
      if (hasDraggedRef.current) return;
      const avail = sectionAvailability[section.id];
      if (!avail) return;
      if (avail.available === 0) return;
      onSelectSection(section.id);
    },
    [sectionAvailability, onSelectSection],
  );

  const hoveredInfo = hoveredSection
    ? sectionAvailability[hoveredSection]
    : null;
  const hoveredSectionData = hoveredSection
    ? venue.sections.find((s) => s.id === hoveredSection)
    : null;

  return (
    <div className="relative space-y-3 h-full">
      {/* Legend — 추첨 모드에서는 잔여석 개념 없으므로 숨김 */}
      {!lotteryMode && (
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="w-3 h-3 rounded-full bg-[#00d2a0]" /> {t("legendAvailable")}
          </span>
          <span className="flex items-center gap-1">
            <span className="w-3 h-3 rounded-full bg-[#ffd43b]" /> {t("legendLimited")}
          </span>
          <span className="flex items-center gap-1">
            <span className="w-3 h-3 rounded-full bg-[#ff6b6b]" /> {t("almostSoldOut")}
          </span>
          <span className="flex items-center gap-1">
            <span className="w-3 h-3 rounded-full bg-[#35333e]" /> {t("soldOut")}
          </span>
          <span className="flex items-center gap-1">
            <span className="w-3 h-3 rounded-full bg-muted border border-dashed border-input" />{" "}
            {t("inactive")}
          </span>
        </div>
      )}

      {/* SVG Map Container */}
      <div
        ref={containerRef}
        className="relative bg-background/60 overflow-hidden select-none"
        style={{ touchAction: scale > 1 ? "none" : "pan-y" }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onWheel={handleWheel}
      >
        <svg
          ref={svgRef}
          viewBox={viewBox}
          className="w-full h-auto"
          style={{
            transform: `scale(${scale}) translate(${translate.x / scale}px, ${translate.y / scale}px)`,
            transformOrigin: "center center",
            transition: isPanning ? "none" : "transform 0.2s ease",
          }}
          role="img"
          aria-label={t("seatingChartAlt", { name: venue.name })}
        >
          {/* SVG defs: hatching pattern & glow filter */}
          <defs>
            <pattern
              id="pk-hatch"
              width="6"
              height="6"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <line
                x1="0"
                y1="0"
                x2="0"
                y2="6"
                stroke="rgba(255,255,255,0.08)"
                strokeWidth="1.5"
              />
            </pattern>
            <filter id="pk-glow">
              <feDropShadow
                dx="0"
                dy="0"
                stdDeviation="8"
                floodColor="#0a0a0a"
                floodOpacity="0.5"
              />
            </filter>
          </defs>

          {/* Seating chart background image */}
          {venue.seating_chart_url && (
            <image
              href={venue.seating_chart_url}
              x="0"
              y="0"
              width={mapW}
              height={mapH}
              preserveAspectRatio="xMidYMid meet"
              opacity={0.12}
            />
          )}

          {/* Auto-generated stage when sections use concert-hall layout */}
          {hasAutoStage && (
            <g>
              <rect
                x={mapW / 2 - 120}
                y={15}
                width={240}
                height={50}
                rx={10}
                fill="hsl(var(--primary))"
                fillOpacity={0.25}
                stroke="hsl(var(--primary))"
                strokeWidth={1.5}
                strokeOpacity={0.4}
                className="pointer-events-none"
              />
              <text
                x={mapW / 2}
                y={46}
                textAnchor="middle"
                fill="hsl(var(--primary) / 0.7)"
                fontSize="16"
                fontWeight="bold"
                pointerEvents="none"
              >
                STAGE
              </text>
            </g>
          )}

          {/* Focal point label — 피그마 stage 섹션이 있으면 생략 (이중 STAGE 방지) */}
          {(() => {
            if (hasFigmaStage) return null;
            const focalLabel = getFocalPointLabel(category);
            if (!focalLabel) return null;
            const isWide =
              category?.toLowerCase() === "sports" ||
              category?.toLowerCase() === "festival";
            const rectW = isWide ? 200 : 160;
            return (
              <>
                <rect
                  x={mapW / 2 - rectW / 2}
                  y={10}
                  width={rectW}
                  height={36}
                  rx={8}
                  fill="hsl(var(--primary))"
                  fillOpacity={0.2}
                />
                <text
                  x={mapW / 2}
                  y={34}
                  textAnchor="middle"
                  fill="hsl(var(--primary) / 0.7)"
                  fontSize="14"
                  fontWeight="bold"
                >
                  {focalLabel}
                </text>
                {category?.toLowerCase() === "sports" && homeTeam && (
                  <text
                    x={mapW * 0.15}
                    y={34}
                    textAnchor="middle"
                    fill="hsl(var(--primary) / 0.7)"
                    fontSize="11"
                    opacity={0.8}
                  >
                    {t("homeTeam", { team: homeTeam })}
                  </text>
                )}
                {category?.toLowerCase() === "sports" && awayTeam && (
                  <text
                    x={mapW * 0.85}
                    y={34}
                    textAnchor="middle"
                    fill="hsl(var(--primary) / 0.7)"
                    fontSize="11"
                    opacity={0.8}
                  >
                    {t("awayTeam", { team: awayTeam })}
                  </text>
                )}
              </>
            );
          })()}

          {/* Sections — 피그마 빌더의 kind/rotation/width/height 반영 */}
          {venue.sections.map((section) => {
            const kind = section.kind ?? "assigned";

            /* ── Console: 음향/조명 부스 — 비좌석 회색 블록, 클릭 불가 ── */
            if (kind === "console") {
              const sw = section.width ?? 180;
              const sh = section.height ?? 80;
              const rot = section.rotation ?? 0;
              const transform = rot
                ? `rotate(${rot} ${section.center_x} ${section.center_y})`
                : undefined;
              const label = section.label || section.name || t("consoleLabel");
              return (
                <g
                  key={section.id}
                  transform={transform}
                  className="pointer-events-none"
                >
                  {section.svg_path ? (
                    <path
                      d={section.svg_path}
                      fill="hsl(var(--muted))"
                      fillOpacity={0.6}
                      stroke="hsl(var(--muted-foreground))"
                      strokeWidth={1.5}
                      strokeOpacity={0.4}
                      strokeDasharray="4 3"
                    />
                  ) : (
                    <rect
                      x={section.center_x - sw / 2}
                      y={section.center_y - sh / 2}
                      width={sw}
                      height={sh}
                      rx={6}
                      fill="hsl(var(--muted))"
                      fillOpacity={0.6}
                      stroke="hsl(var(--muted-foreground))"
                      strokeWidth={1.5}
                      strokeOpacity={0.4}
                      strokeDasharray="4 3"
                    />
                  )}
                  <text
                    x={section.center_x}
                    y={section.center_y + 4}
                    textAnchor="middle"
                    fill="hsl(var(--muted-foreground))"
                    fontSize="12"
                    fontWeight="600"
                    style={{ letterSpacing: "0.05em" }}
                  >
                    🎛️ {label}
                  </text>
                </g>
              );
            }

            /* ── Stage: 피그마 kind=stage 또는 legacy __stage__ ── */
            if (kind === "stage" || section.name === "__stage__") {
              const sw = section.width ?? 320;
              const sh = section.height ?? 80;
              const rot = section.rotation ?? 0;
              const transform = rot
                ? `rotate(${rot} ${section.center_x} ${section.center_y})`
                : undefined;
              return (
                <g
                  key={section.id}
                  transform={transform}
                  className="pointer-events-none"
                >
                  {section.svg_path ? (
                    <path
                      d={section.svg_path}
                      fill="hsl(var(--primary))"
                      fillOpacity={0.25}
                      stroke="hsl(var(--primary))"
                      strokeWidth={1.5}
                      strokeOpacity={0.4}
                    />
                  ) : (
                    <rect
                      x={section.center_x - sw / 2}
                      y={section.center_y - sh / 2}
                      width={sw}
                      height={sh}
                      rx={8}
                      fill="hsl(var(--primary))"
                      fillOpacity={0.25}
                      stroke="hsl(var(--primary))"
                      strokeWidth={1.5}
                      strokeOpacity={0.4}
                    />
                  )}
                  <text
                    x={section.center_x}
                    y={section.center_y + 4}
                    textAnchor="middle"
                    fill="hsl(var(--primary) / 0.8)"
                    fontSize="14"
                    fontWeight="bold"
                    style={{ letterSpacing: "0.2em" }}
                  >
                    STAGE
                  </text>
                </g>
              );
            }

            const avail = sectionAvailability[section.id];
            const isSelected = selectedSectionId === section.id;
            const isHovered = hoveredSection === section.id;
            const generated = generatedLayout.get(section.id);
            // 주최자가 피그마에서 지정한 tier 색상 우선 (section.color). 폴백으로만 자동값.
            const fillColor = section.color || generated?.color || "#94a3b8";
            const isSoldOut = avail ? avail.available === 0 : false;
            const isDisabled = !avail || isSoldOut;
            // 매진은 흐리게, 선택은 원색, 호버/일반은 반투명
            const baseFillOpacity = isSoldOut
              ? 0.15
              : isSelected
                ? 0.85
                : isHovered
                  ? 0.7
                  : 0.55;

            /* ── Standing: 스탠딩 존은 점선 박스 + 수용 인원 표시 ── */
            if (kind === "standing") {
              const sw = section.width ?? 200;
              const sh = section.height ?? 140;
              const rot = section.rotation ?? 0;
              const transform = rot
                ? `rotate(${rot} ${section.center_x} ${section.center_y})`
                : undefined;
              return (
                <g key={section.id} transform={transform}>
                  <rect
                    x={section.center_x - sw / 2}
                    y={section.center_y - sh / 2}
                    width={sw}
                    height={sh}
                    rx={8}
                    fill={fillColor}
                    fillOpacity={baseFillOpacity}
                    stroke={fillColor}
                    strokeWidth={isSelected ? 4 : isHovered ? 2.5 : 1.5}
                    strokeOpacity={isSelected ? 1 : isHovered ? 0.9 : 0.6}
                    strokeDasharray="6 4"
                    filter={isSelected ? "url(#pk-glow)" : undefined}
                    className={cn(
                      "transition-all duration-150",
                      isDisabled ? "cursor-default" : "cursor-pointer",
                    )}
                    onClick={() => handleSectionClick(section)}
                    onMouseEnter={(e) => handleSectionHover(section, e)}
                    onMouseLeave={() => setHoveredSection(null)}
                  />
                  <text
                    x={section.center_x}
                    y={section.center_y - 4}
                    textAnchor="middle"
                    fill="hsl(var(--foreground))"
                    fontSize="12"
                    fontWeight="600"
                    pointerEvents="none"
                  >
                    {section.label}
                  </text>
                  <text
                    x={section.center_x}
                    y={section.center_y + 12}
                    textAnchor="middle"
                    fill="hsl(var(--muted-foreground))"
                    fontSize="10"
                    pointerEvents="none"
                  >
                    {t("standingCapacity", { capacity: section.capacity })}
                  </text>
                </g>
              );
            }

            /* ── Assigned: 섹션 경계 박스 (width/height/rotation 반영) + 내부 좌석 도트 ── */

            // Resolve the SVG path: backend svg_path > generated arc > figma rect
            const resolvedPath = section.svg_path || generated?.svgPath;
            // 피그마 width/height가 있으면 그걸 기준, 없으면 fallback 80x50
            const figmaW = section.width;
            const figmaH = section.height;
            const rectW = figmaW ?? 80;
            const rectH = figmaH ?? 50;
            const rectX = section.center_x - rectW / 2;
            const rectY = section.center_y - rectH / 2;
            const rotation = section.rotation ?? 0;
            const groupTransform =
              rotation && !resolvedPath
                ? `rotate(${rotation} ${section.center_x} ${section.center_y})`
                : undefined;
            const labelX = generated?.centerX ?? section.center_x;
            const labelY = generated?.centerY ?? section.center_y;

            // 선택 시 주최자 지정색 유지 + 굵은 테두리 + 글로우로 강조
            const sharedProps = {
              fill: fillColor,
              fillOpacity: baseFillOpacity,
              stroke: isSelected
                ? fillColor
                : isHovered
                  ? fillColor
                  : "rgba(0,0,0,0.2)",
              strokeWidth: isSelected ? 4 : isHovered ? 2.5 : 1.25,
              strokeOpacity: isSelected ? 1 : isHovered ? 0.9 : 0.5,
              filter: isSelected ? "url(#pk-glow)" : undefined,
              className: cn(
                "transition-all duration-150",
                isDisabled ? "cursor-default" : "cursor-pointer",
              ),
              onClick: () => handleSectionClick(section),
              onMouseEnter: (e: React.MouseEvent) =>
                handleSectionHover(section, e),
              onMouseLeave: () => setHoveredSection(null),
              onKeyDown: (e: React.KeyboardEvent) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  handleSectionClick(section);
                }
              },
              tabIndex: 0,
              role: "button" as const,
              "aria-label": `${section.label} ${avail ? getAvailabilityLabel(avail.available, avail.total, t) : ""}`,
            };

            return (
              <g key={section.id}>
                <g transform={groupTransform}>
                  {resolvedPath ? (
                    <path d={resolvedPath} {...sharedProps} />
                  ) : (
                    <rect
                      x={rectX}
                      y={rectY}
                      width={rectW}
                      height={rectH}
                      rx={8}
                      {...sharedProps}
                    />
                  )}

                  {/* Hatching overlay for unavailable sections */}
                  {isDisabled &&
                    (resolvedPath ? (
                      <path
                        d={resolvedPath}
                        fill="url(#pk-hatch)"
                        pointerEvents="none"
                      />
                    ) : (
                      <rect
                        x={rectX}
                        y={rectY}
                        width={rectW}
                        height={rectH}
                        rx={8}
                        fill="url(#pk-hatch)"
                        pointerEvents="none"
                      />
                    ))}
                </g>

                {/* Label background pill */}
                <rect
                  x={labelX - 36}
                  y={labelY - 10}
                  width={72}
                  height={32}
                  rx={6}
                  fill="rgba(0,0,0,0.5)"
                  pointerEvents="none"
                />

                {/* Section label text */}
                <text
                  x={labelX}
                  y={labelY + 4}
                  textAnchor="middle"
                  fill={isSelected ? "#fff" : "hsl(var(--foreground))"}
                  fontSize="12"
                  fontWeight="600"
                  pointerEvents="none"
                >
                  {section.label}
                </text>

                {/* Remaining seats subtext */}
                <text
                  x={labelX}
                  y={labelY + 16}
                  textAnchor="middle"
                  fill="hsl(var(--muted-foreground))"
                  fontSize="10"
                  pointerEvents="none"
                >
                  {avail ? t("seatsRemaining", { count: avail.available }) : t("inactive")}
                </text>
              </g>
            );
          })}
        </svg>

        {/* Tooltip */}
        {hoveredSection && hoveredInfo && hoveredSectionData && (
          <div
            className="absolute z-10 bg-card text-foreground border border-border text-xs rounded-lg px-3 py-2 pointer-events-none whitespace-nowrap shadow-lg"
            style={{
              left: tooltipPos.x,
              top: tooltipPos.y,
              transform: "translate(-50%, -100%)",
            }}
          >
            <div className="flex items-center gap-2">
              {hoveredSectionData.view_image_url && (
                <Image
                  src={hoveredSectionData.view_image_url}
                  alt={t("sectionViewAlt", { label: hoveredSectionData.label })}
                  width={40}
                  height={40}
                  className="w-10 h-10 rounded object-cover shrink-0"
                />
              )}
              <div>
                <div>
                  {hoveredSectionData.label} — {hoveredInfo.tierName}
                </div>
                <div className="font-tabular">
                  {formatKRW(hoveredInfo.price)} / {t("tooltipRemaining", { count: hoveredInfo.available })}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Zoom controls — 최상위 relative div 기준 고정 */}
      <div className="absolute bottom-3 right-3 z-20 flex flex-col gap-1">
        <button
          type="button"
          onClick={() => setScale((s) => Math.min(3, s + 0.3))}
          className="w-8 h-8 rounded-lg bg-card border border-border shadow-[0_4px_12px_rgba(0,0,0,0.4)] flex items-center justify-center text-sm font-bold text-foreground hover:bg-muted"
          aria-label={t("zoomIn")}
        >
          +
        </button>
        <button
          type="button"
          onClick={() => {
            setScale(1);
            setTranslate({ x: 0, y: 0 });
          }}
          className="w-8 h-8 rounded-lg bg-card border border-border shadow-[0_4px_12px_rgba(0,0,0,0.4)] flex items-center justify-center text-2xs font-bold text-muted-foreground hover:bg-muted"
          aria-label={t("zoomReset")}
        >
          1x
        </button>
        <button
          type="button"
          onClick={() => setScale((s) => Math.max(0.4, s - 0.3))}
          className="w-8 h-8 rounded-lg bg-card border border-border shadow-[0_4px_12px_rgba(0,0,0,0.4)] flex items-center justify-center text-sm font-bold text-foreground hover:bg-muted"
          aria-label={t("zoomOut")}
        >
          -
        </button>
      </div>
    </div>
  );
}
