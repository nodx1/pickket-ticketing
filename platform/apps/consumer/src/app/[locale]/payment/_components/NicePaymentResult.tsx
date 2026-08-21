"use client";

import Link from "next/link";
import { CheckCircle2, Clock, XCircle } from "lucide-react";
import { useTranslations } from "next-intl";

/**
 * 나이스페이 결제 결과 표시(v2 서버승인 후 302 redirect 착지, provider=nicepay).
 * v2 가 이미 승인·정본전파를 마쳤으므로 클라 confirm 은 없다 — reason 으로 상태만 안내한다.
 *   성공: confirmed(완료) · vbank_pending(가상계좌 입금대기) · 그 외(상태 확인 중)
 *   실패: signature_invalid · amount_mismatch · auth_failed · order_not_found ·
 *         approval_failed · user_cancel · 그 외(폴백)
 * organizer nice 결과 컴포넌트의 reason 매핑을 consumer i18n 으로 재사용.
 */

type Variant = "success" | "fail";

interface NicePaymentResultProps {
  locale: string;
  variant: Variant;
  /** v2 return 이 부착한 결과 사유. */
  reason?: string;
  /** v2 주문 UUID(주문상세 링크용). success 착지는 order 쿼리로 전달됨. */
  orderId?: string;
}

const FAIL_REASON_KEY: Record<string, string> = {
  signature_invalid: "reasonSignatureInvalid",
  amount_mismatch: "reasonAmountMismatch",
  auth_failed: "reasonAuthFailed",
  order_not_found: "reasonOrderNotFound",
  approval_failed: "reasonApprovalFailed",
};

export function NicePaymentResult({ locale, variant, reason, orderId }: NicePaymentResultProps) {
  const t = useTranslations("payment.niceResult");
  const orderHref = orderId ? `/${locale}/orders/${orderId}` : `/${locale}/events`;
  const eventsHref = `/${locale}/events`;

  if (variant === "success") {
    const isConfirmed = reason === "confirmed";
    const isVbankPending = reason === "vbank_pending";
    const icon = isConfirmed ? (
      <CheckCircle2 className="size-9" aria-hidden="true" />
    ) : (
      <Clock className="size-9" aria-hidden="true" />
    );
    const iconWrapClass = isConfirmed
      ? "bg-primary/15 text-primary"
      : "bg-warning/15 text-warning";
    const title = isConfirmed
      ? t("successConfirmedTitle")
      : isVbankPending
        ? t("vbankPendingTitle")
        : t("checkingTitle");
    const desc = isConfirmed
      ? t("successConfirmedDesc")
      : isVbankPending
        ? t("vbankPendingDesc")
        : t("checkingDesc");

    return (
      <div className="flex min-h-[60vh] items-center justify-center px-4">
        <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center shadow-sm">
          <div className={`mx-auto flex size-16 items-center justify-center rounded-full ${iconWrapClass}`}>
            {icon}
          </div>
          <h1 className="mt-5 text-xl font-bold text-foreground">{title}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{desc}</p>
          {!isConfirmed && !isVbankPending && reason ? (
            <p className="mt-1 text-xs text-muted-foreground/70">
              {t("statusLabel")}: {reason}
            </p>
          ) : null}
          <div className="mt-6 flex justify-center gap-3">
            <Link
              href={orderHref}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
            >
              {t("viewOrder")}
            </Link>
            <Link
              href={eventsHref}
              className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-foreground hover:bg-muted"
            >
              {t("backToEvents")}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // variant === "fail"
  const isUserCancel = reason === "user_cancel";
  const heading = isUserCancel ? t("cancelTitle") : t("failTitle");
  const detail = isUserCancel
    ? t("cancelDesc")
    : (reason && FAIL_REASON_KEY[reason] ? t(FAIL_REASON_KEY[reason]) : t("reasonFallback"));

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center shadow-sm">
        <div className="mx-auto flex size-16 items-center justify-center rounded-full bg-destructive/15 text-destructive">
          <XCircle className="size-9" aria-hidden="true" />
        </div>
        <h1 className="mt-5 text-xl font-bold text-foreground">{heading}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{detail}</p>
        {reason && !isUserCancel ? (
          <p className="mt-1 text-xs text-muted-foreground/70">
            {t("errorCode")}: {reason}
          </p>
        ) : null}
        <div className="mt-6 flex justify-center gap-3">
          <Link
            href={orderHref}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
          >
            {orderId ? t("retry") : t("backToEvents")}
          </Link>
        </div>
      </div>
    </div>
  );
}
