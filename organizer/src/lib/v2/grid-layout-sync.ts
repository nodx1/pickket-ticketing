/**
 * GO → v2 격자 배치도 구역 동기화
 *
 * 피그마 모드: map_data.figmaLayout.sections 직접 사용 (assigned/standing/stage 모두)
 * 격자 모드: 레이아웃에서 파생한 좌석 bounding box 집계 (폴백)
 *
 * ── 레벨2 컷오버 T1 ──
 * 이전엔 go `seat_maps`(map_data) 와 `seats`(격자 폴백 좌표)를 SELECT 했다. 좌석 스테이징이 사라지면서
 * **배치도 원본은 v2 events.seat_map_data(SoT)에서 read**하고, 격자 폴백 좌표는 캔버스에서
 * `generateSeatsFromCanvas` 로 파생한다(go 미read).
 *
 * ── 레벨2 컷오버 W3-OPS — 잔여 getPool 1건의 사유 ──
 * `seat_tiers` 는 **의도적으로 go read 로 남긴다**. v2 `SeatTier` 에 빌더 메타 12컬럼
 * (view_description·distance_from_stage·resale_*·max_group_size 등)이 없어 지금 옮기면 데이터가
 * 소실되고, figma 섹션의 `tierId` 가 **go seat_tiers.id** 를 가리키므로 v2 tier_id 로 갈아끼우면
 * 섹션↔등급 매핑(색/가격/판매모드)이 통째로 끊긴다. `seat_tiers` 이관은 alembic 스키마 확장을
 * 선행 조건으로 하는 별도 게이트다(정본 LEVEL2-PHASE-3.1-SEATS / EXEC-PLAN T1 주석).
 *
 * v2 수신 엔드포인트: POST /api/v1/internal/grid-layout/sync
 */
import crypto from "node:crypto";
import { logger } from "@/lib/logger";
import { getPool } from "@/lib/db/pool";
import { toCanonicalSaleMode } from "@/lib/domain-model";
import {
  generateSeatsFromCanvas,
  type SeatMapCanvas,
} from "@/lib/seats/seat-generator";
import { getEvent } from "@/lib/v2/commerce-client";
import { toV2EventId } from "@/lib/v2/event-access";

const V2_SYNC_PATH = "/api/v1/internal/grid-layout/sync";

const SEAT_SIZE = 16;
const SEAT_GAP = 4;
const PADDING = 20;
const NAME_HEIGHT = 20;

interface GridSectionPayload {
  name: string;
  center_x: number;
  center_y: number;
  width: number;
  height: number;
  capacity: number;
  color_hex: string;
  /** 섹션 종류: assigned(지정석) | standing(스탠딩) | stage(무대) | console(음향/조명 부스) */
  kind: "assigned" | "standing" | "stage" | "console";
  /** 피그마 빌더에서 지정한 회전각(도). 소비자 화면에서 동일하게 렌더링. */
  rotation: number;
  /** 섹션에 배정된 등급 정보 (없으면 기본값) */
  tier_name: string | null;
  tier_price: number;
  sale_mode: string;
}

interface FigmaSectionRaw {
  name: string;
  x: number;
  y: number;
  rotation?: number;
  kind?: "assigned" | "standing" | "stage" | "console";
  rows?: number;
  seatsPerRow?: number;
  blockedPositions?: string[];
  capacity?: number;
  tierId?: string | null;
  width?: number;
  height?: number;
}

function figmaSectionDims(section: FigmaSectionRaw): { width: number; height: number } {
  if (section.kind === "stage") {
    return { width: section.width ?? 320, height: section.height ?? 80 };
  }
  if (section.kind === "console") {
    return { width: section.width ?? 180, height: section.height ?? 80 };
  }
  if (section.kind === "standing") {
    if (section.width && section.height) {
      return { width: section.width, height: section.height };
    }
    const cap = section.capacity ?? 100;
    const scale = Math.max(1, Math.sqrt(cap / 50));
    return { width: 180 * scale, height: 120 * scale };
  }
  const rows = section.rows ?? 5;
  const seatsPerRow = section.seatsPerRow ?? 8;
  const width = seatsPerRow * (SEAT_SIZE + SEAT_GAP) - SEAT_GAP + PADDING * 2;
  const height = rows * (SEAT_SIZE + SEAT_GAP) - SEAT_GAP + PADDING * 2 + NAME_HEIGHT;
  return { width, height };
}

function figmaSectionCapacity(section: FigmaSectionRaw): number {
  if (section.kind === "stage" || section.kind === "console") return 0;
  if (section.kind === "standing") return section.capacity ?? 0;
  const rows = section.rows ?? 5;
  const seatsPerRow = section.seatsPerRow ?? 8;
  return rows * seatsPerRow - (section.blockedPositions?.length ?? 0);
}

function sign(secret: string, timestamp: string, body: string): string {
  const message = `${timestamp}.${body}`;
  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

/**
 * 이벤트의 좌석을 구역별로 집계하여 bounding box + 대표 색상 계산 후 v2로 push.
 * fire-and-forget — 실패해도 GO 응답에 영향 없음.
 */
export async function pushGridLayoutToV2(eventId: string): Promise<boolean> {
  const baseUrl = process.env.V2_INTERNAL_BASE_URL;
  const secret = process.env.V2_EVENT_SYNC_SECRET;

  if (!baseUrl || !secret) {
    logger.debug("v2 격자 배치도 동기화 스킵: V2_INTERNAL_BASE_URL/SECRET 미설정");
    return false;
  }

  const pool = getPool();

  try {
    // 1) published 배치도 + mapData 조회 — v2 seat_map_data(SoT). go seat_maps 미read.
    //    draft 도 payload 에 담기므로(3.1 draft 계약) 여기서 published 만 명시 필터한다
    //    — 이 동기화의 결과물은 소비자 화면 렌더용이라 미발행 배치도가 새면 안 된다.
    // W3-OPS: 앵커 조회 폐기 — go event id == v2 event id(항등). DB 왕복 없음.
    // "v2 에 그 이벤트가 있는가"는 뒤따르는 getEvent 의 404 가 답한다(아래 catch 에서 warn 처리).
    const v2EventId = toV2EventId(eventId);
    const detail = await getEvent(v2EventId);
    const publishedMaps = (detail.content?.seat_map_data?.maps ?? []).filter(
      (m) => m.status === "published",
    );
    const mapsResult = {
      rows: publishedMaps.map((m) => ({
        id: m.id,
        mapData: (m.map_data ?? null) as
          | ({ mode?: string; figmaLayout?: { sections: FigmaSectionRaw[] } } & SeatMapCanvas)
          | null,
      })),
    };

    if (mapsResult.rows.length === 0) {
      logger.debug("v2 격자 배치도 동기화 스킵: published 배치도 없음", { eventId });
      return false;
    }

    // 2) tier 정보 preload (figma section의 tierId 매핑용)
    const tiersResult = await pool.query<{
      id: string;
      name: string;
      basePrice: string | null;
      saleMode: string | null;
      colorHex: string | null;
    }>(
      `SELECT id, name, base_price AS "basePrice", sale_mode AS "saleMode", color_hex AS "colorHex"
       FROM seat_tiers WHERE event_id = $1`,
      [eventId],
    );
    const tierById = new Map(tiersResult.rows.map((t) => [t.id, t]));

    // 3) 피그마 모드 섹션을 그대로 payload로 변환
    const figmaSections: GridSectionPayload[] = [];
    const hasFigmaMap = mapsResult.rows.some((m) => m.mapData?.mode === "figma");

    if (hasFigmaMap) {
      for (const map of mapsResult.rows) {
        if (map.mapData?.mode !== "figma") continue;
        const sections = map.mapData.figmaLayout?.sections ?? [];
        for (const s of sections) {
          const dims = figmaSectionDims(s);
          const tier = s.tierId ? tierById.get(s.tierId) : null;
          // v2 가 console kind 를 인식하므로 그대로 전달 — 소비자 화면에서 별도 콘솔 블록으로 렌더링됨.
          const v2Kind: "assigned" | "standing" | "stage" | "console" =
            s.kind ?? "assigned";
          figmaSections.push({
            name: s.name,
            center_x: s.x,
            center_y: s.y,
            width: dims.width,
            height: dims.height,
            capacity: figmaSectionCapacity(s),
            color_hex: tier?.colorHex ?? "#6C5CE7",
            kind: v2Kind,
            rotation: s.rotation ?? 0,
            tier_name: tier?.name ?? null,
            tier_price: tier?.basePrice ? Number(tier.basePrice) : 0,
            // v2 는 canonical sale_mode(4종)만 허용 — go tier 어휘(lottery/dutch 등 레거시 포함)를
            // 그대로 보내면 계약 위반. 송신 직전 정규화. (감사 P1-17)
            sale_mode: toCanonicalSaleMode(tier?.saleMode ?? "fixed_fcfs"),
          });
        }
      }
    }

    if (figmaSections.length > 0) {
      // 피그마 모드로 전부 커버되면 seats 집계 생략
      const payload = { eventId, sections: figmaSections };
      return await postGridLayout(baseUrl, secret, payload, eventId);
    }

    // 4) 격자 모드 폴백: 캔버스에서 파생한 좌석의 bounding box 집계(go seats 미read).
    //    좌표는 생성기가 항상 채우므로 아래 NULL 폴백 경로는 레거시 방어로만 남는다.
    const rows = mapsResult.rows
      .flatMap((m) => generateSeatsFromCanvas(m.id, m.mapData).seats)
      .map((s) => {
        const tier = s.tierId ? tierById.get(s.tierId) : null;
        return {
          section: s.section,
          row: s.row,
          seatNumber: s.seatNumber,
          x: s.x as number | null,
          y: s.y as number | null,
          tierColor: tier?.colorHex ?? null,
          tierName: tier?.name ?? null,
          tierPrice: tier?.basePrice ?? null,
          tierSaleMode: tier?.saleMode ?? null,
        };
      })
      .sort(
        (a, b) =>
          a.section.localeCompare(b.section) ||
          a.row.localeCompare(b.row) ||
          a.seatNumber.localeCompare(b.seatNumber),
      );

    if (rows.length === 0) {
      logger.debug("v2 격자 배치도 동기화 스킵: published 배치도 좌석 없음", { eventId });
      return false;
    }

    // x/y NULL 방어: row (A,B,C..) + seat_number(1,2,3..) 기반 가상 좌표 계산
    // 섹션 순서대로 세로로 쌓음 (A 섹션 위, B 섹션 가운데, C 섹션 아래)
    const SEAT_SIZE = 30;
    const SECTION_GAP = SEAT_SIZE;
    const sectionOrder = Array.from(new Set(rows.map((r) => r.section)));

    // 섹션별 행(row) 집합 → 섹션 높이 계산
    const rowsBySection = new Map<string, Set<string>>();
    for (const r of rows) {
      const set = rowsBySection.get(r.section) ?? new Set<string>();
      set.add(r.row);
      rowsBySection.set(r.section, set);
    }

    function computeFallbackXY(
      section: string,
      row: string,
      seatNumber: string,
    ): { x: number; y: number } {
      const sectionIndex = sectionOrder.indexOf(section);
      const rowList = Array.from(rowsBySection.get(section) ?? new Set<string>())
        .sort((a, b) => a.localeCompare(b));
      const rowIndex = rowList.indexOf(row);
      const seatIdx = Math.max(0, parseInt(seatNumber, 10) - 1);

      // 이전 섹션들의 누적 높이
      let baseY = 0;
      for (let i = 0; i < sectionIndex; i += 1) {
        const rowsInPrev = (rowsBySection.get(sectionOrder[i]) ?? new Set()).size;
        baseY += rowsInPrev * SEAT_SIZE + SECTION_GAP;
      }

      const x = seatIdx * SEAT_SIZE + SEAT_SIZE / 2;
      const y = baseY + rowIndex * SEAT_SIZE + SEAT_SIZE / 2;
      return { x, y };
    }

    // 구역별 집계 (이름 → bounding box + tier 정보)
    const sectionMap = new Map<
      string,
      {
        xs: number[];
        ys: number[];
        capacity: number;
        tierColorCounts: Map<string, number>;
        tierNameCounts: Map<string, number>;
        tierPriceCounts: Map<number, number>;
        tierSaleModeCounts: Map<string, number>;
      }
    >();

    for (const row of rows) {
      const entry =
        sectionMap.get(row.section) ??
        {
          xs: [] as number[],
          ys: [] as number[],
          capacity: 0,
          tierColorCounts: new Map<string, number>(),
          tierNameCounts: new Map<string, number>(),
          tierPriceCounts: new Map<number, number>(),
          tierSaleModeCounts: new Map<string, number>(),
        };

      const x = row.x !== null && Number.isFinite(row.x)
        ? row.x
        : computeFallbackXY(row.section, row.row, row.seatNumber).x;
      const y = row.y !== null && Number.isFinite(row.y)
        ? row.y
        : computeFallbackXY(row.section, row.row, row.seatNumber).y;

      entry.xs.push(x);
      entry.ys.push(y);
      entry.capacity += 1;
      if (row.tierColor) {
        entry.tierColorCounts.set(row.tierColor, (entry.tierColorCounts.get(row.tierColor) ?? 0) + 1);
      }
      if (row.tierName) {
        entry.tierNameCounts.set(row.tierName, (entry.tierNameCounts.get(row.tierName) ?? 0) + 1);
      }
      if (row.tierPrice) {
        const price = Number(row.tierPrice);
        entry.tierPriceCounts.set(price, (entry.tierPriceCounts.get(price) ?? 0) + 1);
      }
      if (row.tierSaleMode) {
        entry.tierSaleModeCounts.set(
          row.tierSaleMode,
          (entry.tierSaleModeCounts.get(row.tierSaleMode) ?? 0) + 1,
        );
      }
      sectionMap.set(row.section, entry);
    }

    function dominant<T>(map: Map<T, number>, fallback: T): T {
      let best = fallback;
      let max = 0;
      for (const [k, v] of map.entries()) {
        if (v > max) {
          max = v;
          best = k;
        }
      }
      return best;
    }

    const sections: GridSectionPayload[] = Array.from(sectionMap.entries()).map(
      ([name, info]) => {
        const minX = Math.min(...info.xs);
        const maxX = Math.max(...info.xs);
        const minY = Math.min(...info.ys);
        const maxY = Math.max(...info.ys);
        return {
          name,
          center_x: (minX + maxX) / 2,
          center_y: (minY + maxY) / 2,
          width: Math.max(maxX - minX, 30),
          height: Math.max(maxY - minY, 30),
          capacity: info.capacity,
          color_hex: dominant(info.tierColorCounts, "#6C5CE7"),
          kind: "assigned",
          rotation: 0,
          tier_name: info.tierNameCounts.size > 0 ? dominant(info.tierNameCounts, "") : null,
          tier_price: dominant(info.tierPriceCounts, 0),
          // canonical 정규화 후 송신(위와 동일 계약). (감사 P1-17)
          sale_mode: toCanonicalSaleMode(dominant(info.tierSaleModeCounts, "fixed_fcfs")),
        };
      },
    );

    const payload = { eventId, sections };
    return await postGridLayout(baseUrl, secret, payload, eventId);
  } catch (err: unknown) {
    logger.warn("v2 격자 배치도 동기화 에러", {
      eventId,
      error: err instanceof Error ? err.message : "알 수 없는 오류",
    });
    return false;
  }
}

async function postGridLayout(
  baseUrl: string,
  secret: string,
  payload: { eventId: string; sections: GridSectionPayload[] },
  eventId: string,
): Promise<boolean> {
  const url = `${baseUrl.replace(/\/$/, "")}${V2_SYNC_PATH}`;
  const timestamp = new Date().toISOString();
  const deliveryId = crypto.randomUUID();
  const body = JSON.stringify(payload);
  const signature = sign(secret, timestamp, body);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Pickket-Signature": signature,
      "X-Pickket-Timestamp": timestamp,
      "X-Pickket-Event": "grid-layout.sync",
      "X-Pickket-Delivery-Id": deliveryId,
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });

  if (res.ok) {
    logger.info("v2 격자 배치도 동기화 성공", {
      eventId,
      deliveryId,
      sections: payload.sections.length,
    });
    return true;
  }

  logger.warn("v2 격자 배치도 동기화 실패", {
    eventId,
    deliveryId,
    status: res.status,
    body: await res.text().catch(() => ""),
  });
  return false;
}
