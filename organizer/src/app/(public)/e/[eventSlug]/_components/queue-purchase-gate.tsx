"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { QueueWaiting, type QueueAdmission } from "./queue-waiting";
import { canEnterPurchase, purchaseGateLabel, shouldJoinQueue } from "@/lib/public/purchase-gate";

export const QUEUE_ADMISSION_PREFIX = "pickket-queue-admission:";
export const QUEUE_ADMISSION_EVENT = "pickket:queue-admission";

/**
 * 구매 버튼 — 대기열을 **쓰는 행사에서만** 대기열 뒤에 둔다.
 *
 * ## 🔴 왜 `queueEnabled` 를 받는가 (2026-08-01)
 * 종전엔 이 컴포넌트가 대기열 사용 여부와 **무관하게** 항상 잠긴 채 시작했고,
 * `POST .../queue/join` 이 성공해야 열렸다. 그 요청은 내부에서 v2 를 부른다.
 *
 *     v2 가 한 번 흔들린다 → join 실패 → ready 는 false 로 남는다
 *     → 버튼은 "구매 대기열 확인 중..." 인 채 **영구히 잠긴다**(재시도 없음)
 *     → 그런데 페이지 본문은 SSR 이라 멀쩡히 보인다
 *     ⟹ **"페이지는 되는데 못 사는" 상태.** 손님은 고장난 줄도 모르고 나간다
 *
 * 이 행사는 대기열을 쓰지 않는다. **안 쓰는 기능 때문에 결제가 잠기는 구조 자체가 틀렸다.**
 * `queueEnabled` 가 꺼져 있으면 요청을 아예 보내지 않는다 — 실패할 요청이 없어진다.
 *
 * ## ⚠️ 이 낙관적 개방이 안전한 근거 (심증 아님 — 서버 코드로 확인)
 * 진짜 관문은 화면이 아니라 서버다. `api/checkout/initiate/route.ts:234` 가
 * **v2 에서 직접 읽은** `eventDetail.queue_enabled` 로 판단하고, 켜져 있으면
 * 입장 토큰이 없을 때 403 을 낸다(`eventDetail = await getEvent(body.eventId)` — 본문 값이
 * 아니라 서버 조회라 클라이언트가 속일 수 없다). 즉 이 값이 거짓으로 꺼져 있어도
 * **대기열이 무력화되지 않는다.**
 */
export function QueuePurchaseGate({
  eventId,
  eventSlug,
  soldOut,
  label,
  queueEnabled,
}: {
  eventId: string;
  eventSlug: string;
  soldOut: boolean;
  label: string;
  /** 대기열 사용 여부(v2 정본). 꺼져 있으면 대기열 왕복 자체를 하지 않는다. */
  queueEnabled: boolean;
}) {
  const [admitted, setAdmitted] = useState(false);
  // 판정은 한 곳(`lib/public/purchase-gate`)에서만 한다 — 이 컴포넌트와 스티키 바가
  // 각자 판단하다가 한쪽만 고쳐지는 것이 이번 결함의 모양이었다.
  const open = canEnterPurchase({ queueEnabled, soldOut, admitted });
  const lockedLabel = purchaseGateLabel({ queueEnabled, soldOut, admitted });
  const activate = useCallback(
    (admission: QueueAdmission) => {
      sessionStorage.setItem(
        `${QUEUE_ADMISSION_PREFIX}${eventId}`,
        JSON.stringify(admission),
      );
      window.dispatchEvent(
        new CustomEvent(QUEUE_ADMISSION_EVENT, {
          detail: { eventId, admission },
        }),
      );
      setAdmitted(true);
    },
    [eventId],
  );

  return (
    <>
      <div data-cta-original>
        <Button asChild={open} size="lg" className="w-full text-base font-bold" disabled={!open}>
          {open ? <Link href={`/e/${eventSlug}/checkout`}>{label}</Link> : <span>{lockedLabel}</span>}
        </Button>
      </div>
      {shouldJoinQueue({ queueEnabled, soldOut }) ? (
        <QueueWaiting eventId={eventId} onActivated={activate} />
      ) : null}
    </>
  );
}
