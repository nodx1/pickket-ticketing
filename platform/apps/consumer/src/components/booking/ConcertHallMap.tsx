"use client";

import { useMemo, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import {
  type SeatTier,
  type SeatData,
  type VenueData,
  type VenueSectionData,
} from "@pickket/lib/api";

interface ConcertHallMapProps {
  tiers: SeatTier[];
  selectedTierId: string | null;
  onSelectTier: (tierId: string) => void;
  seats?: SeatData[];
  venue?: VenueData | null;
  selectedSeatIds?: Set<string>;
  onSelectSeat?: (seat: SeatData) => void;
  seatSelectionActive?: boolean;
}

/* ── Fallback SVG 구역 정의 (venue에 section SVG 데이터가 없을 때 사용) ── */
interface SectionShape {
  type: "path" | "rect";
  d?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  rotate?: number;
  labelX: number;
  labelY: number;
}

const FALLBACK_SECTION_SHAPES: Record<string, SectionShape> = {
  // 스테이지: 상단 반원
  stage: {
    type: "path",
    d: "M580 10 C580 80 500 120 400 120 C300 120 220 80 220 10 L580 10 Z",
    labelX: 400,
    labelY: 65,
  },
  // VIP: 무대 바로 앞 센터
  vip: {
    type: "rect",
    x: 270,
    y: 140,
    w: 260,
    h: 110,
    rotate: 0,
    labelX: 400,
    labelY: 195,
  },
  // S석: 왼쪽
  s: {
    type: "rect",
    x: 20,
    y: 140,
    w: 220,
    h: 250,
    rotate: 0,
    labelX: 130,
    labelY: 265,
  },
  // R석: 오른쪽
  r: {
    type: "rect",
    x: 560,
    y: 140,
    w: 220,
    h: 250,
    rotate: 0,
    labelX: 670,
    labelY: 265,
  },
  // 스탠딩: VIP 뒤 센터
  standing: {
    type: "rect",
    x: 270,
    y: 270,
    w: 260,
    h: 120,
    rotate: 0,
    labelX: 400,
    labelY: 330,
  },
};

/* 구역 이름 → fallback SVG shape key 매핑 */
function getFallbackSectionKey(name: string): string {
  const n = name.toLowerCase().replace(/\s+/g, "");
  if (n.includes("vip") || n.includes("soundcheck")) return "vip";
  if (n.includes("스탠딩") || n.includes("standing")) return "standing";
  if (
    n.includes("지정석s") ||
    n.includes("지정석 s") ||
    n === "s" ||
    n === "s석"
  )
    return "s";
  if (
    n.includes("지정석r") ||
    n.includes("지정석 r") ||
    n === "r" ||
    n === "r석"
  )
    return "r";
  return "standing";
}

/* venue section → SectionShape 변환 (항상 fallback shape 우선 사용) */
function venueToShape(section: VenueSectionData): SectionShape {
  // 이름 기반 fallback shape이 있으면 항상 그걸 사용 (일관된 레이아웃 보장)
  const fallbackKey = getFallbackSectionKey(section.name);
  if (FALLBACK_SECTION_SHAPES[fallbackKey]) {
    return FALLBACK_SECTION_SHAPES[fallbackKey];
  }
  if (section.svg_path) {
    return {
      type: "path",
      d: section.svg_path,
      labelX: section.center_x,
      labelY: section.center_y,
    };
  }
  return {
    type: "rect",
    x: section.center_x - 100,
    y: section.center_y - 50,
    w: 200,
    h: 100,
    rotate: 0,
    labelX: section.center_x,
    labelY: section.center_y,
  };
}

/* 구역별 색상 */
const SECTION_COLORS = [
  { fill: "#7B61FF", hover: "#9580FF" },
  { fill: "#01f5a0", hover: "#34ffb8" },
  { fill: "#FFD700", hover: "#ffe44d" },
  { fill: "#00D1FF", hover: "#33ddff" },
  { fill: "#FF00FF", hover: "#ff44ff" },
  { fill: "#FF6B6B", hover: "#ff9999" },
];

/* ── 좌석 좌표 기반 유틸 ── */

/** 좌석에 유효한 x,y 좌표가 있는지 확인 */
function seatsHaveCoordinates(seats: SeatData[]): boolean {
  if (seats.length === 0) return false;
  // 좌표가 있는 좌석이 50% 이상이면 좌표 기반 렌더링
  const withCoords = seats.filter(
    (s) => s.x !== 0 && s.y !== 0 && s.x != null && s.y != null,
  );
  return withCoords.length > seats.length * 0.5;
}

/** 좌석 좌표 경계 계산 + 패딩 */
function computeViewBox(
  seats: SeatData[],
  padding = 40,
): { minX: number; minY: number; width: number; height: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of seats) {
    if (s.x == null || s.y == null) continue;
    if (s.x < minX) minX = s.x;
    if (s.y < minY) minY = s.y;
    if (s.x > maxX) maxX = s.x;
    if (s.y > maxY) maxY = s.y;
  }
  // 스테이지 영역 위에 공간 확보
  const stageHeight = 60;
  return {
    minX: minX - padding,
    minY: minY - padding - stageHeight,
    width: maxX - minX + padding * 2,
    height: maxY - minY + padding * 2 + stageHeight,
  };
}

/** 섹션 내 좌석 클러스터의 중심 좌표 */
function sectionCenter(seats: SeatData[]): { cx: number; cy: number } {
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  for (const s of seats) {
    if (s.x == null || s.y == null) continue;
    sumX += s.x;
    sumY += s.y;
    count++;
  }
  if (count === 0) return { cx: 0, cy: 0 };
  return { cx: sumX / count, cy: sumY / count };
}

/** 섹션 경계 박스 */
function sectionBounds(seats: SeatData[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of seats) {
    if (s.x == null || s.y == null) continue;
    if (s.x < minX) minX = s.x;
    if (s.y < minY) minY = s.y;
    if (s.x > maxX) maxX = s.x;
    if (s.y > maxY) maxY = s.y;
  }
  return { minX, minY, maxX, maxY };
}

/** 좌석 밀도 기반 반지름 계산 */
function computeSeatRadius(seats: SeatData[]): number {
  if (seats.length < 2) return 6;
  // 가장 가까운 좌석 간 거리의 평균으로 반지름 결정
  let minDist = Infinity;
  const sample = seats.slice(0, Math.min(50, seats.length));
  for (let i = 0; i < sample.length; i++) {
    for (let j = i + 1; j < sample.length; j++) {
      const a = sample[i];
      const b = sample[j];
      if (a.x == null || a.y == null || b.x == null || b.y == null) continue;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > 0 && d < minDist) minDist = d;
    }
  }
  if (!isFinite(minDist) || minDist <= 0) return 6;
  // 반지름 = 최소 거리의 35%, 범위 3~8
  return Math.max(3, Math.min(8, minDist * 0.35));
}

/* ── tier → color 조회 ── */
function getTierColor(
  tier: SeatTier,
  index: number,
  venueSectionMap: Map<string, VenueSectionData> | null,
): { fill: string; hover: string } {
  if (venueSectionMap) {
    const venueSection =
      venueSectionMap.get(tier.name) ??
      venueSectionMap.get(tier.name.toLowerCase());
    if (venueSection?.color) {
      return { fill: venueSection.color, hover: `${venueSection.color}cc` };
    }
  }
  return SECTION_COLORS[index % SECTION_COLORS.length];
}

/* ── 메인 컴포넌트 ── */

export default function ConcertHallMap({
  tiers,
  selectedTierId,
  onSelectTier,
  seats,
  venue,
  selectedSeatIds,
  onSelectSeat,
  seatSelectionActive,
}: ConcertHallMapProps) {
  const t = useTranslations("booking.concertHallMap");
  const [hoveredTierId, setHoveredTierId] = useState<string | null>(null);
  const [hoveredSeatId, setHoveredSeatId] = useState<string | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{
    x: number;
    y: number;
  } | null>(null);

  /* venue sections 맵 생성 */
  const venueSectionMap = useMemo(() => {
    if (!venue?.sections?.length) return null;
    const map = new Map<string, VenueSectionData>();
    for (const s of venue.sections) {
      map.set(s.name, s);
      map.set(s.label, s);
    }
    return map;
  }, [venue]);

  const hasVenueSvg =
    venueSectionMap !== null &&
    venue!.sections.some((s) => s.svg_path || (s.center_x && s.center_y));

  /* 좌석 x,y 좌표가 있는지 확인 */
  const hasCoordinates = useMemo(
    () => (seats?.length ? seatsHaveCoordinates(seats) : false),
    [seats],
  );

  /* 좌석 뷰 활성 여부: seatSelectionActive AND 좌표 데이터 존재 */
  const showSeatView = seatSelectionActive && hasCoordinates;

  /* 섹션별 좌석 그룹 */
  const sectionMap = useMemo(() => {
    const map = new Map<string, SeatData[]>();
    if (!seats?.length) return map;
    for (const s of seats) {
      const arr = map.get(s.section) ?? [];
      arr.push(s);
      map.set(s.section, arr);
    }
    return map;
  }, [seats]);

  /* tier_id → tier 조회 맵 */
  const tierById = useMemo(() => {
    const map = new Map<string, { tier: SeatTier; index: number }>();
    tiers.forEach((t, i) => map.set(t.id, { tier: t, index: i }));
    return map;
  }, [tiers]);

  /* 좌표 기반 viewBox */
  const coordViewBox = useMemo(() => {
    if (!hasCoordinates || !seats?.length) return null;
    return computeViewBox(seats);
  }, [hasCoordinates, seats]);

  /* 좌석 반지름 */
  const seatRadius = useMemo(() => {
    if (!seats?.length) return 6;
    return computeSeatRadius(seats);
  }, [seats]);

  /* 기본 viewBox */
  const viewBox = useMemo(() => {
    if (coordViewBox && (showSeatView || hasCoordinates)) {
      return `${coordViewBox.minX} ${coordViewBox.minY} ${coordViewBox.width} ${coordViewBox.height}`;
    }
    return venue?.map_width && venue?.map_height
      ? `0 0 ${venue.map_width} ${venue.map_height}`
      : "0 0 800 440";
  }, [coordViewBox, showSeatView, hasCoordinates, venue]);

  /* tier → shape (fallback 모드용) */
  const getShapeForTier = useCallback(
    (tier: SeatTier): SectionShape | null => {
      if (hasVenueSvg && venueSectionMap) {
        const venueSection =
          venueSectionMap.get(tier.name) ??
          venueSectionMap.get(tier.name.toLowerCase());
        if (venueSection) return venueToShape(venueSection);
      }
      const key = getFallbackSectionKey(tier.name);
      return FALLBACK_SECTION_SHAPES[key] ?? null;
    },
    [hasVenueSvg, venueSectionMap],
  );

  /* stage shape — kind=stage 우선, 없으면 name "stage"/"STAGE" 매칭 */
  const stageShape = useMemo(() => {
    if (hasVenueSvg && venue?.sections?.length) {
      const stageByKind = venue.sections.find(
        (s) => (s.kind ?? "assigned") === "stage",
      );
      if (stageByKind) return venueToShape(stageByKind);
    }
    if (hasVenueSvg && venueSectionMap) {
      const stageSection =
        venueSectionMap.get("stage") ?? venueSectionMap.get("STAGE");
      if (stageSection && (stageSection.kind ?? "assigned") !== "console") {
        return venueToShape(stageSection);
      }
    }
    return FALLBACK_SECTION_SHAPES.stage;
  }, [hasVenueSvg, venue, venueSectionMap]);

  /* 좌석 색상 결정 */
  const getSeatColor = useCallback(
    (seat: SeatData): string => {
      if (selectedSeatIds?.has(seat.id)) return "#FFFFFF";
      if (seat.status === "sold") return "#555555";
      if (seat.status === "held") return "#FFCC00";
      if (seat.status === "reserved") return "#888888";
      // available → tier 색상
      const entry = tierById.get(seat.tier_id);
      if (entry) {
        return getTierColor(entry.tier, entry.index, venueSectionMap).fill;
      }
      return "#999999";
    },
    [selectedSeatIds, tierById, venueSectionMap],
  );

  const getSeatStroke = useCallback(
    (seat: SeatData): string => {
      if (selectedSeatIds?.has(seat.id)) return "#3A89FF";
      return "none";
    },
    [selectedSeatIds],
  );

  const getSeatStrokeWidth = useCallback(
    (seat: SeatData): number => {
      if (selectedSeatIds?.has(seat.id)) return 2;
      return 0;
    },
    [selectedSeatIds],
  );

  const isSeatClickable = useCallback((seat: SeatData): boolean => {
    return seat.status === "available";
  }, []);

  /* 좌석 뷰에서 스테이지 위치 계산 */
  const stageCoordPos = useMemo(() => {
    if (!coordViewBox) return null;
    return {
      x: coordViewBox.minX + coordViewBox.width / 2,
      y: coordViewBox.minY + 30,
      width: coordViewBox.width * 0.4,
      height: 40,
    };
  }, [coordViewBox]);

  /* ── 좌석 뷰 (개별 좌석 렌더링) ── */
  if (showSeatView && seats?.length) {
    return (
      <div className="flex flex-col h-full items-center justify-center px-4">
        <svg
          viewBox={viewBox}
          className="w-full h-auto"
          style={{
            maxHeight: "calc(100% - 40px)",
            maxWidth: "min(900px, 100%)",
          }}
        >
          {/* 스테이지 */}
          {stageCoordPos && (
            <>
              <rect
                x={stageCoordPos.x - stageCoordPos.width / 2}
                y={stageCoordPos.y - stageCoordPos.height / 2}
                width={stageCoordPos.width}
                height={stageCoordPos.height}
                rx={8}
                fill="var(--muted)"
                stroke="var(--border)"
                strokeWidth="1.5"
              />
              <text
                x={stageCoordPos.x}
                y={stageCoordPos.y}
                textAnchor="middle"
                dominantBaseline="middle"
                className="fill-muted-foreground text-[13px] font-bold tracking-[0.2em]"
                style={{ pointerEvents: "none" }}
              >
                STAGE
              </text>
            </>
          )}

          {/* 섹션 라벨 */}
          {Array.from(sectionMap.entries()).map(([section, sectionSeats]) => {
            const center = sectionCenter(sectionSeats);
            if (center.cx === 0 && center.cy === 0) return null;
            // tier 정보로 라벨 표시
            const firstSeat = sectionSeats[0];
            const entry = firstSeat ? tierById.get(firstSeat.tier_id) : null;
            const tierName = entry?.tier.name ?? section;
            return (
              <text
                key={`label-${section}`}
                x={center.cx}
                y={center.cy - seatRadius * 3}
                textAnchor="middle"
                dominantBaseline="middle"
                className="fill-muted-foreground text-[10px] font-semibold"
                style={{ pointerEvents: "none" }}
              >
                {tierName}
              </text>
            );
          })}

          {/* 개별 좌석 */}
          {seats.map((seat) => {
            if (seat.x == null || seat.y == null) return null;
            const clickable = isSeatClickable(seat);
            const isHovered = hoveredSeatId === seat.id;
            const isSelected = selectedSeatIds?.has(seat.id);
            return (
              <circle
                key={seat.id}
                cx={seat.x}
                cy={seat.y}
                r={
                  isSelected
                    ? seatRadius * 1.2
                    : isHovered
                      ? seatRadius * 1.1
                      : seatRadius
                }
                fill={getSeatColor(seat)}
                stroke={getSeatStroke(seat)}
                strokeWidth={getSeatStrokeWidth(seat)}
                opacity={
                  seat.status === "sold"
                    ? 0.3
                    : seat.status === "reserved"
                      ? 0.4
                      : 1
                }
                className={`transition-all duration-100 ${clickable ? "cursor-pointer" : "cursor-not-allowed"}`}
                onClick={() => {
                  if (clickable && onSelectSeat) onSelectSeat(seat);
                }}
                onMouseEnter={(e) => {
                  setHoveredSeatId(seat.id);
                  const svg = e.currentTarget.ownerSVGElement;
                  if (svg) {
                    const pt = svg.createSVGPoint();
                    pt.x = seat.x;
                    pt.y = seat.y;
                    setTooltipPos({ x: seat.x, y: seat.y - seatRadius - 12 });
                  }
                }}
                onMouseLeave={() => {
                  setHoveredSeatId(null);
                  setTooltipPos(null);
                }}
              />
            );
          })}

          {/* 좌석 호버 툴팁 */}
          {hoveredSeatId &&
            tooltipPos &&
            (() => {
              const seat = seats.find((s) => s.id === hoveredSeatId);
              if (!seat) return null;
              const label =
                seat.label ??
                `${seat.section} ${seat.row_number}-${seat.seat_number}`;
              const statusText =
                seat.status === "sold"
                  ? t("soldOut")
                  : seat.status === "held"
                    ? t("held")
                    : seat.status === "reserved"
                      ? t("reserved")
                      : "";
              return (
                <g style={{ pointerEvents: "none" }}>
                  <rect
                    x={tooltipPos.x - 40}
                    y={tooltipPos.y - 14}
                    width={80}
                    height={18}
                    rx={4}
                    fill="var(--popover)"
                    stroke="var(--border)"
                    strokeWidth="0.5"
                    opacity={0.95}
                  />
                  <text
                    x={tooltipPos.x}
                    y={tooltipPos.y - 5}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    className="fill-foreground text-[9px] font-medium"
                  >
                    {label} {statusText}
                  </text>
                </g>
              );
            })()}
        </svg>

        <p className="text-center text-xs text-muted-foreground mt-2">
          {t("clickSeatToSelect")}
        </p>
      </div>
    );
  }

  /* ── 섹션 뷰 (x,y 좌표 기반 경계 박스) — 비활성: 항상 fallback 사용 ── */
  if (false as boolean) {
    return (
      <div className="flex flex-col h-full items-center justify-center px-4">
        <svg
          viewBox={viewBox}
          className="w-full h-auto"
          style={{
            maxHeight: "calc(100% - 40px)",
            maxWidth: "min(900px, 100%)",
          }}
        >
          {/* 스테이지 */}
          {stageCoordPos && (
            <>
              <rect
                x={stageCoordPos.x - stageCoordPos.width / 2}
                y={stageCoordPos.y - stageCoordPos.height / 2}
                width={stageCoordPos.width}
                height={stageCoordPos.height}
                rx={8}
                fill="var(--muted)"
                stroke="var(--border)"
                strokeWidth="1.5"
              />
              <text
                x={stageCoordPos.x}
                y={stageCoordPos.y}
                textAnchor="middle"
                dominantBaseline="middle"
                className="fill-muted-foreground text-[13px] font-bold tracking-[0.2em]"
                style={{ pointerEvents: "none" }}
              >
                STAGE
              </text>
            </>
          )}

          {/* 섹션 영역 (tier별 경계 박스) */}
          {tiers.map((tier, i) => {
            const sectionSeats =
              sectionMap.get(tier.name) ??
              sectionMap.get(tier.section_name ?? "") ??
              [];
            if (sectionSeats.length === 0) return null;

            const bounds = sectionBounds(sectionSeats);
            if (!isFinite(bounds.minX)) return null;

            const pad = seatRadius * 2;
            const bx = bounds.minX - pad;
            const by = bounds.minY - pad;
            const bw = bounds.maxX - bounds.minX + pad * 2;
            const bh = bounds.maxY - bounds.minY + pad * 2;

            const available = sectionSeats.filter(
              (s) => s.status === "available",
            ).length;
            const isSoldOut = sectionSeats.length > 0 && available === 0;
            const isSelected = selectedTierId === tier.id;
            const isHovered = hoveredTierId === tier.id;
            const color = getTierColor(tier, i, venueSectionMap);
            const price = tier.face_price ?? tier.base_price;

            const fillColor = isSoldOut
              ? "var(--muted)"
              : isSelected
                ? `${color.fill}55`
                : isHovered
                  ? `${color.fill}33`
                  : `${color.fill}18`;
            const strokeColor = isSelected
              ? color.fill
              : isHovered
                ? color.fill
                : `${color.fill}66`;
            const sw = isSelected ? 2.5 : 1.5;

            const center = sectionCenter(sectionSeats);

            return (
              <g key={tier.id}>
                <rect
                  x={bx}
                  y={by}
                  width={bw}
                  height={bh}
                  rx={6}
                  fill={fillColor}
                  stroke={strokeColor}
                  strokeWidth={sw}
                  className={`transition-all duration-200 ${isSoldOut ? "opacity-30 cursor-not-allowed" : "cursor-pointer"}`}
                  onClick={() => !isSoldOut && onSelectTier(tier.id)}
                  onMouseEnter={() => setHoveredTierId(tier.id)}
                  onMouseLeave={() => setHoveredTierId(null)}
                />
                <text
                  x={center.cx}
                  y={center.cy - 10}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  className={`text-[14px] font-black ${isSelected ? "fill-foreground" : "fill-foreground"}`}
                  style={{ pointerEvents: "none" }}
                >
                  {tier.name}
                </text>
                <text
                  x={center.cx}
                  y={center.cy + 8}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  className="text-[11px] font-medium fill-muted-foreground"
                  style={{ pointerEvents: "none" }}
                >
                  {isSoldOut ? "매진" : `₩${price.toLocaleString()}`}
                </text>
                <text
                  x={center.cx}
                  y={center.cy + 22}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  className="text-[10px] fill-muted-foreground/60"
                  style={{ pointerEvents: "none" }}
                >
                  {isSoldOut ? "" : `${tier.remaining}석 남음`}
                </text>
              </g>
            );
          })}
        </svg>

        <p className="text-center text-xs text-muted-foreground mt-2">
          구역을 클릭하고 좌석을 선택해주세요
        </p>
      </div>
    );
  }

  /* ── Fallback 섹션 뷰 (기존 SVG shapes 기반) ── */
  const fallbackViewBox =
    venue?.map_width && venue?.map_height
      ? `0 0 ${venue.map_width} ${venue.map_height}`
      : "0 0 800 440";

  return (
    <div className="flex flex-col h-full items-center justify-center px-4">
      <svg
        viewBox={fallbackViewBox}
        className="w-full h-auto"
        style={{ maxHeight: "calc(100% - 40px)", maxWidth: "min(900px, 100%)" }}
      >
        {/* 스테이지 */}
        {stageShape.type === "path" && stageShape.d ? (
          <path
            d={stageShape.d}
            fill="var(--muted)"
            stroke="var(--border)"
            strokeWidth="1.5"
          />
        ) : (
          <rect
            x={stageShape.x!}
            y={stageShape.y!}
            width={stageShape.w!}
            height={stageShape.h!}
            rx={8}
            fill="var(--muted)"
            stroke="var(--border)"
            strokeWidth="1.5"
          />
        )}
        <text
          x={stageShape.labelX}
          y={stageShape.labelY}
          textAnchor="middle"
          dominantBaseline="middle"
          className="fill-muted-foreground text-[13px] font-bold tracking-[0.2em]"
          style={{ pointerEvents: "none" }}
        >
          STAGE
        </text>

        {/* 구역들 */}
        {tiers.map((tier, i) => {
          const shape = getShapeForTier(tier);
          if (!shape) return null;

          const sectionSeats = sectionMap.get(tier.name) ?? [];
          const available = sectionSeats.filter(
            (s) => s.status === "available",
          ).length;
          const isSoldOut = sectionSeats.length > 0 && available === 0;
          const isSelected = selectedTierId === tier.id;
          const isHovered = hoveredTierId === tier.id;
          const color = getTierColor(tier, i, venueSectionMap);
          const price = tier.face_price ?? tier.base_price;

          const fillColor = isSoldOut
            ? "var(--muted)"
            : isSelected
              ? color.fill
              : isHovered
                ? `${color.fill}44`
                : `${color.fill}22`;
          const strokeColor = isSelected
            ? color.fill
            : isHovered
              ? color.fill
              : `${color.fill}66`;
          const sw = isSelected ? 3 : 1.5;
          const cls = `transition-all duration-200 ${isSoldOut ? "opacity-30 cursor-not-allowed" : "cursor-pointer"}`;
          const handlers = {
            onClick: () => !isSoldOut && onSelectTier(tier.id),
            onMouseEnter: () => setHoveredTierId(tier.id),
            onMouseLeave: () => setHoveredTierId(null),
          };

          return (
            <g key={tier.id}>
              {shape.type === "path" ? (
                <path
                  d={shape.d!}
                  fill={fillColor}
                  stroke={strokeColor}
                  strokeWidth={sw}
                  className={cls}
                  {...handlers}
                />
              ) : (
                <rect
                  x={shape.x!}
                  y={shape.y!}
                  width={shape.w!}
                  height={shape.h!}
                  rx={8}
                  transform={
                    shape.rotate
                      ? `rotate(${shape.rotate} ${shape.x! + shape.w! / 2} ${shape.y! + shape.h! / 2})`
                      : undefined
                  }
                  fill={fillColor}
                  stroke={strokeColor}
                  strokeWidth={sw}
                  className={cls}
                  {...handlers}
                />
              )}

              <text
                x={shape.labelX}
                y={shape.labelY - 10}
                textAnchor="middle"
                dominantBaseline="middle"
                className={`text-[14px] font-black ${isSelected ? "fill-white" : "fill-foreground"}`}
                style={{ pointerEvents: "none" }}
              >
                {tier.name}
              </text>

              <text
                x={shape.labelX}
                y={shape.labelY + 10}
                textAnchor="middle"
                dominantBaseline="middle"
                className={`text-[11px] font-medium ${isSelected ? "fill-white/80" : "fill-muted-foreground"}`}
                style={{ pointerEvents: "none" }}
              >
                {isSoldOut ? t("soldOut") : `₩${price.toLocaleString()}`}
              </text>

              <text
                x={shape.labelX}
                y={shape.labelY + 26}
                textAnchor="middle"
                dominantBaseline="middle"
                className={`text-[10px] ${isSelected ? "fill-white/60" : "fill-muted-foreground/60"}`}
                style={{ pointerEvents: "none" }}
              >
                {isSoldOut ? "" : t("seatsRemaining", { count: tier.remaining })}
              </text>

              {isSelected && (
                <circle
                  cx={shape.labelX + 35}
                  cy={shape.labelY - 20}
                  r="5"
                  fill="white"
                />
              )}
            </g>
          );
        })}
      </svg>

      <p className="text-center text-xs text-muted-foreground mt-2">
        {t("clickZoneToSelectSeat")}
      </p>
    </div>
  );
}
