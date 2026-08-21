/**
 * 레벨2 2차 A2 — 좌석 커머스 좌표 정규화 (go ↔ v2).
 *
 * go seats.x/y = NUMERIC(8,3), quality_score = NUMERIC(4,3) → pg 가 문자열로 반환할 수 있다.
 * v2 seats.x/y/quality_score = Float(double precision). NUMERIC(8,3)/NUMERIC(4,3) 은 double 의
 * 유효자릿수(≈15) 안에 완전히 들어가므로 문자열→number 변환은 무손실이다.
 *
 * write-through(go→v2): NULL 좌표는 payload 에서 생략 → v2 SeatUpsert 기본값(x=0.0/y=0.0/quality_score=0.5)
 * 유지(빈 좌표를 0 으로 덮어써 기존 v2 좌표를 파괴하지 않도록 undefined 로 omit).
 */

/** pg NUMERIC(문자열|숫자|NULL) → number|undefined. NULL/비유한값은 undefined(payload 생략). */
export function numCoord(value: string | number | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** go seat row 의 좌표 필드 → SeatUpsertInput 좌표 부분(undefined 필드는 생략됨). */
export function seatCoordFields(row: {
  x: string | number | null;
  y: string | number | null;
  label: string | null;
  qualityScore: string | number | null;
  isObstructed: boolean | null;
}): {
  x?: number;
  y?: number;
  label?: string | null;
  quality_score?: number;
  is_obstructed?: boolean;
} {
  return {
    x: numCoord(row.x),
    y: numCoord(row.y),
    label: row.label ?? null,
    quality_score: numCoord(row.qualityScore),
    is_obstructed: row.isObstructed ?? false,
  };
}
