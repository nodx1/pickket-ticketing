/**
 * 프로모코드 수정·삭제 — 레벨2 컷오버 **W5-COMMERCE**.
 *
 * `promoId` = v2 canonical discount_code_id(go 앵커 폐기). 값·활성상태·삭제 전부 v2 정본에
 * 직접 반영되므로, 옛 "go 앵커만 바꾸고 v2 는 방치" split-brain(주최자 화면=비활성인데
 * 소비자는 여전히 코드 적용 가능)이 구조적으로 불가능해졌다.
 *
 * ## 삭제 의미
 * v2 는 **소프트 삭제 + is_active=false** 로 처리한다. 행을 지우면 그 코드로 발생한 주문의
 * 사용량 근거가 사라지고, is_active 를 함께 끄지 않으면 삭제한 코드가 주문 경로에서 계속
 * 먹는다(주문 생성은 is_active 만 본다). 두 가지를 v2 가 한 트랜잭션에서 처리한다.
 *
 * 🔴 404 를 "이미 없음 → 성공"으로 흡수하지 않는다. 조회 실패(5xx)와 구분되지 않으면
 *    "지우지 않은 것을 지웠다"고 응답하게 된다.
 */
import { z } from "zod";
import { toIsoFromKstLocal } from "@/lib/datetime/kst-local";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { ERR } from "@/lib/errors";
import {
  V2CommerceError,
  deletePromoCode,
  patchPromoCode,
  type PromoCodePatchInput,
} from "@/lib/v2/commerce-client";
import { EventAccessError, eventAccessStatus, resolveOwnedV2EventId } from "@/lib/v2/event-access";

type Params = { eventId: string; promoId: string };

const schema = z.object({
  isActive: z.boolean().optional(),
  code: z.string().min(2).optional(),
  promoType: z.enum(["fixed", "percentage"]).optional(),
  discountValue: z.number().nonnegative().optional(),
  usageLimit: z.number().int().positive().nullable().optional(),
  startsAt: z.string().nullable().optional(),
  endsAt: z.string().nullable().optional(),
});

/** v2 실패 → 사용자 응답. 미존재 404 · 중복 409 · 입력 400 · 그 외 503(성공 위장 금지). */
function mapPromoError(err: V2CommerceError, action: string) {
  if (err.status === 404) return errorResponse("프로모코드를 찾을 수 없습니다", 404);
  if (err.status === 409) return errorResponse("이미 사용 중인 프로모코드입니다", 409);
  if (err.status === 400) return errorResponse("프로모코드 입력값을 확인해주세요", 400);
  return errorResponse(
    `프로모코드 ${action} 중 커머스 서버에 연결하지 못했습니다. 잠시 후 다시 시도해주세요.`,
    503,
  );
}

function mapEventError(err: EventAccessError) {
  return errorResponse(
    err.reason === "not_found"
      ? "이벤트를 찾을 수 없습니다."
      : "커머스 서버에 연결할 수 없습니다. 잠시 후 다시 시도해주세요.",
    eventAccessStatus(err),
  );
}

export const PATCH = withRole<Params>("organizer", async (request, { session, params }) => {
  try {
    const body = schema.parse(await request.json());

    // 정률 할인은 1~100(생성 라우트와 동일 규칙). v2 도 같은 검증을 하지만, 사용자 문구는
    // go 가 고른다(v2 영문 메시지를 화면에 흘리지 않는다).
    if (
      body.promoType === "percentage" &&
      body.discountValue !== undefined &&
      (body.discountValue < 1 || body.discountValue > 100)
    ) {
      return errorResponse("정률 할인은 1~100 사이여야 합니다", 400);
    }
    // promo_type 과 discount_value 는 짝이다 — 한쪽만 바꾸면 "5000%" 같은 값이 만들어진다.
    if ((body.promoType === undefined) !== (body.discountValue === undefined)) {
      return errorResponse("할인 유형과 할인 값은 함께 변경해야 합니다", 400);
    }

    const v2EventId = await resolveOwnedV2EventId(params.eventId, session.accountId);
    if (!v2EventId) {
      return errorResponse("이벤트를 찾을 수 없습니다.", 404);
    }

    // 전달된 키만 실어 보낸다 — v2 는 `model_fields_set` 으로 판정하므로 안 보낸 필드는 보존되고,
    // `null` 은 "무제한/무기한으로 되돌리기"라는 유효값으로 반영된다.
    const patch: PromoCodePatchInput = {};
    if (body.code !== undefined) patch.code = body.code.toUpperCase();
    if (body.promoType !== undefined) patch.promo_type = body.promoType;
    if (body.discountValue !== undefined) patch.discount_value = body.discountValue;
    if (body.usageLimit !== undefined) patch.usage_limit = body.usageLimit;
    if (body.startsAt !== undefined) {
      patch.starts_at = body.startsAt ? toIsoFromKstLocal(body.startsAt) : null;
    }
    if (body.endsAt !== undefined) {
      patch.ends_at = body.endsAt ? toIsoFromKstLocal(body.endsAt) : null;
    }
    if (body.isActive !== undefined) patch.is_active = body.isActive;

    if (Object.keys(patch).length === 0) {
      return successResponse({ id: params.promoId });
    }

    const updated = await patchPromoCode(v2EventId, params.promoId, patch);
    return successResponse({ id: updated.promo_id });
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? ERR.INVALID_INPUT, 400);
    }
    if (err instanceof EventAccessError) return mapEventError(err);
    if (err instanceof V2CommerceError) return mapPromoError(err, "수정");
    return errorResponse(ERR.SERVER, 500);
  }
});

export const DELETE = withRole<Params>("organizer", async (_request, { session, params }) => {
  try {
    const v2EventId = await resolveOwnedV2EventId(params.eventId, session.accountId);
    if (!v2EventId) {
      return errorResponse("이벤트를 찾을 수 없습니다.", 404);
    }
    await deletePromoCode(v2EventId, params.promoId);
    return successResponse({ deleted: true });
  } catch (err: unknown) {
    if (err instanceof EventAccessError) return mapEventError(err);
    if (err instanceof V2CommerceError) return mapPromoError(err, "삭제");
    return errorResponse(ERR.SERVER, 500);
  }
});
