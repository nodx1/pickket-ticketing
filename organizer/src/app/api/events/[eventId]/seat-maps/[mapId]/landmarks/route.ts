/**
 * 트랙 2.6 / 레벨2 3차 3.1 — 좌석맵 랜드마크 CRUD (v2 seat_map_data SoT, go 미write/미read)
 *
 * GET    — v2 seat_map_data.maps[].landmarks 에서 read.
 * POST   — 단일 생성(v2 landmarks 에 append delta, id 는 route 가 발급).
 * PATCH  — 일괄 upsert(빌더 저장, v2 landmarks 전체 교체 delta).
 * DELETE — id 로 단일 제거(v2 landmarks remove delta).
 *
 * ★ go seat_map_landmarks 테이블 write/read 제거(3.1 go DROP 관문). 소유권도 v2 event 기반 검증.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { errorResponse, listResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { getPool } from "@/lib/db/pool";
import { verifySeatMapOwnershipV2 } from "@/lib/seats/ownership";
import { getEvent, V2CommerceError } from "@/lib/v2/commerce-client";
import { EventAccessError } from "@/lib/v2/event-access";
import { pushSeatMapData, resolveV2EventIdFor } from "@/lib/v2/seat-map-payload";

type Params = { eventId: string; mapId: string };

/**
 * 🔴 레벨2 T2-EVT — 소유 검증(resolveV2EventIdFor / verifySeatMapOwnershipV2)이 go `events` 조회에서
 * v2 `organizer_ref` 조회로 바뀌면서 **v2 응답불가는 `EventAccessError(unavailable)`** 로 온다.
 * 잡지 않으면 정체불명 500, 404 로 뭉개면 재시도 가능한 장애가 "없음"으로 보인다 → 503 으로 분리한다.
 */
const UNAVAILABLE_MESSAGE =
  "이벤트 정보를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LandmarkType = z.enum([
  "stage",
  "aisle",
  "exit",
  "restroom",
  "vip_lounge",
  "wheelchair",
  "custom",
]);

const landmarkSchema = z.object({
  id: z.string().uuid().optional(),
  type: LandmarkType,
  label: z.string().nullable().optional(),
  x: z.number(),
  y: z.number(),
  width: z.number().min(0).optional(),
  height: z.number().min(0).optional(),
  rotation: z.number().optional(),
  colorHex: z.string().nullable().optional(),
});

const bulkUpsertSchema = z.object({
  landmarks: z.array(landmarkSchema),
});

/** 입력 landmark → v2 계약 shape(id 포함). */
function toEntry(lm: z.infer<typeof landmarkSchema>, id: string) {
  return {
    id,
    type: lm.type,
    label: lm.label ?? null,
    x: lm.x,
    y: lm.y,
    width: lm.width ?? 80,
    height: lm.height ?? 40,
    rotation: lm.rotation ?? 0,
    color_hex: lm.colorHex ?? null,
    metadata: {},
  };
}

/** v2 계약 landmark → GET/POST 응답 shape(빌더 소비). */
function toResponse(e: {
  id?: string;
  type: string;
  label: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  color_hex: string | null;
}) {
  return {
    id: e.id ?? null,
    type: e.type,
    label: e.label,
    x: e.x,
    y: e.y,
    width: e.width,
    height: e.height,
    rotation: e.rotation,
    colorHex: e.color_hex,
  };
}

export const GET = withRole<Params>("staff", async (_request, { session, params }) => {
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
    const rows = (entry.landmarks ?? []).map(toResponse);
    return listResponse(rows, rows.length);
  } catch (err: unknown) {
    if (err instanceof EventAccessError) {
      return errorResponse(UNAVAILABLE_MESSAGE, 503);
    }
    if (err instanceof V2CommerceError) {
      return errorResponse("랜드마크를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.", 502);
    }
    throw err;
  }
});

export const POST = withRole<Params>(
  "organizer",
  async (request, { session, params }) => {
    if (!UUID_RE.test(params.mapId)) {
      return errorResponse("잘못된 좌석맵 ID 입니다", 400);
    }
    try {
      if (!(await verifySeatMapOwnershipV2(params.eventId, params.mapId, session.accountId))) {
        return errorResponse("좌석맵을 찾을 수 없습니다", 404);
      }
      const body = landmarkSchema.parse(await request.json());
      const id = body.id ?? randomUUID();
      const entry = toEntry(body, id);
      // 레벨2 3차 3.1 — v2 seat_map_data.maps[].landmarks 에 단일 append(go write 없음).
      await pushSeatMapData(getPool(), params.eventId, session.accountId, {
        patchMap: { id: params.mapId, appendLandmark: entry },
      });
      return successResponse(toResponse(entry));
    } catch (err: unknown) {
      if (err instanceof z.ZodError) {
        return errorResponse(err.issues[0]?.message ?? "입력값 오류", 400);
      }
      // v2 응답불가 = 소유 확인 자체가 불가. 아래 400 폴백으로 흘리면 "입력이 잘못됐다"는 오진이 된다.
      if (err instanceof EventAccessError) {
        return errorResponse(UNAVAILABLE_MESSAGE, 503);
      }
      if (err instanceof V2CommerceError) {
        return errorResponse("좌석 배치도 동기화에 실패했습니다. 잠시 후 다시 시도해주세요.", 502);
      }
      return errorResponse("랜드마크 생성 실패", 400);
    }
  },
);

export const PATCH = withRole<Params>(
  "organizer",
  async (request, { session, params }) => {
    if (!UUID_RE.test(params.mapId)) {
      return errorResponse("잘못된 좌석맵 ID 입니다", 400);
    }
    try {
      if (!(await verifySeatMapOwnershipV2(params.eventId, params.mapId, session.accountId))) {
        return errorResponse("좌석맵을 찾을 수 없습니다", 404);
      }
      const body = bulkUpsertSchema.parse(await request.json());
      const landmarks = body.landmarks.map((lm) => toEntry(lm, lm.id ?? randomUUID()));
      // 레벨2 3차 3.1 — v2 seat_map_data.maps[].landmarks 전체 교체(빌더 최종 리스트 통째, go write 없음).
      await pushSeatMapData(getPool(), params.eventId, session.accountId, {
        patchMap: { id: params.mapId, landmarks },
      });
      return successResponse({ updated: landmarks.length });
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
      return errorResponse("랜드마크 저장 실패", 400);
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
      // 레벨2 3차 3.1 — v2 seat_map_data.maps[].landmarks 에서 id 로 단일 제거(go write 없음).
      await pushSeatMapData(getPool(), params.eventId, session.accountId, {
        patchMap: { id: params.mapId, removeLandmarkId: id },
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
