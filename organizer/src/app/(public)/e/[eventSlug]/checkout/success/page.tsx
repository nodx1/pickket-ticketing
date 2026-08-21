import { notFound } from "next/navigation";
import { normalizeEventSlug } from "@/lib/public/event-slug";
import { CheckoutConfirm } from "./_components/checkout-confirm";
import { NiceCheckoutResult } from "./_components/nice-checkout-result";

/**
 * 결제 성공 리다이렉트 착지점.
 *
 * - 토스: successUrl?paymentKey&orderId&amount → 클라 서버 confirm(/api/payment/toss/confirm)으로 최종 승인.
 * - 나이스: v2 가 서버승인 후 302 redirect → ?provider=nicepay&reason=<confirmed|vbank_pending|...>&orderId=
 *   (이미 v2 승인 완료 — 클라 confirm 불필요, reason 으로 상태표시만).
 */
export default async function CheckoutSuccessPage({
  params,
  searchParams,
}: {
  params: Promise<{ eventSlug: string }>;
  searchParams: Promise<{
    provider?: string;
    reason?: string;
    paymentKey?: string;
    orderId?: string;
    amount?: string;
  }>;
}) {
  // 한글 slug 이벤트가 404 로 죽던 결함 — normalizeEventSlug 주석 참조.
  const { eventSlug: rawSlug } = await params;
  const eventSlug = normalizeEventSlug(rawSlug);
  const { provider, reason, paymentKey, orderId, amount } = await searchParams;

  // 나이스 경로: v2 서버승인 후 redirect. reason 으로 상태 표시(클라 confirm 없음).
  if (provider === "nicepay") {
    return <NiceCheckoutResult eventSlug={eventSlug} reason={reason} orderId={orderId} />;
  }

  // 토스 경로(기존): 클라 서버 confirm.
  if (!paymentKey || !orderId || !amount) {
    notFound();
  }

  return (
    <CheckoutConfirm
      eventSlug={eventSlug}
      paymentKey={paymentKey}
      orderId={orderId}
      amount={Number(amount)}
    />
  );
}
