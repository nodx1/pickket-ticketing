"use client";

/**
 * Phase 1-Map — 좌석 배치도 원본(canvas) 뷰어.
 *
 * v2 EventResponse.seat_map_data(= go seat_maps.map_data 원본 + 배경 + 랜드마크 + 다층)을
 * 그대로 렌더한다. 주최자가 피그마 빌더로 그린 배치를 소비자가 원본 좌표로 본다.
 *
 * ── 렌더 대상 ──
 *  1. 배경 도면(background.url, opacity)  — 이미지 오버레이
 *  2. 섹션(map_data.figmaLayout.sections) — 지정석/스탠딩/무대/콘솔 (VenuePreview 규격과 동일)
 *  3. 랜드마크(landmarks)                  — 무대/통로/출구 등 장식 블록
 *  4. 다층(floor_index/floor_label)        — 층 전환 탭
 *
 * ★ 범위: 배치도 "원본 표시" 전용. 좌석 재고/선택/티어 잔여는 여기서 다루지 않는다(기존 예매 플로우 소관).
 * ★ 폴백: map_data 가 figma 형태가 아니거나 섹션이 없으면 배경/랜드마크만 표시. maps 자체가 없으면
 *   상위(EventDetailClient)가 이 컴포넌트를 렌더하지 않고 VenuePreview/seat_map_url 로 폴백한다.
 */

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { MapPin } from "lucide-react";
import type { SeatMapData, SeatMapLayer } from "@pickket/lib/api";

/* 피그마 섹션 원본 shape (go seat_maps.map_data.figmaLayout.sections). 방어적으로 optional. */
type SectionKind = "assigned" | "standing" | "stage" | "console";

interface FigmaSectionRaw {
  name?: string;
  x?: number;
  y?: number;
  rotation?: number;
  kind?: SectionKind;
  rows?: number;
  seatsPerRow?: number;
  blockedPositions?: string[];
  capacity?: number;
  width?: number;
  height?: number;
  tierId?: string | null;
}

interface FigmaMapData {
  mode?: string;
  figmaLayout?: { sections?: FigmaSectionRaw[] };
}

const SEAT_SIZE = 16;
const SEAT_GAP = 4;
const PADDING = 20;
const NAME_HEIGHT = 20;

/** figma 섹션 치수 — go grid-layout-sync / figma-builder 와 동일 계산(원본 재현). */
function sectionDims(s: FigmaSectionRaw): { width: number; height: number } {
  const kind = s.kind ?? "assigned";
  if (kind === "stage") return { width: s.width ?? 320, height: s.height ?? 80 };
  if (kind === "console")
    return { width: s.width ?? 180, height: s.height ?? 80 };
  if (kind === "standing") {
    if (s.width && s.height) return { width: s.width, height: s.height };
    const cap = s.capacity ?? 100;
    const scale = Math.max(1, Math.sqrt(cap / 50));
    return { width: 180 * scale, height: 120 * scale };
  }
  const rows = s.rows ?? 5;
  const seatsPerRow = s.seatsPerRow ?? 8;
  const width = seatsPerRow * (SEAT_SIZE + SEAT_GAP) - SEAT_GAP + PADDING * 2;
  const height =
    rows * (SEAT_SIZE + SEAT_GAP) - SEAT_GAP + PADDING * 2 + NAME_HEIGHT;
  return { width, height };
}

/** map_data(unknown) → figma sections. figma 모드가 아니면 []. */
function extractSections(mapData: unknown): FigmaSectionRaw[] {
  if (!mapData || typeof mapData !== "object") return [];
  const md = mapData as FigmaMapData;
  if (md.mode !== "figma") return [];
  const sections = md.figmaLayout?.sections;
  return Array.isArray(sections) ? sections : [];
}

/** http(s) URL 만 배경으로 허용(스킴 인젝션 방지). */
function safeImageUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith("/")) return trimmed;
  return null;
}

/** 캔버스 경계 계산 — 배경 크기 우선, 없으면 섹션+랜드마크 bbox. */
function computeCanvas(layer: SeatMapLayer): { width: number; height: number } {
  const bgW = layer.background?.width ?? 0;
  const bgH = layer.background?.height ?? 0;
  if (bgW > 0 && bgH > 0) return { width: bgW, height: bgH };

  let maxX = 0;
  let maxY = 0;
  const sections = extractSections(layer.map_data);
  for (const s of sections) {
    const { width, height } = sectionDims(s);
    maxX = Math.max(maxX, (s.x ?? 0) + width / 2);
    maxY = Math.max(maxY, (s.y ?? 0) + height / 2);
  }
  for (const lm of layer.landmarks) {
    maxX = Math.max(maxX, lm.x + lm.width / 2);
    maxY = Math.max(maxY, lm.y + lm.height / 2);
  }
  return {
    width: Math.max(maxX + PADDING * 2, 400),
    height: Math.max(maxY + PADDING * 2, 300),
  };
}

interface SeatMapViewerProps {
  seatMapData: SeatMapData;
}

export default function SeatMapViewer({ seatMapData }: SeatMapViewerProps) {
  const t = useTranslations("event.seatMapViewer");

  /* floor_index 오름차순 정렬된 층 목록 */
  const layers = useMemo(() => {
    return [...(seatMapData.maps ?? [])].sort(
      (a, b) => a.floor_index - b.floor_index,
    );
  }, [seatMapData]);

  const [activeId, setActiveId] = useState<string | null>(
    layers[0]?.id ?? null,
  );
  const activeLayer =
    layers.find((l) => l.id === activeId) ?? layers[0] ?? null;

  if (!activeLayer) return null;

  const sections = extractSections(activeLayer.map_data);
  const bgUrl = safeImageUrl(activeLayer.background?.url);
  const canvas = computeCanvas(activeLayer);
  const viewBox = `0 0 ${canvas.width} ${canvas.height}`;
  const hasContent =
    sections.length > 0 || activeLayer.landmarks.length > 0 || !!bgUrl;

  return (
    <div>
      {/* 층 전환 탭 (다층일 때만) */}
      {layers.length > 1 && (
        <div className="flex flex-wrap gap-2 mb-4">
          {layers.map((layer) => {
            const isActive = layer.id === activeLayer.id;
            const label =
              layer.floor_label ||
              layer.name ||
              t("floorFallback", { index: layer.floor_index + 1 });
            return (
              <button
                key={layer.id}
                type="button"
                onClick={() => setActiveId(layer.id)}
                aria-pressed={isActive}
                className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors ${
                  isActive
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:bg-muted/70"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}

      {!hasContent ? (
        <div className="flex flex-col items-center justify-center py-16 px-4">
          <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mb-4">
            <MapPin className="h-7 w-7 text-primary/40" />
          </div>
          <p className="text-sm font-medium text-muted-foreground">
            {t("emptyTitle")}
          </p>
        </div>
      ) : (
        <div className="relative w-full max-w-4xl mx-auto rounded-xl overflow-hidden bg-muted/5 border border-border/40">
          <svg
            viewBox={viewBox}
            className="w-full h-auto"
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label={t("mapAriaLabel", {
              name: activeLayer.floor_label || activeLayer.name || "",
            })}
          >
            {/* 1) 배경 도면 */}
            {bgUrl && (
              <image
                href={bgUrl}
                x={0}
                y={0}
                width={canvas.width}
                height={canvas.height}
                preserveAspectRatio="xMidYMid meet"
                opacity={activeLayer.background?.opacity ?? 0.5}
              />
            )}

            {/* 2) 랜드마크(장식: 무대/통로/출구 등) — 섹션 아래 레이어 */}
            {activeLayer.landmarks.map((lm, i) => {
              const color = lm.color_hex || "#94A3B8";
              const transform = lm.rotation
                ? `rotate(${lm.rotation} ${lm.x} ${lm.y})`
                : undefined;
              return (
                <g
                  key={`lm-${i}`}
                  transform={transform}
                  className="pointer-events-none"
                >
                  <rect
                    x={lm.x - lm.width / 2}
                    y={lm.y - lm.height / 2}
                    width={lm.width}
                    height={lm.height}
                    rx={6}
                    fill={color}
                    fillOpacity={0.14}
                    stroke={color}
                    strokeWidth={1.2}
                    strokeOpacity={0.5}
                  />
                  {lm.label && (
                    <text
                      x={lm.x}
                      y={lm.y + 4}
                      textAnchor="middle"
                      className="text-[12px] font-semibold"
                      fill={color}
                    >
                      {lm.label}
                    </text>
                  )}
                </g>
              );
            })}

            {/* 3) 섹션(figma 원본 좌표) */}
            {sections.map((s, i) => {
              const kind = s.kind ?? "assigned";
              const { width, height } = sectionDims(s);
              const cx = s.x ?? 0;
              const cy = s.y ?? 0;
              const rotation = s.rotation ?? 0;
              const transform = rotation
                ? `rotate(${rotation} ${cx} ${cy})`
                : undefined;
              const name = s.name ?? "";

              if (kind === "stage") {
                return (
                  <g
                    key={`sec-${i}`}
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
                      {name || "STAGE"}
                    </text>
                  </g>
                );
              }

              if (kind === "console") {
                return (
                  <g
                    key={`sec-${i}`}
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
                      {name || t("consoleLabel")}
                    </text>
                  </g>
                );
              }

              if (kind === "standing") {
                return (
                  <g
                    key={`sec-${i}`}
                    transform={transform}
                    className="pointer-events-none"
                  >
                    <rect
                      x={cx - width / 2}
                      y={cy - height / 2}
                      width={width}
                      height={height}
                      rx={8}
                      fill="#6C5CE7"
                      fillOpacity={0.22}
                      stroke="#6C5CE7"
                      strokeWidth={1.5}
                      strokeOpacity={0.7}
                      strokeDasharray="6 4"
                    />
                    <text
                      x={cx}
                      y={cy - 4}
                      textAnchor="middle"
                      className="text-[12px] font-bold"
                      fill="#6C5CE7"
                    >
                      {name}
                    </text>
                    {s.capacity ? (
                      <text
                        x={cx}
                        y={cy + 14}
                        textAnchor="middle"
                        className="text-[10px] fill-muted-foreground"
                      >
                        {t("standingCapacity", { count: s.capacity })}
                      </text>
                    ) : null}
                  </g>
                );
              }

              /* assigned — 섹션 박스 + 좌석 격자(원본 rows×seatsPerRow, blocked 반영) */
              const rows = s.rows ?? 5;
              const seatsPerRow = s.seatsPerRow ?? 8;
              const blocked = new Set(s.blockedPositions ?? []);
              const gridLeft = cx - width / 2 + PADDING;
              const gridTop = cy - height / 2 + PADDING + NAME_HEIGHT;
              const seatDots: React.ReactNode[] = [];
              for (let r = 0; r < rows; r++) {
                for (let c = 0; c < seatsPerRow; c++) {
                  if (blocked.has(`${r}-${c}`)) continue;
                  seatDots.push(
                    <rect
                      key={`d-${r}-${c}`}
                      x={gridLeft + c * (SEAT_SIZE + SEAT_GAP)}
                      y={gridTop + r * (SEAT_SIZE + SEAT_GAP)}
                      width={SEAT_SIZE}
                      height={SEAT_SIZE}
                      rx={3}
                      fill="#6C5CE7"
                      fillOpacity={0.55}
                    />,
                  );
                }
              }
              return (
                <g
                  key={`sec-${i}`}
                  transform={transform}
                  className="pointer-events-none"
                >
                  <rect
                    x={cx - width / 2}
                    y={cy - height / 2}
                    width={width}
                    height={height}
                    rx={6}
                    fill="#6C5CE7"
                    fillOpacity={0.06}
                    stroke="#6C5CE7"
                    strokeWidth={1}
                    strokeOpacity={0.35}
                  />
                  <text
                    x={cx}
                    y={cy - height / 2 + 14}
                    textAnchor="middle"
                    className="text-[11px] font-bold"
                    fill="#6C5CE7"
                    fillOpacity={0.9}
                  >
                    {name}
                  </text>
                  {seatDots}
                </g>
              );
            })}
          </svg>
        </div>
      )}

      <p className="text-2xs text-muted-foreground/60 mt-3 text-center">
        {t("disclaimer")}
      </p>
    </div>
  );
}
