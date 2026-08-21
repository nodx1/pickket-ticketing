import { errorResponse, successResponse } from "@/lib/apiResponse";
import { getPool } from "@/lib/db/pool";
import { logger } from "@/lib/logger";
import { finishCronRun, startCronRun } from "@/lib/ops/cron-run";
import { processWaitlistClaimRecovery } from "@/lib/waitlist/claim-recovery-drain";

/**
 * 대기자 claim 복구 큐 드레인 cron — 레벨2 재감사 P1(waitlist recovery drain).
 *
 * 공개 claim 라우트가 claim-commit 실패 시 waitlist_claim_recovery(mig229)에 pending 으로 남긴 행을
 * 동일 orderId 로 재-commit(멱등 앵커 수렴)한다. 이 cron 이 큐의 유일 소비자다 — 안 돌면
 * converted_order_id=NULL 이 영구잔류(주문↔대기자 연결끊김). 1분 주기 권장
 * (infra/cron/drain-waitlist-recovery.yaml).
 *
 * CRON_SECRET Bearer 가드. 드레인 자체는 lease + SKIP LOCKED 라 동시 2회 실행 안전.
 * failed(재시도 대기) 또는 manualReview(재-commit 최종 실패)가 남으면 degraded(207)로 전파 —
 * 복구 큐 미수렴을 성공으로 위장하지 않는다.
 */
export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET ?? "";
  const authHeader = request.headers.get("authorization") ?? "";
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return errorResponse("인증 정보가 올바르지 않습니다", 401);
  }

  const pool = getPool();
  const cronRun = await startCronRun(pool, "drain-waitlist-recovery");
  try {
    const summary = await processWaitlistClaimRecovery(100);
    // 미복구분 판정: 일시 failed도 현재 실행에서는 미수렴이므로 degraded. 큐의 백오프 재시도는 유지한다.
    const degraded = summary.failed > 0 || summary.manualReview > 0;

    if (summary.manualReview > 0) {
      // 조용한 실패 금지 — manual_review 는 주문↔대기자 split-brain 이므로 경보성 로그(Sentry 는 drain 내부).
      logger.error("[drain-waitlist-recovery] 미복구 claim 존재 — 조사 필요", {
        source: "drain-waitlist-recovery",
        ...summary,
      });
    } else if (summary.failed > 0) {
      logger.warn("[drain-waitlist-recovery] 재-commit 재시도 대기분 존재", {
        source: "drain-waitlist-recovery",
        ...summary,
      });
    }

    await finishCronRun(pool, cronRun, degraded ? "degraded" : "succeeded", summary);
    if (degraded) {
      return new Response(JSON.stringify({ success: false, data: summary }), {
        status: 207,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }
    return successResponse(summary);
  } catch (error) {
    await finishCronRun(pool, cronRun, "failed", undefined, error);
    logger.error("[drain-waitlist-recovery] 드레인 실행 실패", {
      source: "drain-waitlist-recovery",
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse("대기자 복구 큐 드레인에 실패했습니다", 500);
  }
}
