import { createQueue } from "@/lib/queue/connection";
import { logger } from "@/lib/logger";

/**
 * 결제 확정(confirm) v2 write-through 재조정 큐 (레벨2 재감사 P1).
 *
 * recordPaymentConfirmOutbox 가 go COMMIT 과 원자적으로 pending outbox 행을 남긴다(외부호출 0).
 * 호출부(toss confirm·webhook·order-finalize)는 COMMIT 후 pending 행이 있으면 이 큐에 enqueue 만 하고
 * 즉시 반환한다. 워커(scripts/payment-confirm-worker.ts)가 pending 을 클레임해 **트랜잭션 밖**에서
 * 동일 멱등키로 v2 confirm 한다(역 split-brain 불가 — v2 호출은 항상 커밋 후).
 *
 * ⚠️ 이 큐는 **가속기**일 뿐이다 — 유실이 나도 payment-reconcile cron 이 outbox 를 drain 하므로
 *    (이중 안전망) 데이터 일관성은 큐 생존에 의존하지 않는다. Redis 장애 시 enqueue 실패는
 *    조용히 삼켜도 안전(다음 cron 주기가 처리).
 *
 * 큐 이름: go:payment-confirm
 */

export interface PaymentConfirmJob {
  orderId: string;
}

let queueInstance: ReturnType<typeof createQueue> | null = null;

export function getPaymentConfirmQueue() {
  if (!queueInstance) {
    queueInstance = createQueue("payment-confirm");
  }
  return queueInstance;
}

/**
 * outbox pending 행의 재confirm 을 큐잉한다.
 * 유일 진실은 outbox(DB) — 큐는 즉시 처리 트리거일 뿐이라 enqueue 실패는 로그만 남기고 삼킨다.
 * (cron 이중 안전망이 결국 처리하므로 결제 흐름을 절대 막지 않는다.)
 */
export async function enqueuePaymentConfirm(orderId: string): Promise<void> {
  try {
    const queue = getPaymentConfirmQueue();
    await queue.add(
      "confirm",
      { orderId } satisfies PaymentConfirmJob,
      {
        // 주문당 1작업 — 중복 enqueue 를 BullMQ 가 dedupe. (실제 멱등은 outbox+v2 가 보장)
        jobId: `pay-confirm:${orderId}`,
        attempts: 3,
        backoff: { type: "exponential", delay: 5_000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    );
  } catch (err: unknown) {
    logger.warn("[payment-confirm] enqueue 실패 — cron 이중 안전망에 위임", {
      orderId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
