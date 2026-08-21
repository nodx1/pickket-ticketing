import { NiceFailResult } from "./_components/nice-fail-result";
import { normalizeEventSlug } from "@/lib/public/event-slug";

/**
 * 결제 실패/취소 리다이렉트 착지점. 주문은 pending 유지되므로 재시도 안내만 한다.
 *
 * - 토스: failUrl?code&message&orderId.
 * - 나이스: v2 가 서버승인 실패 시 302 redirect → ?provider=nicepay&reason=<signature_invalid|amount_mismatch|...>&orderId=.
 */
export default async function CheckoutFailPage({
  params,
  searchParams,
}: {
  params: Promise<{ eventSlug: string }>;
  searchParams: Promise<{ provider?: string; reason?: string; code?: string; message?: string }>;
}) {
  // 한글 slug 이벤트가 404 로 죽던 결함 — normalizeEventSlug 주석 참조.
  const { eventSlug: rawSlug } = await params;
  const eventSlug = normalizeEventSlug(rawSlug);
  const { provider, reason, code, message } = await searchParams;

  return (
    <NiceFailResult
      eventSlug={eventSlug}
      isNice={provider === "nicepay"}
      reason={reason}
      code={code}
      message={message}
    />
  );
}
