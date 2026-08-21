/**
 * payment-confirm 큐 워커 (레벨2 재감사 P1).
 *
 * confirmPaymentToV2 가 v2 confirm 에 실패하면 outbox 를 pending 으로 남기고, 호출부가 이 큐에
 * enqueue 한다. 워커는 트리거를 받으면 outbox 를 drain 해 동일 멱등키로 재confirm 한다.
 *
 * ⚠️ job.data.orderId 는 힌트일 뿐 — 실제 처리는 outbox(DB) 를 스캔한다. 그래서 큐 유실이
 *    나도 payment-reconcile cron 이 같은 drain 을 돌려 결국 수렴한다(이중 안전망).
 *
 * 사용:
 *   npx tsx scripts/payment-confirm-worker.ts
 *
 * 운영: PM2/K8s Deployment 로 상시 기동(payment-effects-worker 와 동형).
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createWorker } from "@/lib/queue/connection";
import type { PaymentConfirmJob } from "@/lib/queue/payment-confirm-queue";
import { processPaymentConfirmOutbox } from "@/lib/payment/confirm-outbox";
import { logger } from "@/lib/logger";

// .env.local 자동 로딩(payment-effects-worker 와 동일 패턴)
const envLocalPath = path.resolve(process.cwd(), ".env.local");
if (fs.existsSync(envLocalPath)) {
  for (const line of fs.readFileSync(envLocalPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

const worker = createWorker<PaymentConfirmJob>(
  "payment-confirm",
  async (job) => {
    const { orderId } = job.data;
    logger.info("[payment-confirm-worker] 처리 시작", { jobId: job.id, orderId });
    // outbox 를 drain — job 의 orderId 는 트리거 힌트, 실제 대상은 pending/failed 전부.
    const summary = await processPaymentConfirmOutbox();
    logger.info("[payment-confirm-worker] 처리 완료", {
      jobId: job.id,
      orderId,
      confirmed: summary.confirmed,
      failed: summary.failed,
      manualReview: summary.manualReview,
    });
  },
  { concurrency: 4 },
);

const workerWithEvents = worker as unknown as {
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  close: () => Promise<void>;
};

workerWithEvents.on("failed", (...args: unknown[]) => {
  const [job, err] = args as [{ id?: string; data: PaymentConfirmJob } | undefined, Error];
  logger.error("[payment-confirm-worker] job 실패", {
    jobId: job?.id,
    orderId: job?.data?.orderId,
    error: err?.message,
  });
});

console.log("[payment-confirm-worker] 기동 완료 — concurrency=4");

const handleShutdown = async (signal: string) => {
  console.log(`[payment-confirm-worker] ${signal} 수신 — graceful shutdown`);
  await workerWithEvents.close();
  process.exit(0);
};

process.on("SIGTERM", () => void handleShutdown("SIGTERM"));
process.on("SIGINT", () => void handleShutdown("SIGINT"));
