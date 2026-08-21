/**
 * 체크아웃 프로모코드 적용(표시용) — 레벨2 컷오버 **W5-COMMERCE**.
 *
 * ## 🔴 왜 go 가 계산하지 않는가
 * 옛 코드는 go `promo_codes` 를 읽어 `Math.min` / `Math.floor` 로 직접 할인액을 냈다.
 * 그런데 실제 청구액은 v2 가 `_compute_discount_amount` 로 **다시** 계산한다(주문 생성 시).
 * 두 산식이 조금이라도 다르면(반올림·최소주문액·최대할인캡) 화면에 보여준 금액과 청구액이
 * 갈라지고, v2 의 total_amount 재검증이 AMOUNT_MISMATCH 로 결제를 거절한다.
 * → 표시액도 **v2 가 계산한 값 그대로**를 쓴다. 산식은 한 곳에만 있어야 한다.
 *
 * ## 사용 횟수는 여기서 차감되지 않는다
 * 차감은 주문 생성 트랜잭션 안에서 1회(코드 행 `FOR UPDATE` + used_count+1)만 일어난다.
 * 검증 단계에서 차감하면 결제까지 안 간 조회가 한도를 갉아먹고, 재시도가 2회 차감한다.
 * 반대로 한도 초과는 v2 가 **여기서도 409 로 막는다**(통과시키면 화면만 할인되고 결제 실패).
 *
 * ## 실패 취급
 * v2 장애를 "할인 0원"·"유효하지 않은 코드"로 흘리지 않는다 → **503**.
 * 조용히 0원 처리하면 구매자는 할인이 안 됐다고 오인하고, 정상 코드를 폐기해 버린다.
 */
import { z } from "zod";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRateLimit } from "@/lib/auth/withRateLimit";
import { ERR } from "@/lib/errors";
import { V2CommerceError, v2ErrorCode, validatePromoCode } from "@/lib/v2/commerce-client";

const schema = z.object({
  eventId: z.string().uuid(),
  code: z.string().min(2),
  totalAmount: z.number().nonnegative(),
});

/** v2 에러 → 구매자용 한국어 문구. 코드별로 갈라야 안내가 맞는다(400 뭉개기 금지). */
function mapValidateError(err: V2CommerceError) {
  switch (v2ErrorCode(err)) {
    case "PROMO_NOT_FOUND":
      return errorResponse("유효하지 않은 프로모코드입니다", 404);
    case "PROMO_NOT_YET":
      return errorResponse("아직 사용할 수 없는 프로모코드입니다", 400);
    case "PROMO_EXPIRED":
      return errorResponse("만료된 프로모코드입니다", 400);
    case "PROMO_EXHAUSTED":
      return errorResponse("사용 한도를 초과했습니다", 400);
    case "PROMO_INVALID":
      return errorResponse("이 주문에는 사용할 수 없는 프로모코드입니다", 400);
    case "EVENT_NOT_FOUND":
      return errorResponse("이벤트를 찾을 수 없습니다", 404);
    default:
      // 코드 미상 4xx 도 "코드 문제"로 단정하지 않는다. 5xx/네트워크는 명시적 503.
      if (err.status >= 400 && err.status < 500) {
        return errorResponse("프로모코드를 확인할 수 없습니다", 400);
      }
      return errorResponse(
        "프로모코드를 확인할 수 없습니다. 잠시 후 다시 시도해주세요.",
        503,
      );
  }
}

async function applyPromoHandler(request: Request) {
  try {
    const body = schema.parse(await request.json());

    // v2 event id 는 go event id 와 항등(T2-EVT). 공개 라우트라 소유 검증은 없다 —
    // 코드는 이벤트 스코프이므로 타 이벤트 코드가 새어 들어올 수 없다.
    const result = await validatePromoCode(body.eventId, {
      code: body.code.toUpperCase(),
      gross_amount: body.totalAmount,
    });

    return successResponse({
      valid: true,
      discountAmount: result.discount_amount,
      finalAmount: result.final_amount,
      promoCode: { code: result.code },
    });
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? ERR.INVALID_INPUT, 400);
    }
    if (err instanceof V2CommerceError) {
      return mapValidateError(err);
    }
    return errorResponse(ERR.SERVER, 500);
  }
}

export const POST = withRateLimit({
  max: 20,
  windowMs: 60_000,
  keyPrefix: "checkout:apply-promo",
})(applyPromoHandler);
