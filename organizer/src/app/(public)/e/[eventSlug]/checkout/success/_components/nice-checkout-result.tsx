"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { CheckCircle2, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useCheckoutStore } from "@/lib/stores/checkoutStore";
import { checkoutLandingLinks } from "@/lib/public/checkout-landing";

interface NiceCheckoutResultProps {
  eventSlug: string;
  /** v2 return 핸들러가 부착한 결과 사유: confirmed | vbank_pending | ... */
  reason?: string;
  orderId?: string;
}

/**
 * 나이스페이 결제 결과 표시(v2 서버승인 후 302 redirect 착지).
 * v2 가 이미 승인·정본전파를 마쳤으므로 클라 confirm 은 없다 — reason 으로 상태만 안내한다.
 *   - confirmed:     결제 완료 → 완료 페이지 이동 버튼(+ store 정리).
 *   - vbank_pending: 가상계좌 입금대기 안내(입금 전이므로 예약 미확정).
 *   - 그 외:          예외 상태 안내(문의 유도).
 */
export function NiceCheckoutResult({ eventSlug, reason, orderId }: NiceCheckoutResultProps) {
  const { reset } = useCheckoutStore();
  const cleaned = useRef(false);

  const isConfirmed = reason === "confirmed";
  const isVbankPending = reason === "vbank_pending";

  useEffect(() => {
    if (cleaned.current) return;
    cleaned.current = true;
    // 결제창을 거친 뒤이므로 확정/입금대기 모두 체크아웃 store 정리(뒤로가기 재결제 방지).
    if (isConfirmed || isVbankPending) reset();
  }, [isConfirmed, isVbankPending, reset]);

  // 🔴 slug 해석이 실패해도 **홈으로 보내지 않는다** (2026-08-04, 대표 지적).
  //    「이벤트로 돌아가기」를 눌렀는데 마케팅 홈이 뜨면 손님은 결제가 잘못된 줄 안다.
  //    행사 링크는 모르면 아예 그리지 않고, 주문 링크는 내 티켓으로 보낸다.
  const { eventHref, orderHref: completeHref } = checkoutLandingLinks(eventSlug, orderId);

  return (
    <div className="min-h-screen bg-background px-4 py-10">
      <div className="mx-auto mt-6 max-w-lg">
        <Card className="border-border bg-card/95">
          <CardContent className="space-y-6 p-8 text-center" aria-live="polite">
            {isConfirmed ? (
              <>
                <div className="mx-auto flex size-16 items-center justify-center rounded-full bg-primary/15 text-primary">
                  <CheckCircle2 className="size-9" aria-hidden="true" />
                </div>
                <div>
                  <h1 className="text-2xl font-black tracking-[-0.03em] text-foreground">결제가 완료되었습니다</h1>
                  <p className="mt-2 text-sm text-muted-foreground">
                    나이스페이 결제가 정상 승인되었습니다. 예약 내역을 확인해 주세요.
                  </p>
                </div>
                {/*
                  🔴 성공 갈래만 버튼이 하나였다 (2026-08-02, 대표 실사용 지적).
                  결제를 마친 손님이 행사 페이지로 돌아갈 길이 없었다 — 다른 날짜 티켓을
                  더 사려면(주중권 ↔ 주말권) 뒤로가기밖에 없다. 뒤로가기는 결제창으로
                  되돌아가는 경로라 쓸 수 없다.
                  같은 파일의 vbank_pending·오류 갈래는 처음부터 버튼이 둘이었다.
                */}
                <div className="flex justify-center gap-3">
                  <Button asChild>
                    <Link href={completeHref}>예약 내역 확인</Link>
                  </Button>
                  {eventHref ? (
                    <Button variant="outline" asChild>
                      <Link href={eventHref}>이벤트로 돌아가기</Link>
                    </Button>
                  ) : null}
                </div>
              </>
            ) : isVbankPending ? (
              <>
                <div className="mx-auto flex size-16 items-center justify-center rounded-full bg-warning/15 text-warning">
                  <Clock className="size-9" aria-hidden="true" />
                </div>
                <div>
                  <h1 className="text-2xl font-black tracking-[-0.03em] text-foreground">가상계좌 입금 대기 중</h1>
                  <p className="mt-2 text-sm text-muted-foreground">
                    가상계좌가 발급되었습니다. 안내된 계좌로 입금하시면 예약이 확정됩니다.
                    입금 확인 후 티켓이 발급되며, 입금 기한 내 미입금 시 예약은 자동 취소됩니다.
                  </p>
                </div>
                <div className="flex justify-center gap-3">
                  <Button asChild>
                    <Link href={completeHref}>예약 내역 확인</Link>
                  </Button>
                  {eventHref ? (
                    <Button variant="outline" asChild>
                      <Link href={eventHref}>이벤트로 돌아가기</Link>
                    </Button>
                  ) : null}
                </div>
              </>
            ) : (
              <>
                <div className="mx-auto flex size-16 items-center justify-center rounded-full bg-warning/15 text-warning">
                  <Clock className="size-9" aria-hidden="true" />
                </div>
                <div>
                  <h1 className="text-2xl font-black tracking-[-0.03em] text-foreground">결제 상태 확인 중</h1>
                  <p className="mt-2 text-sm text-muted-foreground">
                    결제 결과를 확인하고 있습니다. 잠시 후에도 예약이 보이지 않으면 문의해 주세요.
                  </p>
                  {reason ? (
                    <p className="mt-1 text-xs text-muted-foreground/70">상태: {reason}</p>
                  ) : null}
                </div>
                <div className="flex justify-center gap-3">
                  <Button asChild>
                    <Link href={completeHref}>예약 내역 확인</Link>
                  </Button>
                  <Button variant="outline" asChild>
                    <a href="mailto:support@pickket.kr">문의하기</a>
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
