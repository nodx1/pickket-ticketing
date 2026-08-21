/**
 * 트랙 2.11 / 레벨2 3차 3.1 — 좌석맵 버저닝 (v2 seat_map_data SoT, go 미write/미read)
 *
 * GET  /versions — v2 seat_map_data.maps[].versions 최근 30개.
 * POST /versions — 현재 상태 스냅샷 저장(v2 versions append delta, 30개 유지).
 *
 * ★ go seat_map_versions write/read 제거(3.1 go DROP 관문).
 */
import { z } from "zod";
import { errorResponse, listResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { getPool } from "@/lib/db/pool";
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
  snapshot: z.record(z.string(), z.unknown()),
  note: z.string().max(200).optional(),
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
      const rows = (entry.versions ?? [])
        .slice()
        .sort((a, b) => b.version - a.version)
        .slice(0, 30)
        .map((v) => ({
          version: v.version,
          note: v.note,
          createdAt: v.created_at,
        }));
      return listResponse(rows, rows.length);
    } catch (err: unknown) {
      if (err instanceof EventAccessError) {
        return errorResponse(UNAVAILABLE_MESSAGE, 503);
      }
      if (err instanceof V2CommerceError) {
        return errorResponse("버전 목록을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.", 502);
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
      const body = createSchema.parse(await request.json());

      // 현재 v2 versions 에서 다음 version 번호 계산(go 미read).
      const detail = await getEvent(v2EventId);
      const entry = (detail.content?.seat_map_data?.maps ?? []).find(
        (m) => m.id === params.mapId,
      );
      if (!entry) {
        return errorResponse("좌석맵을 찾을 수 없습니다", 404);
      }
      const maxVersion = (entry.versions ?? []).reduce(
        (max, v) => (v.version > max ? v.version : max),
        0,
      );
      const nextVersion = maxVersion + 1;
      const versionEntry = {
        version: nextVersion,
        note: body.note ?? null,
        snapshot: body.snapshot,
        created_at: new Date().toISOString(),
      };
      // 레벨2 3차 3.1 — v2 seat_map_data.maps[].versions 에 append(applySeatMapDelta 가 30개로 트림).
      await pushSeatMapData(getPool(), params.eventId, session.accountId, {
        patchMap: { id: params.mapId, appendVersion: versionEntry },
      });
      return successResponse({
        version: nextVersion,
        note: body.note ?? null,
        createdAt: versionEntry.created_at,
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
      return errorResponse("버전 저장 실패", 400);
    }
  },
);
