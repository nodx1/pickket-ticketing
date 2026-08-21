/**
 * Touch gestures — Pointer Events 기반 핀치 줌 + 팬 + 더블탭
 *
 * SeatMap Canvas에 마운트하여 모바일/태블릿/트랙패드 제스처를 처리한다.
 * - 두 손가락 거리 변화 → scale 조정
 * - 한 손가락 드래그 → translate (x, y)
 * - 더블탭 → 1.5배 줌 토글
 *
 * 사용:
 *   const detach = attachTouchGestures(canvasEl, {
 *     onTransform: ({ scale, x, y }) => { ... },
 *     minScale: 0.4,
 *     maxScale: 3,
 *   });
 */

export interface Transform {
  scale: number;
  x: number;
  y: number;
}

export interface TouchGestureOptions {
  onTransform: (next: Transform) => void;
  getTransform: () => Transform;
  minScale?: number;
  maxScale?: number;
  doubleTapScale?: number;
}

interface PointerState {
  id: number;
  x: number;
  y: number;
}

const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_DIST = 32;

export function attachTouchGestures(
  el: HTMLElement,
  opts: TouchGestureOptions,
): () => void {
  const minScale = opts.minScale ?? 0.4;
  const maxScale = opts.maxScale ?? 3;
  const doubleTapScale = opts.doubleTapScale ?? 1.5;

  const pointers = new Map<number, PointerState>();
  let pinchStartDist = 0;
  let pinchStartScale = 1;
  let panLast: { x: number; y: number } | null = null;
  let lastTapAt = 0;
  let lastTapX = 0;
  let lastTapY = 0;

  function distance(a: PointerState, b: PointerState): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function midpoint(a: PointerState, b: PointerState): { x: number; y: number } {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  function onPointerDown(e: PointerEvent) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    el.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { id: e.pointerId, x: e.clientX, y: e.clientY });

    if (pointers.size === 2) {
      const [p1, p2] = Array.from(pointers.values());
      pinchStartDist = distance(p1, p2);
      pinchStartScale = opts.getTransform().scale;
      panLast = null;
    } else if (pointers.size === 1) {
      panLast = { x: e.clientX, y: e.clientY };

      // 더블탭 감지
      const now = Date.now();
      const dx = e.clientX - lastTapX;
      const dy = e.clientY - lastTapY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (now - lastTapAt < DOUBLE_TAP_MS && dist < DOUBLE_TAP_DIST) {
        // 더블탭 → 줌 토글
        const cur = opts.getTransform();
        const targetScale = cur.scale > 1.2 ? 1 : doubleTapScale;
        opts.onTransform({ scale: targetScale, x: cur.x, y: cur.y });
        lastTapAt = 0;
      } else {
        lastTapAt = now;
        lastTapX = e.clientX;
        lastTapY = e.clientY;
      }
    }
  }

  function onPointerMove(e: PointerEvent) {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { id: e.pointerId, x: e.clientX, y: e.clientY });

    if (pointers.size === 2) {
      const [p1, p2] = Array.from(pointers.values());
      const dist = distance(p1, p2);
      if (pinchStartDist === 0) {
        pinchStartDist = dist;
        return;
      }
      const ratio = dist / pinchStartDist;
      const nextScale = Math.max(
        minScale,
        Math.min(maxScale, pinchStartScale * ratio),
      );
      const mid = midpoint(p1, p2);
      const rect = el.getBoundingClientRect();
      const cur = opts.getTransform();
      // 핀치 중심 좌표 기준으로 줌 (확대/축소 시 손가락 위치 유지)
      const cx = mid.x - rect.left;
      const cy = mid.y - rect.top;
      const scaleRatio = nextScale / cur.scale;
      const nextX = cx - (cx - cur.x) * scaleRatio;
      const nextY = cy - (cy - cur.y) * scaleRatio;
      opts.onTransform({ scale: nextScale, x: nextX, y: nextY });
    } else if (pointers.size === 1 && panLast) {
      const dx = e.clientX - panLast.x;
      const dy = e.clientY - panLast.y;
      panLast = { x: e.clientX, y: e.clientY };
      const cur = opts.getTransform();
      opts.onTransform({ scale: cur.scale, x: cur.x + dx, y: cur.y + dy });
    }
  }

  function onPointerUp(e: PointerEvent) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) {
      pinchStartDist = 0;
    }
    if (pointers.size === 0) {
      panLast = null;
    } else if (pointers.size === 1) {
      // 핀치에서 한 손가락 떼면 팬으로 전환
      const remaining = Array.from(pointers.values())[0];
      panLast = { x: remaining.x, y: remaining.y };
    }
  }

  function onWheel(e: WheelEvent) {
    // 데스크탑 휠 줌 (마우스 위치 중심)
    e.preventDefault();
    const cur = opts.getTransform();
    const delta = -e.deltaY * 0.001;
    const nextScale = Math.max(
      minScale,
      Math.min(maxScale, cur.scale + delta),
    );
    const rect = el.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const scaleRatio = nextScale / cur.scale;
    const nextX = cx - (cx - cur.x) * scaleRatio;
    const nextY = cy - (cy - cur.y) * scaleRatio;
    opts.onTransform({ scale: nextScale, x: nextX, y: nextY });
  }

  el.addEventListener("pointerdown", onPointerDown);
  el.addEventListener("pointermove", onPointerMove);
  el.addEventListener("pointerup", onPointerUp);
  el.addEventListener("pointercancel", onPointerUp);
  el.addEventListener("pointerleave", onPointerUp);
  el.addEventListener("wheel", onWheel, { passive: false });

  // 모바일 기본 제스처 차단 (브라우저 핀치 줌)
  el.style.touchAction = "none";

  return () => {
    el.removeEventListener("pointerdown", onPointerDown);
    el.removeEventListener("pointermove", onPointerMove);
    el.removeEventListener("pointerup", onPointerUp);
    el.removeEventListener("pointercancel", onPointerUp);
    el.removeEventListener("pointerleave", onPointerUp);
    el.removeEventListener("wheel", onWheel);
    el.style.touchAction = "";
  };
}
