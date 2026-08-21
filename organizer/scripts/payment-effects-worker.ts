/**
 * payment-effects 큐 워커 (H6 대응).
 *
 * 웹훅 핸들러가 enqueue한 주문 후처리를 비동기로 실행.
 * - notifyNewOrder (주최자 알림)
 * - notifySoldOut (매진 알림)
 * - dispatchWebhook (파트너 웹훅)
 *
 * 사용:
 *   npx tsx scripts/payment-effects-worker.ts
 *
 * 운영: K8s Deployment 또는 PM2 프로세스로 상시 기동.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createWorker } from "@/lib/queue/connection";
import type { PaymentEffectsJob } from "@/lib/queue/payment-effects-queue";
import { finalizePaymentEffects } from "@/lib/payment/webhook";
import { logger } from "@/lib/logger";

// .env.local 자동 로딩
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

const worker = createWorker<PaymentEffectsJob>(
  "payment-effects",
  async (job) => {
    const { orderId } = job.data;
    logger.info("[payment-effects-worker] 처리 시작", { jobId: job.id, orderId });
    await finalizePaymentEffects(orderId);
    logger.info("[payment-effects-worker] 처리 완료", { jobId: job.id, orderId });
  },
  { concurrency: 4 },
);

const workerWithEvents = worker as unknown as {
  on: (event: string, handler: (...args: unknown[]) => void) => void;
};

workerWithEvents.on("failed", (...args: unknown[]) => {
  const [job, err] = args as [{ id?: string; data: PaymentEffectsJob } | undefined, Error];
  logger.error("[payment-effects-worker] job 실패", {
    jobId: job?.id,
    orderId: job?.data?.orderId,
    error: err?.message,
  });
});

console.log("[payment-effects-worker] 기동 완료 — concurrency=4");

const handleShutdown = async (signal: string) => {
  console.log(`[payment-effects-worker] ${signal} 수신 — graceful shutdown`);
  await (worker as unknown as { close: () => Promise<void> }).close();
  process.exit(0);
};

process.on("SIGTERM", () => void handleShutdown("SIGTERM"));
process.on("SIGINT", () => void handleShutdown("SIGINT"));
