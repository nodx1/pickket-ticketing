import { z } from "zod";
import { withAuth } from "@/lib/auth/withAuth";
import { successResponse, errorResponse } from "@/lib/apiResponse";
import { requireFeature } from "@/lib/server/require-feature";
import { ERR } from "@/lib/errors";
// ── 레벨2 컷오버 W5-SUPPORT: go `final_call_rules` → v2 `final_call_rules`(신설). ──
// ⚠️ v2 에 이미 있는 `final_calls`(FinalCall)는 확정된 **실행 인스턴스**(할인가·오픈일시·status)라
//    이 **규칙 설정**(발동시점·할인율·최소잔여율)과 1:1 이 아니다 → 재사용 금지, 별도 신설.
// 테넌트 경계(옛 `AND account_id = $2`)는 v2 `events.organizer_id` 가 강제한다.
import {
  getFinalCallRule,
  putFinalCallRule,
  type FinalCallRuleRow,
  V2CommerceError,
} from "@/lib/v2/commerce-client";

type Params = { eventId: string };

// GET/PUT 응답을 프론트 계약(camelCase)으로 정규화.
// ⚠️ 여기 기본값은 v2 가 "설정 없음(configured:false)"을 **확정**했을 때만 쓰인다.
//    조회 실패는 예외로 갈라져 503 이 되므로 장애가 기본값으로 위장되지 않는다.
function toConfig(row: FinalCallRuleRow) {
  return {
    isActive: row.is_active,
    triggerHoursBefore: row.trigger_hours_before,
    discountPercent: row.discount_percent,
    minRemainingPercent: row.min_remaining_percent,
    maxDiscountTickets: row.max_discount_tickets,
    notifyBuyers: row.notify_buyers,
  };
}

export const GET = withAuth<Params>(async (_request, { session, params }) => {
  const { eventId } = await params;
  const featureBlock = await requireFeature(eventId, session.accountId, "final_call");
  if (featureBlock) return featureBlock;
  try {
    const result = await getFinalCallRule(eventId, session.accountId);
    return successResponse(toConfig(result.rule));
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      if (err.status === 404) return errorResponse(ERR.NOT_FOUND, 404);
      return errorResponse("파이널콜 설정을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    throw err;
  }
});

// 프론트 입력 경계(할인율 5~80% 등)를 API 에서도 강제 — 직접 호출로 음수/과대값 주입 차단.
// 프론트가 항상 전체 config 를 보내지만, 부분 전송에도 기존 기본값 동작을 보존하려 optional 유지.
const putSchema = z.object({
  isActive: z.boolean().optional(),
  triggerHoursBefore: z.number().int().min(1).max(720).optional(),
  discountPercent: z.number().int().min(5).max(80).optional(),
  minRemainingPercent: z.number().int().min(0).max(90).optional(),
  maxDiscountTickets: z.number().int().min(1).nullable().optional(),
  notifyBuyers: z.boolean().optional(),
});

export const PUT = withAuth<Params>(async (request, { session, params }) => {
  const { eventId } = await params;
  const featureBlock = await requireFeature(eventId, session.accountId, "final_call");
  if (featureBlock) return featureBlock;

  let body: z.infer<typeof putSchema>;
  try {
    body = putSchema.parse(await request.json());
  } catch (err: unknown) {
    if (err instanceof z.ZodError) return errorResponse(err.issues[0]?.message ?? ERR.INVALID_INPUT, 400);
    return errorResponse(ERR.INVALID_INPUT, 400);
  }

  // 이벤트당 1행 upsert — 옛 `ON CONFLICT (event_id)` 동등(v2 uq_final_call_rules_event).
  try {
    const saved = await putFinalCallRule(eventId, {
      organizer_ref: session.accountId,
      is_active: body.isActive ?? false,
      trigger_hours_before: body.triggerHoursBefore ?? 24,
      discount_percent: body.discountPercent ?? 30,
      min_remaining_percent: body.minRemainingPercent ?? 20,
      max_discount_tickets: body.maxDiscountTickets ?? null,
      notify_buyers: body.notifyBuyers ?? true,
    });
    return successResponse(toConfig(saved.rule));
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      // 🔴 저장 실패를 200 으로 흘리면 주최자는 할인 규칙이 켜진 줄 안다.
      if (err.status === 404) return errorResponse(ERR.NOT_FOUND, 404);
      return errorResponse("파이널콜 설정을 저장하지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    throw err;
  }
});
