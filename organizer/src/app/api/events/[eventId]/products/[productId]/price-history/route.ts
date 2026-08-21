/**
 * 가격 변경 이력 — 레벨2 컷오버 **W5-COMMERCE**.
 *
 * go `price_history` (+ `pricing_rules` LEFT JOIN + `products` 소유 JOIN)를 v2
 * `tier_price_history` 로 옮겼다.
 *
 * ## go 에서는 늘 비어 있던 화면이었다
 * go 에는 이 표에 INSERT 하는 코드가 **하나도 없었다**(writer 0). 즉 이력은 구조만 있고
 * 절대 쌓이지 않았다. v2 에서는 가격 정본인 티어 upsert(`_do_upsert_tiers`)가 base_price
 * 변경을 감지해 기록하므로 — 가격을 바꿀 수 있는 경로가 그 하나뿐이라 — 누락이 없다.
 *
 * ## 실패 취급
 * 옛 코드는 실패를 `errorResponse(err.message, 500)` 으로 내보내 내부 메시지를 노출했다.
 * 미소유/미존재 404 · v2 장애 503 으로 분리한다(빈 배열 폴백 금지 — "가격을 한 번도 안
 * 바꿨다"와 "조회 실패"는 완전히 다른 사실이다).
 */
import { successResponse, errorResponse } from "@/lib/apiResponse";
import { withAuth } from "@/lib/auth/withAuth";
import { ERR } from "@/lib/errors";
import { catalogErrorResponse } from "@/lib/v2/catalog-http";
import { listPriceHistory } from "@/lib/v2/commerce-client";
import { requireOwnedEvent } from "@/lib/v2/event-access";

export const GET = withAuth(async (_request, { session, params }) => {
  const { eventId, productId } = params as { eventId: string; productId: string };
  try {
    const event = await requireOwnedEvent(eventId, session.accountId);
    const { history } = await listPriceHistory(event.event_id, productId, 50);
    return successResponse(
      history.map((h) => ({
        id: h.history_id,
        oldPrice: h.old_price,
        newPrice: h.new_price,
        reason: h.reason,
        appliedAt: h.applied_at,
        ruleType: h.rule_type,
      })),
    );
  } catch (err: unknown) {
    const mapped = catalogErrorResponse(err, {
      notFoundMessage: "상품을 찾을 수 없습니다",
      unavailableMessage: "가격 이력을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.",
      context: { eventId, productId },
    });
    if (mapped) return mapped;
    return errorResponse(ERR.SERVER, 500);
  }
});
