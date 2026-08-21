import { notFound } from "next/navigation";
import { resolveEventSlugByGoOrderId } from "@/lib/v2/order-event-slug";
import { NiceCheckoutResult } from "@/app/(public)/e/[eventSlug]/checkout/success/_components/nice-checkout-result";

/**
 * 나이스페이 결제 성공 착지점 — 이벤트-비의존(go 전역) 라우트.
 *
 * v2 return 핸들러가 mallReserved='go' 를 읽어 여기(NICEPAY_GO_SUCCESS_URL)로 302 redirect 한다.
 * v2 는 go 이벤트 slug 를 모르므로, 여기서 orderId(=go order id)로 이벤트 slug 를 해석해
 * 기존 이벤트-스코프 결과 컴포넌트를 그대로 재사용한다. (Phase 2b)
 *
 * 착지 파라미터(v2 계약): ?provider=nicepay&reason=<confirmed|vbank_pending|...>&orderId=<go order id>
 * v2 가 이미 서버승인·정본전파를 마쳤으므로 클라 confirm 은 없다(reason 으로 상태표시만).
 *
 * ── 레벨2 컷오버 W2-PUB ──
 * go `orders JOIN events` slug 조회 → v2 `orders/by-external` + 이벤트 상세.
 * slug 해석 실패는 홈 폴백(표시 전용) — 결제 결과 통지를 절대 막지 않는다.
 */
export default async function GoNiceSuccessPage({
  searchParams,
}: {
  searchParams: Promise<{ provider?: string; reason?: string; orderId?: string }>;
}) {
  const { provider, reason, orderId } = await searchParams;

  // v2 나이스 경로만 처리(그 외 접근은 404 — 이 라우트는 나이스 착지 전용).
  if (provider !== "nicepay") {
    notFound();
  }

  const eventSlug = await resolveEventSlugByGoOrderId(orderId);
  return <NiceCheckoutResult eventSlug={eventSlug} reason={reason} orderId={orderId} />;
}
