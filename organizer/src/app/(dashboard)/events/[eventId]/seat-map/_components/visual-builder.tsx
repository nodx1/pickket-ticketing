"use client";

/**
 * VisualBuilder — 트랙 2.1~2.5 + 2.17 통합 빌더
 *
 * 신규 기능:
 * - 2.1 도면 이미지 배경 (Konva.Image, opacity slider)
 * - 2.2 lasso/사각 다중 선택 (drag rectangle)
 * - 2.3 Undo/Redo (Cmd+Z / Cmd+Shift+Z, 50 history)
 * - 2.4 행/열 wizard 트리거 (외부 모달은 row-generator-wizard.tsx 에서)
 * - 2.5 복사/붙여넣기 (Cmd+C / Cmd+V) + 격자 스냅
 * - 2.17 모바일/태블릿 (Konva Stage touch 핸들러 — 핀치 줌 + 한 손가락 팬)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Circle,
  Group,
  Image as KonvaImage,
  Layer,
  Rect,
  Stage,
  Text,
} from "react-konva";
import type Konva from "konva";
import { History } from "@/lib/builder/history";
import { snapPoint } from "@/lib/builder/grid-snap";
import { pointInRect } from "@/lib/builder/selection";
import type { GeneratedSeat } from "@/lib/builder/row-wizard";

export interface SeatNode {
  id: string;
  x: number;
  y: number;
  label: string;
  tierId: string | null;
  isObstructed: boolean;
}

export interface TierLite {
  id: string;
  name: string;
  colorHex: string;
}

interface BackgroundProps {
  url: string | null;
  opacity: number;
}

interface VisualBuilderProps {
  initialSeats: SeatNode[];
  tiers: TierLite[];
  background?: BackgroundProps;
  /** 격자 스냅 px 단위 (0=꺼짐) */
  gridSize?: number;
  onChange: (seats: SeatNode[]) => void;
  /** 행/열 wizard 결과를 외부 모달이 주입할 때 사용 */
  onRequestWizard?: () => void;
}

const SEAT_RADIUS = 14;
const STAGE_W = 1000;
const STAGE_H = 700;

export function VisualBuilder({
  initialSeats,
  tiers,
  background,
  gridSize = 0,
  onChange,
  onRequestWizard,
}: VisualBuilderProps) {
  const [seats, setSeats] = useState<SeatNode[]>(initialSeats);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [zoom, setZoom] = useState(1);
  const [stagePan, setStagePan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [snap, setSnap] = useState(gridSize);
  const stageRef = useRef<Konva.Stage>(null);
  const clipboardRef = useRef<SeatNode[]>([]);
  const historyRef = useRef<History<SeatNode[]>>(new History<SeatNode[]>());

  // 2.17 — 핀치 거리 추적용
  const lastPinchDistRef = useRef<number | null>(null);
  const pinchStartZoomRef = useRef<number>(1);
  const isTouchPanningRef = useRef(false);
  const touchPanLastRef = useRef<{ x: number; y: number } | null>(null);

  // 사각 선택 드래그 (lasso 1차 — 사각형)
  const [marquee, setMarquee] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const marqueeStartRef = useRef<{ x: number; y: number } | null>(null);

  // 배경 이미지 (Konva.Image)
  const [bgImage, setBgImage] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!background?.url) {
      setBgImage(null);
      return;
    }
    const img = new window.Image();
    img.crossOrigin = "anonymous";
    img.onload = () => setBgImage(img);
    img.onerror = () => setBgImage(null);
    img.src = background.url;
  }, [background?.url]);

  // history 초기화 (한 번만)
  useEffect(() => {
    historyRef.current.reset(initialSeats);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const commit = useCallback(
    (next: SeatNode[]) => {
      setSeats(next);
      historyRef.current.push(next);
      onChange(next);
    },
    [onChange],
  );

  // ─── 좌석 추가 / 사각 선택 ───
  const handleStageMouseDown = useCallback(
    (e: Konva.KonvaEventObject<MouseEvent>) => {
      if (e.target !== e.target.getStage()) return;
      const stage = e.target.getStage();
      if (!stage) return;
      const pointer = stage.getPointerPosition();
      if (!pointer) return;
      // Shift 누른 채 드래그 → 사각 선택
      if (e.evt.shiftKey) {
        marqueeStartRef.current = {
          x: pointer.x / zoom,
          y: pointer.y / zoom,
        };
        setMarquee({
          x: pointer.x / zoom,
          y: pointer.y / zoom,
          width: 0,
          height: 0,
        });
        return;
      }
    },
    [zoom],
  );

  const handleStageMouseMove = useCallback(() => {
    if (!marqueeStartRef.current) return;
    const stage = stageRef.current;
    if (!stage) return;
    const pointer = stage.getPointerPosition();
    if (!pointer) return;
    setMarquee({
      x: marqueeStartRef.current.x,
      y: marqueeStartRef.current.y,
      width: pointer.x / zoom - marqueeStartRef.current.x,
      height: pointer.y / zoom - marqueeStartRef.current.y,
    });
  }, [zoom]);

  const handleStageMouseUp = useCallback(
    (e: Konva.KonvaEventObject<MouseEvent>) => {
      if (marqueeStartRef.current && marquee) {
        // 사각 안에 들어온 좌석 모두 선택
        const insideIds = new Set<string>();
        for (const s of seats) {
          if (pointInRect({ x: s.x, y: s.y }, marquee)) {
            insideIds.add(s.id);
          }
        }
        setSelectedIds(insideIds);
        marqueeStartRef.current = null;
        setMarquee(null);
        return;
      }
      // 빈 공간 단순 클릭 → 좌석 추가
      if (e.target === e.target.getStage()) {
        const stage = e.target.getStage();
        if (!stage) return;
        const pointer = stage.getPointerPosition();
        if (!pointer) return;
        const point = snapPoint(
          { x: pointer.x / zoom, y: pointer.y / zoom },
          snap,
        );
        const newSeat: SeatNode = {
          id: crypto.randomUUID(),
          x: point.x,
          y: point.y,
          label: `${seats.length + 1}`,
          tierId: tiers[0]?.id ?? null,
          isObstructed: false,
        };
        commit([...seats, newSeat]);
      }
    },
    [seats, tiers, zoom, marquee, snap, commit],
  );

  const handleSeatClick = useCallback(
    (id: string, e: Konva.KonvaEventObject<MouseEvent>) => {
      e.cancelBubble = true;
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (e.evt.shiftKey || e.evt.metaKey || e.evt.ctrlKey) {
          if (next.has(id)) next.delete(id);
          else next.add(id);
        } else {
          next.clear();
          next.add(id);
        }
        return next;
      });
    },
    [],
  );

  const deleteSelected = useCallback(() => {
    if (selectedIds.size === 0) return;
    commit(seats.filter((s) => !selectedIds.has(s.id)));
    setSelectedIds(new Set());
  }, [seats, selectedIds, commit]);

  const assignTierToSelected = useCallback(
    (tierId: string) => {
      if (selectedIds.size === 0) return;
      commit(seats.map((s) => (selectedIds.has(s.id) ? { ...s, tierId } : s)));
    },
    [seats, selectedIds, commit],
  );

  // ─── Undo / Redo ───
  const undo = useCallback(() => {
    const prev = historyRef.current.undo();
    if (prev) {
      setSeats(prev);
      onChange(prev);
    }
  }, [onChange]);

  const redo = useCallback(() => {
    const next = historyRef.current.redo();
    if (next) {
      setSeats(next);
      onChange(next);
    }
  }, [onChange]);

  // ─── 복사/붙여넣기 ───
  const copySelected = useCallback(() => {
    const picked = seats.filter((s) => selectedIds.has(s.id));
    clipboardRef.current = picked.map((s) => ({ ...s }));
  }, [seats, selectedIds]);

  const pasteFromClipboard = useCallback(() => {
    if (clipboardRef.current.length === 0) return;
    const offset = 24; // 약간 옆으로
    const cloned = clipboardRef.current.map((s) => ({
      ...s,
      id: crypto.randomUUID(),
      x: s.x + offset,
      y: s.y + offset,
    }));
    const next = [...seats, ...cloned];
    commit(next);
    setSelectedIds(new Set(cloned.map((s) => s.id)));
  }, [seats, commit]);

  // 2.17 — 모바일 터치 핸들러 (Konva Stage 기본 touch 이벤트)
  // 두 손가락이면 핀치 줌, 한 손가락이면 팬
  const handleTouchMove = useCallback(
    (e: Konva.KonvaEventObject<TouchEvent>) => {
      e.evt.preventDefault();
      const touches = e.evt.touches;
      if (touches.length === 2) {
        const t1 = touches[0];
        const t2 = touches[1];
        const dx = t2.clientX - t1.clientX;
        const dy = t2.clientY - t1.clientY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (lastPinchDistRef.current === null) {
          lastPinchDistRef.current = dist;
          pinchStartZoomRef.current = zoom;
          isTouchPanningRef.current = false;
          return;
        }
        const ratio = dist / lastPinchDistRef.current;
        const nextZoom = Math.max(
          0.3,
          Math.min(3, pinchStartZoomRef.current * ratio),
        );
        setZoom(nextZoom);
      } else if (touches.length === 1) {
        // 단일 터치 = 팬 (마우스 드래그와 별도)
        const t = touches[0];
        if (!isTouchPanningRef.current) {
          touchPanLastRef.current = { x: t.clientX, y: t.clientY };
          isTouchPanningRef.current = true;
          return;
        }
        if (touchPanLastRef.current) {
          const ddx = t.clientX - touchPanLastRef.current.x;
          const ddy = t.clientY - touchPanLastRef.current.y;
          touchPanLastRef.current = { x: t.clientX, y: t.clientY };
          setStagePan((prev) => ({ x: prev.x + ddx, y: prev.y + ddy }));
        }
      }
    },
    [zoom],
  );

  const handleTouchEnd = useCallback(
    (e: Konva.KonvaEventObject<TouchEvent>) => {
      // 손가락 모두 떼면 상태 초기화
      if (e.evt.touches.length === 0) {
        lastPinchDistRef.current = null;
        isTouchPanningRef.current = false;
        touchPanLastRef.current = null;
      }
    },
    [],
  );

  // 키보드 단축키
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA"].includes(target.tagName)) return;
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
      }
      if (meta && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) {
        e.preventDefault();
        redo();
        return;
      }
      if (meta && e.key.toLowerCase() === "c") {
        e.preventDefault();
        copySelected();
        return;
      }
      if (meta && e.key.toLowerCase() === "v") {
        e.preventDefault();
        pasteFromClipboard();
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        deleteSelected();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [undo, redo, copySelected, pasteFromClipboard, deleteSelected]);

  /**
   * 외부에서 wizard 결과를 주입하기 위한 imperative 핸들
   * (생성된 좌석을 history 에 commit)
   */
  const insertGeneratedSeats = useCallback(
    (generated: GeneratedSeat[]) => {
      commit([...seats, ...generated]);
    },
    [seats, commit],
  );

  // 외부에서 접근 가능하도록 window 등록 (단순/임시 — 본 세션 wizard 모달 미구현)
  useEffect(() => {
    (window as unknown as { __seatBuilderInsert?: typeof insertGeneratedSeats }).__seatBuilderInsert =
      insertGeneratedSeats;
    return () => {
      (window as unknown as { __seatBuilderInsert?: typeof insertGeneratedSeats }).__seatBuilderInsert =
        undefined;
    };
  }, [insertGeneratedSeats]);

  const tierColor = useCallback(
    (tierId: string | null) => {
      const tier = tiers.find((t) => t.id === tierId);
      return tier?.colorHex ?? "#9ca3af";
    },
    [tiers],
  );

  const bgOpacity = useMemo(
    () => (background?.opacity ?? 0.5),
    [background?.opacity],
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">
          {seats.length}석 · 선택 {selectedIds.size}석
        </span>
        <button
          type="button"
          className="rounded border border-border px-2 py-1 hover:bg-muted disabled:opacity-50"
          onClick={undo}
          disabled={!historyRef.current.canUndo()}
          aria-label="실행 취소 (Cmd+Z)"
          title="실행 취소 (Cmd+Z)"
        >
          ↶ Undo
        </button>
        <button
          type="button"
          className="rounded border border-border px-2 py-1 hover:bg-muted disabled:opacity-50"
          onClick={redo}
          disabled={!historyRef.current.canRedo()}
          aria-label="다시 실행 (Cmd+Shift+Z)"
          title="다시 실행 (Cmd+Shift+Z)"
        >
          ↷ Redo
        </button>
        <button
          type="button"
          className="rounded border border-border px-2 py-1 hover:bg-muted disabled:opacity-50"
          onClick={copySelected}
          disabled={selectedIds.size === 0}
          title="복사 (Cmd+C)"
        >
          복사
        </button>
        <button
          type="button"
          className="rounded border border-border px-2 py-1 hover:bg-muted disabled:opacity-50"
          onClick={pasteFromClipboard}
          title="붙여넣기 (Cmd+V)"
        >
          붙여넣기
        </button>
        {onRequestWizard ? (
          <button
            type="button"
            className="rounded border border-border px-2 py-1 hover:bg-muted"
            onClick={onRequestWizard}
            title="행/열 wizard"
          >
            행/열 생성
          </button>
        ) : null}
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={snap > 0}
            onChange={(e) => setSnap(e.target.checked ? 20 : 0)}
            aria-label="격자 스냅"
          />
          격자 스냅
        </label>
        <button
          type="button"
          className="ml-auto rounded border border-border px-3 py-1 hover:bg-muted disabled:opacity-50"
          onClick={deleteSelected}
          disabled={selectedIds.size === 0}
        >
          삭제
        </button>
        {tiers.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => assignTierToSelected(t.id)}
            disabled={selectedIds.size === 0}
            className="rounded border border-border px-3 py-1 hover:bg-muted disabled:opacity-50"
            style={{ borderLeftColor: t.colorHex, borderLeftWidth: 4 }}
          >
            {t.name}
          </button>
        ))}
      </div>
      <div
        className="rounded-lg border border-border bg-muted/20"
        style={{ width: STAGE_W, maxWidth: "100%" }}
      >
        <Stage
          ref={stageRef}
          width={STAGE_W}
          height={STAGE_H}
          onMouseDown={handleStageMouseDown}
          onMouseMove={handleStageMouseMove}
          onMouseUp={handleStageMouseUp}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onWheel={(e) => {
            e.evt.preventDefault();
            const scaleBy = 1.05;
            const newZoom = e.evt.deltaY > 0 ? zoom / scaleBy : zoom * scaleBy;
            setZoom(Math.max(0.3, Math.min(3, newZoom)));
          }}
          x={stagePan.x}
          y={stagePan.y}
          scaleX={zoom}
          scaleY={zoom}
        >
          {/* 배경 도면 레이어 */}
          {bgImage ? (
            <Layer listening={false}>
              <KonvaImage image={bgImage} opacity={bgOpacity} />
            </Layer>
          ) : null}

          <Layer>
            {/* 무대 */}
            <Rect
              x={STAGE_W / 2 - 100}
              y={20}
              width={200}
              height={40}
              fill="#1f2937"
              cornerRadius={4}
            />
            <Text
              x={STAGE_W / 2 - 100}
              y={32}
              width={200}
              text="STAGE"
              fontSize={16}
              fill="#fff"
              align="center"
            />

            {/* 좌석 */}
            {seats.map((seat) => {
              const isSelected = selectedIds.has(seat.id);
              return (
                <Group
                  key={seat.id}
                  x={seat.x}
                  y={seat.y}
                  onClick={(e) => handleSeatClick(seat.id, e)}
                >
                  <Circle
                    radius={SEAT_RADIUS}
                    fill={tierColor(seat.tierId)}
                    stroke={isSelected ? "#6c5ce7" : "#000"}
                    strokeWidth={isSelected ? 3 : 1}
                    opacity={seat.isObstructed ? 0.5 : 1}
                  />
                  <Text
                    x={-SEAT_RADIUS}
                    y={-5}
                    width={SEAT_RADIUS * 2}
                    text={seat.label}
                    fontSize={10}
                    fill="#fff"
                    align="center"
                  />
                </Group>
              );
            })}

            {/* 사각 선택 박스 */}
            {marquee ? (
              <Rect
                x={marquee.x}
                y={marquee.y}
                width={marquee.width}
                height={marquee.height}
                fill="rgba(108, 92, 231, 0.1)"
                stroke="#6c5ce7"
                strokeWidth={1}
                dash={[4, 4]}
              />
            ) : null}
          </Layer>
        </Stage>
      </div>
      <p className="text-xs text-muted-foreground">
        빈 공간 클릭 → 좌석 추가. Shift+드래그 → 사각 다중 선택. Cmd+Z/Y → Undo/Redo.
        Cmd+C/V → 복사/붙여넣기. Delete → 삭제.
      </p>
    </div>
  );
}
