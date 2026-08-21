import type { PoolClient } from "pg";
import { getPool } from "@/lib/db/pool";
import { logger } from "@/lib/logger";
import { enqueueAuditOutbox } from "@/lib/audit/outbox";
import { replayInterServiceWebhook } from "@/lib/v2/commerce-client";

const SUPPORTED_EVENTS = new Set([
  "order.payment.confirmed",
  "order.payment.failed",
  "order.cancelled",
  "order.refunded",
]);

type ReplayStatus = "processed" | "pending" | "retrying" | "dead_lettered" | "ignored_stale" | "failed" | "quarantined" | "in_progress" | "already_processed";

interface DeadLetterRow {
  row_id: number;
  delivery_id: string;
  event: string;
  payload: Record<string, unknown>;
  payload_fingerprint: string | null;
  computed_fingerprint: string;
  status: string;
  replay_status: string;
  replay_count: number;
  replay_requested_at: string | null;
  replay_attempt_id: string | null;
  account_id: string;
  order_id: string;
  order_status: string;
  v2_event_id: string | null;
}

export interface ReplayInput {
  deliveryRowId: string;
  accountId: string;
  actorId: string;
  operationKey: string;
  reason: string;
  dryRun?: boolean;
}

export interface ReplayResult {
  status: ReplayStatus;
  deliveryId: string;
  replayAttemptId?: string;
  reason?: string;
  dryRun?: boolean;
}

function validatePayload(row: DeadLetterRow): string | null {
  const payload = row.payload;
  if (!payload || typeof payload !== "object") return "payload_not_object";
  if (!SUPPORTED_EVENTS.has(row.event) || payload.event !== row.event) return "unsupported_or_mismatched_event";
  if (payload.delivery_id !== row.delivery_id) return "delivery_id_mismatch";
  if (typeof payload.order_id !== "string" || payload.order_id !== row.order_id) return "order_id_mismatch";
  if (typeof payload.timestamp !== "string" || !payload.data || typeof payload.data !== "object") return "payload_shape_invalid";
  if (!row.payload_fingerprint || row.payload_fingerprint !== row.computed_fingerprint) return "payload_fingerprint_mismatch";
  // W2-ORD: v2_event_id 는 이제 go orders.event_id(=v2 event id, 항등) 그 자체다.
  // 앵커 컬럼이 아니라 주문 행의 필수 컬럼이라 NULL 이 나올 수 없지만, 방어는 유지한다
  // (NULL 이면 replay 대상 이벤트를 특정할 수 없으므로 격리가 맞다).
  if (!row.v2_event_id) return "v2_event_anchor_missing";
  return null;
}

async function markReplayAudit(
  client: PoolClient,
  input: ReplayInput,
  row: DeadLetterRow,
  replayAttemptId: string,
  status: string,
  result: Record<string, unknown>,
) {
  // 트랜잭션 아웃박스(P1): go audit_logs 직접쓰기 → 동일 txn 아웃박스 적재 → v2 드레인.
  // dedup_key = operationKey+status 로 replay 상태전이(quarantined/processing)당 1행만 enqueue.
  await enqueueAuditOutbox(client, {
    action: "update",
    tableName: "inter_service_webhook_deliveries",
    userId: input.actorId,
    accountId: input.accountId,
    recordId: String(row.row_id),
    changes: {
      operationKey: input.operationKey,
      replayAttemptId,
      deliveryId: row.delivery_id,
      event: row.event,
      fromStatus: row.status,
      action: "replay",
      status,
      reason: input.reason,
      result,
    },
    dedupKey: `webhook-replay:${input.accountId}:${input.operationKey}:${status}`,
  });
}

/** Owner-only DLQ replay. Original payload is read-only; each call creates a replay attempt. */
export async function replayDeadLetteredWebhook(input: ReplayInput): Promise<ReplayResult> {
  const pool = getPool();
  const client = await pool.connect();
  let row: DeadLetterRow | null = null;
  let replayAttemptId: string | null = null;
  try {
    await client.query("BEGIN");
    const locked = await client.query<DeadLetterRow>(
      `SELECT d.id AS row_id, d.delivery_id, d.event, d.payload,
              d.payload_fingerprint, md5(d.payload::text) AS computed_fingerprint,
              d.status, d.replay_status, d.replay_count, d.replay_requested_at, d.replay_attempt_id,
              o.account_id, o.v2_order_id::text AS order_id, o.status AS order_status,
              -- W2-ORD: 옛 JOIN events(e.v2_event_id) 폐기.
              -- go event id == v2 event id(항등)이므로 주문 행의 event_id 가 곧 v2 event id 다.
              -- 테넌트 경계는 아래 o.account_id = $2 가 강제한다(JOIN 이 겸하지 않았다).
              o.event_id::text AS v2_event_id
         FROM inter_service_webhook_deliveries d
         JOIN orders o ON o.v2_order_id::text = d.payload->>'order_id'
        WHERE d.id = $1::bigint AND d.direction = 'inbound'
          AND d.source = 'v2' AND o.account_id = $2
        FOR UPDATE`,
      [input.deliveryRowId, input.accountId],
    );
    row = locked.rows[0] ?? null;
    if (!row) {
      // Do not reveal whether another tenant owns this delivery.
      await client.query("ROLLBACK");
      return { status: "failed", deliveryId: input.deliveryRowId, reason: "not_found" };
    }

    const invalid = validatePayload(row);
    if (invalid) {
      const quarantined = await client.query<{ id: string }>(
        `INSERT INTO webhook_delivery_replay_attempts
          (delivery_row_id, delivery_id, account_id, actor_id, operation_key, payload_fingerprint, status, reason, result)
         VALUES ($1, $2, $3, $4, $5, $6, 'quarantined', $7, $8::jsonb)
         ON CONFLICT (account_id, operation_key) DO NOTHING
         RETURNING id`,
        [row.row_id, row.delivery_id, input.accountId, input.actorId, input.operationKey, row.payload_fingerprint ?? "", input.reason, JSON.stringify({ invalid })],
      );
      if (quarantined.rows[0]) {
        await client.query(
          `UPDATE inter_service_webhook_deliveries SET replay_status = 'quarantined', replay_reason = $2, replay_requested_by = $3, replay_requested_at = NOW() WHERE id = $1`,
          [row.row_id, invalid, input.actorId],
        );
        await markReplayAudit(client, input, row, quarantined.rows[0].id, "quarantined", { invalid });
      }
      await client.query("COMMIT");
      return { status: "quarantined", deliveryId: row.delivery_id, reason: invalid };
    }

    if (row.status !== "dead_lettered") {
      await client.query("ROLLBACK");
      return { status: "already_processed", deliveryId: row.delivery_id, reason: row.status };
    }
    if (input.dryRun) {
      await client.query("ROLLBACK");
      return { status: "processed", deliveryId: row.delivery_id, dryRun: true, reason: "precondition_ok" };
    }
    if (row.replay_status === "processing" && row.replay_requested_at && Date.now() - new Date(row.replay_requested_at).getTime() < 15 * 60_000) {
      await client.query("ROLLBACK");
      return { status: "in_progress", deliveryId: row.delivery_id, replayAttemptId: row.replay_attempt_id ?? undefined };
    }
    if (row.replay_status === "processing" && row.replay_attempt_id) {
      await client.query(`UPDATE webhook_delivery_replay_attempts SET status = 'failed', error_message = 'stale_replay_lease', completed_at = NOW() WHERE id = $1 AND status = 'processing'`, [row.replay_attempt_id]);
    }

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO webhook_delivery_replay_attempts
        (delivery_row_id, delivery_id, account_id, actor_id, operation_key, payload_fingerprint, status, reason)
       VALUES ($1, $2, $3, $4, $5, $6, 'processing', $7)
       ON CONFLICT (account_id, operation_key) DO NOTHING
       RETURNING id`,
      [row.row_id, row.delivery_id, input.accountId, input.actorId, input.operationKey, row.payload_fingerprint, input.reason],
    );
    if (inserted.rows.length === 0) {
      const prior = await client.query<{ id: string; status: ReplayStatus; result: Record<string, unknown> }>(
        `SELECT id, status, result FROM webhook_delivery_replay_attempts WHERE account_id = $1 AND operation_key = $2`,
        [input.accountId, input.operationKey],
      );
      await client.query("ROLLBACK");
      const previous = prior.rows[0];
      return { status: previous?.status ?? "in_progress", deliveryId: row.delivery_id, replayAttemptId: previous?.id, ...(previous?.result ?? {}) } as ReplayResult;
    }
    replayAttemptId = inserted.rows[0]!.id;
    await client.query(
      `UPDATE inter_service_webhook_deliveries
          SET replay_status = 'processing', replay_count = replay_count + 1,
              replay_requested_by = $2, replay_reason = $3, replay_requested_at = NOW(), replay_attempt_id = $4::uuid
        WHERE id = $1`,
      [row.row_id, input.actorId, input.reason, replayAttemptId],
    );
    await markReplayAudit(client, input, row, replayAttemptId, "processing", {});
    await client.query("COMMIT");

    const replayed = await replayInterServiceWebhook(
      row.v2_event_id!,
      row.delivery_id,
      { idempotencyKey: input.operationKey },
    );
    const outcome: ReplayStatus = "pending";
    await pool.query(
      `UPDATE webhook_delivery_replay_attempts
          SET status = $2, result = $3::jsonb, completed_at = NOW()
        WHERE id = $1 AND status = 'processing'`,
      [
        replayAttemptId,
        outcome,
        JSON.stringify({
          sourceStatus: replayed.status,
          replacementDeliveryId: replayed.delivery_id,
        }),
      ],
    );
    await pool.query(
      `UPDATE inter_service_webhook_deliveries
          SET replay_status = 'pending'
        WHERE id = $1 AND replay_attempt_id = $2::uuid`,
      [row.row_id, replayAttemptId],
    );
    return { status: outcome, deliveryId: row.delivery_id, replayAttemptId };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (replayAttemptId) {
      await pool.query(
        `UPDATE webhook_delivery_replay_attempts
            SET status = 'failed', error_message = $2, completed_at = NOW()
          WHERE id = $1 AND status = 'processing'`,
        [
          replayAttemptId,
          error instanceof Error ? error.message.slice(0, 1000) : "replay_failed",
        ],
      ).catch(() => undefined);
      if (row) {
        await pool.query(
          `UPDATE inter_service_webhook_deliveries
              SET replay_status = 'failed'
            WHERE id = $1 AND replay_attempt_id = $2::uuid`,
          [row.row_id, replayAttemptId],
        ).catch(() => undefined);
      }
    }
    if (row) {
      logger.error("[webhook-dlq] replay 실패", { deliveryId: row.delivery_id, error: error instanceof Error ? error.message : "unknown" });
    }
    return { status: "failed", deliveryId: row?.delivery_id ?? input.deliveryRowId, reason: error instanceof Error ? error.message : "replay_failed" };
  } finally {
    client.release();
  }
}
