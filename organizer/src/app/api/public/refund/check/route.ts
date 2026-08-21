/**
 * POST /api/public/refund/check — 환불 미리보기(공개, 구매자 지식 검증).
 *
 * ── 레벨2 컷오버 W2-PUB ──
 * go `orders JOIN events` 앵커 조회 → v2 `GET /internal/orders/by-external/{go order id}`.
 * 요청 계약(`orderId` = go order id)은 **바뀌지 않는다** — 이미 배포된 티켓/환불 화면과
 * refund POST 의 `refund_requests.order_id`(go orders FK)가 같은 값을 쓴다.
 *
 * 실패 계약: 미존재/불일치 404(구매자 열거 방지) · v2 응답불가 **503**.
 * ⚠️ 예전엔 v2 앵커가 없으면 go local `total_amount` 로 폴백해 **부분환불을 무시한** 금액을
 *    보여줬다. v2 단일 SoT 이후 그 폴백은 존재할 수 없다(폴백=과다환불 안내 위험) → 제거.
 */
import { cookies } from "next/headers";
import { z } from "zod";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRateLimit } from "@/lib/auth/withRateLimit";
import { ERR } from "@/lib/errors";
import {
  matchesPublicLookup,
  PUBLIC_LOOKUP_COOKIE,
  verifyPublicLookupToken,
} from "@/lib/public-access";
import { calculateCancellationRefund, toLegacyPreview, toTiers } from "@/lib/refund/cancellation-fee";
import { V2CommerceError, getOrderByExternalRef } from "@/lib/v2/commerce-client";
import { PUBLIC_ANY_STATUS, resolvePublicEventById } from "@/lib/v2/public-event";

const schema = z.object({
  orderId: z.string().uuid(),
  email: z.email("올바른 이메일 형식을 입력해주세요"),
});

async function refundCheckHandler(request: Request) {
  try {
    const body = schema.parse(await request.json());
    const lookup = verifyPublicLookupToken((await cookies()).get(PUBLIC_LOOKUP_COOKIE)?.value);

    let order: Awaited<ReturnType<typeof getOrderByExternalRef>>;
    try {
      order = await getOrderByExternalRef(body.orderId);
    } catch (err: unknown) {
      if (err instanceof V2CommerceError) {
        // 4xx(404 포함) = 미존재 → 존재 사실을 노출하지 않는다. 5xx/네트워크 = 재시도 가능.
        if (err.status >= 400 && err.status < 500) {
          return errorResponse("주문 정보를 찾을 수 없습니다", 404);
        }
        return errorResponse(ERR.SERVER, 503);
      }
      return errorResponse(ERR.SERVER, 500);
    }

    // 구매자 검증 — v2 가 buyer SoT. 이메일 일치 + 룩업 쿠키 일치를 함께 확인.
    const buyerEmail = order.buyer.email;
    const buyerPhone = order.buyer.phone;
    if (
      buyerEmail !== body.email ||
      !matchesPublicLookup(lookup, { email: buyerEmail, phone: buyerPhone })
    ) {
      return errorResponse("주문 정보를 찾을 수 없습니다", 404);
    }

    // 환불 정책 기준일 = 이벤트 시작일(v2 event_date).
    const eventResolved = await resolvePublicEventById(order.event_id, PUBLIC_ANY_STATUS);
    if (!eventResolved.ok) {
      return eventResolved.status === 404
        ? errorResponse("주문 정보를 찾을 수 없습니다", 404)
        : errorResponse(ERR.SERVER, 503);
    }
    const startsAt = eventResolved.event.event_date;
    if (!startsAt) {
      return errorResponse("이벤트 일정이 확정되지 않아 환불 규정을 계산할 수 없습니다", 409);
    }

    // 환불 미리보기 기준금액 = 결제액 − 누적환불액(v2 SoT). 실제 제출(refund/route.ts)과 동일 기준.
    const refundableBase = Math.max(order.paid_amount - order.total_refunded, 0);
    // 🔴 종전엔 정책을 **아예 안 넘겨** 항상 하드코딩 기본값으로 계산했다(2026-07-31 발견).
    //    주최자가 대시보드에서 무엇을 설정하든 구매자가 보는 미리보기는 안 바뀌었다.
    const preview = toLegacyPreview(
      calculateCancellationRefund(
        toTiers(eventResolved.event.cancellation_fee_tiers),
        startsAt,
        refundableBase,
        new Date(),
      ),
    );
    return successResponse(preview);
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? ERR.INVALID_INPUT, 400);
    }
    return errorResponse(ERR.SERVER, 500);
  }
}

export const POST = withRateLimit({
  max: 10,
  windowMs: 60_000,
  keyPrefix: "public:refund-check",
})(refundCheckHandler);
