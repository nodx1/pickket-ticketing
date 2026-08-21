"use client";

/**
 * SeatMap — Canvas 기반 좌석 배치도 (Phase 6 포팅)
 *
 * v2 consumer/src/components/seat-map/SeatMap.tsx를 GO에 맞춰 포팅.
 * - `@/lib/seats/types`의 Seat 타입 사용 (section/row/seatNumber가 string)
 * - NULL 좌표 방어: row+seatNumber로 그리드 좌표 폴백
 * - 실시간 업데이트는 `@/lib/hooks/useSeatStream` 사용 (Phase 4 스텁)
 * - 접근성: 캔버스 focus + 키보드 탐색(방향키/Space/Enter)
 * - 라이트모드 전용 색상 토큰
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import dynamic from "next/dynamic";
import type { Seat, SeatStatus } from "@/lib/seats/types";
import { useSeatStream } from "@/lib/hooks/useSeatStream";
import { attachTouchGestures, type Transform } from "@/lib/seats/touch-gestures";
import { formatKRW } from "@/lib/format";
import { pickRenderer } from "./renderers/types";

// PixiJS 렌더러는 SSR 불가 + 번들 큼 → 동적 import (admin/대형 이벤트 전용)
const SeatMapWebGL = dynamic(
  () => import("./SeatMapWebGL").then((m) => m.SeatMapWebGL),
  { ssr: false },
);

type DisplayStatus = SeatStatus | "selected" | "disabled";

const STATUS_COLORS: Record<DisplayStatus, string> = {
  available: "#10b981", // emerald-500
  held: "#f59e0b", // amber-500
  sold: "#9ca3af", // gray-400
  selected: "#6c5ce7", // primary
  disabled: "#e5e7eb", // gray-200
  reserved: "#9ca3af",
  blocked: "#9ca3af",
};

const STATUS_LABEL: Record<DisplayStatus, string> = {
  available: "선택 가능",
  selected: "내 선택",
  held: "선택 중",
  sold: "판매 완료",
  reserved: "판매 완료",
  blocked: "이용 불가",
  disabled: "이용 불가",
};

/**
 * P0-A2 — 색각 이상(색맹) 사용자도 상태를 구분할 수 있도록 좌석 중앙에
 * 심볼을 덧그린다. 색상만으로 구분하는 대신 텍스트/기호를 같이 표시.
 * - selected: ✓ (체크)
 * - held: ◴ (타이머)
 * - sold/reserved: × (매진)
 * - blocked/disabled: ■ (블록)
 * - available: 심볼 없음 (좌석 번호만)
 */
const STATUS_SYMBOL: Record<DisplayStatus, string> = {
  available: "",
  selected: "✓",
  held: "◴",
  sold: "×",
  reserved: "×",
  blocked: "■",
  disabled: "■",
};

const SEAT_SIZE = 22;
const SEAT_GAP = 6;

export interface SeatTierInfo {
  id: string;
  name: string;
  price: number;
  color?: string;
}

interface SeatMapProps {
  eventId: string;
  seats: Seat[];
  maxSelectable?: number;
  onSelect?: (selected: Seat[]) => void;
  /** 등급 정보 — 가격 라벨/색상에 사용 */
  tiers?: SeatTierInfo[];
  /** 좌석 길게 누름(500ms) → 시야 미리보기 트리거 */
  onSeatLongPress?: (seat: Seat) => void;
  /**
   * 렌더러 선택 (트랙 3.1):
   * - "auto" (기본): 5,000석 미만 → canvas2d, 이상 → webgl(pixijs)
   * - "canvas2d": 강제 Canvas 2D
   * - "webgl": 강제 PixiJS WebGL (대형 이벤트, 잠실급)
   */
  renderer?: "auto" | "canvas2d" | "webgl";
  className?: string;
}

/**
 * seatNumber 문자열에서 숫자만 추출. "12A" → 12, "A-03" → 3.
 */
function parseNumericSuffix(value: string): number {
  const match = value.match(/\d+/g);
  if (!match || match.length === 0) return 0;
  return Number.parseInt(match[match.length - 1] ?? "0", 10) || 0;
}

/**
 * NULL 좌표 방어 — row/seatNumber로 그리드 좌표를 계산한다.
 */
function resolveSeatGrid(seats: Seat[]): Map<string, { gx: number; gy: number }> {
  const rowSet = new Set<string>();
  for (const s of seats) rowSet.add(s.row);
  const rowList = Array.from(rowSet).sort((a, b) => a.localeCompare(b));
  const rowIndex = new Map<string, number>();
  rowList.forEach((row, idx) => rowIndex.set(row, idx));

  const result = new Map<string, { gx: number; gy: number }>();
  for (const seat of seats) {
    const gx =
      seat.x !== null && Number.isFinite(seat.x)
        ? seat.x
        : parseNumericSuffix(seat.seatNumber);
    const gy =
      seat.y !== null && Number.isFinite(seat.y)
        ? seat.y
        : rowIndex.get(seat.row) ?? 0;
    result.set(seat.id, { gx, gy });
  }
  return result;
}

export function SeatMap({
  eventId,
  seats: initialSeats,
  maxSelectable = 4,
  onSelect,
  tiers,
  onSeatLongPress,
  renderer = "auto",
  className,
}: SeatMapProps) {
  // 트랙 3 — 렌더러 자동/명시 선택
  const effectiveRenderer = useMemo(() => {
    if (renderer === "auto") return pickRenderer(initialSeats.length);
    return renderer;
  }, [renderer, initialSeats.length]);

  if (effectiveRenderer === "webgl") {
    return (
      <SeatMapWebGL
        eventId={eventId}
        seats={initialSeats}
        maxSelectable={maxSelectable}
        onSelect={onSelect}
        tiers={tiers}
        onSeatLongPress={onSeatLongPress}
        className={className}
      />
    );
  }

  // canvas2d 경로 (기본)
  return (
    <SeatMapCanvas2D
      eventId={eventId}
      seats={initialSeats}
      maxSelectable={maxSelectable}
      onSelect={onSelect}
      tiers={tiers}
      onSeatLongPress={onSeatLongPress}
      className={className}
    />
  );
}

interface CanvasProps {
  eventId: string;
  seats: Seat[];
  maxSelectable: number;
  onSelect?: (selected: Seat[]) => void;
  tiers?: SeatTierInfo[];
  onSeatLongPress?: (seat: Seat) => void;
  className?: string;
}

function SeatMapCanvas2D({
  eventId,
  seats: initialSeats,
  maxSelectable,
  onSelect,
  tiers,
  onSeatLongPress,
  className,
}: CanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [seats, setSeats] = useState<Seat[]>(initialSeats);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [focusSeatId, setFocusSeatId] = useState<string | null>(null);
  const [transform, setTransform] = useState<Transform>({ scale: 1, x: 0, y: 0 });
  const transformRef = useRef(transform);
  useEffect(() => {
    transformRef.current = transform;
  }, [transform]);

  // 등급 ID → 정보 맵 (가격 라벨, 색상)
  const tierMap = useMemo(() => {
    const m = new Map<string, SeatTierInfo>();
    tiers?.forEach((t) => m.set(t.id, t));
    return m;
  }, [tiers]);

  // 호환용: 기존 코드는 scale만 참조
  const scale = transform.scale;

  // prop 변경 반영 — 좌석 ID 셋이 실제로 바뀔 때만 업데이트 (배열 참조 변경 무시)
  const seatIdsKey = useMemo(
    () => initialSeats.map((s) => `${s.id}:${s.status}`).join("|"),
    [initialSeats],
  );
  useEffect(() => {
    setSeats(initialSeats);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seatIdsKey]);

  // 실시간 업데이트
  useSeatStream(eventId, (update) => {
    setSeats((prev) =>
      prev.map((s) =>
        s.id === update.seatId
          ? { ...s, status: update.status, heldUntil: update.heldUntil ?? null }
          : s,
      ),
    );
    if (update.status !== "available" && selectedIds.has(update.seatId)) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(update.seatId);
        return next;
      });
    }
  });

  const gridMap = useMemo(() => resolveSeatGrid(seats), [seats]);

  // 그리드 범위 계산 (aria-label, 포커스 탐색용)
  const { minGx, minGy } = useMemo(() => {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    gridMap.forEach(({ gx, gy }) => {
      if (gx < minX) minX = gx;
      if (gy < minY) minY = gy;
    });
    if (!Number.isFinite(minX)) minX = 0;
    if (!Number.isFinite(minY)) minY = 0;
    return { minGx: minX, minGy: minY };
  }, [gridMap]);

  const drawSeat = useCallback(
    (ctx: CanvasRenderingContext2D, seat: Seat, isSelected: boolean, isFocused: boolean) => {
      const pos = gridMap.get(seat.id);
      if (!pos) return;
      const x = (pos.gx - minGx) * (SEAT_SIZE + SEAT_GAP);
      const y = (pos.gy - minGy) * (SEAT_SIZE + SEAT_GAP);
      const status: DisplayStatus = isSelected ? "selected" : seat.status;
      // tier 색상 우선 (사용 가능 좌석에 한해), 그 외에는 상태별 색상
      const tier = seat.tierId ? tierMap.get(seat.tierId) : null;
      const useTierColor =
        status === "available" && tier?.color && tier.color.startsWith("#");
      ctx.fillStyle = useTierColor ? (tier!.color as string) : STATUS_COLORS[status];
      ctx.beginPath();
      if (typeof ctx.roundRect === "function") {
        ctx.roundRect(x, y, SEAT_SIZE, SEAT_SIZE, 4);
      } else {
        ctx.rect(x, y, SEAT_SIZE, SEAT_SIZE);
      }
      ctx.fill();

      if (isFocused) {
        ctx.strokeStyle = "#1a1d2e";
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      if (scale > 0.8) {
        const isDim =
          status === "sold" ||
          status === "reserved" ||
          status === "blocked";
        ctx.fillStyle = isDim ? "#ffffff" : "#1a1d2e";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        // P0-A2 — 색각 이상 대응: 상태별 심볼을 표시해 색상에만 의존하지 않게 함
        const symbol = STATUS_SYMBOL[status];
        if (symbol) {
          ctx.font = "bold 14px sans-serif";
          ctx.fillText(symbol, x + SEAT_SIZE / 2, y + SEAT_SIZE / 2);
        } else {
          ctx.font = "10px sans-serif";
          const labelText = seat.label || `${seat.row}${seat.seatNumber}`;
          ctx.fillText(
            labelText.length > 4 ? labelText.slice(0, 4) : labelText,
            x + SEAT_SIZE / 2,
            y + SEAT_SIZE / 2,
          );
        }
      }

      // 가격 라벨 (Phase 1.2) — 줌 1.4 이상에서만 표시 (성능)
      if (scale >= 1.4 && tier && status === "available") {
        ctx.fillStyle = "#1a1d2e";
        ctx.font = "9px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        const priceText =
          tier.price >= 10000
            ? `${Math.round(tier.price / 1000)}k`
            : String(tier.price);
        ctx.fillText(priceText, x + SEAT_SIZE / 2, y + SEAT_SIZE + 2);
      }
    },
    [gridMap, minGx, minGy, scale, tierMap],
  );

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    ctx.save();
    // Phase 1.1 — pan(translate) + zoom(scale) 통합
    ctx.translate(transform.x, transform.y);
    ctx.scale(transform.scale, transform.scale);

    for (const seat of seats) {
      drawSeat(ctx, seat, selectedIds.has(seat.id), focusSeatId === seat.id);
    }
    ctx.restore();
  }, [seats, selectedIds, focusSeatId, transform, drawSeat]);

  useEffect(() => {
    draw();
    const handleResize = () => draw();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [draw]);

  const toggleSeat = useCallback(
    (seat: Seat) => {
      if (
        seat.status === "sold" ||
        seat.status === "held" ||
        seat.status === "reserved" ||
        seat.status === "blocked"
      ) {
        return;
      }
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(seat.id)) {
          next.delete(seat.id);
        } else if (next.size < maxSelectable) {
          next.add(seat.id);
        }
        return next;
      });
    },
    [maxSelectable],
  );

  // 클라이언트 좌표 → 좌석 좌표계 (transform 역변환)
  const findSeatAt = useCallback(
    (clientX: number, clientY: number): Seat | null => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const x = (clientX - rect.left - transform.x) / transform.scale;
      const y = (clientY - rect.top - transform.y) / transform.scale;
      for (const seat of seats) {
        const pos = gridMap.get(seat.id);
        if (!pos) continue;
        const sx = (pos.gx - minGx) * (SEAT_SIZE + SEAT_GAP);
        const sy = (pos.gy - minGy) * (SEAT_SIZE + SEAT_GAP);
        if (x >= sx && x <= sx + SEAT_SIZE && y >= sy && y <= sy + SEAT_SIZE) {
          return seat;
        }
      }
      return null;
    },
    [transform, seats, gridMap, minGx, minGy],
  );

  // 클릭 좌석 토글 (드래그 후 클릭은 무시)
  const dragMovedRef = useRef(false);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const handlePointerDownCanvas = (e: React.PointerEvent<HTMLCanvasElement>) => {
    dragMovedRef.current = false;
    dragStartRef.current = { x: e.clientX, y: e.clientY };
  };
  const handlePointerMoveCanvas = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragStartRef.current) return;
    const dx = e.clientX - dragStartRef.current.x;
    const dy = e.clientY - dragStartRef.current.y;
    if (dx * dx + dy * dy > 16) dragMovedRef.current = true;
  };
  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (dragMovedRef.current) return;
    const clicked = findSeatAt(e.clientX, e.clientY);
    if (!clicked) return;
    setFocusSeatId(clicked.id);
    toggleSeat(clicked);
  };

  // 길게 누름 → 시야 미리보기 (Phase 1.5)
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleLongPressStart = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!onSeatLongPress) return;
    const startX = e.clientX;
    const startY = e.clientY;
    longPressTimerRef.current = setTimeout(() => {
      const seat = findSeatAt(startX, startY);
      if (seat) onSeatLongPress(seat);
    }, 500);
  };
  const handleLongPressEnd = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  // 부모에게 선택 변경 통지 (onSelect는 ref로 저장하여 deps에서 제외 → 무한 루프 방지)
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);
  useEffect(() => {
    const picked = seats.filter((s) => selectedIds.has(s.id));
    onSelectRef.current?.(picked);
  }, [selectedIds, seats]);

  // 키보드 탐색
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (seats.length === 0) return;
    const currentSeat =
      seats.find((s) => s.id === focusSeatId) ?? seats[0] ?? null;
    if (!currentSeat) return;

    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleSeat(currentSeat);
      return;
    }

    const dirs: Record<string, { dx: number; dy: number }> = {
      ArrowRight: { dx: 1, dy: 0 },
      ArrowLeft: { dx: -1, dy: 0 },
      ArrowDown: { dx: 0, dy: 1 },
      ArrowUp: { dx: 0, dy: -1 },
    };
    const dir = dirs[e.key];
    if (!dir) return;
    e.preventDefault();

    const curPos = gridMap.get(currentSeat.id);
    if (!curPos) return;
    const targetGx = curPos.gx + dir.dx;
    const targetGy = curPos.gy + dir.dy;

    // 같은 행/열에서 가장 가까운 좌석으로 이동
    let best: { seat: Seat; dist: number } | null = null;
    for (const seat of seats) {
      const pos = gridMap.get(seat.id);
      if (!pos) continue;
      if (dir.dy === 0 && pos.gy !== curPos.gy) continue;
      if (dir.dx === 0 && pos.gx !== curPos.gx) continue;
      const dist =
        (pos.gx - targetGx) * (pos.gx - targetGx) +
        (pos.gy - targetGy) * (pos.gy - targetGy);
      if (!best || dist < best.dist) best = { seat, dist };
    }
    if (best) setFocusSeatId(best.seat.id);
  };

  // Phase 1.1 — 핀치 줌 + 팬 attach (Pointer Events)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const detach = attachTouchGestures(canvas, {
      getTransform: () => transformRef.current,
      onTransform: (next) => setTransform(next),
      minScale: 0.4,
      maxScale: 3,
    });
    return detach;
  }, []);

  // 섹션별 첫 좌석 (Phase 1.6 섹션 점프)
  const sectionAnchors = useMemo(() => {
    const map = new Map<string, Seat>();
    for (const s of seats) {
      if (!map.has(s.section)) map.set(s.section, s);
    }
    return Array.from(map.entries()).map(([section, seat]) => ({ section, seat }));
  }, [seats]);

  const jumpToSection = useCallback(
    (seat: Seat) => {
      const pos = gridMap.get(seat.id);
      if (!pos) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const targetScale = Math.max(transformRef.current.scale, 1.4);
      const cx = canvas.clientWidth / 2;
      const cy = canvas.clientHeight / 2;
      const seatX = (pos.gx - minGx) * (SEAT_SIZE + SEAT_GAP) * targetScale;
      const seatY = (pos.gy - minGy) * (SEAT_SIZE + SEAT_GAP) * targetScale;
      setTransform({ scale: targetScale, x: cx - seatX, y: cy - seatY });
    },
    [gridMap, minGx, minGy],
  );

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {
      available: 0,
      held: 0,
      sold: 0,
    };
    for (const seat of seats) {
      if (seat.status === "available") counts.available += 1;
      else if (seat.status === "held") counts.held += 1;
      else counts.sold += 1;
    }
    return counts;
  }, [seats]);

  const focusedSeat = focusSeatId
    ? seats.find((s) => s.id === focusSeatId) ?? null
    : null;

  return (
    <div
      ref={containerRef}
      role="application"
      aria-label={`좌석 배치도. 선택 가능 ${statusCounts.available}석, 선택 중 ${statusCounts.held}석, 판매 완료 ${statusCounts.sold}석.`}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className={`relative w-full overflow-hidden rounded-lg border bg-muted/30 focus:outline-none focus:ring-2 focus:ring-primary ${className ?? ""}`}
    >
      <div className="flex flex-wrap gap-4 p-3 text-xs">
        {(["available", "selected", "held", "sold"] as DisplayStatus[]).map(
          (status) => (
            <div key={status} className="flex items-center gap-1.5">
              <span
                aria-hidden
                className="inline-flex h-4 w-4 items-center justify-center rounded-sm text-[10px] font-bold text-white"
                style={{ backgroundColor: STATUS_COLORS[status] }}
              >
                {STATUS_SYMBOL[status]}
              </span>
              <span className="text-muted-foreground">
                {STATUS_LABEL[status]}
              </span>
            </div>
          ),
        )}
      </div>

      <div
        aria-hidden
        className="mx-auto mb-2 w-48 rounded-b-lg bg-foreground/10 py-1 text-center text-xs text-muted-foreground"
      >
        STAGE
      </div>

      {sectionAnchors.length > 1 ? (
        <div
          className="flex flex-wrap gap-1 px-3 pb-2"
          role="toolbar"
          aria-label="섹션 빠른 이동"
        >
          {sectionAnchors.map(({ section, seat }) => (
            <button
              key={section}
              type="button"
              onClick={() => jumpToSection(seat)}
              className="rounded-full border border-border bg-background px-3 py-1 text-xs font-medium text-foreground transition hover:border-primary hover:text-primary"
            >
              {section}
            </button>
          ))}
        </div>
      ) : null}

      <canvas
        ref={canvasRef}
        className="h-[500px] w-full cursor-pointer select-none"
        onClick={handleClick}
        onPointerDown={(e) => {
          handlePointerDownCanvas(e);
          handleLongPressStart(e);
        }}
        onPointerMove={handlePointerMoveCanvas}
        onPointerUp={handleLongPressEnd}
        onPointerCancel={handleLongPressEnd}
        onPointerLeave={handleLongPressEnd}
        aria-label={
          focusedSeat
            ? `포커스: ${focusedSeat.section} ${focusedSeat.row}열 ${focusedSeat.seatNumber}번, 상태: ${STATUS_LABEL[focusedSeat.status as DisplayStatus]}`
            : "좌석 캔버스"
        }
      />

      {/* aria-live: 좌석 선택 안내 (스크린 리더) */}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {focusedSeat
          ? `${focusedSeat.section}섹션 ${focusedSeat.row}열 ${focusedSeat.seatNumber}번 ${STATUS_LABEL[focusedSeat.status as DisplayStatus]}${
              focusedSeat.tierId && tierMap.get(focusedSeat.tierId)
                ? `, ${formatKRW(tierMap.get(focusedSeat.tierId)!.price)}`
                : ""
            }`
          : ""}
      </div>
    </div>
  );
}
