import { z } from "zod";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { getPool } from "@/lib/db/pool";
import {
  deleteAffiliate,
  getAffiliateDetail,
  patchAffiliate,
  V2CommerceError,
} from "@/lib/v2/commerce-client";
import { EventAccessError, resolveOwnedV2EventId } from "@/lib/v2/event-access";

type Params = { eventId: string; affiliateId: string };

const schema = z.object({
  name: z.string().min(2).optional(),
  commissionRate: z.number().min(0).max(100).optional(),
  status: z.enum(["active", "inactive"]).optional(),
});

export const GET = withRole<Params>("staff", async (_request, { session, params }) => {
  const pool = getPool();
  // ── 레벨2 read-flip: 제휴 상세/전환 정본 = v2. go affiliates·affiliate_conversions read 제거. ──
  // ── 레벨2 컷오버 T2-EVT: go events 앵커 조회 제거. 소유격리(옛 `AND account_id`)는
  //    v2 `organizer_ref` 가 강제한다(미소유/부재→null→기존과 동일하게 404).
  let v2EventId: string | null;
  try {
    v2EventId = await resolveOwnedV2EventId(params.eventId, session.accountId);
  } catch (err: unknown) {
    if (err instanceof EventAccessError) {
      return errorResponse("커머스 서버에 연결할 수 없습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    throw err;
  }
  if (!v2EventId) {
    return errorResponse("어필리에이트를 찾을 수 없습니다", 404);
  }

  let detail;
  try {
    detail = await getAffiliateDetail(v2EventId, params.affiliateId);
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      // v2 AFFILIATE_NOT_FOUND(404) 포함 — 소유/존재 실패는 404 로 통일.
      if (err.status === 404) {
        return errorResponse("어필리에이트를 찾을 수 없습니다", 404);
      }
      return errorResponse("어필리에이트를 불러오지 못했습니다", 502);
    }
    throw err;
  }

  // 표시용 주문번호만 go orders 앵커에서 배치 매핑(order_ref = go order id).
  const orderRefs = detail.conversions
    .map((c) => c.order_ref)
    .filter((r): r is string => Boolean(r));
  const orderNumberByRef = new Map<string, string>();
  if (orderRefs.length > 0) {
    const { rows } = await pool.query<{ id: string; order_number: string }>(
      `SELECT id, order_number FROM orders WHERE id = ANY($1::uuid[])`,
      [orderRefs],
    );
    for (const r of rows) orderNumberByRef.set(r.id, r.order_number);
  }

  return successResponse({
    id: detail.affiliate.external_ref ?? detail.affiliate.affiliate_id,
    name: detail.affiliate.name,
    code: detail.affiliate.code,
    commissionRate: detail.affiliate.commission_rate,
    status: detail.affiliate.status,
    createdAt: detail.affiliate.created_at,
    conversions: detail.conversions.map((c) => ({
      id: c.id,
      orderNumber: c.order_ref ? (orderNumberByRef.get(c.order_ref) ?? null) : null,
      orderAmount: c.order_amount,
      commissionAmount: c.commission_amount,
      createdAt: c.created_at,
    })),
  });
});

export const PATCH = withRole<Params>("organizer", async (request, { session, params }) => {
  try {
    const body = schema.parse(await request.json());
    // 소유격리 + v2 앵커. ── 레벨2 컷오버 T2-EVT: go events 조회 제거, 옛 `AND account_id`
    // 테넌트 경계는 v2 `organizer_ref` 가 강제(미소유/부재 → null → 기존과 동일하게 404).
    const v2EventId = await resolveOwnedV2EventId(params.eventId, session.accountId);
    if (!v2EventId) {
      return errorResponse("어필리에이트를 찾을 수 없습니다", 404);
    }

    // ── W5-SUPPORT: go 앵커 read(존재확인) + go UPDATE 미러 + 보상 롤백을 모두 제거. ──
    // 존재/미소유 판정은 v2 patch 가 404 로 직접 알려준다. 원장이 하나뿐이라 미러 실패도,
    // 되돌릴 "이전 값" 스냅샷도 필요 없다(부분 성공 상태 자체가 사라졌다).
    try {
      await patchAffiliate(v2EventId, params.affiliateId, {
        name: body.name,
        commission_rate: body.commissionRate,
        status: body.status,
      });
    } catch (err: unknown) {
      if (err instanceof V2CommerceError) {
        if (err.status === 404) {
          return errorResponse("어필리에이트를 찾을 수 없습니다", 404);
        }
        return errorResponse(
          "어필리에이트 수정 중 커머스 동기화에 실패했습니다. 잠시 후 다시 시도해주세요.",
          502,
        );
      }
      throw err;
    }
    return successResponse({ updated: true });
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      return errorResponse(error.issues[0]?.message ?? "입력값을 확인해주세요", 400);
    }
    // 광범위 catch 가 400 으로 뭉개므로 v2 장애만 명시 분기(입력값 문제로 오인 금지).
    if (error instanceof EventAccessError) {
      return errorResponse("커머스 서버에 연결할 수 없습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    return errorResponse("어필리에이트를 수정하지 못했습니다", 400);
  }
});

export const DELETE = withRole<Params>("organizer", async (_request, { session, params }) => {
  // ── 레벨2 컷오버 T2-EVT: go events 앵커 조회 제거. 옛 `AND account_id` 테넌트 경계는
  //    v2 `organizer_ref` 가 강제(미소유/부재 → null → 기존과 동일하게 404).
  let v2EventId: string | null;
  try {
    v2EventId = await resolveOwnedV2EventId(params.eventId, session.accountId);
  } catch (err: unknown) {
    if (err instanceof EventAccessError) {
      return errorResponse("커머스 서버에 연결할 수 없습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    throw err;
  }
  if (!v2EventId) {
    return errorResponse("어필리에이트를 찾을 수 없습니다", 404);
  }

  // ── W5-SUPPORT: go 앵커 상태조회 + go soft-delete 미러 + 보상 롤백 제거. ──
  // 🔴 "조회 실패 → 이미 없음 → 200 deleted" 로 흡수하지 않는다. v2 가 404 를 준 경우에만
  //    404, 그 밖의 장애는 **삭제되지 않았다**는 뜻이므로 502 로 끊는다.
  // v2 는 soft-delete(status=inactive) — 수수료 증빙(conversions)은 계속 조회 가능하다.
  try {
    await deleteAffiliate(v2EventId, params.affiliateId);
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      if (err.status === 404) {
        return errorResponse("어필리에이트를 찾을 수 없습니다", 404);
      }
      return errorResponse(
        "어필리에이트 삭제 중 커머스 동기화에 실패했습니다. 잠시 후 다시 시도해주세요.",
        502,
      );
    }
    throw err;
  }
  return successResponse({ deleted: true, softDeleted: true });
});
