import { errorResponse, successResponse } from "@/lib/apiResponse";
import { getPool } from "@/lib/db/pool";
import { finishCronRun, startCronRun } from "@/lib/ops/cron-run";

/** 운영 telemetry 보존기간 정리와 stale running 원장 회수. 하루 1회 권장. */
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

  const retentionDays = Math.min(365, Math.max(7, Number(process.env.OPS_CRON_RETENTION_DAYS ?? 30) || 30));
  const staleMinutes = Math.min(24 * 60, Math.max(15, Number(process.env.OPS_CRON_STALE_MINUTES ?? 30) || 30));
  const pool = getPool();
  const cronRun = await startCronRun(pool, "ops-cleanup");
  try {
    const reclaimed = await pool.query(
      `UPDATE ops_cron_runs
          SET status = 'failed',
              finished_at = NOW(),
              error_summary = 'stale_lease_reclaimed',
              result = COALESCE(result, '{}'::jsonb) || jsonb_build_object('staleReclaimed', 1)
        WHERE status = 'running'
          AND started_at < NOW() - ($1::int * INTERVAL '1 minute')`,
      [staleMinutes],
    );
    const deleted = await pool.query(
      `DELETE FROM ops_cron_runs
        WHERE finished_at IS NOT NULL
          AND finished_at < NOW() - ($1::int * INTERVAL '1 day')`,
      [retentionDays],
    );
    const result = { retentionDays, staleMinutes, staleReclaimed: reclaimed.rowCount ?? 0, telemetryDeleted: deleted.rowCount ?? 0 };
    await finishCronRun(pool, cronRun, "succeeded", result);
    return successResponse(result);
  } catch (error) {
    await finishCronRun(pool, cronRun, "failed", undefined, error);
    return errorResponse("운영 telemetry 정리에 실패했습니다", 500);
  }
}
