"use client";

/**
 * SeatMapWebGL — PixiJS WebGL 기반 좌석맵 (트랙 3, 80,000석 60fps 목표)
 *
 * 동일 props 인터페이스로 SeatMap 을 대체 가능. 5,000석 이상 또는 사용자가 명시
 * "webgl" 옵션 지정 시 SeatMap 에서 동적 import 로 로드된다.
 *
 * 의존성: pixi.js@^8 (~400KB gzip, 동적 import)
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Seat } from "@/lib/seats/types";
import { useSeatStream } from "@/lib/hooks/useSeatStream";
import { attachTouchGestures, type Transform } from "@/lib/seats/touch-gestures";
import type { SeatTierInfo } from "./SeatMap";
import type { SeatRenderer } from "./renderers/types";

interface Props {
  eventId: string;
  seats: Seat[];
  maxSelectable?: number;
  onSelect?: (selected: Seat[]) => void;
  tiers?: SeatTierInfo[];
  onSeatLongPress?: (seat: Seat) => void;
  className?: string;
}

export function SeatMapWebGL({
  eventId,
  seats: initialSeats,
  maxSelectable = 4,
  onSelect,
  tiers,
  onSeatLongPress,
  className,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<SeatRenderer | null>(null);
  const [seats, setSeats] = useState<Seat[]>(initialSeats);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [focusSeatId, setFocusSeatId] = useState<string | null>(null);
  const [transform, setTransform] = useState<Transform>({ scale: 1, x: 0, y: 0 });
  const transformRef = useRef(transform);
  useEffect(() => {
    transformRef.current = transform;
  }, [transform]);
  // maxSelectable ref — 클릭 핸들러가 마운트 시 캡처된 초기값이 아닌 최신값을 읽도록 (#13 수정).
  const maxSelectableRef = useRef(maxSelectable);
  useEffect(() => {
    maxSelectableRef.current = maxSelectable;
  }, [maxSelectable]);
  // seats ref — long-press 핸들러가 최신 seats 배열을 읽도록 (#14 수정).
  const seatsRef = useRef(seats);
  useEffect(() => {
    seatsRef.current = seats;
  }, [seats]);

  const tierMap = useMemo(() => {
    const m = new Map<string, SeatTierInfo>();
    tiers?.forEach((t) => m.set(t.id, t));
    return m;
  }, [tiers]);

  const seatIdsKey = useMemo(
    () => initialSeats.map((s) => `${s.id}:${s.status}`).join("|"),
    [initialSeats],
  );
  useEffect(() => {
    setSeats(initialSeats);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seatIdsKey]);

  // 실시간 SSE
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

  // PixiJS 렌더러 마운트 (동적 import)
  useEffect(() => {
    let cancelled = false;
    let detachGestures: (() => void) | null = null;
    let cleanedUp = false;

    (async () => {
      const host = hostRef.current;
      if (!host) return;
      const { PixiSeatRenderer } = await import("./renderers/pixi");
      if (cancelled) return;
      const renderer = new PixiSeatRenderer();
      await renderer.mount(host);
      if (cancelled) {
        renderer.destroy();
        return;
      }
      rendererRef.current = renderer;
      renderer.setSeats(seats, tierMap);
      renderer.setTransform(transformRef.current);
      renderer.setSelection(selectedIds, focusSeatId);

      // 핀치 줌 + 팬
      const canvas = host.querySelector("canvas");
      if (canvas) {
        detachGestures = attachTouchGestures(canvas as HTMLElement, {
          getTransform: () => transformRef.current,
          onTransform: (next) => {
            transformRef.current = next;
            setTransform(next);
            renderer.setTransform(next);
          },
          minScale: 0.2,
          maxScale: 4,
        });

        // 클릭 hit test — maxSelectableRef 로 최신값 참조 (#13 수정).
        canvas.addEventListener("click", (e: Event) => {
          if (cleanedUp) return;
          const me = e as MouseEvent;
          const id = renderer.hitTest(me.clientX, me.clientY);
          if (!id) return;
          setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) {
              next.delete(id);
            } else if (next.size < maxSelectableRef.current) {
              next.add(id);
            }
            return next;
          });
          setFocusSeatId(id);
        });

        // 길게 누름 → 시야 미리보기
        let longPressTimer: ReturnType<typeof setTimeout> | null = null;
        canvas.addEventListener("pointerdown", (e: Event) => {
          if (!onSeatLongPress) return;
          const pe = e as PointerEvent;
          const sx = pe.clientX;
          const sy = pe.clientY;
          longPressTimer = setTimeout(() => {
            const id = renderer.hitTest(sx, sy);
            if (!id) return;
            // seatsRef.current 로 최신 좌석 상태 참조 (#14 수정).
            const seat = seatsRef.current.find((s) => s.id === id);
            if (seat) onSeatLongPress(seat);
          }, 500);
        });
        const cancelLongPress = () => {
          if (longPressTimer) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
          }
        };
        canvas.addEventListener("pointerup", cancelLongPress);
        canvas.addEventListener("pointercancel", cancelLongPress);
        canvas.addEventListener("pointerleave", cancelLongPress);
      }
    })();

    return () => {
      cancelled = true;
      cleanedUp = true;
      if (detachGestures) detachGestures();
      const r = rendererRef.current;
      if (r) {
        r.destroy();
        rendererRef.current = null;
      }
    };
    // mount 한 번만
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // seats / tiers 변경 시 렌더러에 반영
  useEffect(() => {
    rendererRef.current?.setSeats(seats, tierMap);
  }, [seats, tierMap]);

  // 선택 변경 시 렌더러에 반영
  useEffect(() => {
    rendererRef.current?.setSelection(selectedIds, focusSeatId);
  }, [selectedIds, focusSeatId]);

  // 부모에게 선택 통지
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);
  useEffect(() => {
    const picked = seats.filter((s) => selectedIds.has(s.id));
    onSelectRef.current?.(picked);
  }, [selectedIds, seats]);

  return (
    <div
      role="application"
      aria-label="좌석 배치도 (WebGL)"
      className={`relative w-full overflow-hidden rounded-lg border bg-muted/30 ${className ?? ""}`}
    >
      <div
        aria-hidden
        className="mx-auto mb-2 w-48 rounded-b-lg bg-foreground/10 py-1 text-center text-xs text-muted-foreground"
      >
        STAGE
      </div>
      <div ref={hostRef} className="h-[500px] w-full" />
    </div>
  );
}
