/**
 * 트랙 2.14 — 좌석 번호 자동 생성 패턴
 *
 * 선택된 좌석들에 대해 패턴(A1, A2... / 1, 2... / 가, 나...) 에 따라
 * 라벨을 일괄 재부여한다.
 */

export type NumberingPattern = "alpha-num" | "number-only" | "hangul-num";
export type NumberingOrder = "left-right" | "right-left";
export type NumberingParity = "sequential" | "odd-even-split";

export interface SeatForNumbering {
  id: string;
  x: number;
  y: number;
  label?: string;
}

export interface NumberingConfig {
  pattern: NumberingPattern;
  order?: NumberingOrder;
  parity?: NumberingParity;
  /** 행 간 y 거리 임계값 — 이 이하면 같은 행으로 간주 */
  rowThreshold?: number;
  /** 첫 행 라벨 (A 또는 1 또는 '가') */
  firstRowIndex?: number;
  /** 첫 좌석 번호 */
  firstSeatNumber?: number;
}

const HANGUL = ["가", "나", "다", "라", "마", "바", "사", "아", "자", "차", "카", "타", "파", "하"];

function rowLabel(idx: number, pattern: NumberingPattern): string {
  if (pattern === "number-only") return String(idx + 1);
  if (pattern === "hangul-num") {
    if (idx < HANGUL.length) return HANGUL[idx];
    return `${HANGUL[Math.floor(idx / HANGUL.length) - 1] ?? "하"}${HANGUL[idx % HANGUL.length]}`;
  }
  // alpha-num: A, B, ..., Z, AA, AB
  const result: string[] = [];
  let n = idx;
  do {
    result.unshift(String.fromCharCode(65 + (n % 26)));
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return result.join("");
}

export function applyAutoNumbering(
  seats: SeatForNumbering[],
  cfg: NumberingConfig,
): SeatForNumbering[] {
  if (seats.length === 0) return seats;
  const threshold = cfg.rowThreshold ?? 20;
  const firstRow = cfg.firstRowIndex ?? 0;
  const firstSeat = cfg.firstSeatNumber ?? 1;

  // y 값으로 행 그룹화
  const sortedByY = [...seats].sort((a, b) => a.y - b.y);
  const rowGroups: SeatForNumbering[][] = [];
  let currentRow: SeatForNumbering[] = [];
  let currentY = sortedByY[0].y;
  for (const s of sortedByY) {
    if (Math.abs(s.y - currentY) > threshold && currentRow.length > 0) {
      rowGroups.push(currentRow);
      currentRow = [];
      currentY = s.y;
    }
    currentRow.push(s);
  }
  if (currentRow.length > 0) rowGroups.push(currentRow);

  const result: Record<string, string> = {};
  rowGroups.forEach((rowSeats, rowIdx) => {
    const ordered = [...rowSeats].sort((a, b) =>
      cfg.order === "right-left" ? b.x - a.x : a.x - b.x,
    );

    if (cfg.parity === "odd-even-split") {
      // 왼쪽부터 홀수, 오른쪽부터 짝수 — 간단 구현: 중앙 기준 분리
      const mid = Math.floor(ordered.length / 2);
      const leftHalf = ordered.slice(0, mid);
      const rightHalf = ordered.slice(mid);
      const rowText = rowLabel(firstRow + rowIdx, cfg.pattern);
      leftHalf.forEach((s, i) => {
        const num = firstSeat + i * 2 + 1; // 홀수
        result[s.id] = `${rowText}${num}`;
      });
      rightHalf.forEach((s, i) => {
        const num = firstSeat + i * 2; // 짝수
        result[s.id] = `${rowText}${num}`;
      });
    } else {
      const rowText = rowLabel(firstRow + rowIdx, cfg.pattern);
      ordered.forEach((s, i) => {
        result[s.id] = `${rowText}${firstSeat + i}`;
      });
    }
  });

  return seats.map((s) => ({ ...s, label: result[s.id] ?? s.label }));
}
