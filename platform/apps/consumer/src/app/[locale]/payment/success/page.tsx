import { notFound } from "next/navigation";
import { PaymentSuccessClient } from "./PaymentSuccessClient";
import { NicePaymentResult } from "../_components/NicePaymentResult";

/**
 * 결제창 성공 리다이렉트 착지점(provider 분기).
 *
 * 토스: successUrl?order=<v2주문UUID>&paymentKey&orderId(=payment_id)&amount
 *   → 클라 confirm(POST /orders/{id}/pay)로 최종 승인 후 주문상세로 이동.
 * 나이스: v2 서버승인 후 302 redirect → ?provider=nicepay&reason=<confirmed|vbank_pending|...>&orderId
 *   → v2 가 이미 확정했으므로 클라 confirm 없이 reason 으로 상태만 표시.
 *   ⚠️ 서버(payment_webhook._nice_redirect_url)는 v2 주문 UUID 를 **`orderId`** 쿼리로 붙인다
 *      (토스의 `order` 와 파라미터명이 다름). 두 이름 모두 수용해 주문복귀 링크 유실을 막는다.
 */
export default async function PaymentSuccessPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{
    order?: string;
    paymentKey?: string;
    orderId?: string;
    amount?: string;
    provider?: string;
    reason?: string;
    guest?: string;
  }>;
}) {
  const { locale } = await params;
  const { order, paymentKey, orderId, amount, provider, reason, guest } =
    await searchParams;

  // 나이스 경로: v2 가 서버승인·정본전파를 마친 뒤 착지 — reason 으로 상태만 안내(confirm 없음).
  // 서버는 v2 주문 UUID 를 `orderId` 로 붙이므로 `order ?? orderId` 로 수용(둘 중 존재하는 값).
  if (provider === "nicepay") {
    return (
      <NicePaymentResult
        locale={locale}
        variant="success"
        reason={reason}
        orderId={order ?? orderId}
      />
    );
  }

  // 토스 경로(기존): confirm 에 paymentKey·amount 필요.
  if (!order || !paymentKey || !amount) {
    notFound();
  }

  return (
    <PaymentSuccessClient
      locale={locale}
      orderId={order}
      paymentKey={paymentKey}
      paymentId={orderId ?? ""}
      amount={Number(amount)}
      isGuest={guest === "1"}
    />
  );
}
