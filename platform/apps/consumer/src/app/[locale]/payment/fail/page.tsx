import Link from "next/link";
import { XCircle } from "lucide-react";
import { NicePaymentResult } from "../_components/NicePaymentResult";

/**
 * 결제창 실패/취소 리다이렉트 착지점(provider 분기). 주문은 pending 유지 → 재시도 안내.
 *
 * 토스: failUrl?order=<v2주문UUID>&code&message (기존 경로 불변).
 * 나이스: v2 return 실패 → ?provider=nicepay&reason=<signature_invalid|amount_mismatch|user_cancel|...>&orderId
 *   ⚠️ 서버(payment_webhook._nice_redirect_url)는 v2 주문 UUID 를 **`orderId`** 쿼리로 붙인다
 *      (토스의 `order` 와 파라미터명이 다름). 두 이름 모두 수용해 재시도 링크 유실을 막는다.
 */
export default async function PaymentFailPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{
    order?: string;
    orderId?: string;
    code?: string;
    message?: string;
    provider?: string;
    reason?: string;
    guest?: string;
  }>;
}) {
  const { locale } = await params;
  const { order, orderId, code, message, provider, reason, guest } =
    await searchParams;
  const isGuest = guest === "1";

  // 나이스 경로: reason 기반 i18n 안내(organizer reason 매핑 재사용).
  // 서버는 v2 주문 UUID 를 `orderId` 로 붙이므로 `order ?? orderId` 로 수용.
  if (provider === "nicepay") {
    return (
      <NicePaymentResult
        locale={locale}
        variant="fail"
        reason={reason}
        orderId={order ?? orderId}
      />
    );
  }

  // 토스 경로(기존, 불변).
  const isUserCancel = code === "PAY_PROCESS_CANCELED" || code === "USER_CANCEL";
  const heading = isUserCancel ? "결제가 취소되었습니다" : "결제에 실패했습니다";
  const detail = isUserCancel
    ? "결제를 다시 진행하시려면 아래 버튼을 눌러주세요."
    : message ?? "결제 처리 중 문제가 발생했습니다. 다시 시도해 주세요.";
  const backHref = order
    ? isGuest
      ? `/${locale}/guests/orders/${order}`
      : `/${locale}/orders/${order}`
    : `/${locale}/events`;

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center shadow-sm">
        <div className="mx-auto flex size-16 items-center justify-center rounded-full bg-destructive/15 text-destructive">
          <XCircle className="size-9" />
        </div>
        <h1 className="mt-5 text-xl font-bold text-foreground">{heading}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{detail}</p>
        {code && !isUserCancel ? (
          <p className="mt-1 text-xs text-muted-foreground/70">오류코드: {code}</p>
        ) : null}
        <div className="mt-6 flex justify-center gap-3">
          <Link
            href={backHref}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
          >
            {order ? "주문 확인 · 재시도" : "이벤트로"}
          </Link>
        </div>
      </div>
    </div>
  );
}
