"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useCheckoutStore } from "@/lib/stores/checkoutStore";
import { readCheckoutJson } from "@/lib/checkout/read-json";

interface CheckoutConfirmProps {
  eventSlug: string;
  paymentKey: string;
  orderId: string;
  amount: number;
}

/**
 * 토스 결제창 성공 후 서버 confirm 을 호출해 최종 승인한다.
 * confirm 성공 → 완료 페이지. 실패 → 에러 안내 + **같은 paymentKey/orderId 로 confirm 재시도**.
 * ⚠️ 재시도를 결제 페이지로 돌려보내면 안 된다 — PG 에는 이미 승인된 결제가 있는데
 * 새 주문·새 결제를 또 만들어 이중 결제가 된다. (교차검증 [신규1])
 * 가상계좌 pending 도 완료 페이지에서 안내.
 */
export function CheckoutConfirm({ eventSlug, paymentKey, orderId, amount }: CheckoutConfirmProps) {
  const router = useRouter();
  const { reset } = useCheckoutStore();
  const started = useRef(false);
  const confirming = useRef(false);
  const [error, setError] = useState<string | null>(null);

  const runConfirm = useCallback(async () => {
    if (confirming.current) return;
    confirming.current = true;
    setError(null);
    try {
      const res = await fetch("/api/payment/toss/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentKey, orderId, amount }),
      });
      // HTML 응답이 오면 `Unexpected token '<'` 가 구매자 화면에 뜬다 — 방어 파싱.
      const payload = await readCheckoutJson<{ error?: string }>(res, "payment/toss/confirm");
      if (!res.ok) {
        throw new Error(payload.error ?? "결제 승인에 실패했습니다");
      }
      reset(); // 체크아웃 store 정리(뒤로가기 재결제 방지)
      router.replace(`/e/${eventSlug}/checkout/complete?orderId=${orderId}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "결제 승인 중 오류가 발생했습니다");
    } finally {
      confirming.current = false;
    }
  }, [amount, eventSlug, orderId, paymentKey, reset, router]);

  useEffect(() => {
    if (started.current) return; // StrictMode/중복 confirm 방지
    started.current = true;
    void runConfirm();
  }, [runConfirm]);

  return (
    <div className="min-h-screen bg-background px-4 py-10">
      <div className="mx-auto mt-6 max-w-lg">
        <Card className="border-border bg-card/95">
          <CardContent className="space-y-6 p-8 text-center" aria-live="polite">
            {error ? (
              <>
                <div className="mx-auto flex size-16 items-center justify-center rounded-full bg-destructive/15 text-destructive">
                  <XCircle className="size-9" aria-hidden="true" />
                </div>
                <div>
                  <h1 className="text-2xl font-black tracking-[-0.03em] text-foreground">결제 승인 실패</h1>
                  <p className="mt-2 text-sm text-muted-foreground">{error}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    결제 금액은 아직 확정되지 않았습니다. 아래 버튼으로 승인을 다시 시도해주세요.
                    반복 실패 시 결제는 자동 취소되며, 문의 주시면 빠르게 확인해드립니다.
                  </p>
                </div>
                <div className="flex justify-center gap-3">
                  <Button onClick={() => void runConfirm()}>승인 다시 시도</Button>
                  <Button variant="outline" asChild>
                    <a href="mailto:support@pickket.kr">문의하기</a>
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className="mx-auto flex size-16 items-center justify-center rounded-full bg-primary/15 text-primary">
                  <Loader2 className="size-9 animate-spin" aria-hidden="true" />
                </div>
                <div>
                  <h1 className="text-2xl font-black tracking-[-0.03em] text-foreground">결제 확인 중</h1>
                  <p className="mt-2 text-sm text-muted-foreground">잠시만 기다려 주세요. 결제를 안전하게 확정하고 있습니다.</p>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
