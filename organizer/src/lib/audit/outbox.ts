/**
 * 감사(audit) 트랜잭션 아웃박스 — 레벨2 코덱스 재감사 P1.
 *
 * 배경: go 고유 감사쓰기 4곳(seats/audit·webhooks/replay·payment-compensations route·
 *   message-deliveries route)은 상태변경과 **동일 트랜잭션에서** audit_logs 에 직접 INSERT
 *   했다. 감사 정본이 v2(AuditLog)로 이관됐지만, 이들은 async HTTP(lib/audit.ts)로 옮기면
 *   "상태는 커밋됐는데 감사는 유실"(외부호출 후 crash / 동시성)이 가능해진다.
 *
 * 해법(트랜잭션 아웃박스):
 *   1) enqueueAuditOutbox(client, entry): 호출자의 **동일 txn** 에서 audit_outbox 로 INSERT.
 *      → 상태변경이 커밋되면 아웃박스 행도 반드시 존재, 롤백되면 함께 사라진다(감사 유실 불가).
 *   2) processAuditOutbox(limit): 워커/cron 이 pending/failed 행을 클레임(lease + SKIP LOCKED)해
 *      트랜잭션 밖·커밋 후 v2 /internal/audit-logs 로 POST → delivered.
 *
 * 멱등/동시성 증명:
 *   - "동시 2회 실행하면?" → 클레임은 FOR UPDATE SKIP LOCKED + lease_token 이라 두 워커가 같은
 *     행을 잡지 못한다. 최종 UPDATE 는 lease_token 일치 조건으로 stale 워커의 덮어쓰기를 막는다.
 *   - "외부호출(v2 POST) 후 crash 하면?" → 행은 pending 으로 남고(또는 lease 만료 회수), 다음
 *     드레인이 재POST 한다. v2 audit write 는 append-only(중복행 무해)라 이중 전송이 안전하다.
 *     추가로 dedup_key(부분 UNIQUE) 로 정상경로 double-enqueue 자체를 차단한다.
 */
import crypto from "node:crypto";
import type { PoolClient } from "pg";
import { getPool } from "@/lib/db/pool";
import { logger } from "@/lib/logger";

/** enqueue 는 반드시 호출자 트랜잭션 클라이언트를 받는다(트랜잭션 결합의 핵심). */
type TxExecutor = Pick<PoolClient, "query">;

export interface AuditOutboxEntry {
  action: string;
  tableName: string;
  accountId?: string | null;
  userId?: string | null;
  recordId?: string | null;
  changes?: unknown;
  ipAddress?: string | null;
  /** 안정 멱등키(있으면 부분 UNIQUE 로 double-enqueue 차단). 없으면 중복허용(관측데이터라 무해). */
  dedupKey?: string | null;
}

/**
 * 감사 이벤트를 호출자의 **동일 트랜잭션** 안에서 아웃박스에 적재한다.
 * 반드시 상태변경과 같은 client(txn)로 호출해야 원자성이 성립한다.
 * COMMIT 은 호출자가 관장 — 여기서는 커밋하지 않는다.
 */
export async function enqueueAuditOutbox(
  client: TxExecutor,
  entry: AuditOutboxEntry,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_outbox
       (action, table_name, account_id, user_id, record_id, changes, ip_address, dedup_key)
     VALUES ($1, $2, $3::uuid, $4::uuid, $5, $6::jsonb, $7, $8)
     ON CONFLICT (dedup_key) WHERE dedup_key IS NOT NULL DO NOTHING`,
    [
      entry.action,
      entry.tableName,
      entry.accountId ?? null,
      entry.userId ?? null,
      entry.recordId ?? null,
      entry.changes === undefined || entry.changes === null ? null : JSON.stringify(entry.changes),
      entry.ipAddress ?? null,
      entry.dedupKey ?? null,
    ],
  );
}

export interface AuditOutboxSummary {
  claimed: number;
  delivered: number;
  failed: number;
  dead: number;
}

type OutboxRow = {
  id: string;
  action: string;
  table_name: string;
  account_id: string | null;
  user_id: string | null;
  record_id: string | null;
  changes: unknown;
  ip_address: string | null;
  attempts: number;
  max_attempts: number;
  lease_token: string;
};

function getV2Base(): string | undefined {
  return process.env.V2_INTERNAL_BASE_URL;
}
function getSecret(): string | undefined {
  return process.env.GO_WEBHOOK_SECRET ?? process.env.V2_EVENT_SYNC_SECRET;
}

/** v2 /internal/audit-logs POST(1건). append-only 라 재전송 안전. 실패 시 예외를 던진다. */
async function postAuditToV2(row: OutboxRow): Promise<void> {
  const base = getV2Base();
  const secret = getSecret();
  if (!base || !secret) {
    // 미설정은 "일시 장애"로 취급 — 삼키지 않고 예외 → 재시도 대상으로 남긴다(유실 금지).
    throw new Error("v2 audit 클라이언트 미설정(V2_INTERNAL_BASE_URL/secret)");
  }
  const payload = JSON.stringify({
    action: row.action,
    table_name: row.table_name,
    user_id: row.user_id,
    account_id: row.account_id,
    record_id: row.record_id,
    changes: row.changes ?? null,
    ip_address: row.ip_address,
  });
  const ts = new Date().toISOString();
  const sig = crypto.createHmac("sha256", secret).update(`${ts}.${payload}`).digest("hex");
  const res = await fetch(`${base.replace(/\/$/, "")}/api/v1/internal/audit-logs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Pickket-Service-Token": secret,
      "X-Pickket-Signature": sig,
      "X-Pickket-Timestamp": ts,
      "Idempotency-Key": `audit-outbox:${row.id}`,
      "User-Agent": "pickket-go-audit-outbox/1.0",
    },
    body: payload,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`v2 audit write 비정상 응답 status=${res.status}`);
  }
}

/**
 * 아웃박스를 한 번 드레인한다(호출자=워커/cron 이 주기 관장).
 *
 * 트랜잭션 경계: 클레임(BEGIN..COMMIT)에서 lease 를 잡고, **외부호출(v2 POST)은 트랜잭션 밖**에서
 *   수행한 뒤 결과를 별도 UPDATE 로 반영한다(외부호출을 DB 락 안에 두지 않음).
 */
export async function processAuditOutbox(limit = 200): Promise<AuditOutboxSummary> {
  const pool = getPool();
  const client = await pool.connect();
  let rows: OutboxRow[] = [];
  try {
    await client.query("BEGIN");

    // 만료 lease 회수: 크래시한 워커가 잡고 있던 행을 다시 pending 으로(재POST 는 append 라 안전).
    await client.query(
      `UPDATE audit_outbox
          SET status = 'pending', lease_token = NULL, lease_expires_at = NULL,
              next_retry_at = NOW(), updated_at = NOW()
        WHERE status IN ('pending', 'failed') AND lease_token IS NOT NULL
          AND lease_expires_at IS NOT NULL AND lease_expires_at < NOW()`,
    );

    // max_attempts 소진분 → dead 로 격리(조용한 유실 금지, 아래에서 에스컬레이션).
    await client.query(
      `UPDATE audit_outbox
          SET status = 'dead', last_error = COALESCE(last_error, 'max_attempts_exceeded'),
              lease_token = NULL, lease_expires_at = NULL, updated_at = NOW()
        WHERE status IN ('pending', 'failed') AND attempts >= max_attempts`,
    );

    const claimed = await client.query<OutboxRow>(
      `SELECT id, action, table_name, account_id, user_id, record_id, changes, ip_address,
              attempts, max_attempts
         FROM audit_outbox
        WHERE status IN ('pending', 'failed')
          AND next_retry_at <= NOW()
          AND attempts < max_attempts
          AND lease_token IS NULL
        ORDER BY next_retry_at
        FOR UPDATE SKIP LOCKED
        LIMIT $1`,
      [limit],
    );

    if (claimed.rows.length > 0) {
      rows = claimed.rows.map((row) => ({ ...row, lease_token: crypto.randomUUID() }));
      for (const row of rows) {
        await client.query(
          `UPDATE audit_outbox
              SET status = 'pending', attempts = attempts + 1,
                  lease_token = $2::uuid, lease_expires_at = NOW() + INTERVAL '10 minutes',
                  updated_at = NOW()
            WHERE id = $1 AND status IN ('pending', 'failed')`,
          [row.id, row.lease_token],
        );
      }
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  let delivered = 0;
  let failed = 0;
  let dead = 0;

  for (const row of rows) {
    try {
      await postAuditToV2(row);
      const updated = await pool.query(
        `UPDATE audit_outbox
            SET status = 'delivered', delivered_at = NOW(), last_error = NULL,
                lease_token = NULL, lease_expires_at = NULL, updated_at = NOW()
          WHERE id = $1 AND lease_token = $2::uuid`,
        [row.id, row.lease_token],
      );
      if ((updated.rowCount ?? 0) > 0) delivered++;
    } catch (err: unknown) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      const exhausted = row.attempts + 1 >= row.max_attempts;
      // 지수 백오프(분): 2^n, 최대 60분.
      const delayMinutes = Math.min(60, 2 ** Math.min(row.attempts, 5));
      const targetStatus = exhausted ? "dead" : "failed";
      await pool.query(
        `UPDATE audit_outbox
            SET status = $2, last_error = $3,
                next_retry_at = CASE WHEN $2 = 'failed' THEN NOW() + ($4 || ' minutes')::interval ELSE next_retry_at END,
                lease_token = NULL, lease_expires_at = NULL, updated_at = NOW()
          WHERE id = $1 AND lease_token = $5::uuid`,
        [row.id, targetStatus, message, String(delayMinutes), row.lease_token],
      );
      if (targetStatus === "dead") {
        dead++;
        // 조용한 유실 금지 — 감사 유실은 규제 리스크이므로 즉시 에스컬레이션.
        logger.error("[audit-outbox] max_attempts 소진 — dead(감사 유실 위험, 즉시 조사)", {
          id: row.id,
          action: row.action,
          tableName: row.table_name,
          attempts: row.attempts + 1,
          error: message,
        });
      } else {
        failed++;
        logger.warn("[audit-outbox] v2 전송 실패 — 재시도 대기", {
          id: row.id,
          action: row.action,
          tableName: row.table_name,
          attempts: row.attempts + 1,
          nextRetryMinutes: delayMinutes,
          error: message,
        });
      }
    }
  }

  return { claimed: rows.length, delivered, failed, dead };
}
