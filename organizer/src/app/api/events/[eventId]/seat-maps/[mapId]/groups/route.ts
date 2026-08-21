/**
 * 트랙 2.12 / 레벨2 3차 3.1 — 좌석 그룹 (v2 seat_map_data SoT, go 미write/미read)
 *
 * GET    /groups — v2 seat_map_data.maps[].groups 에서 read.
 * POST   /groups — 생성(v2 groups append delta, id 는 route 가 발급). seatIds 는 v2 좌석(external_ref) 검증.
 * DELETE /groups?id=... — id 로 v2 groups 단일 제거.
 *
 * ★ go seat_groups / seat_group_members write/read 제거(3.1 go DROP 관문).
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { errorResponse, listResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { getPool } from "@/lib/db/pool";
import { verifySeatMapOwnershipV2 } from "@/lib/seats/ownership";
import { fetchV2SeatStatusMap } from "@/lib/seats/v2-status";
import { getEvent, V2CommerceError } from "@/lib/v2/commerce-client";
import { EventAccessError } from "@/lib/v2/event-access";
import { pushSeatMapData, resolveV2EventIdFor } from "@/lib/v2/seat-map-payload";

type Params = { eventId: string; mapId: string };

/**
 * 🔴 레벨2 T2-EVT — 소유 검증이 go `events` 조회에서 v2 `organizer_ref` 조회로 바뀌면서
 * v2 응답불가는 `EventAccessError(unavailable)` 로 온다. 404(없음)와 섞지 말고 503(재시도 가능)으로.
 */
const UNAVAILABLE_MESSAGE =
  "이벤트 정보를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const createSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum([
    "vip_box",
    "wheelchair",
    "companion",
    "group_ticket",
    "couple",
    "family",
    "custom",
  ]),
  colorHex: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  icon: z.string().max(32).optional(),
  seatIds: z.array(z.string().uuid()).min(1),
});

export const GET = withRole<Params>(
  "staff",
  async (_request, { session, params }) => {
    if (!UUID_RE.test(params.mapId)) {
      return errorResponse("잘못된 좌석맵 ID 입니다", 400);
    }
    const pool = getPool();
    try {
      // 소유 해석도 try 안에서 — v2 장애(EventAccessError)가 밖으로 새면 500 이 된다.
      const v2EventId = await resolveV2EventIdFor(pool, params.eventId, session.accountId);
      if (!v2EventId) {
        return errorResponse("좌석맵을 찾을 수 없습니다", 404);
      }
      const detail = await getEvent(v2EventId);
      const entry = (detail.content?.seat_map_data?.maps ?? []).find(
        (m) => m.id === params.mapId,
      );
      if (!entry) {
        return errorResponse("좌석맵을 찾을 수 없습니다", 404);
      }
      const rows = (entry.groups ?? []).map((g) => ({
        id: g.id ?? null,
        name: g.name,
        type: g.type,
        colorHex: g.color_hex,
        icon: g.icon,
        seatIds: g.seat_refs ?? [],
      }));
      return listResponse(rows, rows.length);
    } catch (err: unknown) {
      if (err instanceof EventAccessError) {
        return errorResponse(UNAVAILABLE_MESSAGE, 503);
      }
      if (err instanceof V2CommerceError) {
        return errorResponse("좌석 그룹을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.", 502);
      }
      throw err;
    }
  },
);

export const POST = withRole<Params>(
  "organizer",
  async (request, { session, params }) => {
    if (!UUID_RE.test(params.mapId)) {
      return errorResponse("잘못된 좌석맵 ID 입니다", 400);
    }
    try {
      const pool = getPool();
      const v2EventId = await resolveV2EventIdFor(pool, params.eventId, session.accountId);
      if (!v2EventId) {
        return errorResponse("좌석맵을 찾을 수 없습니다", 404);
      }
      if (!(await verifySeatMapOwnershipV2(params.eventId, params.mapId, session.accountId))) {
        return errorResponse("좌석맵을 찾을 수 없습니다", 404);
      }
      const body = createSchema.parse(await request.json());

      // seatIds 가 이 이벤트(=맵)의 v2 좌석(external_ref=go seat id)에 속하는지 검증. go seats 미read.
      const { statusByGoSeatId } = await fetchV2SeatStatusMap(v2EventId);
      const mismatched = body.seatIds.filter((sid) => !statusByGoSeatId.has(sid));
      if (mismatched.length > 0) {
        return errorResponse("다른 좌석맵의 좌석이 포함되어 있습니다", 400);
      }

      const id = randomUUID();
      const group = {
        id,
        name: body.name,
        type: body.type,
        color_hex: body.colorHex ?? null,
        icon: body.icon ?? null,
        seat_refs: body.seatIds,
      };
      // 레벨2 3차 3.1 — v2 seat_map_data.maps[].groups 에 단일 append(go write 없음).
      await pushSeatMapData(getPool(), params.eventId, session.accountId, {
        patchMap: { id: params.mapId, appendGroup: group },
      });
      return successResponse({
        id,
        name: body.name,
        type: body.type,
        colorHex: body.colorHex ?? null,
        icon: body.icon ?? null,
        seatIds: body.seatIds,
      });
    } catch (err: unknown) {
      if (err instanceof z.ZodError) {
        return errorResponse(err.issues[0]?.message ?? "입력값 오류", 400);
      }
      // v2 응답불가 = 소유 확인 자체가 불가 → 400(입력 오류)이 아니라 재시도 가능한 503.
      if (err instanceof EventAccessError) {
        return errorResponse(UNAVAILABLE_MESSAGE, 503);
      }
      if (err instanceof V2CommerceError) {
        return errorResponse("좌석 배치도 동기화에 실패했습니다. 잠시 후 다시 시도해주세요.", 502);
      }
      return errorResponse("그룹 생성 실패", 400);
    }
  },
);

export const DELETE = withRole<Params>(
  "organizer",
  async (request, { session, params }) => {
    if (!UUID_RE.test(params.mapId)) {
      return errorResponse("잘못된 좌석맵 ID 입니다", 400);
    }
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    if (!id || !UUID_RE.test(id)) {
      return errorResponse("id 파라미터 필요", 400);
    }
    try {
      if (!(await verifySeatMapOwnershipV2(params.eventId, params.mapId, session.accountId))) {
        return errorResponse("좌석맵을 찾을 수 없습니다", 404);
      }
      // 레벨2 3차 3.1 — v2 seat_map_data.maps[].groups 에서 id 로 단일 제거(go write 없음).
      await pushSeatMapData(getPool(), params.eventId, session.accountId, {
        patchMap: { id: params.mapId, removeGroupId: id },
      });
      return successResponse({ deleted: 1 });
    } catch (err: unknown) {
      // v2 응답불가는 500 으로 흘리지 않는다(재시도 가능한 일시 장애).
      if (err instanceof EventAccessError) {
        return errorResponse(UNAVAILABLE_MESSAGE, 503);
      }
      if (err instanceof V2CommerceError) {
        return errorResponse("좌석 배치도 동기화에 실패했습니다. 잠시 후 다시 시도해주세요.", 502);
      }
      throw err;
    }
  },
);
