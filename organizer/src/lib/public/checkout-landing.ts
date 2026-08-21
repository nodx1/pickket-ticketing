/**
 * 결제 착지 화면의 **갈 곳** — 손님을 마케팅 홈으로 보내지 않는다.
 *
 * ## 🔴 왜 고치나 (2026-08-04, 대표 실사용 지적)
 * 「이벤트로 돌아가기」를 눌렀더니 **피켓고 홈페이지**로 갔다.
 *
 * 나이스 착지는 이벤트-비의존 라우트(`/checkout/nice/success`)라 URL 에 slug 가 없다.
 * 그래서 `orderId` 로 v2 에 물어 slug 를 역산하는데, **그 왕복이 실패하면 빈 문자열**이
 * 오고 화면은 이렇게 폴백했다:
 *
 * ```
 * const eventHref = eventSlug ? `/e/${eventSlug}` : "/";     ← 홈
 * ```
 *
 * ⚠️ **버튼 이름이 거짓말을 한다.** 「이벤트로 돌아가기」라고 적힌 것을 눌렀는데 행사와
 *    무관한 랜딩이 뜨면, 손님은 결제가 잘못됐다고 읽는다. 결제를 막 끝낸 사람에게
 *    가장 나쁜 신호다.
 *
 * ## 규칙
 * ```
 * 행사 링크   slug 를 모르면 **그리지 않는다**(null). 거짓 목적지보다 없는 편이 낫다
 * 주문 링크   항상 유효한 곳으로 — slug 를 모르면 `/my-tickets`
 * ```
 * `/my-tickets` 는 홈과 달리 **손님이 방금 산 것을 실제로 볼 수 있는 곳**이다.
 */
import { eventPagePath } from "./event-path";

export interface CheckoutLandingLinks {
  /** 「예약 내역 확인」 목적지. 🔴 항상 유효하다(막다른 곳이 없다). */
  orderHref: string;
  /** 행사 페이지. slug 를 모르면 `null` — 호출부는 버튼을 그리지 않는다. */
  eventHref: string | null;
  /** 결제 재시도(실패 화면 전용). slug 를 모르면 `null`. */
  retryHref: string | null;
}

export function checkoutLandingLinks(
  eventSlug: string | null | undefined,
  orderId?: string | null,
): CheckoutLandingLinks {
  const eventHref = eventPagePath(eventSlug);
  const hasOrder = typeof orderId === "string" && orderId.trim() !== "";

  return {
    eventHref,
    retryHref: eventHref ? `${eventHref}/checkout/payment` : null,
    // 🔴 slug 를 모르면 홈이 아니라 내 티켓으로 — 방금 산 것을 볼 수 있는 곳이다.
    orderHref:
      eventHref && hasOrder
        ? `${eventHref}/checkout/complete?orderId=${encodeURIComponent(orderId!.trim())}`
        : "/my-tickets",
  };
}
