/**
 * SeatRenderer — Canvas2D / WebGL(PixiJS) 공통 인터페이스 (트랙 3.1)
 *
 * SeatMap 컴포넌트는 이 인터페이스만 알면 되고, 백엔드는 좌석 수 / 디바이스 / prop 에
 * 따라 자동 분기한다.
 */

import type { Seat } from "@/lib/seats/types";
import type { SeatTierInfo } from "../SeatMap";

export interface RenderTransform {
  scale: number;
  x: number;
  y: number;
}

export interface RenderState {
  seats: Seat[];
  selectedIds: Set<string>;
  focusSeatId: string | null;
  transform: RenderTransform;
  tiers?: Map<string, SeatTierInfo>;
}

export interface SeatRenderer {
  /** 캔버스 또는 컨테이너에 마운트 */
  mount(host: HTMLElement): Promise<void> | void;
  /** 좌석 데이터 교체 */
  setSeats(seats: Seat[], tiers?: Map<string, SeatTierInfo>): void;
  /** 카메라 transform 갱신 */
  setTransform(transform: RenderTransform): void;
  /** 선택/포커스 상태 갱신 */
  setSelection(selectedIds: Set<string>, focusSeatId: string | null): void;
  /** 클릭 좌표 → 좌석 ID (히트 테스트) */
  hitTest(clientX: number, clientY: number): string | null;
  /** 화면 갱신 */
  draw(): void;
  /** 리사이즈 대응 */
  resize(width: number, height: number): void;
  /** 정리 */
  destroy(): void;
}

export type RendererKind = "canvas2d" | "webgl";

/**
 * 좌석 수 / 디바이스 / WebGL 지원에 따라 자동 선택.
 * - 5,000석 미만 → canvas2d (호환성 우선)
 * - 5,000석 이상 → webgl (성능 우선)
 * - WebGL 미지원 환경 → canvas2d 강제
 */
export function pickRenderer(seatCount: number): RendererKind {
  if (typeof window === "undefined") return "canvas2d";
  if (seatCount < 5000) return "canvas2d";

  // WebGL2 지원 검사
  try {
    const test = document.createElement("canvas");
    const ctx =
      test.getContext("webgl2") ?? test.getContext("webgl");
    return ctx ? "webgl" : "canvas2d";
  } catch {
    return "canvas2d";
  }
}
