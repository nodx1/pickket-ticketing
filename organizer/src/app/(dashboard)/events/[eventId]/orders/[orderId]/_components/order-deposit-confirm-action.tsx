"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatKRW } from "@/lib/format";
import { fetchWithRefresh } from "@/lib/fetchWithAuth";

interface OrderDepositConfirmActionProps {
  eventId: string;
  orderId: string;
  amount: number;
}

/**
 * 무통장입금 입금확정 (주최자 전용).
 *
 * 구매자는 무통장입금을 self-complete 할 수 없고 입금대기로만 남는다(감사 P0-F).
 * 주최자가 계좌에서 실입금을 확인한 뒤 이 버튼으로 주문을 확정 → 결제완료 + 티켓 발급.
 */
export function OrderDepositConfirmAction({
  eventId,
  orderId,
  amount,
}: OrderDepositConfirmActionProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleConfirm() {
    // 🔴 재진입 가드 — 확정 시 티켓이 발급된다. 두 번 눌리면 중복 발권 위험.
    if (loading) return;
    setLoading(true);
    setMessage(null);

    try {
      const response = await fetchWithRefresh(`/api/events/${eventId}/orders/${orderId}/confirm-deposit`, {
        method: "POST",
        credentials: "include",
      });

      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        setMessage(payload.error ?? "입금확정에 실패했습니다.");
      } else {
        setMessage("입금이 확정되어 티켓이 발급되었습니다.");
      }
    } catch {
      // 🔴 응답을 못 받은 경우 — 확정·발권이 됐는지 알 수 없다 (2026-07-30 감사).
      //    옛 화면을 보고 재시도하면 중복 발권 위험이 있어, 결과를 확인하라고 안내한다.
      setMessage(
        "입금확정 결과를 확인할 수 없습니다. 주문 상태를 확인한 뒤 다시 시도해주세요.",
      );
    }
    // 성공·실패 모두 서버 상태를 다시 읽는다. 실제로 확정됐다면 상태가 갱신돼 확정 버튼이
    // 사라진다 — 옛 화면 기준 재시도를 구조적으로 막는다.
    router.refresh();

    setOpen(false);
    setLoading(false);
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-foreground">무통장입금 확인</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg border border-border bg-muted p-5">
            <p className="text-sm text-muted-foreground">
              계좌에서 실입금을 확인한 뒤 입금확정을 진행하세요. 확정 시 결제가 완료되고 티켓이 발급됩니다.
            </p>
            <p className="mt-2 text-2xl font-black tracking-[-0.04em] text-foreground">{formatKRW(amount)}</p>
            <p className="mt-2 text-sm text-muted-foreground">입금 예정 금액</p>
          </div>
          {message ? <p className="text-sm text-muted-foreground">{message}</p> : null}
          <div className="flex justify-end">
            <Button disabled={loading} onClick={() => setOpen(true)}>
              입금확정
            </Button>
          </div>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={open}
        title="입금을 확정할까요?"
        description={`${formatKRW(amount)} 입금을 확인했습니다. 확정 시 결제 완료 처리되고 티켓이 발급됩니다.`}
        confirmText="입금확정"
        onConfirm={() => void handleConfirm()}
        onOpenChange={setOpen}
        pending={loading}
      />
    </>
  );
}
