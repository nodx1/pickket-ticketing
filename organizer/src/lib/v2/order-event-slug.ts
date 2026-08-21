/**
 * go order id → 이벤트 slug (표시 전용) — 레벨2 컷오버 W2-PUB.
 *
 * 나이스 결제 착지 페이지가 `?orderId=<go order id>` 만 받고 이벤트 slug 를 모른다.
 * 예전엔 go `orders JOIN events` 로 풀었지만, 주문 id 는 canonical 승격 대상이 아니라
 * v2 `orders.external_ref` 역인덱스(`/internal/orders/by-external`)로 해석한다.
 *
 * **표시 전용**: 실패하면 빈 slug 를 돌려주고 화면은 홈 링크로 폴백한다. 여기서 503 을
 * 던지면 이미 승인·확정된 결제의 결과 화면 자체가 안 뜬다(결제는 v2 가 이미 끝냈다).
 * 즉 이 폴백은 "장애 은폐"가 아니라 **결제 결과 통지를 절대 막지 않는다**는 계약이다.
 */
import {
  V2CommerceError,
  getEvent,
  getOrderByExternalRef,
} from "@/lib/v2/commerce-client";
import { logger } from "@/lib/logger";

const UUID_RE = /^[0-9a-fA-F-]{36}$/;

/**
 * 🔴 일시 실패는 한 번 더 물어본다 (2026-08-04).
 *
 * 이 왕복은 **결제를 막 끝낸 손님의 화면**을 좌우한다. v2 가 재배포로 잠깐 끊기거나
 * 커넥션 하나가 떨어지면, 해석이 실패해 화면에서 행사로 돌아갈 길이 사라진다.
 * 그 순간은 되돌릴 수 없다 — 손님은 이미 그 페이지를 봤다.
 *
 * ⚠️ **4xx 는 재시도하지 않는다.** 404(그런 주문 없음)는 다시 물어도 같은 답이고,
 *    괜히 결과 화면 렌더만 늦춘다. 5xx·네트워크 오류만 한 번 더 시도한다.
 */
function isRetryable(err: unknown): boolean {
  if (err instanceof V2CommerceError) return err.status >= 500;
  return true; // 네트워크·타임아웃 등 status 가 없는 실패
}

export async function resolveEventSlugByGoOrderId(
  orderId: string | undefined,
): Promise<string> {
  if (!orderId || !UUID_RE.test(orderId)) return "";

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const order = await getOrderByExternalRef(orderId);
      const event = await getEvent(order.event_id);
      return event.slug ?? "";
    } catch (err: unknown) {
      const retry = attempt === 1 && isRetryable(err);
      // 관측성: 조용히 폴백하면 "왜 이벤트로 안 돌아가지?" 를 추적할 수 없다.
      logger.warn(retry ? "나이스 착지 slug 해석 실패(재시도)" : "나이스 착지 slug 해석 실패(폴백)", {
        orderId,
        attempt,
        status: err instanceof V2CommerceError ? err.status : undefined,
        error: err instanceof Error ? err.message : "unknown",
      });
      if (!retry) return "";
    }
  }
  return "";
}
