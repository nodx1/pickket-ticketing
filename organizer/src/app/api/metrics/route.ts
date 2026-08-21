import { getPool } from "@/lib/db/pool";
import type { QueryResult, QueryResultRow } from "pg";
// W5-MSG: 발송 원장(message_deliveries / _attempts)은 v2 소유 — 큐/에러 게이지만 v2 경유.
// 나머지 큐(감사 아웃박스·결제보상·결제확정·웹훅·크론·리플레이)는 go 운영 테이블이라 유지.
import { getMessagingMetrics } from "@/lib/v2/messaging-ledger-client";

export const dynamic = "force-dynamic";

function authorized(request: Request): boolean {
  const token = process.env.METRICS_TOKEN?.trim();
  if (!token) return process.env.NODE_ENV !== "production";
  return request.headers.get("authorization") === `Bearer ${token}`;
}

function metric(name: string, value: number, labels: Record<string, string> = {}): string {
  const encoded = Object.entries(labels).map(([key, label]) => `${key}="${label.replaceAll('"', '\\"')}"`).join(",");
  return `${name}${encoded ? `{${encoded}}` : ""} ${Number.isFinite(value) ? value : 0}`;
}

async function timedQuery<T extends QueryResultRow>(
  pool: ReturnType<typeof getPool>,
  text: string,
  values: unknown[] = [],
): Promise<QueryResult<T>> {
  const client = await pool.connect();
  try {
    await client.query("SET statement_timeout = '5000ms'");
    return await client.query<T>(text, values);
  } finally {
    await client.query("RESET statement_timeout").catch(() => undefined);
    client.release();
  }
}

export async function GET(request: Request) {
  if (!authorized(request)) return new Response("unauthorized\n", { status: 401 });
  const pool = getPool();
  try {
    const [messaging, auditOutbox, compensations, confirmOutbox, webhooks, crons, replays] = await Promise.all([
      // 🔴 실패 시 throw → 아래 catch 가 503 "metrics unavailable" 을 낸다. 발송 큐만 0 으로
      //    채운 200 을 내보내면 스크레이퍼가 "미확정 0건"으로 읽어 알림이 침묵한다.
      getMessagingMetrics(15),
      // P1: 감사 outbox dead/failed 는 규제 감사 누락 후보이므로 상태·최장대기·alert를 노출한다.
      timedQuery<{ status: string; count: string; oldest_age_seconds: string | null }>(
        pool,
        `SELECT status, COUNT(*)::text AS count,
                EXTRACT(EPOCH FROM (NOW() - MIN(created_at)))::text AS oldest_age_seconds
           FROM audit_outbox
          WHERE status IN ('pending','failed','dead')
          GROUP BY status
         UNION ALL
         SELECT 'stale_pending', COUNT(*)::text,
                EXTRACT(EPOCH FROM (NOW() - MIN(created_at)))::text
           FROM audit_outbox
          WHERE status IN ('pending','failed') AND created_at < NOW() - INTERVAL '30 minutes'
         HAVING COUNT(*) > 0`,
      ),
      timedQuery<{ status: string; count: string; oldest_age_seconds: string | null }>(
        pool,
        `SELECT status, COUNT(*)::text AS count,
                EXTRACT(EPOCH FROM (NOW() - MIN(created_at)))::text AS oldest_age_seconds
           FROM payment_compensation_actions
          WHERE status IN ('pending','processing','failed_retryable','unknown','manual_review','completed')
          GROUP BY status
         UNION ALL
         SELECT 'retry_exhausted', COUNT(*)::text,
                EXTRACT(EPOCH FROM (NOW() - MIN(created_at)))::text
           FROM payment_compensation_actions
          WHERE attempt_count >= max_attempts AND status NOT IN ('completed','cancelled')
         HAVING COUNT(*) > 0`,
      ),
      // P1(레벨2 재감사): 결제확정 outbox 상태 메트릭 — manual_review(실결제 v2 미확정)를 노출한다.
      // confirm-outbox drain 이 max_attempts 소진 시 manual_review 로 격리하지만, 지금까진 logger 만
      // 있어 대시보드/알림에 뜨지 않았다. 여기서 status 별 집계 + 알림 후보로 승격한다.
      timedQuery<{ status: string; count: string; oldest_age_seconds: string | null }>(
        pool,
        `SELECT status, COUNT(*)::text AS count,
                EXTRACT(EPOCH FROM (NOW() - MIN(created_at)))::text AS oldest_age_seconds
           FROM payment_confirm_outbox
          -- 'superseded'(T9) 도 노출한다. 알림 대상은 아니지만(정상 종결) 대량 발생은
          -- 판매 직후 대량취소 같은 신호라 대시보드에서 보여야 한다.
          WHERE status IN ('pending','failed','manual_review','superseded')
          GROUP BY status
         UNION ALL
         SELECT 'stale_pending', COUNT(*)::text,
                EXTRACT(EPOCH FROM (NOW() - MIN(created_at)))::text
           FROM payment_confirm_outbox
          WHERE status IN ('pending','failed') AND created_at < NOW() - INTERVAL '30 minutes'
         HAVING COUNT(*) > 0`,
      ),
      timedQuery<{ status: string; count: string; oldest_age_seconds: string | null }>(
        pool,
        `SELECT status, COUNT(*)::text AS count,
                EXTRACT(EPOCH FROM (NOW() - MIN(created_at)))::text AS oldest_age_seconds
           FROM inter_service_webhook_deliveries
          WHERE status IN ('pending','retrying','dead_lettered')
          GROUP BY status`,
      ),
      timedQuery<{
        status: string;
        count: string;
        max_started_age_seconds: string | null;
        max_duration_ms: string | null;
        stale_reclaimed: string;
        duplicate_claim_prevented: string;
      }>(
        pool,
        `SELECT status, COUNT(*)::text AS count,
                EXTRACT(EPOCH FROM (NOW() - MAX(started_at)))::text AS max_started_age_seconds,
                MAX(duration_ms)::text AS max_duration_ms,
                COALESCE(SUM(stale_reclaimed), 0)::text AS stale_reclaimed,
                COALESCE(SUM(duplicate_claim_prevented), 0)::text AS duplicate_claim_prevented
           FROM ops_cron_runs
          WHERE started_at > NOW() - INTERVAL '24 hours'
          GROUP BY status`,
      ),
      timedQuery<{ status: string; count: string }>(
        pool,
        `SELECT status, COUNT(*)::text AS count
           FROM webhook_delivery_replay_attempts
          WHERE created_at > NOW() - INTERVAL '24 hours'
          GROUP BY status`,
      ),
    ]);
    const messages = { rows: messaging.queues.map((q) => ({
      status: q.status,
      count: String(q.count),
      oldest_age_seconds: q.oldest_age_seconds === null ? null : String(q.oldest_age_seconds),
    })) };
    const providerErrors = { rows: messaging.provider_errors.map((e) => ({
      error_class: e.error_class,
      count: String(e.count),
    })) };
    const lines = [
      "# HELP pickket_queue_items Current durable recovery queue items.",
      "# TYPE pickket_queue_items gauge",
      ...messages.rows.map((row) => metric("pickket_queue_items", Number(row.count), { queue: "message", status: row.status })),
      ...compensations.rows.map((row) => metric("pickket_queue_items", Number(row.count), { queue: "compensation", status: row.status })),
      ...confirmOutbox.rows.map((row) => metric("pickket_queue_items", Number(row.count), { queue: "confirm_outbox", status: row.status })),
      ...auditOutbox.rows.map((row) => metric("pickket_queue_items", Number(row.count), { queue: "audit_outbox", status: row.status })),
      ...webhooks.rows.map((row) => metric("pickket_queue_items", Number(row.count), { queue: "webhook", status: row.status })),
      "# HELP pickket_queue_oldest_age_seconds Oldest item age by durable queue/status.",
      "# TYPE pickket_queue_oldest_age_seconds gauge",
      ...messages.rows.filter((row) => row.oldest_age_seconds).map((row) => metric("pickket_queue_oldest_age_seconds", Number(row.oldest_age_seconds), { queue: "message", status: row.status })),
      ...compensations.rows.filter((row) => row.oldest_age_seconds).map((row) => metric("pickket_queue_oldest_age_seconds", Number(row.oldest_age_seconds), { queue: "compensation", status: row.status })),
      ...confirmOutbox.rows.filter((row) => row.oldest_age_seconds).map((row) => metric("pickket_queue_oldest_age_seconds", Number(row.oldest_age_seconds), { queue: "confirm_outbox", status: row.status })),
      ...auditOutbox.rows.filter((row) => row.oldest_age_seconds).map((row) => metric("pickket_queue_oldest_age_seconds", Number(row.oldest_age_seconds), { queue: "audit_outbox", status: row.status })),
      ...webhooks.rows.filter((row) => row.oldest_age_seconds).map((row) => metric("pickket_queue_oldest_age_seconds", Number(row.oldest_age_seconds), { queue: "webhook", status: row.status })),
      "# HELP pickket_cron_runs Recent cron executions.",
      "# TYPE pickket_cron_runs gauge",
      ...crons.rows.map((row) => metric("pickket_cron_runs", Number(row.count), { status: row.status })),
      ...crons.rows.filter((row) => row.max_duration_ms).map((row) => metric("pickket_cron_duration_ms", Number(row.max_duration_ms), { status: row.status, statistic: "max" })),
      ...crons.rows.map((row) => metric("pickket_cron_stale_reclaimed_total", Number(row.stale_reclaimed), { status: row.status })),
      ...crons.rows.map((row) => metric("pickket_cron_duplicate_prevented_total", Number(row.duplicate_claim_prevented), { status: row.status })),
      ...replays.rows.map((row) => metric("pickket_webhook_replay_total", Number(row.count), { status: row.status })),
      ...providerErrors.rows.map((row) => metric("pickket_provider_errors_total", Number(row.count), { status: row.error_class })),
      metric("pickket_alert_candidate", messages.rows.some((row) => ["unknown", "manual_review", "stale_inflight"].includes(row.status) && Number(row.count) > 0) ? 1 : 0, { alert: "message_review" }),
      metric("pickket_alert_candidate", compensations.rows.some((row) => ["unknown", "manual_review", "retry_exhausted"].includes(row.status) && Number(row.count) > 0) ? 1 : 0, { alert: "compensation_review" }),
      // manual_review = 실결제 v2 미확정(매출 누락). stale_pending = 30분 넘게 미확정(워커/cron 정지 의심).
      metric("pickket_alert_candidate", confirmOutbox.rows.some((row) => ["manual_review", "stale_pending"].includes(row.status) && Number(row.count) > 0) ? 1 : 0, { alert: "confirm_outbox_review" }),
      metric("pickket_alert_candidate", auditOutbox.rows.some((row) => ["failed", "dead", "stale_pending"].includes(row.status) && Number(row.count) > 0) ? 1 : 0, { alert: "audit_outbox_review" }),
      metric("pickket_alert_candidate", webhooks.rows.some((row) => row.status === "dead_lettered" && Number(row.count) > 0) ? 1 : 0, { alert: "webhook_dead_letter" }),
      "",
    ];
    return new Response(lines.join("\n"), { status: 200, headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" } });
  } catch {
    return new Response("metrics unavailable\n", { status: 503, headers: { "cache-control": "no-store" } });
  }
}
