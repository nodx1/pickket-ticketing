import { errorResponse, successResponse } from "@/lib/apiResponse";
import { ERR } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { getPool } from "@/lib/db/pool";
import { finishCronRun, startCronRun } from "@/lib/ops/cron-run";
import { reconcilePayments, reconcileOrphanTossPendingPayments } from "@/lib/payment/reconcile";
import { processExpiredPaymentCompensations, reconcileUnknownCompensations } from "@/lib/payment/compensation";
import { reconcileOrderState } from "@/lib/orders/reconcile-order-state";

/**
 * 결제확정 대사 cron (감사 P1-3/P1-4).
 *
 * confirm-v2 write-through 가 실패해 v2 매출이 누락된 주문(go=completed·v2 미확정)을 주기적으로
 * 재확정한다. reconcilePayments 로직·멱등키는 이미 견고하나 실제 배선(cron)이 없어 드리프트가
 * 영구 미복구였다. 5분 주기 배포 권장(infra/cron/payment-reconcile.yaml).
 *
 * CRON_SECRET Bearer 가드 + timestamp freshness(±5분).
 */
export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET ?? "";
  const authHeader = request.headers.get("authorization") ?? "";
  const timestamp = request.headers.get("x-cron-timestamp") ?? "";

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return errorResponse("인증 정보가 올바르지 않습니다", 401);
  }

  if (timestamp) {
    const requestTime = new Date(timestamp).getTime();
    if (Number.isNaN(requestTime) || Math.abs(Date.now() - requestTime) > 300_000) {
      return errorResponse("요청 시간이 만료되었습니다", 401);
    }
  }

  const pool = getPool();
  const cronRun = await startCronRun(pool, "payment-reconcile");
  try {
    // 🔴 순서가 계약이다 — **보상 드레인보다 먼저** 역방향 대사를 돌린다.
    //
    // 이 크론의 아래 `processExpiredPaymentCompensations()` 는 큐에 쌓인 보상건을
    // 실제 PG 환불로 집행한다(`compensation.ts` → `refundOrder({full:true})`).
    // v2→go 전파가 유실돼 결제 주문이 go 에서 만료돼 있었다면 그 큐에는 **정당한 결제**가
    // 들어 있을 수 있다. 대사가 먼저 돌아 repair 하면서 그 큐를 취소하므로,
    // 순서를 뒤집으면 같은 tick 에서 **돈이 먼저 나간다.**
    //
    // (같은 이유로 이 크론은 expire-orders 보다 먼저 도는 편이 낫다 — 실측 4초 차.)
    const orderStateReconcile = await reconcileOrderState();

    const summary = await reconcilePayments();
    const compensation = await processExpiredPaymentCompensations();
    const compensationReconciliation = await reconcileUnknownCompensations();
    // P0-3: orphan Toss pending(PG 캡처·go pending) 회수 → 환불 보상큐.
    const orphanToss = await reconcileOrphanTossPendingPayments();

    // 미복구분 판정: 재confirm 실패·v2 조회 실패·manual_review·orphan 조회실패가 남으면 degraded.
    const degraded =
      summary.failed > 0 || summary.lookupFailed > 0 || summary.manualReview > 0 ||
      compensation.failed > 0 || compensation.unknown > 0 || compensation.manualReview > 0 ||
      compensationReconciliation.manualReview > 0 || orphanToss.lookupFailed > 0 ||
      // 🔴 전파 유실 보정이 실패했거나 v2 에 못 물어본 건이 남으면 degraded — 조용히 넘기면
      //    결제된 주문이 계속 뒤처진 채 남는다.
      orderStateReconcile.undecidable > 0 || orderStateReconcile.notifyFailed > 0;

    // 재confirm 실패분 또는 v2 조회 실패분이 남으면 경보성 로그 → Sentry/모니터링 포착. (감사 P1-4)
    if (degraded) {
      logger.error("[payment-reconcile] 결제확정 대사 미복구분 존재 — 조사 필요", {
        source: "payment-reconcile",
        scanned: summary.scanned,
        mismatched: summary.mismatched,
        repaired: summary.repaired,
        failed: summary.failed,
        lookupFailed: summary.lookupFailed,
        manualReview: summary.manualReview,
        backfilled: summary.backfilled,
        compensation,
        compensationReconciliation,
        orphanToss,
        orderStateReconcile,
      });
    } else {
      logger.info("[payment-reconcile] 대사 완료", {
        source: "payment-reconcile",
        scanned: summary.scanned,
        repaired: summary.repaired,
        backfilled: summary.backfilled,
        compensation,
        compensationReconciliation,
        orphanToss,
        orderStateReconcile,
      });
    }

    const result = {
      scanned: summary.scanned,
      healthy: summary.healthy,
      mismatched: summary.mismatched,
      repaired: summary.repaired,
      failed: summary.failed,
      lookupFailed: summary.lookupFailed,
      manualReview: summary.manualReview,
      backfilled: summary.backfilled,
      compensation,
      compensationReconciliation,
      orphanToss,
      // 🔴 이 값이 0 이 아니면 v2→go 전파가 새고 있다는 뜻이다. 응답에 담아야
      //    크론 감시(ops_cron_runs)에서 보인다 — 로그에만 있으면 아무도 안 본다.
      orderStateReconcile,
      degraded,
    };
    // P1: 미복구분이 남으면 cron 실행을 성공으로 위장하지 않는다 — degraded 상태를 전파(비200/degraded).
    await finishCronRun(pool, cronRun, degraded ? "degraded" : "succeeded", result);
    if (degraded) {
      return new Response(JSON.stringify({ success: false, data: result }), {
        status: 207,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }
    return successResponse(result);
  } catch (err: unknown) {
    await finishCronRun(pool, cronRun, "failed", undefined, err);
    if (err instanceof Error) {
      logger.error("[payment-reconcile] 대사 실행 실패", {
        source: "payment-reconcile",
        error: err.message,
      });
    }
    return errorResponse(ERR.SERVER, 500);
  }
}
