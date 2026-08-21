/**
 * 대기자 claim 앵커 기록(claim-commit) 실패 복구 큐 기록부 — 레벨2 재감사 P1.
 *
 * 배경: 공개 claim 라우트가 3-phase(claim-begin → createOrder → claim-commit)로 대기건을
 *   주문으로 전환한다. claim-commit(converted_order_id 앵커 기록)이 최종 실패하면 v2 entry 는
 *   converted 이면서 converted_order_id=NULL 로 잔류하고, 생성된 주문과의 연결이 끊긴다
 *   (재-claim 시 409, orphan order). 기존 코드는 이 실패를 catch-and-log 로만 삼키고 201 을
 *   반환했다 → go↔v2 split-brain.
 *
 * 이 모듈은 claim-commit 실패 시 (entry_id, order_id) 를 `waitlist_claim_recovery` 큐에 기록해,
 *   재조정 워커/cron 이 동일 orderId 로 claim-commit 을 재시도(앵커 수렴)하게 한다. claim 라우트는
 *   **이 기록 성공 여부와 무관하게 502 를 반환**하고(성공응답=앵커 확인 후에만), 기록마저 실패하면
 *   error 로그로 남겨 수동복구 대상으로 표면화한다.
 *
 * 멱등성: entry_id PK + ON CONFLICT DO UPDATE(pending 재무장, resolved 보존)로 동일 entry 재기록이
 *   중복행을 만들지 않는다. 동시 2회 실패해도 마지막 order_id 로 수렴.
 */
import { getPool } from "@/lib/db/pool";
import { logger } from "@/lib/logger";

export interface WaitlistClaimRecoveryInput {
  entryId: string;
  orderId: string;
  accountId?: string | null;
  eventId?: string | null;
  error?: string;
}

function summarizeError(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[phone]")
    .slice(0, 300);
}

/**
 * claim-commit 실패건을 복구 큐에 pending 으로 기록한다.
 *
 * @returns recorded: 복구 행을 기록/재무장했는지. false 면 DB 기록 자체가 실패(수동복구 필요).
 */
export async function recordWaitlistClaimRecovery(
  input: WaitlistClaimRecoveryInput,
): Promise<{ recorded: boolean }> {
  const pool = getPool();
  const lastError = input.error ? summarizeError(input.error) : null;
  try {
    // resolved 행은 되돌리지 않는다(이미 앵커 수렴 완료). 그 외엔 pending 재무장 + attempts 리셋.
    await pool.query(
      `
        INSERT INTO waitlist_claim_recovery
          (entry_id, order_id, account_id, event_id, status, attempts, next_retry_at, last_error)
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'pending', 0, NOW(), $5)
        ON CONFLICT (entry_id) DO UPDATE SET
          order_id      = EXCLUDED.order_id,
          account_id    = COALESCE(EXCLUDED.account_id, waitlist_claim_recovery.account_id),
          event_id      = COALESCE(EXCLUDED.event_id, waitlist_claim_recovery.event_id),
          status        = CASE WHEN waitlist_claim_recovery.status = 'resolved'
                               THEN waitlist_claim_recovery.status ELSE 'pending' END,
          attempts      = CASE WHEN waitlist_claim_recovery.status = 'resolved'
                               THEN waitlist_claim_recovery.attempts ELSE 0 END,
          next_retry_at = CASE WHEN waitlist_claim_recovery.status = 'resolved'
                               THEN waitlist_claim_recovery.next_retry_at ELSE NOW() END,
          last_error    = $5,
          updated_at    = NOW()
      `,
      [input.entryId, input.orderId, input.accountId ?? null, input.eventId ?? null, lastError],
    );
    return { recorded: true };
  } catch (err: unknown) {
    // 복구 큐 기록마저 실패 — 앵커 유실 + 큐 미기록. 최후의 관측 지점(error 로그).
    logger.error("대기자 claim 복구 큐 기록 실패 — 수동복구 필요", {
      entryId: input.entryId,
      orderId: input.orderId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { recorded: false };
  }
}
