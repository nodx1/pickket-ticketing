/**
 * 도달결과(DLR) 대사 cron — provider 상태조회로 sent→delivered/failed 교정 + unknown 대사.
 * 인증: Authorization: Bearer ${CRON_SECRET}. 권장 주기 5분.
 *
 * ── 레벨2 컷오버 W5-MSG ─────────────────────────────────────────────────────
 * 원장은 v2 소유. 이 라우트는 **provider 조회 arm** 만 담당한다(dlr.ts 주석 참조).
 *
 * 위임한 것(= 여기서 더 이상 안 하는 것):
 *   · stale 'sending' 고아행 스윕 + 부모 재큐잉 → v2 celery `reconcile_deliveries` 단독 소유.
 *     go 가 같이 스윕하면 같은 행을 두 주체가 정정한다.
 *   · 오픈/클릭 집계 캐시 갱신 → v2 트래킹 엔드포인트가 기록 시점에 원장을 갱신하므로
 *     별도 배치 재집계가 불필요(캠페인 stats 는 조회 시 실측 COUNT).
 *
 * 남긴 것: SENS/Mailer 상태조회(go 에만 있는 provider 클라이언트) → 결과를 v2 로 반영.
 *
 * 🔴 fail-closed: v2 원장 호출 실패는 삼키지 않고 502 로 끊는다. 200 + "checked:0" 으로
 *   응답하면 크론 감시가 정상으로 오독해 미확정 발송이 조용히 쌓인다.
 */
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { getPool } from "@/lib/db/pool";
import { reconcileDeliveries, reconcileUnknownDeliveries } from "@/lib/notification/dlr";
import { logger } from "@/lib/logger";
import { finishCronRun, startCronRun } from "@/lib/ops/cron-run";
import { V2MessagingLedgerError } from "@/lib/v2/messaging-ledger-client";

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET ?? "";
  const authHeader = request.headers.get("authorization") ?? "";
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return errorResponse("인증 정보가 올바르지 않습니다", 401);
  }

  // ops_cron_runs 는 go 운영 테이블(이 트랙 소유 아님) — 크론 실행 증적은 그대로 남긴다.
  const pool = getPool();
  const cronRun = await startCronRun(pool, "reconcile-deliveries");
  try {
    let ledgerUnavailable: string | null = null;

    let dlr = { checked: 0, delivered: 0, failed: 0 };
    try {
      dlr = await reconcileDeliveries(50);
    } catch (err: unknown) {
      // 원장 장애든 예상 못한 버그든, 대사가 **안 돈** 사실은 감춘다고 나아지지 않는다.
      ledgerUnavailable =
        err instanceof V2MessagingLedgerError
          ? err.message
          : err instanceof Error
            ? err.message
            : "unknown";
      logger.error("DLR 대사 실패", { error: err instanceof Error ? err.message : "unknown" });
    }

    let unknown = { checked: 0, resolved: 0, manualReview: 0, remaining: 0 };
    try {
      unknown = await reconcileUnknownDeliveries(50);
    } catch (err: unknown) {
      // 원장 장애든 예상 못한 버그든, 대사가 **안 돈** 사실은 감춘다고 나아지지 않는다.
      ledgerUnavailable =
        err instanceof V2MessagingLedgerError
          ? err.message
          : err instanceof Error
            ? err.message
            : "unknown";
      logger.error("unknown delivery 대사 실패", {
        error: err instanceof Error ? err.message : "unknown",
      });
    }

    const result = { dlr, unknown, sweepDelegatedToV2: true };

    if (ledgerUnavailable) {
      // 원장에 닿지 못한 tick 을 "성공"으로 기록하지 않는다 — 대사가 멈춘 사실을 드러낸다.
      await finishCronRun(pool, cronRun, "failed", result, new Error(ledgerUnavailable));
      return errorResponse(`발송 원장에 연결할 수 없어 대사를 건너뛰었습니다: ${ledgerUnavailable}`, 502);
    }

    await finishCronRun(pool, cronRun, "succeeded", result);
    return successResponse(result);
  } catch (error) {
    await finishCronRun(pool, cronRun, "failed", undefined, error);
    throw error;
  }
}
