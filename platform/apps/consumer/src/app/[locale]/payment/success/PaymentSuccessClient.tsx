"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, XCircle } from "lucide-react";
import { confirmOrderPayment, confirmGuestPayment } from "@pickket/lib/api";
import { readGuestViewToken } from "@/hooks/useGuestBooking";

interface PaymentSuccessClientProps {
  locale: string;
  orderId: string; // v2 주문 UUID
  paymentKey: string; // 토스 paymentKey
  paymentId: string; // ord_xxx (= 토스 orderId)
  amount: number;
  /** 게스트(비회원) 결제 return — view 토큰으로 confirmGuestPayment. */
  isGuest?: boolean;
}

/**
 * 토스 결제창 성공 후 서버 confirm 을 호출해 최종 승인한다.
 * confirm 성공 → 주문상세(/orders/{id})로 이동. 실패 → 에러 안내(재시도).
 */
export function PaymentSuccessClient({
  locale,
  orderId,
  paymentKey,
  paymentId,
  amount,
  isGuest = false,
}: PaymentSuccessClientProps) {
  const router = useRouter();
  const started = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(true);

  const runConfirm = useCallback(async () => {
    setError(null);
    setConfirming(true);
    try {
      if (isGuest) {
        // 게스트: view 토큰(sessionStorage) 소유증명으로 confirmGuestPayment.
        const viewToken = readGuestViewToken(orderId);
        if (!viewToken) {
          throw new Error(
            "주문 접근 정보가 만료되었습니다. 주문 조회 링크(이메일)에서 상태를 확인해 주세요.",
          );
        }
        await confirmGuestPayment(orderId, {
          view_token: viewToken,
          pg_provider: "toss",
          pg_transaction_id: paymentKey,
          payment_id: paymentId || undefined,
          amount,
        });
        router.replace(`/${locale}/guests/orders/${orderId}`);
        return;
      }
      await confirmOrderPayment(orderId, {
        pg_provider: "toss",
        pg_transaction_id: paymentKey,
        payment_id: paymentId || undefined,
        amount,
      });
      router.replace(`/${locale}/orders/${orderId}`);
    } catch (err: unknown) {
      const message =
        err instanceof Error
          ? err.message
          : (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ||
            "결제 승인 중 오류가 발생했습니다.";
      setError(message);
      setConfirming(false);
    }
  }, [amount, isGuest, locale, orderId, paymentId, paymentKey, router]);

  useEffect(() => {
    if (started.current) return; // StrictMode/중복 confirm 방지
    started.current = true;
    void runConfirm();
  }, [runConfirm]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center shadow-sm">
        {error ? (
          <>
            <div className="mx-auto flex size-16 items-center justify-center rounded-full bg-destructive/15 text-destructive">
              <XCircle className="size-9" />
            </div>
            <h1 className="mt-5 text-xl font-bold text-foreground">결제 승인 실패</h1>
            <p className="mt-2 text-sm text-muted-foreground">{error}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              결제는 정상 처리되었을 수 있습니다. 다시 시도하거나 주문 상태를 확인해 주세요.
            </p>
            <div className="mt-6 flex justify-center gap-3">
              <button
                onClick={() => void runConfirm()}
                disabled={confirming}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
              >
                {confirming ? "확인 중..." : "다시 시도"}
              </button>
              <button
                onClick={() =>
                  router.replace(
                    isGuest
                      ? `/${locale}/guests/orders/${orderId}`
                      : `/${locale}/orders/${orderId}`,
                  )
                }
                className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-foreground hover:bg-muted"
              >
                주문 확인
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="mx-auto flex size-16 items-center justify-center rounded-full bg-primary/15 text-primary">
              <Loader2 className="size-9 animate-spin" />
            </div>
            <h1 className="mt-5 text-xl font-bold text-foreground">결제 확인 중</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              잠시만 기다려 주세요. 결제를 안전하게 확정하고 있습니다.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
