import * as Sentry from "@sentry/nextjs";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { getPool } from "@/lib/db/pool";
import { logger } from "@/lib/logger";
import { finishCronRun, startCronRun } from "@/lib/ops/cron-run";
import { processAuditOutbox } from "@/lib/audit/outbox";

/**
 * 감사(audit) 트랜잭션 아웃박스 드레인 cron — 레벨2 코덱스 재감사 P1.
 *
 * go 고유 감사쓰기 4곳(seats/audit·webhooks/replay·payment-compensations·message-deliveries)이
 * 상태변경과 동일 txn 으로 audit_outbox 에 적재한 행을 v2 /internal/audit-logs 로 드레인한다.
 * 1분 주기 권장(infra/cron/drain-audit-outbox.yaml). 큐/워커가 없어도 이 cron 이 유일 안전망.
 *
 * CRON_SECRET Bearer 가드. 드레인 자체는 lease + SKIP LOCKED 라 동시 2회 실행 안전.
 */
export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET ?? "";
  const authHeader = request.headers.get("authorization") ?? "";
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return errorResponse("인증 정보가 올바르지 않습니다", 401);
  }

  const pool = getPool();
  const cronRun = await startCronRun(pool, "drain-audit-outbox");
  try {
    const summary = await processAuditOutbox(200);
    const degraded = summary.dead > 0 || summary.failed > 0;
    // 조용한 유실 금지 — dead/failed 는 감사 유실 위험이므로 cron 상태·HTTP·Sentry 모두 경보.
    if (degraded) {
      logger.error("[drain-audit-outbox] 미전송 감사 존재 — 조사 필요", {
        source: "drain-audit-outbox",
        ...summary,
      });
      try {
        Sentry.captureMessage("[audit] audit_outbox 미전송 행 존재", {
          level: "error",
          tags: { audit_alert: "outbox_delivery" },
          extra: { ...summary },
        });
      } catch (alertError: unknown) {
        logger.warn("[drain-audit-outbox] Sentry 캡처 실패(무시)", {
          error: alertError instanceof Error ? alertError.message : String(alertError),
        });
      }
    }
    await finishCronRun(pool, cronRun, degraded ? "degraded" : "succeeded", summary);
    if (degraded) {
      return new Response(JSON.stringify({ success: false, data: { ...summary, degraded: true } }), {
        status: 207,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }
    return successResponse(summary);
  } catch (error) {
    await finishCronRun(pool, cronRun, "failed", undefined, error);
    return errorResponse("감사 아웃박스 드레인에 실패했습니다", 500);
  }
}
