/**
 * 트랙 2.4 — 행/열 자동 생성 wizard 알고리즘
 *
 * 직선/곡선(arc) 패턴으로 좌석 일괄 생성.
 */
export interface RowWizardConfig {
  rows: number;
  cols: number;
  startX: number;
  startY: number;
  spacingX: number;
  spacingY: number;
  /** 0=직선, >0=부채꼴 곡률 (라디안) */
  arcRadians?: number;
  rowLabel?: "letter" | "number"; // A,B,C... or 1,2,3...
  startSeatNumber?: number;
  defaultTierId?: string | null;
}

export interface GeneratedSeat {
  id: string;
  x: number;
  y: number;
  label: string;
  tierId: string | null;
  isObstructed: boolean;
}

function rowLabelOf(idx: number, mode: "letter" | "number" = "letter"): string {
  if (mode === "number") return String(idx + 1);
  // 26 이상은 AA, AB...
  const result: string[] = [];
  let n = idx;
  do {
    result.unshift(String.fromCharCode(65 + (n % 26)));
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return result.join("");
}

export function generateRows(cfg: RowWizardConfig): GeneratedSeat[] {
  const seats: GeneratedSeat[] = [];
  const startNum = cfg.startSeatNumber ?? 1;
  const arc = cfg.arcRadians ?? 0;
  for (let r = 0; r < cfg.rows; r++) {
    const rowLabel = rowLabelOf(r, cfg.rowLabel);
    for (let c = 0; c < cfg.cols; c++) {
      let x = cfg.startX + c * cfg.spacingX;
      let y = cfg.startY + r * cfg.spacingY;
      if (arc > 0) {
        // 부채꼴: row 가 커질수록 곡률 증가, col 중심 기준 회전
        const center = (cfg.cols - 1) / 2;
        const offset = c - center;
        const radius = (cfg.spacingY * cfg.rows) / Math.max(arc, 0.01);
        const angle = (offset / cfg.cols) * arc;
        x = cfg.startX + center * cfg.spacingX + Math.sin(angle) * (radius + r * cfg.spacingY);
        y = cfg.startY + (radius + r * cfg.spacingY) - Math.cos(angle) * (radius + r * cfg.spacingY);
      }
      seats.push({
        id: crypto.randomUUID(),
        x: Math.round(x),
        y: Math.round(y),
        label: `${rowLabel}${startNum + c}`,
        tierId: cfg.defaultTierId ?? null,
        isObstructed: false,
      });
    }
  }
  return seats;
}
