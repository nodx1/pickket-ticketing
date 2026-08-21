"use client";

import React, { useMemo } from "react";
import { useTranslations } from "next-intl";
import { MapPin } from "lucide-react";
import type {
  VenueData,
  SeatTier,
  SeatData,
  VenueSectionData,
} from "@pickket/lib/api";
import { formatKRW, getFocalPointLabel } from "@pickket/lib";
import { cn } from "@pickket/lib";

interface VenuePreviewProps {
  venue: VenueData;
  tiers: SeatTier[];
  /**
   * 주최자가 피그마 빌더로 그린 개별 좌석. 있으면 assigned 섹션 내부에
   * 좌석 도트가 실제 x/y 좌표대로 렌더링된다.
   */
  seats?: SeatData[];
  category?: string;
  homeTeam?: string;
  awayTeam?: string;
}

/* ── tier legend color palette (section.color가 비어있을 때 fallback) ── */
const TIER_COLORS: { color: string; glow: string }[] = [
  { color: "#7B61FF", glow: "rgba(123,97,255,0.4)" },
  { color: "#FFD700", glow: "rgba(255,215,0,0.35)" },
  { color: "#01f5a0", glow: "rgba(1,245,160,0.35)" },
  { color: "#00D1FF", glow: "rgba(0,209,255,0.35)" },
  { color: "#FF00FF", glow: "rgba(255,0,255,0.3)" },
  { color: "#ff6b6b", glow: "rgba(255,107,107,0.35)" },
  { color: "#ffa726", glow: "rgba(255,167,38,0.35)" },
];

function getTierColor(index: number) {
  return TIER_COLORS[index % TIER_COLORS.length];
}

/* ── 섹션 기본 치수 (width/height가 sync에서 누락됐을 때 fallback) ── */
function sectionDims(section: VenueSectionData): {
  width: number;
  height: number;
} {
  if (section.width && section.height) {
    return { width: section.width, height: section.height };
  }
  const kind = section.kind ?? "assigned";
  if (kind === "stage") return { width: 320, height: 80 };
  if (kind === "console") return { width: 180, height: 80 };
  if (kind === "standing") {
    const scale = Math.max(1, Math.sqrt((section.capacity || 100) / 50));
    return { width: 180 * scale, height: 120 * scale };
  }
  // assigned fallback: capacity 기반 정사각에 가까운 박스
  const approx = Math.ceil(Math.sqrt(Math.max(section.capacity, 1)));
  return { width: approx * 20 + 40, height: approx * 20 + 60 };
}

export default function VenuePreview({
  venue,
  tiers,
  seats,
  category,
  homeTeam,
  awayTeam,
}: VenuePreviewProps) {
  const t = useTranslations("event.venuePreview");

  /* 캔버스 크기 — go 피그마 캔버스와 1:1 매핑 */
  const mapWidth = venue.map_width || 1000;
  const mapHeight = venue.map_height || 700;
  const viewBox = `0 0 ${mapWidth} ${mapHeight}`;

  /* tier id → color/label 맵 */
  const tierInfo = useMemo(() => {
    const map = new Map<
      string,
      { color: string; name: string; price: number }
    >();
    tiers.forEach((t, idx) => {
      const color = getTierColor(idx).color;
      map.set(t.id, {
        color,
        name: t.name,
        price: t.face_price || t.base_price,
      });
    });
    return map;
  }, [tiers]);

  /* 섹션 이름 → 좌석 배열 */
  const seatsBySection = useMemo(() => {
    const map = new Map<string, SeatData[]>();
    if (!seats?.length) return map;
    for (const s of seats) {
      const arr = map.get(s.section) ?? [];
      arr.push(s);
      map.set(s.section, arr);
    }
    return map;
  }, [seats]);

  /* 좌석 도트 반지름 — 가장 가까운 두 좌석 간 거리의 35% 기준 */
  const seatRadius = useMemo(() => {
    if (!seats || seats.length < 2) return 4;
    let minDist = Infinity;
    const sample = seats.slice(0, Math.min(80, seats.length));
    for (let i = 0; i < sample.length; i++) {
      for (let j = i + 1; j < sample.length; j++) {
        const a = sample[i];
        const b = sample[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > 0 && d < minDist) minDist = d;
      }
    }
    if (!isFinite(minDist) || minDist <= 0) return 4;
    return Math.max(2, Math.min(6, minDist * 0.35));
  }, [seats]);

  /* tier 범례 (고유 tier 이름 기준) */
  const tierLegend = useMemo(() => {
    const seen = new Set<string>();
    return tiers
      .filter((t) => {
        if (seen.has(t.name)) return false;
        seen.add(t.name);
        return true;
      })
      .map((t, idx) => ({
        name: t.name,
        price: t.face_price || t.base_price,
        remaining: t.remaining,
        capacity: t.capacity,
        ...getTierColor(idx),
      }));
  }, [tiers]);

  const focalLabel = getFocalPointLabel(category);
  const hasSections = venue.sections.length > 0;
  const hasAnyStage = venue.sections.some(
    (s) => (s.kind ?? "assigned") === "stage",
  );

  return (
    <div>
      {/* 장소명 */}
      <p className="text-xs text-muted-foreground mb-4">{venue.name}</p>

      {/* Empty state */}
      {!hasSections && !venue.seating_chart_url && (
        <div className="flex flex-col items-center justify-center py-16 px-4">
          <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mb-4">
            <MapPin className="h-7 w-7 text-primary/40" />
          </div>
          <p className="text-sm font-medium text-muted-foreground">
            {t("emptyTitle")}
          </p>
          <p className="text-xs text-muted-foreground/60 mt-1">
            {t("emptyDescription")}
          </p>
        </div>
      )}

      {(hasSections || venue.seating_chart_url) && (
        <div className="flex flex-col md:flex-row">
          {/* Left: Figma-faithful seat map */}
          <div className="flex-1 p-6 md:p-8 flex flex-col items-center justify-center">
            {/* Sports team labels */}
            {category?.toLowerCase() === "sports" && (homeTeam || awayTeam) && (
              <div className="w-full max-w-lg flex justify-between mb-4 px-4">
                {homeTeam && (
                  <span className="text-2xs font-bold uppercase tracking-widest text-emerald-600 dark:text-emerald-400">
                    {t("homeTeam", { name: homeTeam ?? "" })}
                  </span>
                )}
                {awayTeam && (
                  <span className="text-2xs font-bold uppercase tracking-widest text-red-600 dark:text-red-400">
                    {t("awayTeam", { name: awayTeam ?? "" })}
                  </span>
                )}
              </div>
            )}

            <div className="relative w-full max-w-4xl mx-auto rounded-xl overflow-hidden bg-muted/5 border border-border/40">
              <svg
                viewBox={viewBox}
                className="w-full h-auto"
                preserveAspectRatio="xMidYMid meet"
                role="img"
                aria-label={t("mapAriaLabel", { name: venue.name ?? "" })}
              >
                {/* Seating chart background (optional overlay) */}
                {venue.seating_chart_url && (
                  <image
                    href={venue.seating_chart_url}
                    x={0}
                    y={0}
                    width={mapWidth}
                    height={mapHeight}
                    preserveAspectRatio="xMidYMid meet"
                    opacity={0.15}
                  />
                )}

                {/* 섹션 렌더링 — 피그마 빌더의 x/y/rotation/width/height 그대로 */}
                {venue.sections.map((section) => {
                  const kind = section.kind ?? "assigned";
                  const { width, height } = sectionDims(section);
                  const cx = section.center_x;
                  const cy = section.center_y;
                  const rotation = section.rotation ?? 0;
                  const baseColor =
                    section.color || (kind === "stage" ? "#94A3B8" : "#6C5CE7");
                  const transform = rotation
                    ? `rotate(${rotation} ${cx} ${cy})`
                    : undefined;

                  if (kind === "stage") {
                    return (
                      <g
                        key={section.id}
                        transform={transform}
                        className="pointer-events-none"
                      >
                        <rect
                          x={cx - width / 2}
                          y={cy - height / 2}
                          width={width}
                          height={height}
                          rx={8}
                          fill="var(--muted)"
                          stroke="var(--border)"
                          strokeWidth={1.5}
                        />
                        <text
                          x={cx}
                          y={cy + 4}
                          textAnchor="middle"
                          className="fill-muted-foreground text-[13px] font-bold tracking-[0.25em]"
                        >
                          STAGE
                        </text>
                      </g>
                    );
                  }

                  if (kind === "console") {
                    const consoleLabel =
                      section.label || section.name || t("consoleLabel");
                    return (
                      <g
                        key={section.id}
                        transform={transform}
                        className="pointer-events-none"
                      >
                        <rect
                          x={cx - width / 2}
                          y={cy - height / 2}
                          width={width}
                          height={height}
                          rx={6}
                          fill="var(--muted)"
                          fillOpacity={0.6}
                          stroke="var(--muted-foreground)"
                          strokeWidth={1.5}
                          strokeOpacity={0.4}
                          strokeDasharray="4 3"
                        />
                        <text
                          x={cx}
                          y={cy + 4}
                          textAnchor="middle"
                          className="fill-muted-foreground text-[12px] font-semibold"
                        >
                          🎛️ {consoleLabel}
                        </text>
                      </g>
                    );
                  }

                  if (kind === "standing") {
                    return (
                      <g key={section.id} transform={transform}>
                        <rect
                          x={cx - width / 2}
                          y={cy - height / 2}
                          width={width}
                          height={height}
                          rx={8}
                          fill={baseColor}
                          fillOpacity={0.22}
                          stroke={baseColor}
                          strokeWidth={1.5}
                          strokeOpacity={0.7}
                          strokeDasharray="6 4"
                        />
                        <text
                          x={cx}
                          y={cy - 4}
                          textAnchor="middle"
                          className="text-[12px] font-bold"
                          fill={baseColor}
                        >
                          {section.label || section.name}
                        </text>
                        <text
                          x={cx}
                          y={cy + 14}
                          textAnchor="middle"
                          className="text-[10px] fill-muted-foreground"
                        >
                          {t("standingCapacity", { count: section.capacity ?? 0 })}
                        </text>
                      </g>
                    );
                  }

                  /* assigned — 박스 경계 + 개별 좌석 도트 */
                  const sectionSeats = seatsBySection.get(section.name) ?? [];
                  return (
                    <g key={section.id}>
                      {/* 섹션 경계 박스 (회전 적용) */}
                      <g transform={transform}>
                        <rect
                          x={cx - width / 2}
                          y={cy - height / 2}
                          width={width}
                          height={height}
                          rx={6}
                          fill={baseColor}
                          fillOpacity={0.08}
                          stroke={baseColor}
                          strokeWidth={1}
                          strokeOpacity={0.35}
                        />
                        <text
                          x={cx}
                          y={cy - height / 2 + 14}
                          textAnchor="middle"
                          className="text-[11px] font-bold"
                          fill={baseColor}
                          fillOpacity={0.9}
                        >
                          {section.label || section.name}
                        </text>
                      </g>

                      {/* 개별 좌석 도트 — seat.x/y는 이미 회전 반영된 절대 좌표 */}
                      {sectionSeats.map((seat) => {
                        const info = tierInfo.get(seat.tier_id);
                        const color = info?.color ?? baseColor;
                        const isSold = seat.status === "sold";
                        const isHeld = seat.status === "held";
                        const isReserved = seat.status === "reserved";
                        return (
                          <circle
                            key={seat.id}
                            cx={seat.x}
                            cy={seat.y}
                            r={seatRadius}
                            fill={
                              isSold || isReserved
                                ? "#9ca3af"
                                : isHeld
                                  ? "#F59E0B"
                                  : color
                            }
                            opacity={
                              isSold
                                ? 0.4
                                : isReserved
                                  ? 0.6
                                  : isHeld
                                    ? 0.7
                                    : 0.95
                            }
                          >
                            <title>
                              {seat.label ||
                                `${seat.section} ${seat.row_number}-${seat.seat_number}`}
                            </title>
                          </circle>
                        );
                      })}
                    </g>
                  );
                })}

                {/* focal label — 섹션에 STAGE가 없고 category별 포인트가 있을 때 상단에 장식 */}
                {!hasAnyStage && focalLabel && (
                  <g className="pointer-events-none">
                    <rect
                      x={mapWidth / 2 - 80}
                      y={10}
                      width={160}
                      height={28}
                      rx={14}
                      fill="var(--muted)"
                      stroke="var(--border)"
                      strokeWidth={1}
                    />
                    <text
                      x={mapWidth / 2}
                      y={29}
                      textAnchor="middle"
                      className="fill-muted-foreground text-[12px] font-bold tracking-[0.2em]"
                    >
                      {focalLabel}
                    </text>
                  </g>
                )}
              </svg>
            </div>
          </div>

          {/* Right: Legend sidebar */}
          {tierLegend.length > 0 && (
            <aside className="w-full md:w-72 p-6 border-t md:border-t-0 md:border-l border-border/50 flex flex-col gap-6">
              {/* Seat legend */}
              <div>
                <h4 className="text-2xs font-bold uppercase tracking-[0.2em] text-muted-foreground/60 mb-4">
                  Seat Legend
                </h4>

                <div className="flex flex-col gap-2.5 mb-5">
                  <div className="flex items-center gap-2.5">
                    <div className="w-2.5 h-2.5 rounded-full bg-foreground" />
                    <span className="text-xs font-medium text-muted-foreground">
                      {t("statusAvailable")}
                    </span>
                  </div>
                  <div className="flex items-center gap-2.5">
                    <div className="w-2.5 h-2.5 rounded-full bg-amber-500 opacity-70" />
                    <span className="text-xs font-medium text-muted-foreground">
                      {t("statusHeld")}
                    </span>
                  </div>
                  <div className="flex items-center gap-2.5 opacity-40">
                    <div className="w-2.5 h-2.5 rounded-full bg-muted" />
                    <span className="text-xs font-medium text-muted-foreground">
                      {t("statusSoldOut")}
                    </span>
                  </div>
                </div>

                <div className="pt-4 border-t border-border flex flex-col gap-3">
                  {tierLegend.map((item) => {
                    const isSoldOut = item.remaining === 0;
                    const pctSold =
                      item.capacity > 0
                        ? Math.round(
                            ((item.capacity - item.remaining) / item.capacity) *
                              100,
                          )
                        : 0;

                    return (
                      <div
                        key={item.name}
                        className={cn(
                          "flex items-center justify-between",
                          isSoldOut && "opacity-40",
                        )}
                      >
                        <div className="flex items-center gap-2.5">
                          <div
                            className="w-2.5 h-2.5 rounded-full shrink-0"
                            style={{
                              backgroundColor: item.color,
                              boxShadow: `0 0 6px ${item.glow}`,
                            }}
                          />
                          <div className="flex flex-col">
                            <span className="text-xs font-semibold text-foreground">
                              {item.name}
                            </span>
                            {!isSoldOut ? (
                              <span className="text-2xs text-muted-foreground/60">
                                {t("tierRemaining", { remaining: item.remaining ?? 0, pct: pctSold ?? 0 })}
                              </span>
                            ) : (
                              <span className="text-2xs text-red-600 dark:text-red-400">
                                {t("tierSoldOut")}
                              </span>
                            )}
                          </div>
                        </div>
                        <span
                          className="text-xs-plus font-bold font-tabular"
                          style={{ color: item.color }}
                        >
                          {formatKRW(item.price)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </aside>
          )}
        </div>
      )}
    </div>
  );
}
