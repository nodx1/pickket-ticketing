/**
 * 대기자 claim 복구 큐 드레인(재-commit) — 레벨2 재감사 P1(waitlist recovery drain worker).
 *
 * 배경: 공개 claim 라우트(app/api/public/waitlist/[entryId]/claim)가 claim-commit(converted_order_id
 *   앵커 기록)에 실패하면 (entry_id, order_id)를 `waitlist_claim_recovery`(mig229) 큐에 pending 으로
 *   기록하고 502 를 반환한다(recordWaitlistClaimRecovery). 그러나 이 큐를 **소비하는 워커/cron 이 없어**
 *   converted_order_id=NULL 이 영구잔류(주문↔대기자 연결끊김)했다 → 이 모듈이 그 소비자다.
 *
 * 동작: pending/failed 행을 lease + FOR UPDATE SKIP LOCKED 로 클레임 → **트랜잭션 밖·커밋 후** 동일
 *   orderId 로 v2 claim-commit 을 재시도(멱등 앵커 수렴) → 성공 resolved / 일시실패 백오프 failed /
 *   max_attempts 소진 manual_review.
 *
 * 결제 outbox(confirm-outbox.ts)·감사 outbox(audit/outbox.ts) 드레인 패턴과 동형.
 *
 * ── 멱등성/트랜잭션 경계 증명 ─────────────────────────────────────────────
 *  · "동시 2회 실행하면?" → 클레임은 `FOR UPDATE SKIP LOCKED` + lease_token 이라 두 워커가 같은 행을
 *    잡지 못한다. 최종 상태 UPDATE 는 `WHERE lease_token = $` 로 stale 워커의 덮어쓰기를 막는다.
 *  · "외부호출(v2 claim-commit) 후 crash 하면?" → 행은 pending(또는 lease 만료 회수)으로 남고, 다음
 *    드레인이 **같은 orderId** 로 재-commit 한다. v2 claim-commit 은 멱등(converted_order_id 를 그
 *    orderId 로 수렴)이라 이중 앵커·이중 전환이 없다.
 *  · 성공판정은 claim 라우트와 동일: `committed || converted_order_id === orderId`. v2 가 **다른** order 로
 *    이미 앵커돼 있으면(anchor mismatch) 자동복구 불가 → 즉시 manual_review + Sentry(조용한 실패 금지).
 *
 * account 경계: 큐 행에 account_id 스냅샷을 보관하되, 재-commit 은 entry_id+order_id 키로만 v2 를
 *   호출한다(claim-commit 계약이 account 를 받지 않음, entry_id 가 이미 테넌트 고정). 집계/알림에만 사용.
 */
import crypto from "node:crypto";
import { getPool } from "@/lib/db/pool";
import { claimCommit } from "@/lib/v2/waitlist-client";
import { V2CommerceError } from "@/lib/v2/commerce-client";
import { alertWaitlistRecovery } from "@/lib/waitlist/recovery-alert";
import { logger } from "@/lib/logger";

export interface WaitlistRecoveryDrainSummary {
  claimed: number;
  resolved: number;
  failed: number;
  manualReview: number;
}

type RecoveryRow = {
  entry_id: string;
  order_id: string;
  account_id: string | null;
  event_id: string | null;
  attempts: number;
  max_attempts: number;
  lease_token: string;
};

function summarizeError(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[phone]")
    .slice(0, 300);
}

/**
 * 복구 큐를 한 번 드레인한다(호출자=워커/cron 이 주기 관장).
 *
 * 트랜잭션 경계: 클레임(BEGIN..COMMIT)에서 lease 를 잡고, **외부호출(v2 claim-commit)은 트랜잭션 밖**에서
 *   수행한 뒤 결과를 별도 UPDATE 로 반영한다(외부호출을 DB 락 안에 두지 않음 — confirm-outbox 와 동형).
 */
export async function processWaitlistClaimRecovery(
  limit = 100,
): Promise<WaitlistRecoveryDrainSummary> {
  const pool = getPool();
  const client = await pool.connect();
  let rows: RecoveryRow[] = [];
  try {
    await client.query("BEGIN");

    // 만료 lease 회수: 크래시한 워커가 잡고 있던 행을 다시 pending 으로. 재-commit 은 멱등이라
    // (외부호출 후 crash 했더라도) 재호출이 안전하다 → 곧장 pending 으로 되돌려도 무방.
    await client.query(
      `UPDATE waitlist_claim_recovery
          SET status = 'pending', lease_token = NULL, lease_expires_at = NULL,
              next_retry_at = NOW(), updated_at = NOW()
        WHERE status IN ('pending', 'failed') AND lease_token IS NOT NULL
          AND lease_expires_at IS NOT NULL AND lease_expires_at < NOW()`,
    );

    // max_attempts 소진분 → manual_review 로 격리(조용한 실패 금지, 아래에서 에스컬레이션).
    await client.query(
      `UPDATE waitlist_claim_recovery
          SET status = 'manual_review', last_error = COALESCE(last_error, 'max_attempts_exceeded'),
              lease_token = NULL, lease_expires_at = NULL, updated_at = NOW()
        WHERE status IN ('pending', 'failed') AND attempts >= max_attempts`,
    );

    const claimed = await client.query<RecoveryRow>(
      `SELECT entry_id, order_id, account_id, event_id, attempts, max_attempts
         FROM waitlist_claim_recovery
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
          `UPDATE waitlist_claim_recovery
              SET status = 'pending', attempts = attempts + 1,
                  lease_token = $2::uuid, lease_expires_at = NOW() + INTERVAL '10 minutes',
                  updated_at = NOW()
            WHERE entry_id = $1 AND status IN ('pending', 'failed')`,
          [row.entry_id, row.lease_token],
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

  let resolved = 0;
  let failed = 0;
  let manualReview = 0;

  for (const row of rows) {
    try {
      // 동일 orderId 로 재-commit(멱등 앵커 수렴). claim 라우트와 같은 성공판정:
      //   committed(이번에 앵커) 또는 converted_order_id === orderId(이미 같은 order 로 앵커).
      const commit = await claimCommit(row.entry_id, row.order_id);
      const anchored = commit.committed || commit.converted_order_id === row.order_id;

      if (anchored) {
        const updated = await pool.query(
          `UPDATE waitlist_claim_recovery
              SET status = 'resolved', resolved_at = NOW(), last_error = NULL,
                  lease_token = NULL, lease_expires_at = NULL,
                  updated_at = NOW()
            WHERE entry_id = $1 AND lease_token = $2::uuid`,
          [row.entry_id, row.lease_token],
        );
        if ((updated.rowCount ?? 0) > 0) resolved++;
        logger.info("[waitlist-recovery] 재-commit 앵커 수렴 성공", {
          entryId: row.entry_id,
          orderId: row.order_id,
        });
        continue;
      }

      // v2 가 **다른** order 로 이미 앵커됨(anchor mismatch) → 자동복구 불가. 즉시 manual_review.
      //   (동일 entry 가 다른 order 로 전환됐다는 뜻 = 이중 주문/데이터 손상 신호)
      manualReview += await escalateManualReview(pool, row, {
        reason: "anchor_mismatch",
        message: `anchor mismatch: v2=${commit.converted_order_id ?? "null"} expected=${row.order_id}`,
      });
    } catch (err: unknown) {
      const message = summarizeError(err instanceof Error ? err.message : String(err));
      const status = err instanceof V2CommerceError ? err.status : undefined;
      const exhausted = row.attempts + 1 >= row.max_attempts;
      // 지수 백오프(분): 2^n, 최대 60분. confirm-outbox 와 동일.
      const delayMinutes = Math.min(60, 2 ** Math.min(row.attempts, 5));

      if (exhausted) {
        manualReview += await escalateManualReview(pool, row, {
          reason: "max_attempts_exceeded",
          message,
          status,
        });
      } else {
        const updated = await pool.query(
          `UPDATE waitlist_claim_recovery
              SET status = 'failed', last_error = $2,
                  next_retry_at = NOW() + ($3 || ' minutes')::interval,
                  lease_token = NULL, lease_expires_at = NULL, updated_at = NOW()
            WHERE entry_id = $1 AND lease_token = $4::uuid`,
          [row.entry_id, message, String(delayMinutes), row.lease_token],
        );
        if ((updated.rowCount ?? 0) > 0) failed++;
        logger.warn("[waitlist-recovery] 재-commit 실패 — 재시도 대기", {
          entryId: row.entry_id,
          orderId: row.order_id,
          attempts: row.attempts + 1,
          nextRetryMinutes: delayMinutes,
          status,
          error: message,
        });
      }
    }
  }

  return { claimed: rows.length, resolved, failed, manualReview };
}

/**
 * manual_review 로 격리 + Sentry 에스컬레이션. 조용한 실패 금지 —
 * "converted 인데 앵커 미수렴"은 주문↔대기자 split-brain 이므로 즉시 조사 대상.
 * @returns 상태전이(lease 일치)에 성공하면 1, stale 워커라 실패하면 0.
 */
async function escalateManualReview(
  pool: ReturnType<typeof getPool>,
  row: RecoveryRow,
  detail: { reason: string; message: string; status?: number },
): Promise<number> {
  const updated = await pool.query(
    `UPDATE waitlist_claim_recovery
        SET status = 'manual_review', last_error = $2,
            lease_token = NULL, lease_expires_at = NULL, updated_at = NOW()
      WHERE entry_id = $1 AND lease_token = $3::uuid`,
    [row.entry_id, detail.message, row.lease_token],
  );
  if ((updated.rowCount ?? 0) === 0) return 0;

  logger.error("[waitlist-recovery] 재-commit 앵커 미수렴 — manual_review(주문↔대기자 연결끊김, 즉시 조사)", {
    entryId: row.entry_id,
    orderId: row.order_id,
    accountId: row.account_id,
    eventId: row.event_id,
    reason: detail.reason,
    attempts: row.attempts + 1,
    status: detail.status,
    error: detail.message,
  });
  alertWaitlistRecovery({
    kind: "manual_review",
    entryId: row.entry_id,
    orderId: row.order_id,
    accountId: row.account_id,
    eventId: row.event_id,
    reason: detail.reason,
    attempts: row.attempts + 1,
  });
  return 1;
}
