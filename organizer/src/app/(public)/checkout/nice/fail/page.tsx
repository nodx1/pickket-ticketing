import { notFound } from "next/navigation";
import { resolveEventSlugByGoOrderId } from "@/lib/v2/order-event-slug";
import { NiceFailResult } from "@/app/(public)/e/[eventSlug]/checkout/fail/_components/nice-fail-result";

/**
 * 나이스페이 결제 실패/취소 착지점 — 이벤트-비의존(go 전역) 라우트.
 *
 * v2 return 핸들러가 mallReserved='go' 를 읽어 여기(NICEPAY_GO_FAIL_URL)로 302 redirect 한다.
 * v2 는 go 이벤트 slug 를 모르므로 orderId(=go order id)로 slug 를 해석해 공용 결과 컴포넌트
 * 를 재사용한다. (Phase 2b)
 *
 * 착지 파라미터(v2 계약): ?provider=nicepay&reason=<signature_invalid|amount_mismatch|...>&orderId=
 *
 * ── 레벨2 컷오버 W2-PUB ──
 * go `orders JOIN events` slug 조회 → v2 `orders/by-external` + 이벤트 상세(표시 전용·홈 폴백).
 */
export default async function GoNiceFailPage({
  searchParams,
}: {
  searchParams: Promise<{ provider?: string; reason?: string; orderId?: string }>;
}) {
  const { provider, reason, orderId } = await searchParams;

  // 나이스 착지 전용 라우트.
  if (provider !== "nicepay") {
    notFound();
  }

  const eventSlug = await resolveEventSlugByGoOrderId(orderId);
  return <NiceFailResult eventSlug={eventSlug} isNice reason={reason} />;
}
