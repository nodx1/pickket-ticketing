/**
 * 트랙 2.11 / 레벨2 3차 3.1 — 단일 버전 조회 (복원 시 snapshot 로딩, v2 seat_map_data SoT)
 *
 * ★ go seat_map_versions 미read — v2 seat_map_data.maps[].versions 에서 version 번호로 조회.
 *   3.1 에서 버전 식별자는 version 번호(정수). versionId 경로는 그 정수 문자열.
 */
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { getPool } from "@/lib/db/pool";
import { getEvent, V2CommerceError } from "@/lib/v2/commerce-client";
import { EventAccessError } from "@/lib/v2/event-access";
import { resolveV2EventIdFor } from "@/lib/v2/seat-map-payload";

type Params = { eventId: string; mapId: string; versionId: string };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET = withRole<Params>(
  "staff",
  async (_request, { session, params }) => {
    if (!UUID_RE.test(params.mapId)) {
      return errorResponse("잘못된 ID 입니다", 400);
    }
    const versionNum = Number.parseInt(params.versionId, 10);
    if (!Number.isInteger(versionNum) || String(versionNum) !== params.versionId) {
      return errorResponse("잘못된 버전 번호 입니다", 400);
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
      const version = (entry.versions ?? []).find((v) => v.version === versionNum);
      if (!version) {
        return errorResponse("버전을 찾을 수 없습니다", 404);
      }
      return successResponse({
        version: version.version,
        snapshot: version.snapshot,
        note: version.note,
        createdAt: version.created_at,
      });
    } catch (err: unknown) {
      // v2 응답불가 = "없음"이 아니라 "확인 불가" → 404 로 뭉개지 않고 재시도 가능한 503.
      if (err instanceof EventAccessError) {
        return errorResponse("이벤트 정보를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
      }
      if (err instanceof V2CommerceError) {
        return errorResponse("버전을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.", 502);
      }
      throw err;
    }
  },
);
