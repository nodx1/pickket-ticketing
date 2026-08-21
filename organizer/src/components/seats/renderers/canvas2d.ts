/**
 * Canvas2D SeatRenderer — Phase R1 고도화
 *
 * 개선:
 * - ✅ Frustum culling: viewport 밖 좌석 skip
 * - ✅ RAF dirty loop: requestAnimationFrame + dirty flag (jank 방지)
 * - ✅ 가격 라벨 표시 임계: scale >= 1.2 (기존 1.4에서 낮춤)
 * - ✅ 좌석 라벨 표시 임계: scale > 1.0 (LOD 단순화)
 * - 기존: DPR 스케일링 + tier 색상 + 색맹 심볼 유지
 *
 * ⚠️ 성능 수치는 코드 구조 기반 추정이며, 실측 벤치마크 미수행.
 *    실측은 SEAT_MANUAL_VERIFICATION.md 시나리오 C1 참조.
 */

import type { Seat } from "@/lib/seats/types";
import type { SeatTierInfo } from "../SeatMap";
import type {
  RenderTransform,
  SeatRenderer,
} from "./types";

const SEAT_SIZE = 22;
const SEAT_GAP = 6;
const CELL = SEAT_SIZE + SEAT_GAP;

const STATUS_COLORS: Record<string, string> = {
  available: "#10b981",
  held: "#f59e0b",
  sold: "#9ca3af",
  reserved: "#9ca3af",
  blocked: "#9ca3af",
  selected: "#6c5ce7",
};

const STATUS_SYMBOL: Record<string, string> = {
  available: "",
  selected: "✓",
  held: "◴",
  sold: "×",
  reserved: "×",
  blocked: "■",
};

interface SeatPosition {
  gx: number;
  gy: number;
}

function parseNumericSuffix(value: string): number {
  const m = value.match(/\d+/g);
  if (!m || m.length === 0) return 0;
  return Number.parseInt(m[m.length - 1] ?? "0", 10) || 0;
}

function buildGrid(seats: Seat[]): {
  positions: Map<string, SeatPosition>;
  minGx: number;
  minGy: number;
} {
  const rowSet = new Set<string>();
  for (const s of seats) rowSet.add(s.row);
  const rowList = Array.from(rowSet).sort((a, b) => a.localeCompare(b));
  const rowIndex = new Map<string, number>();
  rowList.forEach((r, i) => rowIndex.set(r, i));

  const positions = new Map<string, SeatPosition>();
  let minGx = Number.POSITIVE_INFINITY;
  let minGy = Number.POSITIVE_INFINITY;
  for (const s of seats) {
    const gx =
      s.x !== null && Number.isFinite(s.x)
        ? s.x
        : parseNumericSuffix(s.seatNumber);
    const gy =
      s.y !== null && Number.isFinite(s.y)
        ? s.y
        : (rowIndex.get(s.row) ?? 0);
    positions.set(s.id, { gx, gy });
    if (gx < minGx) minGx = gx;
    if (gy < minGy) minGy = gy;
  }
  if (!Number.isFinite(minGx)) minGx = 0;
  if (!Number.isFinite(minGy)) minGy = 0;
  return { positions, minGx, minGy };
}

export class Canvas2DSeatRenderer implements SeatRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null = null;
  private host: HTMLElement | null = null;
  private seats: Seat[] = [];
  private tiers: Map<string, SeatTierInfo> = new Map();
  private positions: Map<string, SeatPosition> = new Map();
  private minGx = 0;
  private minGy = 0;
  private transform: RenderTransform = { scale: 1, x: 0, y: 0 };
  private selectedIds: Set<string> = new Set();
  private focusSeatId: string | null = null;

  // R1 — RAF dirty loop
  private dirty = true;
  private rafId = 0;
  private destroyed = false;

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.style.width = "100%";
    this.canvas.style.height = "500px";
    this.canvas.style.display = "block";
    this.canvas.style.cursor = "pointer";
    this.canvas.style.userSelect = "none";
  }

  mount(host: HTMLElement): void {
    this.host = host;
    host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: false });
    this.resize(this.canvas.clientWidth, 500);
    this.startLoop();
  }

  // R1 — requestAnimationFrame 루프
  private startLoop(): void {
    const tick = () => {
      if (this.destroyed) return;
      if (this.dirty) {
        this.dirty = false;
        this.drawInternal();
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private markDirty(): void {
    this.dirty = true;
  }

  setSeats(seats: Seat[], tiers?: Map<string, SeatTierInfo>): void {
    this.seats = seats;
    if (tiers) this.tiers = tiers;
    const grid = buildGrid(seats);
    this.positions = grid.positions;
    this.minGx = grid.minGx;
    this.minGy = grid.minGy;
    this.markDirty();
  }

  setTransform(t: RenderTransform): void {
    this.transform = t;
    this.markDirty();
  }

  setSelection(selectedIds: Set<string>, focusSeatId: string | null): void {
    this.selectedIds = selectedIds;
    this.focusSeatId = focusSeatId;
    this.markDirty();
  }

  hitTest(clientX: number, clientY: number): string | null {
    const rect = this.canvas.getBoundingClientRect();
    const x = (clientX - rect.left - this.transform.x) / this.transform.scale;
    const y = (clientY - rect.top - this.transform.y) / this.transform.scale;
    for (const seat of this.seats) {
      const pos = this.positions.get(seat.id);
      if (!pos) continue;
      const sx = (pos.gx - this.minGx) * CELL;
      const sy = (pos.gy - this.minGy) * CELL;
      if (x >= sx && x <= sx + SEAT_SIZE && y >= sy && y <= sy + SEAT_SIZE) {
        return seat.id;
      }
    }
    return null;
  }

  resize(width: number, height: number): void {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = width * dpr;
    this.canvas.height = height * dpr;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.markDirty();
  }

  /** 외부 호출용 (호환) — dirty 마킹으로 다음 RAF에서 그림 */
  draw(): void {
    this.markDirty();
  }

  /** 실제 렌더 — RAF 루프에서만 호출 */
  private drawInternal(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (this.canvas.width !== width * dpr || this.canvas.height !== height * dpr) {
      this.resize(width, height);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.translate(this.transform.x, this.transform.y);
    ctx.scale(this.transform.scale, this.transform.scale);

    // R1 — Frustum culling: viewport 밖 좌석 skip
    const s = this.transform.scale;
    const tx = this.transform.x;
    const ty = this.transform.y;
    const vpLeft = -tx / s - CELL;
    const vpTop = -ty / s - CELL;
    const vpRight = (width - tx) / s + CELL;
    const vpBottom = (height - ty) / s + CELL;

    for (const seat of this.seats) {
      const pos = this.positions.get(seat.id);
      if (!pos) continue;
      const x = (pos.gx - this.minGx) * CELL;
      const y = (pos.gy - this.minGy) * CELL;

      // Frustum culling — viewport 밖이면 skip
      if (x + SEAT_SIZE < vpLeft || x > vpRight || y + SEAT_SIZE < vpTop || y > vpBottom) {
        continue;
      }
      const isSelected = this.selectedIds.has(seat.id);
      const status = isSelected ? "selected" : seat.status;
      const tier = seat.tierId ? this.tiers.get(seat.tierId) : undefined;
      const useTierColor =
        status === "available" && tier?.color?.startsWith("#");
      ctx.fillStyle = useTierColor
        ? (tier!.color as string)
        : (STATUS_COLORS[status] ?? STATUS_COLORS.available);

      ctx.beginPath();
      if (typeof ctx.roundRect === "function") {
        ctx.roundRect(x, y, SEAT_SIZE, SEAT_SIZE, 4);
      } else {
        ctx.rect(x, y, SEAT_SIZE, SEAT_SIZE);
      }
      ctx.fill();

      if (this.focusSeatId === seat.id) {
        ctx.strokeStyle = "#1a1d2e";
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // R3 LOD — 줌별 텍스트 표시
      if (s > 0.8) {
        const isDim =
          status === "sold" || status === "reserved" || status === "blocked";
        ctx.fillStyle = isDim ? "#ffffff" : "#1a1d2e";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const symbol = STATUS_SYMBOL[status] ?? "";
        if (symbol) {
          ctx.font = "bold 14px sans-serif";
          ctx.fillText(symbol, x + SEAT_SIZE / 2, y + SEAT_SIZE / 2);
        } else if (s > 1.0) {
          // R1 개선: 기본 줌(1.0)에서도 라벨 표시 (기존 0.8 → 1.0)
          ctx.font = "10px sans-serif";
          const labelText = seat.label || `${seat.row}${seat.seatNumber}`;
          ctx.fillText(
            labelText.length > 4 ? labelText.slice(0, 4) : labelText,
            x + SEAT_SIZE / 2,
            y + SEAT_SIZE / 2,
          );
        }

        // 가격 라벨: 기존 1.4 → 1.2 (더 빨리 표시)
        if (s >= 1.2 && tier && status === "available") {
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
      }
    }
    ctx.restore();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    if (this.host && this.canvas.parentElement === this.host) {
      this.host.removeChild(this.canvas);
    }
    this.host = null;
    this.ctx = null;
  }
}
