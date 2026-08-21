import { z } from "zod";
import { errorResponse, listResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { ERR } from "@/lib/errors";
// ── 레벨2 컷오버 W5-SUPPORT: go `capacity_assignments` → v2 `capacity_assignments`(신설). ──
// 테넌트 경계(옛 `capacity_assignments.account_id = $1`)는 v2 `events.organizer_id` 가 강제.
// 옛 `INNER JOIN products` 상품명은 v2 가 `seat_tiers.external_ref` 로 **OUTER** 조인해 붙인다
// (INNER 였다면 미동기화 티어의 배정 행이 목록에서 조용히 사라진다).
import {
  listCapacityAssignments,
  listTiers,
  upsertCapacityAssignment,
  V2CommerceError,
} from "@/lib/v2/commerce-client";
import { EventAccessError, resolveOwnedV2EventId } from "@/lib/v2/event-access";

type Params = { eventId: string };

const schema = z.object({
  productId: z.string().uuid(),
  capacity: z.number().int().positive(),
});

export const GET = withRole<Params>("organizer", async (_request, { session, params }) => {
  try {
    const result = await listCapacityAssignments(params.eventId, session.accountId);
    // 응답 계약(camelCase) 유지. productId = go product id(= v2 tier external_ref).
    const rows = result.assignments.map((a) => ({
      id: a.id,
      productId: a.product_ref,
      capacity: a.capacity,
      usedCapacity: a.used_capacity,
      status: a.status,
      productName: a.product_name,
    }));
    return listResponse(rows, rows.length);
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      // 🔴 빈 배열 폴백 금지 — "배정 없음"으로 오독되면 주최자가 용량을 다시 배정해 덮어쓴다.
      if (err.status === 404) return errorResponse("이벤트를 찾을 수 없습니다", 404);
      return errorResponse("용량 배정을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    throw err;
  }
});

export const POST = withRole<Params>("organizer", async (request, { session, params }) => {
  try {
    const body = schema.parse(await request.json());

    // ── used_capacity 시드: DROP 대상 order_items 집계 → v2 tiers live read(sold_count)로 교체. ──
    // 레벨2 컷오버 T2-EVT — go events 앵커 조회 폐기(go event id == v2 event id).
    // 테넌트 경계는 이제 v2 가 강제한다(organizer_ref 불일치 → not found).
    // sold_count 는 환불 제외 판매 SoT(좌석 존재 시 좌석 집계, GA 는 tier.sold_count).
    const v2EventId = await resolveOwnedV2EventId(params.eventId, session.accountId);
    if (!v2EventId) {
      // 없거나 내 계정 소유 아님 = v2 커머스 정본 미연결 → 정확한 used_capacity 산출 불가. 오설정 방지로 거부.
      return errorResponse("이벤트가 아직 커머스(v2)에 연결되지 않았습니다", 409);
    }
    let usedCapacity = 0;
    try {
      const tierList = await listTiers(v2EventId);
      const tier = tierList.tiers.find((t) => t.external_ref === body.productId);
      usedCapacity = tier?.sold_count ?? 0;
    } catch (err: unknown) {
      // V2CommerceError 는 전파(미러 swallow 금지) — 잘못된 used_capacity 시드를 막는다.
      if (err instanceof V2CommerceError) {
        return errorResponse(`판매 수량 조회에 실패했습니다 (v2: ${err.message})`, 502);
      }
      throw err;
    }

    // (event_id, product_ref) 유니크 upsert — 옛 `ON CONFLICT (event_id, product_id)` 동등.
    const saved = await upsertCapacityAssignment(params.eventId, {
      organizer_ref: session.accountId,
      product_ref: body.productId,
      capacity: body.capacity,
      used_capacity: usedCapacity,
    });
    return successResponse({ id: saved.id });
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(ERR.INVALID_INPUT, 400);
    }
    // v2 장애로 소유 확인 자체가 불가한 경우 — 아래 500(서버 오류)로 흘리지 않고 재시도 가능 신호(503).
    if (err instanceof EventAccessError) {
      return errorResponse("이벤트 정보를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    // 🔴 저장 실패를 500(서버 오류)로 뭉개지 않는다 — 저장되지 않았음을 재시도 가능 신호로 알린다.
    if (err instanceof V2CommerceError) {
      if (err.status === 404) return errorResponse("이벤트를 찾을 수 없습니다", 404);
      return errorResponse("용량 배정을 저장하지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    return errorResponse(ERR.SERVER, 500);
  }
});
