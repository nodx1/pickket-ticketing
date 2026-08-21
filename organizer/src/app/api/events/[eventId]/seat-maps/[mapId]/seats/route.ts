/**
 * 빌더 좌석 목록/상태변경 — 레벨2 컷오버 T1: go `seats`/`seat_maps` 미사용.
 *
 * ── 좌석 id 계약 변경 ──
 * 이전엔 go `seats.id`(uuid)가 좌석 식별자였고 v2 호출 때마다 `v2_seat_id` 앵커를 되짚었다.
 * go 좌석이 사라지면서 **v2 canonical seat_id 가 정본 id** 가 된다(응답 `id` = v2 seat_id).
 * 앵커 조회가 통째로 사라지므로 "미앵커라 변경 불가(409)" 분기도 함께 없어진다.
 */
import { z } from "zod";
import { errorResponse, listResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { getPool } from "@/lib/db/pool";
import {
  blockSeats,
  unblockSeats,
  upsertSeats,
  V2CommerceError,
  type SeatUpsertInput,
} from "@/lib/v2/commerce-client";
import { pushGridLayoutToV2 } from "@/lib/v2/grid-layout-sync";
import { computeCapacity, persistCapacity } from "@/lib/seats/capacity";
import { generateSeatsFromCanvas, type SeatMapCanvas } from "@/lib/seats/seat-generator";
import { EventAccessError } from "@/lib/v2/event-access";
import { fetchSeatMapEntry } from "@/lib/v2/seat-map-payload";
import { fetchV2SeatLiveMap } from "@/lib/seats/v2-status";

type Params = { eventId: string; mapId: string };

const schema = z
  .object({
    seatIds: z.array(z.string().uuid()).min(1, "좌석을 선택해주세요"),
    status: z.enum(["available", "blocked"]).optional(),
    tierId: z.string().uuid().nullable().optional(),
  })
  .refine((b) => b.status !== undefined || b.tierId !== undefined, {
    message: "status 또는 tierId 중 하나는 필요합니다",
  });

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET = withRole<Params>("staff", async (request, { session, params }) => {
  // mapId 가 "undefined" 등 잘못 들어오면 즉시 400
  if (!params.mapId || !UUID_RE.test(params.mapId)) {
    return errorResponse("잘못된 좌석맵 ID 입니다", 400);
  }
  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const pool = getPool();

  // 소유권 + 맵 존재 확인은 v2 seat_map_data(SoT) 기준.
  let owned: Awaited<ReturnType<typeof fetchSeatMapEntry>>;
  let live: Awaited<ReturnType<typeof fetchV2SeatLiveMap>> | null = null;
  try {
    owned = await fetchSeatMapEntry(pool, params.eventId, params.mapId, session.accountId);
    if (owned) live = await fetchV2SeatLiveMap(owned.v2EventId);
  } catch (err: unknown) {
    // 🔴 레벨2 T2-EVT — fetchSeatMapEntry 의 소유 검증이 v2 조회로 바뀌면서 v2 응답불가는
    //    EventAccessError 로 온다(안 잡으면 정체불명 500). 404(없음)와 분리해 503 으로.
    if (err instanceof EventAccessError) {
      return errorResponse("이벤트 정보를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    if (err instanceof V2CommerceError) {
      return errorResponse("좌석 목록을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.", 502);
    }
    throw err;
  }
  if (!owned || !live) {
    return errorResponse("좌석맵을 찾을 수 없습니다", 404);
  }

  // 좌석 구조·상태·좌표 모두 v2 커머스 SoT. 빌더는 이벤트당 활성 맵 1개 계약이라
  // 이벤트 좌석 전량을 이 맵의 좌석으로 투영한다(go seat_map_id 필터 불가·불필요).
  const rows = [...live.byGoSeatId.values()]
    .map((s) => ({
      id: s.seatId,
      externalRef: s.externalRef,
      section: s.section,
      row: s.row,
      seatNumber: s.seatNumber,
      status: s.status,
      productId: null,
      tierId: s.tierId,
      x: s.x,
      y: s.y,
      label: s.label,
      isObstructed: s.isObstructed,
      qualityScore: s.qualityScore,
    }))
    .sort(
      (a, b) =>
        a.section.localeCompare(b.section) ||
        a.row.localeCompare(b.row) ||
        (Number(a.seatNumber) || 0) - (Number(b.seatNumber) || 0),
    );

  const filtered = status ? rows.filter((r) => r.status === status) : rows;
  return listResponse(filtered, filtered.length);
});

export const PATCH = withRole<Params>("organizer", async (request, { session, params }) => {
  if (!params.mapId || !UUID_RE.test(params.mapId)) {
    return errorResponse("잘못된 좌석맵 ID 입니다", 400);
  }
  try {
    const body = schema.parse(await request.json());
    const pool = getPool();

    // 소유권 + 맵(캔버스) + 좌석 live 를 v2 에서 한 번에 확보.
    const owned = await fetchSeatMapEntry(pool, params.eventId, params.mapId, session.accountId);
    if (!owned) {
      return errorResponse("좌석맵을 찾을 수 없습니다", 404);
    }
    const v2EventId = owned.v2EventId;
    const live = await fetchV2SeatLiveMap(v2EventId);

    // 요청 seatIds(= v2 seat_id) → live 행. 존재하지 않거나 판매중지(reserved)인 좌석은 제외
    // (기존 동작: go status <> 'reserved' 필터. v2 도 SOLD/HELD 는 어차피 409).
    const bySeatId = new Map([...live.byGoSeatId.values()].map((s) => [s.seatId, s]));
    const targets = body.seatIds
      .map((id) => bySeatId.get(id))
      .filter((s): s is NonNullable<typeof s> => Boolean(s) && s!.status !== "reserved");
    if (targets.length === 0) {
      return errorResponse("변경 가능한 좌석이 없습니다", 400);
    }

    // ── 1) status 변경 (available/blocked) → v2 block/unblock ──
    //   빌더 'blocked' = v2 RESERVED(판매중지). 'available' = unblock(RESERVED→AVAILABLE).
    if (body.status !== undefined) {
      const seatIds = targets.map((s) => s.seatId);
      if (body.status === "blocked") {
        await blockSeats({ event_id: v2EventId, seat_ids: seatIds });
      } else {
        await unblockSeats({ event_id: v2EventId, seat_ids: seatIds });
      }
    }

    // ── 2) tier 배정 변경 → v2 upsertSeats(external_ref 멱등 upsert) ──
    //   seat_tiers.v2_tier_id 앵커로 v2 canonical tier_id 해석(티어는 아직 go 저장소 — 3.1 범위 밖).
    //   ⚠️ 좌표/라벨을 같이 실어 보내야 v2 가 기본값(0.0)으로 덮어써 파괴하지 않는다.
    if (body.tierId !== undefined) {
      let v2TierId: string | null = null;
      if (body.tierId !== null) {
        const { rows: tierRows } = await pool.query<{ v2_tier_id: string | null }>(
          `SELECT v2_tier_id FROM seat_tiers WHERE id = $1 AND event_id = $2 LIMIT 1`,
          [body.tierId, params.eventId],
        );
        v2TierId = tierRows[0]?.v2_tier_id ?? null;
        if (!v2TierId) {
          return errorResponse("선택한 등급이 v2 에 연동되지 않아 배정할 수 없습니다", 409);
        }
      }
      const seats: SeatUpsertInput[] = targets.map((s) => ({
        external_ref: s.externalRef, // 결정적 좌석키 — 멱등 upsert
        tier_id: v2TierId,
        section: s.section,
        row_number: Number(s.row) || 0,
        seat_number: Number(s.seatNumber) || 0,
        ...(s.x != null ? { x: s.x } : {}),
        ...(s.y != null ? { y: s.y } : {}),
        label: s.label,
        is_obstructed: s.isObstructed,
        ...(s.qualityScore != null ? { quality_score: s.qualityScore } : {}),
      }));
      await upsertSeats(v2EventId, seats);
    }

    // tierId 배정 시 & 현재 배치도가 published 면 v2 grid-layout 색상 갱신
    if (body.tierId !== undefined && owned.entry.status === "published") {
      void pushGridLayoutToV2(params.eventId);
    }

    // 좌석 상태 변경(blocked 토글) 시 events.max_attendees 재산출.
    // 산출(v2 read)은 트랜잭션 밖, 반영(go write)만 짧은 트랜잭션 — 외부호출을 경계 안에 넣지 않는다.
    if (body.status !== undefined) {
      const layout = generateSeatsFromCanvas(
        params.mapId,
        (owned.entry.map_data ?? null) as SeatMapCanvas | null,
      );
      const computed = await computeCapacity(pool, params.eventId, layout);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await persistCapacity(client, params.eventId, session.accountId, computed);
        await client.query("COMMIT");
      } catch (err: unknown) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    }

    return successResponse({ updated: true });
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      return errorResponse(error.issues[0]?.message ?? "입력값을 확인해주세요", 400);
    }
    // 🔴 레벨2 T2-EVT — 소유 확인 불가(v2 응답불가)는 아래 400 폴백으로 흘리면 "입력이 잘못됐다"는
    //    오진이 된다. 재시도 가능한 503 으로 분리한다(좌석 상태 변경은 미적용 — fail-closed).
    if (error instanceof EventAccessError) {
      return errorResponse("이벤트 정보를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    // v2 write-through 실패는 swallow 하지 않고 상태코드 전파(미러 아님).
    if (error instanceof V2CommerceError) {
      const status = error.status >= 400 && error.status < 500 ? error.status : 502;
      return errorResponse(error.message || "좌석 상태를 변경하지 못했습니다", status);
    }
    return errorResponse("좌석 상태를 변경하지 못했습니다", 400);
  }
});
