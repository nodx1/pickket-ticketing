/**
 * Owner-only operational snapshot for durable recovery queues.
 * This endpoint is read-only and intentionally returns counts/ages only;
 * recipient addresses, payloads, and payment secrets never leave the DB.
 */
import { withRole } from "@/lib/auth/permissions";
import { getPool } from "@/lib/db/pool";
import { successResponse, errorResponse } from "@/lib/apiResponse";
// W5-MSG: 발송 원장은 v2 소유 — 메시지 큐 집계만 v2 경유. 나머지 3종(결제보상·웹훅·크론)은
// go 운영 테이블이라 그대로 둔다(이 트랙 소유 아님).
import {
  getMessageRecoverySummary,
  ledgerErrorStatus,
  V2MessagingLedgerError,
} from "@/lib/v2/messaging-ledger-client";

export const GET = withRole("owner", async (_request, { session }) => {
  const pool = getPool();
  // 🔴 fail-closed: 발송 큐 집계를 0 으로 흘리면 미확정 발송이 없는 것처럼 보여 알림이 죽는다.
  //    이 엔드포인트의 존재 이유가 "쌓인 게 있으면 알리는 것"이라 침묵이 최악이다.
  let messageSummary;
  try {
    messageSummary = await getMessageRecoverySummary(session.accountId);
  } catch (err: unknown) {
    if (err instanceof V2MessagingLedgerError) {
      return errorResponse(
        `발송 원장에 연결할 수 없어 복구 큐 요약을 만들 수 없습니다: ${err.message}`,
        ledgerErrorStatus(err),
      );
    }
    throw err;
  }

  const [compensations, webhooks, crons] = await Promise.all([
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE a.status = 'pending')::int AS pending,
         COUNT(*) FILTER (WHERE a.status = 'processing')::int AS processing,
         COUNT(*) FILTER (WHERE a.status = 'failed_retryable')::int AS failed_retryable,
         COUNT(*) FILTER (WHERE a.status = 'unknown')::int AS unknown,
         COUNT(*) FILTER (WHERE a.status = 'manual_review')::int AS manual_review,
         COUNT(*) FILTER (WHERE a.status = 'completed')::int AS completed,
         COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(a.created_at) FILTER (WHERE a.status = 'pending'))), 0)::int AS oldest_pending_age_seconds,
         COUNT(*) FILTER (WHERE a.attempt_count >= a.max_attempts AND a.status NOT IN ('completed', 'cancelled'))::int AS max_attempts_exceeded
       FROM payment_compensation_actions a
       JOIN orders o ON o.id = a.order_id
      WHERE o.account_id = $1`,
      [session.accountId],
    ),
    pool.query(
      `WITH scoped AS (
        SELECT d.*
          FROM inter_service_webhook_deliveries d
          JOIN orders o ON o.v2_order_id::text = d.payload->>'order_id' AND o.account_id = $1
         WHERE d.direction = 'inbound' AND d.source = 'v2'
      )
      SELECT
         COUNT(*) FILTER (WHERE d.status = 'pending')::int AS pending,
         COUNT(*) FILTER (WHERE d.status = 'retrying')::int AS retrying,
         COUNT(*) FILTER (WHERE d.status = 'dead_lettered')::int AS dead_lettered,
         COUNT(*) FILTER (WHERE d.replay_status = 'processing')::int AS replaying,
         COUNT(*) FILTER (WHERE d.replay_status = 'ignored_stale')::int AS ignored_stale,
         COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(d.next_attempt_at) FILTER (WHERE d.status IN ('pending', 'retrying')))), 0)::int AS oldest_pending_age_seconds,
         (SELECT COALESCE(jsonb_object_agg(x.retry_count::text, x.count), '{}'::jsonb)
            FROM (SELECT retry_count, COUNT(*)::int AS count FROM scoped GROUP BY retry_count) x) AS retry_count_distribution
       FROM scoped d`,
      [session.accountId],
    ),
    pool.query(
      `SELECT job_name,
              MAX(started_at) AS last_started_at,
              MAX(finished_at) FILTER (WHERE status = 'succeeded') AS last_succeeded_at,
              MAX(finished_at) FILTER (WHERE status = 'failed') AS last_failed_at,
              MAX(duration_ms) FILTER (WHERE status <> 'running') AS last_duration_ms,
              COUNT(*) FILTER (WHERE status = 'running')::int AS currently_running
         FROM ops_cron_runs
        WHERE started_at > NOW() - INTERVAL '7 days'
        GROUP BY job_name
        ORDER BY job_name`,
    ),
  ]);

  const message: Record<string, number> = {
    inflight: messageSummary.inflight,
    unknown: messageSummary.unknown,
    manual_review: messageSummary.manual_review,
    failed: messageSummary.failed,
    oldest_unknown_age_seconds: messageSummary.oldest_unknown_age_seconds,
    parent_stuck: messageSummary.parent_stuck,
  };
  const compensation = compensations.rows[0] ?? {};
  const webhook = webhooks.rows[0] ?? {};
  const alerts: Array<{ code: string; severity: "warning" | "critical"; value: number | string }> = [];
  if (Number(message.unknown ?? 0) > 0) alerts.push({ code: "MESSAGE_UNKNOWN", severity: "critical", value: Number(message.unknown) });
  if (Number(message.parent_stuck ?? 0) > 0) alerts.push({ code: "MESSAGE_PARENT_STUCK", severity: "critical", value: Number(message.parent_stuck) });
  if (Number(compensation.unknown ?? 0) > 0 || Number(compensation.manual_review ?? 0) > 0) alerts.push({ code: "COMPENSATION_REVIEW", severity: "critical", value: Number(compensation.unknown ?? 0) + Number(compensation.manual_review ?? 0) });
  if (Number(webhook.dead_lettered ?? 0) > 0) alerts.push({ code: "WEBHOOK_DLQ", severity: "critical", value: Number(webhook.dead_lettered) });

  return successResponse({
    generatedAt: new Date().toISOString(),
    accountId: session.accountId,
    messages: message,
    compensations: compensation,
    webhooks: webhook,
    crons: crons.rows,
    alerts,
    alertPolicy: {
      messageUnknown: ">=1",
      messageInflightLease: "lease*2",
      compensationUnknownOrManualReview: ">=1",
      webhookDeadLettered: ">=1",
      cronMissed: "last success older than 2x schedule",
      providerErrorRate: ">1% 429/5xx",
      migrationLockWait: ">30s",
      readiness: ">=3 failures in 5m",
    },
  });
});
