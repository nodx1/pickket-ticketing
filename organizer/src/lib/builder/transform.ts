/**
 * 트랙 2.7 — 선택 좌석 회전/대칭/정렬
 *
 * visual-builder 가 호출해 선택된 SeatNode 들의 좌표를 일괄 변환한다.
 */
export interface Point {
  x: number;
  y: number;
}

export interface HasPosition extends Point {
  id: string;
}

/** 중심점 기준 radian 회전 */
export function rotatePoints<T extends HasPosition>(
  items: T[],
  radians: number,
): T[] {
  if (items.length === 0) return items;
  const cx = items.reduce((s, p) => s + p.x, 0) / items.length;
  const cy = items.reduce((s, p) => s + p.y, 0) / items.length;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return items.map((p) => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    return {
      ...p,
      x: Math.round(cx + dx * cos - dy * sin),
      y: Math.round(cy + dx * sin + dy * cos),
    };
  });
}

/** 좌우 대칭 (선택 영역 중심 기준) */
export function flipHorizontal<T extends HasPosition>(items: T[]): T[] {
  if (items.length === 0) return items;
  const cx = items.reduce((s, p) => s + p.x, 0) / items.length;
  return items.map((p) => ({ ...p, x: Math.round(2 * cx - p.x) }));
}

/** 상하 대칭 */
export function flipVertical<T extends HasPosition>(items: T[]): T[] {
  if (items.length === 0) return items;
  const cy = items.reduce((s, p) => s + p.y, 0) / items.length;
  return items.map((p) => ({ ...p, y: Math.round(2 * cy - p.y) }));
}

/** 선택 항목 수평선 정렬 (평균 y 로) */
export function alignHorizontal<T extends HasPosition>(items: T[]): T[] {
  if (items.length === 0) return items;
  const avgY = Math.round(
    items.reduce((s, p) => s + p.y, 0) / items.length,
  );
  return items.map((p) => ({ ...p, y: avgY }));
}

/** 선택 항목 수직선 정렬 (평균 x 로) */
export function alignVertical<T extends HasPosition>(items: T[]): T[] {
  if (items.length === 0) return items;
  const avgX = Math.round(
    items.reduce((s, p) => s + p.x, 0) / items.length,
  );
  return items.map((p) => ({ ...p, x: avgX }));
}

/** X 축 균등 분배 (선택 항목이 3개 이상일 때) */
export function distributeX<T extends HasPosition>(items: T[]): T[] {
  if (items.length < 3) return items;
  const sorted = [...items].sort((a, b) => a.x - b.x);
  const minX = sorted[0].x;
  const maxX = sorted[sorted.length - 1].x;
  const step = (maxX - minX) / (sorted.length - 1);
  const mapById = new Map(
    sorted.map((p, idx) => [p.id, Math.round(minX + idx * step)]),
  );
  return items.map((p) => ({ ...p, x: mapById.get(p.id) ?? p.x }));
}

/** Y 축 균등 분배 */
export function distributeY<T extends HasPosition>(items: T[]): T[] {
  if (items.length < 3) return items;
  const sorted = [...items].sort((a, b) => a.y - b.y);
  const minY = sorted[0].y;
  const maxY = sorted[sorted.length - 1].y;
  const step = (maxY - minY) / (sorted.length - 1);
  const mapById = new Map(
    sorted.map((p, idx) => [p.id, Math.round(minY + idx * step)]),
  );
  return items.map((p) => ({ ...p, y: mapById.get(p.id) ?? p.y }));
}
