/**
 * 트랙 2.2 — Lasso(올가미) + 사각 다중 선택
 *
 * point-in-polygon (ray casting) + point-in-rect 알고리즘.
 */
export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 점이 사각형 안에 있는지 (좌석 중심 좌표 기준) */
export function pointInRect(p: Point, r: Rect): boolean {
  const x1 = Math.min(r.x, r.x + r.width);
  const x2 = Math.max(r.x, r.x + r.width);
  const y1 = Math.min(r.y, r.y + r.height);
  const y2 = Math.max(r.y, r.y + r.height);
  return p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2;
}

/**
 * 점이 다각형 안에 있는지 (ray casting algorithm).
 * Lasso 자유 곡선의 vertices 를 polygon 으로 받음.
 */
export function pointInPolygon(p: Point, polygon: Point[]): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersect =
      yi > p.y !== yj > p.y &&
      p.x < ((xj - xi) * (p.y - yi)) / (yj - yi + 1e-9) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
