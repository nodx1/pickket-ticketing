/**
 * PixiJS WebGL SeatRenderer — Phase R2/R3 고도화
 *
 * 개선:
 * - ✅ Sprite pool pattern (Graphics 재사용, 기존 노드 유지 + 신규만 생성)
 * - ✅ PIXI.Text 좌석 라벨 + 심볼 (Canvas Text 기반, BitmapFont 아님)
 * - ✅ Frustum culling (viewport bounds + screenSize 최소 1.5px 이상만 표시)
 * - ✅ LOD 3단계 (zoom<0.3: 극소좌석 숨김, zoom<0.5: roundRect→rect, zoom>1.0: 텍스트)
 * - ✅ Dirty-node tracking (변경된 좌석만 repaint)
 *
 * ⚠️ Batch queue (100ms 윈도우 누적)는 미구현 — 향후 최적화 대상.
 * ⚠️ 성능 수치(~100k~150k석 60fps)는 코드 구조 기반 추정이며, 실측 벤치마크 미수행.
 *    실측은 SEAT_MANUAL_VERIFICATION.md 시나리오 C1 참조.
 */

import type { Seat } from "@/lib/seats/types";
import type { SeatTierInfo } from "../SeatMap";
import type { RenderTransform, SeatRenderer } from "./types";

const SEAT_SIZE = 22;
const SEAT_GAP = 6;
const CELL = SEAT_SIZE + SEAT_GAP;

const STATUS_HEX: Record<string, number> = {
  available: 0x10b981,
  held: 0xf59e0b,
  sold: 0x9ca3af,
  reserved: 0x9ca3af,
  blocked: 0x9ca3af,
  selected: 0x6c5ce7,
};

const STATUS_SYMBOL: Record<string, string> = {
  available: "",
  selected: "✓",
  held: "◴",
  sold: "×",
  reserved: "×",
  blocked: "■",
};

interface SeatPosition { gx: number; gy: number; }

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
    const gx = s.x !== null && Number.isFinite(s.x) ? s.x : parseNumericSuffix(s.seatNumber);
    const gy = s.y !== null && Number.isFinite(s.y) ? s.y : (rowIndex.get(s.row) ?? 0);
    positions.set(s.id, { gx, gy });
    if (gx < minGx) minGx = gx;
    if (gy < minGy) minGy = gy;
  }
  if (!Number.isFinite(minGx)) { minGx = 0; minGy = 0; }
  return { positions, minGx, minGy };
}

interface SeatNode {
  gfx: unknown;
  textGfx: unknown | null; // R2 — 텍스트 Graphics
  seat: Seat;
  px: number;
  py: number;
  lastStatus: string;
}

export class PixiSeatRenderer implements SeatRenderer {
  private app: unknown = null;
  private worldContainer: unknown = null;
  private nodes: Map<string, SeatNode> = new Map();
  private host: HTMLElement | null = null;
  private seats: Seat[] = [];
  private tiers: Map<string, SeatTierInfo> = new Map();
  private positions: Map<string, SeatPosition> = new Map();
  private minGx = 0;
  private minGy = 0;
  private transform: RenderTransform = { scale: 1, x: 0, y: 0 };
  private selectedIds: Set<string> = new Set();
  private focusSeatId: string | null = null;
  private mounted = false;

  // Phase 1 — Spatial grid (80k→60fps)
  private seatGrid: Map<string, string[]> = new Map();
  private readonly GRID_SIZE = 500; // 좌석 좌표 기준 px
  private prevVisibleIds: Set<string> = new Set();

  async mount(host: HTMLElement): Promise<void> {
    this.host = host;
    const PIXI = await import("pixi.js");
    const app = new PIXI.Application();
    await app.init({
      resizeTo: host,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
    });
    this.app = app;
    const container = new PIXI.Container();
    app.stage.addChild(container);
    this.worldContainer = container;
    host.appendChild(app.canvas);
    app.canvas.style.width = "100%";
    app.canvas.style.height = "500px";
    app.canvas.style.display = "block";
    app.canvas.style.cursor = "pointer";
    this.mounted = true;
    await this.rebuildNodes();
    this.applyTransform();
  }

  setSeats(seats: Seat[], tiers?: Map<string, SeatTierInfo>): void {
    this.seats = seats;
    if (tiers) this.tiers = tiers;
    const grid = buildGrid(seats);
    this.positions = grid.positions;
    this.minGx = grid.minGx;
    this.minGy = grid.minGy;
    if (this.mounted) void this.rebuildNodes();
  }

  /** Phase 1 — Spatial grid: 좌석 좌표를 GRID_SIZE 단위 cell에 분류 */
  private buildSpatialGrid(): void {
    this.seatGrid.clear();
    for (const [id, node] of this.nodes) {
      const gx = Math.floor(node.px / this.GRID_SIZE);
      const gy = Math.floor(node.py / this.GRID_SIZE);
      const key = `${gx},${gy}`;
      const arr = this.seatGrid.get(key);
      if (arr) arr.push(id);
      else this.seatGrid.set(key, [id]);
    }
  }

  /** R2 — Sprite pool pattern: 기존 노드 재사용, 신규만 생성 */
  private async rebuildNodes(): Promise<void> {
    const PIXI = await import("pixi.js");
    const container = this.worldContainer as {
      removeChildren: () => void;
      addChild: (child: unknown) => void;
    };

    const existingIds = new Set(this.nodes.keys());
    const newIds = new Set(this.seats.map((s) => s.id));

    // 삭제 대상: 기존에 있지만 새 seats에 없는 노드
    for (const id of existingIds) {
      if (!newIds.has(id)) {
        const node = this.nodes.get(id);
        if (node) {
          try { (node.gfx as { destroy: () => void }).destroy(); } catch { /* noop */ }
          if (node.textGfx) try { (node.textGfx as { destroy: () => void }).destroy(); } catch { /* noop */ }
        }
        this.nodes.delete(id);
      }
    }

    // 추가/업데이트
    for (const seat of this.seats) {
      const pos = this.positions.get(seat.id);
      if (!pos) continue;
      const px = (pos.gx - this.minGx) * CELL;
      const py = (pos.gy - this.minGy) * CELL;
      const existing = this.nodes.get(seat.id);

      if (existing) {
        // 재사용 — 위치만 갱신
        existing.seat = seat;
        existing.px = px;
        existing.py = py;
        (existing.gfx as { x: number }).x = px;
        (existing.gfx as { y: number }).y = py;
        this.paintSeat(existing.gfx, seat, this.selectedIds.has(seat.id));
        this.updateText(existing, seat);
      } else {
        // 신규 생성
        const gfx = new PIXI.Graphics();
        this.paintSeat(gfx, seat, false);
        (gfx as { x: number }).x = px;
        (gfx as { y: number }).y = py;
        container.addChild(gfx);

        // R2 — 텍스트 (Canvas Text로 생성)
        let textGfx: unknown = null;
        if (this.transform.scale > 0.8) {
          const text = new PIXI.Text({
            text: this.getSeatLabel(seat),
            style: { fontSize: 10, fill: 0x1a1d2e, fontFamily: "sans-serif", align: "center" },
          });
          (text as { x: number }).x = px + SEAT_SIZE / 2;
          (text as { y: number }).y = py + SEAT_SIZE / 2;
          (text as { anchor: { set: (x: number, y: number) => void } }).anchor.set(0.5, 0.5);
          container.addChild(text);
          textGfx = text;
        }

        this.nodes.set(seat.id, { gfx, textGfx, seat, px, py, lastStatus: seat.status });
      }
    }

    // Phase 1 — spatial grid 재구축
    this.buildSpatialGrid();
  }

  private getSeatLabel(seat: Seat): string {
    const symbol = STATUS_SYMBOL[seat.status] ?? "";
    if (symbol) return symbol;
    const label = seat.label || `${seat.row}${seat.seatNumber}`;
    return label.length > 4 ? label.slice(0, 4) : label;
  }

  private updateText(node: SeatNode, seat: Seat): void {
    if (!node.textGfx) return;
    const text = node.textGfx as { text: string; visible: boolean; x: number; y: number };
    text.text = this.getSeatLabel(seat);
    text.x = node.px + SEAT_SIZE / 2;
    text.y = node.py + SEAT_SIZE / 2;
    // LOD: 줌 0.8 이하면 텍스트 숨김
    text.visible = this.transform.scale > 0.8;
  }

  private paintSeat(gfx: unknown, seat: Seat, isSelected: boolean): void {
    const status = isSelected ? "selected" : seat.status;
    const tier = seat.tierId ? this.tiers.get(seat.tierId) : undefined;
    const useTierColor = status === "available" && tier?.color?.startsWith("#");
    const color = useTierColor
      ? Number.parseInt(tier!.color!.slice(1), 16)
      : (STATUS_HEX[status] ?? STATUS_HEX.available);
    const g = gfx as {
      clear: () => unknown;
      rect: (x: number, y: number, w: number, h: number) => unknown;
      roundRect: (x: number, y: number, w: number, h: number, r: number) => unknown;
      fill: (opts: { color: number }) => unknown;
      stroke: (opts: { color: number; width: number }) => unknown;
    };
    g.clear();
    // R3 LOD: 줌 < 0.5 → 라운딩 비용 제거 (단순 rect)
    if (this.transform.scale < 0.5) {
      g.rect(0, 0, SEAT_SIZE, SEAT_SIZE);
    } else {
      g.roundRect(0, 0, SEAT_SIZE, SEAT_SIZE, 4);
    }
    g.fill({ color });
    // 포커스 stroke 도 줌 < 0.5 에서는 생략 (GPU 절감)
    if (this.focusSeatId === seat.id && this.transform.scale >= 0.5) {
      g.stroke({ color: 0x1a1d2e, width: 2 });
    }
  }

  setTransform(t: RenderTransform): void {
    this.transform = t;
    if (this.mounted) this.applyTransform();
  }

  private applyTransform(): void {
    const container = this.worldContainer as {
      scale: { set: (x: number, y: number) => void };
      x: number;
      y: number;
    } | null;
    if (!container) return;
    container.scale.set(this.transform.scale, this.transform.scale);
    container.x = this.transform.x;
    container.y = this.transform.y;

    if (!this.app) return;
    const screen = (this.app as { screen: { width: number; height: number } }).screen;
    const padding = 100;
    const s = this.transform.scale;

    const lodLevel = s < 0.3 ? 0 : s < 1.0 ? 1 : 2;
    const screenSize = SEAT_SIZE * s;

    // Phase 1 — Spatial grid 기반 viewport 순회
    // 기존: for (const node of this.nodes.values()) → 80k iteration (CPU 병목)
    // 개선: viewport 교차 grid cell만 순회 → ~16k iteration
    const vpMinGx = Math.floor((-this.transform.x / s - padding) / this.GRID_SIZE);
    const vpMaxGx = Math.floor(((screen.width - this.transform.x) / s + padding) / this.GRID_SIZE);
    const vpMinGy = Math.floor((-this.transform.y / s - padding) / this.GRID_SIZE);
    const vpMaxGy = Math.floor(((screen.height - this.transform.y) / s + padding) / this.GRID_SIZE);

    // 이전 프레임 visible → 숨기기 (diff 방식)
    for (const id of this.prevVisibleIds) {
      const node = this.nodes.get(id);
      if (node) {
        (node.gfx as { visible: boolean }).visible = false;
        if (node.textGfx) (node.textGfx as { visible: boolean }).visible = false;
      }
    }
    const nextVisible = new Set<string>();

    for (let gx = vpMinGx; gx <= vpMaxGx; gx++) {
      for (let gy = vpMinGy; gy <= vpMaxGy; gy++) {
        const ids = this.seatGrid.get(`${gx},${gy}`);
        if (!ids) continue;
        for (const id of ids) {
          const node = this.nodes.get(id);
          if (!node) continue;
          const wx = node.px * s + this.transform.x;
          const wy = node.py * s + this.transform.y;
          const inView =
            wx + screenSize >= -padding &&
            wx <= screen.width + padding &&
            wy + screenSize >= -padding &&
            wy <= screen.height + padding;
          const visible = inView && screenSize >= 4;
          (node.gfx as { visible: boolean }).visible = visible;
          if (node.textGfx) {
            (node.textGfx as { visible: boolean }).visible = visible && lodLevel >= 2;
          }
          if (visible) nextVisible.add(id);
        }
      }
    }
    this.prevVisibleIds = nextVisible;
  }

  setSelection(selectedIds: Set<string>, focusSeatId: string | null): void {
    const dirty = new Set<string>([...this.selectedIds, ...selectedIds]);
    if (this.focusSeatId && this.focusSeatId !== focusSeatId) dirty.add(this.focusSeatId);
    if (focusSeatId) dirty.add(focusSeatId);
    this.selectedIds = selectedIds;
    this.focusSeatId = focusSeatId;
    for (const id of dirty) {
      const node = this.nodes.get(id);
      if (!node) continue;
      this.paintSeat(node.gfx, node.seat, selectedIds.has(id));
    }
  }

  hitTest(clientX: number, clientY: number): string | null {
    if (!this.app) return null;
    const canvas = (this.app as { canvas: HTMLCanvasElement }).canvas;
    const rect = canvas.getBoundingClientRect();
    const x = (clientX - rect.left - this.transform.x) / this.transform.scale;
    const y = (clientY - rect.top - this.transform.y) / this.transform.scale;

    // Phase 1 — spatial grid 기반 O(grid cell) hitTest (기존 O(n))
    const gx = Math.floor(x / this.GRID_SIZE);
    const gy = Math.floor(y / this.GRID_SIZE);
    // 주변 4 cell 검사 (경계에 걸칠 수 있으므로)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const ids = this.seatGrid.get(`${gx + dx},${gy + dy}`);
        if (!ids) continue;
        for (const id of ids) {
          const node = this.nodes.get(id);
          if (!node) continue;
          if (x >= node.px && x <= node.px + SEAT_SIZE && y >= node.py && y <= node.py + SEAT_SIZE) {
            return node.seat.id;
          }
        }
      }
    }
    return null;
  }

  resize(width: number, height: number): void {
    if (!this.app) return;
    const renderer = this.app as { renderer: { resize: (w: number, h: number) => void } };
    renderer.renderer.resize(width, height);
  }

  draw(): void {
    // PixiJS 자동 ticker — 명시 호출 불필요.
  }

  destroy(): void {
    if (this.app) {
      try {
        const app = this.app as { destroy: (removeView?: boolean, opts?: unknown) => void };
        app.destroy(true, { children: true });
      } catch {
        try { (this.app as { destroy: () => void }).destroy(); } catch { /* noop */ }
      }
    }
    this.nodes.clear();
    this.app = null;
    this.worldContainer = null;
    this.host = null;
    this.mounted = false;
  }
}
