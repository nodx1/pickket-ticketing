"use client";

import { useRouter } from "next/navigation";
import { fetchWithRefresh } from "@/lib/fetchWithAuth";
import { useState } from "react";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatKRW } from "@/lib/format";

interface OrderRefundActionProps {
  eventId: string;
  orderId: string;
  policyLabel: string;
  refundPercent: number;
  refundAmount: number;
  canRefund: boolean;
}

export function OrderRefundAction({
  eventId,
  orderId,
  policyLabel,
  refundPercent,
  refundAmount,
  canRefund,
}: OrderRefundActionProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleRefund() {
    // 🔴 재진입 가드 — 돈이 나가는 호출이다 (2026-07-29 감사).
    //    v2 멱등 캐시는 성공 응답만 저장하고 선점 락이 없어, 같은 멱등키의 두 요청이
    //    나란히 들어가면 2차가 갱신된 잔여액으로 재검증을 통과해 **같은 금액을 또 집행**한다.
    //    자동 재시도는 이미 retries:0 으로 막았지만 사람이 두 번 누르는 경로는 열려 있었다.
    if (loading) return;
    setLoading(true);
    setMessage(null);

    try {
      const response = await fetchWithRefresh(`/api/events/${eventId}/orders/${orderId}/refund`, {
        method: "POST",
        credentials: "include",
      });

      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        setMessage(payload.error ?? "환불 처리에 실패했습니다.");
      } else {
        setMessage("환불 처리가 완료되었습니다.");
      }
    } catch {
      // 🔴 응답을 못 받은 경우 — 서버가 환불을 집행했는지 **알 수 없다** (2026-07-30 감사).
      //    부분환불은 status 가 `partially_refunded` 로 남아 재시도 게이트를 통과하고,
      //    멱등키가 누적 환불액 파생(`go-refund:{orderId}:{alreadyRefunded+amount}`)이라
      //    서버가 이미 집행한 뒤 재시도하면 **키가 달라져 멱등이 걸리지 않는다** →
      //    잔액의 N% 가 한 번 더 환불된다. (전액환불은 status=refunded 라 go 400 에서 끊긴다.)
      setMessage(
        "환불 처리 결과를 확인할 수 없습니다. 아래 환불 내역을 확인한 뒤 다시 시도해주세요.",
      );
    }
    // 성공·실패 모두 서버 상태를 다시 읽는다. 실제로 환불됐다면 환불액·상태가 갱신돼
    // 재시도 버튼이 사라지거나 금액이 줄어든 채 보인다 — 옛 화면 기준 재시도를 구조적으로 막는다.
    // ※ 클라이언트 state(message)는 refresh 로 지워지지 않는다 — 프로덕션 빌드로 실측 확인.
    router.refresh();

    setOpen(false);
    setLoading(false);
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-foreground">환불 규정</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg border border-border bg-muted p-5">
            <p className="text-sm text-muted-foreground">{policyLabel}</p>
            <p className="mt-2 text-2xl font-black tracking-[-0.04em] text-foreground">{refundPercent}% 환불</p>
            <p className="mt-2 text-sm text-muted-foreground">예상 환불액 {formatKRW(refundAmount)}</p>
          </div>
          {message ? <p className="text-sm text-muted-foreground">{message}</p> : null}
          <div className="flex justify-end">
            <Button variant="outline" disabled={!canRefund || loading} onClick={() => setOpen(true)}>
              환불하기
            </Button>
          </div>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={open}
        title="환불을 진행할까요?"
        description={`${policyLabel} 기준으로 ${refundPercent}% 환불됩니다.`}
        confirmText="환불 진행"
        onConfirm={() => void handleRefund()}
        onOpenChange={setOpen}
        pending={loading}
      />
    </>
  );
}
