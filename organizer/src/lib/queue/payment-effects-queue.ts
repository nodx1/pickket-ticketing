import { createQueue } from "@/lib/queue/connection";

/**
 * 결제 성공 후처리 큐 (H6 대응).
 *
 * 웹훅 핸들러가 notifyNewOrder / notifySoldOut / dispatchWebhook을 동기 실행하면
 * 알림·파트너 웹훅 발송이 PG 타임아웃(5~10초)을 초과해 재시도 루프가 발생할 수 있음.
 * 이 큐에 enqueue만 하고 200 즉시 반환 → worker가 별도로 처리.
 *
 * 큐 이름: go:payment-effects (prefix="go"로 자동 네임스페이스됨)
 * 워커: scripts/payment-effects-worker.ts (별도 프로세스로 실행)
 */

export interface PaymentEffectsJob {
  orderId: string;
}

let queueInstance: ReturnType<typeof createQueue> | null = null;

export function getPaymentEffectsQueue() {
  if (!queueInstance) {
    queueInstance = createQueue("payment-effects");
  }
  return queueInstance;
}

export async function enqueuePaymentEffects(orderId: string) {
  const queue = getPaymentEffectsQueue();
  await queue.add(
    "finalize",
    { orderId } satisfies PaymentEffectsJob,
    {
      // 주문당 1회 처리 — idempotency 보강
      jobId: `finalize:${orderId}`,
      // 실패 시 3회 재시도, 지수 백오프
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  );
}
