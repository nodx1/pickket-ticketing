/**
 * 레벨2 컷오버 T1 — 배치도 레이아웃 → 좌석 행 생성(순수 함수, go DB 미사용).
 *
 * ── 왜 필요한가 ──
 * 이전 빌더는 좌석을 go `seats` 에 INSERT 해 스테이징한 뒤 그걸 다시 SELECT 해서 v2 로 write-through 했다.
 * go DB 를 제거하려면 이 스테이징이 사라져야 한다 → **레이아웃 스펙(map_data)에서 좌석을 직접 파생**하고
 * v2 `upsertSeats` 로 바로 보낸다. 배치도 원본(map_data)은 이미 v2 events.seat_map_data(SoT)에 있으므로
 * 좌석은 언제든 재생성 가능하다(파생 데이터 — go 소실 시에도 복원 가능).
 *
 * ── external_ref(멱등키) 설계 ──
 * 이전엔 go seat uuid 였다. go 가 사라지므로 **레이아웃 자연키에서 결정적으로 파생**한다:
 *     `smseat:{mapId}:{sha256(section \0 row \0 seatNumber)[0..16]}`
 * - 결정적 → 같은 레이아웃을 몇 번 저장해도 같은 ref → v2 가 update(멱등). "동시 2회 실행"해도
 *   같은 좌석행을 갱신할 뿐 중복 생성되지 않는다.
 * - mapId 를 포함 → v2 `ix_seats_external_ref`(전역 UNIQUE)와 충돌하지 않고, 맵 단위 정리(scope_prefix)가 가능.
 * - v2 `Seat.external_ref` 는 String(100) → 해시로 길이를 고정한다(section/row 가 길어도 안전).
 *   16 hex(64bit) 충돌확률은 맵당 1만석 기준 무시 가능(~3e-12).
 *
 * ── 좌표/기하 ──
 * 기존 라우트(seat-maps POST·[mapId] PATCH)의 상수·계산식을 그대로 옮겼다(회귀 방지).
 * 피그마 모드는 섹션 회전(rotation)을 적용한 절대좌표, 격자 모드는 섹션 세로 쌓기.
 */
import crypto from "node:crypto";

import type { SeatUpsertInput } from "@/lib/v2/commerce-client";

/** 피그마 모드 기하 상수 — 기존 빌더 라우트와 동일(값 변경 시 좌표 회귀). */
const FIGMA_SEAT_SIZE = 16;
const FIGMA_SEAT_GAP = 4;
const FIGMA_PADDING = 20;
const FIGMA_NAME_HEIGHT = 20;
/** 격자 모드 기하 상수 — 기존 빌더 라우트와 동일. */
const GRID_SEAT_SIZE = 30;

/** external_ref prefix — 맵 단위 정리 범위(upsertSeats scope_prefix)로도 쓰인다. */
export function seatRefPrefix(mapId: string): string {
  return `smseat:${mapId}:`;
}

/**
 * 좌석 자연키 → 결정적 external_ref. 같은 (map, section, row, seat) 는 항상 같은 값.
 * NUL 구분자로 조인해 `A|1` 과 `A1|` 같은 경계 모호성을 없앤다.
 */
export function seatExternalRef(
  mapId: string,
  section: string,
  row: string,
  seatNumber: string,
): string {
  const natural = [section, row, seatNumber].join("\u0000");
  const hash = crypto.createHash("sha256").update(natural).digest("hex").slice(0, 16);
  return `${seatRefPrefix(mapId)}${hash}`;
}

/**
 * external_ref → 소속 배치도 id (`smseat:{mapId}:{hash}` 역파싱).
 *
 * go `seats.seat_map_id` 가 사라진 뒤 "이 좌석이 어느 배치도 것인가"를 알 수 있는 유일한 단서다
 * (소비자 좌석목록의 published 맵 게이트·SSE 브로드캐스트 대상 판정에 쓴다).
 * 레거시 좌석(go seat uuid 를 그대로 external_ref 로 쓰던 시절)은 맵 정보를 담지 않으므로 null —
 * 호출부는 null 을 "맵 불명 → 단일맵 계약상 이 이벤트 좌석"으로 취급한다.
 */
export function mapIdFromSeatRef(ref: string | null | undefined): string | null {
  const PREFIX = "smseat:";
  if (!ref || !ref.startsWith(PREFIX)) return null;
  const rest = ref.slice(PREFIX.length);
  const sep = rest.lastIndexOf(":");
  if (sep <= 0) return null;
  return rest.slice(0, sep);
}

/** go 행 라벨(알파벳 A·B.. 또는 숫자) → v2 row_number(int). A→1, B→2, AA→27. 숫자면 그대로. */
export function rowToNumber(row: string): number {
  const trimmed = (row ?? "").trim();
  const n = Number.parseInt(trimmed, 10);
  if (Number.isFinite(n) && String(n) === trimmed) return n; // 순수 숫자 행
  let acc = 0;
  for (const ch of trimmed.toUpperCase()) {
    const c = ch.charCodeAt(0) - 64; // A=1
    if (c < 1 || c > 26) return acc || 0;
    acc = acc * 26 + c;
  }
  return acc || 0;
}

/** 피그마 섹션 스펙(map_data.figmaLayout.sections[] 원본 shape). */
export interface FigmaSectionSpec {
  name: string;
  x: number;
  y: number;
  rotation?: number;
  kind?: "assigned" | "standing" | "stage" | "console";
  rows?: number;
  seatsPerRow?: number;
  /** "rowIdx-seatIdx" — 빌더가 클릭으로 막은 자리. */
  blockedPositions?: string[];
  /** 스탠딩 전용 수용인원. */
  capacity?: number;
  tierId?: string | null;
  width?: number;
  height?: number;
}

/** 격자 모드 스펙(map_data 원본 shape). */
export interface GridLayoutSpec {
  sections?: string[];
  rowsPerSection?: number;
  seatsPerRow?: number;
}

/** 생성된 좌석 1개 — v2 전송 전 중간표현(tier 미배정도 포함해 정원 집계에 쓴다). */
export interface GeneratedSeat {
  externalRef: string;
  section: string;
  row: string;
  seatNumber: string;
  x: number;
  y: number;
  tierId: string | null;
  /** 빌더 차단석(판매대상 제외). v2 로는 status="reserved" 로 전송된다. */
  blocked: boolean;
}

/** 배치도 map_data(캔버스 원본)에서 좌석·스탠딩 정원을 파생한 결과. */
export interface GeneratedLayout {
  seats: GeneratedSeat[];
  /** tierId → 스탠딩 수용인원 합(좌석 행이 없는 정원). */
  standingByTier: Map<string, number>;
  /** tier 무관 스탠딩 총합(max_attendees 산출용). */
  standingTotal: number;
}

/** map_data 캔버스 JSON(피그마/격자 공용) — v2 seat_map_data.maps[].map_data 와 동일 shape. */
export interface SeatMapCanvas {
  mode?: string;
  figmaLayout?: { sections?: FigmaSectionSpec[] } | null;
  sections?: string[];
  rowsPerSection?: number;
  seatsPerRow?: number;
}

/**
 * 피그마 레이아웃 → 좌석 생성. assigned 섹션만 좌석 행을 만들고,
 * standing 은 정원만(좌석 행 없음), stage/console 은 장식이라 무시한다.
 * 좌표는 섹션 중심(x,y) 기준 로컬좌표를 rotation 만큼 회전시킨 절대좌표.
 */
export function generateFigmaSeats(
  mapId: string,
  sections: FigmaSectionSpec[],
): GeneratedLayout {
  const seats: GeneratedSeat[] = [];
  const standingByTier = new Map<string, number>();
  let standingTotal = 0;

  for (const section of sections) {
    const kind = section.kind ?? "assigned";
    if (kind === "stage" || kind === "console") continue; // 장식 — 정원/좌석 없음
    if (kind === "standing") {
      const cap = Number(section.capacity) || 0;
      standingTotal += cap;
      if (section.tierId) {
        standingByTier.set(section.tierId, (standingByTier.get(section.tierId) ?? 0) + cap);
      }
      continue;
    }

    const rows = section.rows ?? 5;
    const seatsPerRow = section.seatsPerRow ?? 8;
    const blocked = new Set(section.blockedPositions ?? []);
    const width =
      seatsPerRow * (FIGMA_SEAT_SIZE + FIGMA_SEAT_GAP) - FIGMA_SEAT_GAP + FIGMA_PADDING * 2;
    const height =
      rows * (FIGMA_SEAT_SIZE + FIGMA_SEAT_GAP) -
      FIGMA_SEAT_GAP +
      FIGMA_PADDING * 2 +
      FIGMA_NAME_HEIGHT;
    const rotation = section.rotation ?? 0;
    const cosR = Math.cos((rotation * Math.PI) / 180);
    const sinR = Math.sin((rotation * Math.PI) / 180);

    for (let rowIdx = 0; rowIdx < rows; rowIdx += 1) {
      const rowLetter = String.fromCharCode(65 + rowIdx);
      for (let seatIdx = 0; seatIdx < seatsPerRow; seatIdx += 1) {
        const lx =
          FIGMA_PADDING +
          seatIdx * (FIGMA_SEAT_SIZE + FIGMA_SEAT_GAP) +
          FIGMA_SEAT_SIZE / 2 -
          width / 2;
        const ly =
          FIGMA_PADDING +
          FIGMA_NAME_HEIGHT +
          rowIdx * (FIGMA_SEAT_SIZE + FIGMA_SEAT_GAP) +
          FIGMA_SEAT_SIZE / 2 -
          height / 2;
        const seatNumber = String(seatIdx + 1);
        seats.push({
          externalRef: seatExternalRef(mapId, section.name, rowLetter, seatNumber),
          section: section.name,
          row: rowLetter,
          seatNumber,
          x: section.x + lx * cosR - ly * sinR,
          y: section.y + lx * sinR + ly * cosR,
          tierId: section.tierId ?? null,
          blocked: blocked.has(`${rowIdx}-${seatIdx}`),
        });
      }
    }
  }

  return { seats, standingByTier, standingTotal };
}

/** 격자 레이아웃 → 좌석 생성(섹션을 세로로 쌓는 기존 계산식 그대로). tier 배정은 없다. */
export function generateGridSeats(mapId: string, spec: GridLayoutSpec): GeneratedLayout {
  const seats: GeneratedSeat[] = [];
  const { sections, rowsPerSection, seatsPerRow } = spec;
  if (!sections || !rowsPerSection || !seatsPerRow) {
    return { seats, standingByTier: new Map(), standingTotal: 0 };
  }

  const rowLetters = Array.from({ length: rowsPerSection }, (_, i) => String.fromCharCode(65 + i));
  const sectionGap = GRID_SEAT_SIZE;
  const sectionHeight = rowsPerSection * GRID_SEAT_SIZE;

  for (const [sectionIndex, section] of sections.entries()) {
    const sectionBaseY = sectionIndex * (sectionHeight + sectionGap);
    for (const [rowIndex, row] of rowLetters.entries()) {
      for (let seatIndex = 1; seatIndex <= seatsPerRow; seatIndex += 1) {
        const seatNumber = String(seatIndex);
        seats.push({
          externalRef: seatExternalRef(mapId, section, row, seatNumber),
          section,
          row,
          seatNumber,
          x: (seatIndex - 1) * GRID_SEAT_SIZE + GRID_SEAT_SIZE / 2,
          y: sectionBaseY + rowIndex * GRID_SEAT_SIZE + GRID_SEAT_SIZE / 2,
          tierId: null,
          blocked: false,
        });
      }
    }
  }

  return { seats, standingByTier: new Map(), standingTotal: 0 };
}

/**
 * map_data 캔버스(피그마/격자 자동판별) → 좌석·정원 파생.
 * v2 seat_map_data 에서 읽어온 map_data 를 그대로 넣을 수 있다(빌더 저장경로·재계산경로 공용).
 */
export function generateSeatsFromCanvas(
  mapId: string,
  canvas: SeatMapCanvas | null | undefined,
): GeneratedLayout {
  if (!canvas) return { seats: [], standingByTier: new Map(), standingTotal: 0 };
  const figmaSections = canvas.figmaLayout?.sections;
  if (figmaSections && figmaSections.length > 0) {
    return generateFigmaSeats(mapId, figmaSections);
  }
  return generateGridSeats(mapId, canvas);
}

/**
 * 생성 좌석 → v2 upsertSeats 페이로드. **tier 미배정 좌석은 제외**(v2 tier_id 필수 계약).
 * 차단석은 status="reserved" 로 보낸다 — 이전엔 go-local 'blocked' 로만 남아 v2 에 미전송이었고,
 * go 가 사라지면 차단 사실이 소실되므로 v2 로 승격한다(v2 SeatStatus 에 blocked 가 없어 reserved 로 매핑).
 *
 * ⚠️ v2 는 SOLD/HELD 좌석의 status 를 덮어쓰지 않는다(결제분 보호) → 판매된 좌석을 빌더가
 *    차단해도 v2 가 거부하는 게 정상 동작이다.
 */
export function toSeatUpsertInputs(seats: GeneratedSeat[]): SeatUpsertInput[] {
  return seats
    .filter((s) => s.tierId)
    .map((s) => ({
      external_ref: s.externalRef,
      section: s.section,
      row_number: rowToNumber(s.row),
      seat_number: Number.parseInt(s.seatNumber, 10) || 0,
      tier_ref: s.tierId as string,
      x: s.x,
      y: s.y,
      status: s.blocked ? "reserved" : "available",
    }));
}

/** 판매대상 좌석 수(차단석 제외) — max_attendees·tier capacity 산출 입력. */
export function countSellableSeats(layout: GeneratedLayout): number {
  return layout.seats.filter((s) => !s.blocked).length;
}

/** tierId → 판매대상 지정석 수(차단석 제외). */
export function countSellableByTier(layout: GeneratedLayout): Map<string, number> {
  const byTier = new Map<string, number>();
  for (const s of layout.seats) {
    if (s.blocked || !s.tierId) continue;
    byTier.set(s.tierId, (byTier.get(s.tierId) ?? 0) + 1);
  }
  return byTier;
}
