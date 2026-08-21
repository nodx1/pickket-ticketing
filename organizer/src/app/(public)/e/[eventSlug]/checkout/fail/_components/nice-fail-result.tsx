import Link from "next/link";
import { XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { checkoutLandingLinks } from "@/lib/public/checkout-landing";

/** 나이스 v2 return 실패 사유 → 사용자 안내 문구(reason 계약). */
const NICE_REASON_MESSAGE: Record<string, string> = {
  signature_invalid: "결제 검증에 실패했습니다. 결제가 정상적으로 처리되지 않았습니다. 다시 시도해 주세요.",
  amount_mismatch: "결제 금액이 주문 금액과 일치하지 않아 결제가 취소되었습니다. 다시 시도해 주세요.",
  auth_failed: "결제 인증에 실패했습니다. 다시 시도해 주세요.",
  order_not_found: "주문 정보를 찾을 수 없습니다. 처음부터 다시 시도해 주세요.",
  approval_failed: "결제 승인이 거절되었습니다. 카드사 사정 등으로 승인되지 않았을 수 있습니다.",
  user_cancel: "결제가 취소되었습니다. 결제를 다시 진행하시려면 아래 버튼을 눌러주세요.",
};

interface NiceFailResultProps {
  /** 이벤트 slug. 이벤트-비의존 go 착지에서 해석 실패 시 빈 문자열 → 홈 폴백. */
  eventSlug: string;
  /** nicepay(true) / toss·기타(false) 판별. */
  isNice: boolean;
  reason?: string;
  code?: string;
  message?: string;
}

/**
 * 결제 실패/취소 결과 표시(공용). 이벤트-스코프 fail 페이지와 이벤트-비의존 go 착지 라우트가 공유.
 * 주문은 pending 유지되므로 재시도 안내만 한다.
 */
export function NiceFailResult({ eventSlug, isNice, reason, code, message }: NiceFailResultProps) {
  const isUserCancel = isNice
    ? reason === "user_cancel"
    : code === "PAY_PROCESS_CANCELED" || code === "USER_CANCEL";

  const heading = isUserCancel ? "결제가 취소되었습니다" : "결제에 실패했습니다";
  const detail = isNice
    ? (reason && NICE_REASON_MESSAGE[reason]) ??
      "결제 처리 중 문제가 발생했습니다. 다시 시도해 주세요."
    : isUserCancel
      ? "결제를 다시 진행하시려면 아래 버튼을 눌러주세요."
      : (message ?? "결제 처리 중 문제가 발생했습니다. 다시 시도해 주세요.");

  // 진단용 코드 표기(사용자 취소는 숨김).
  const diagnosticCode = isNice ? reason : code;

  // 🔴 slug 를 몰라도 **홈으로 보내지 않는다** (2026-08-04). 「다시 시도」가 홈으로 가면
  //    손님은 결제창이 열릴 줄 알고 눌렀다가 랜딩을 본다. 갈 곳을 모르면 안 그린다.
  const { eventHref, retryHref, orderHref } = checkoutLandingLinks(eventSlug);

  return (
    <div className="min-h-screen bg-background px-4 py-10">
      <div className="mx-auto mt-6 max-w-lg">
        <Card className="border-border bg-card/95">
          <CardContent className="space-y-6 p-8 text-center">
            <div className="mx-auto flex size-16 items-center justify-center rounded-full bg-destructive/15 text-destructive">
              <XCircle className="size-9" />
            </div>
            <div>
              <h1 className="text-2xl font-black tracking-[-0.03em] text-foreground">{heading}</h1>
              <p className="mt-2 text-sm text-muted-foreground">{detail}</p>
              {diagnosticCode && !isUserCancel ? (
                <p className="mt-1 text-xs text-muted-foreground/70">오류코드: {diagnosticCode}</p>
              ) : null}
            </div>
            <div className="flex justify-center gap-3">
              {retryHref ? (
                <Button asChild>
                  <Link href={retryHref}>다시 시도</Link>
                </Button>
              ) : null}
              {eventHref ? (
                <Button variant="outline" asChild>
                  <Link href={eventHref}>이벤트로 돌아가기</Link>
                </Button>
              ) : (
                // 행사를 특정할 수 없을 때의 유일한 유효 목적지 — 홈이 아니다.
                <Button variant="outline" asChild>
                  <Link href={orderHref}>내 티켓 조회</Link>
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
