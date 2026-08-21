import type { PoolClient } from "pg";
import { logger } from "@/lib/logger";

/**
 * 소비자 PG 결제완료 → v2 신뢰경로 결제확정 write-through의 **pending-first 기록부**(B1, 레벨2 P0 재배선).
 *
 * ⚠️ 근본 재배선(코덱스 P0 — 역 split-brain 원천 차단):
 *   과거 이 함수는 go 트랜잭션 **안에서** v2 confirmOrderPayment 를 먼저 호출한 뒤 outbox 를 UPSERT 했다.
 *   그러나 **외부 v2 호출과 go DB 커밋은 원자화가 불가능**하다. v2 confirm 성공 직후 outbox INSERT
 *   또는 go COMMIT 이 실패하면 → v2=confirmed, go=롤백, outbox=소멸 = **역 split-brain(실돈 confirmed
 *   인데 go 는 미완료·추적행 없음)**. "동일 PoolClient" 는 이 원자성을 보장하지 못한다.
 *
 * ✅ 재배선(진짜 outbox = pending-first):
 *   이 함수는 **외부호출을 전혀 하지 않는다.** go 트랜잭션에서 **pending outbox 행만 기록**한다.
 *   외부호출(v2 confirmOrderPayment)은 오직 워커/cron(processPaymentConfirmOutbox)이 **go COMMIT
 *   이후·트랜잭션 밖**에서만 수행한다. 따라서:
 *     - outbox 기록(INSERT)은 go orders=completed·attendees=confirmed 와 **완전히 같은 트랜잭션**에서
 *       원자 커밋된다 → "completed 인데 outbox 없음"이 구조적으로 불가능.
 *     - v2 호출은 항상 커밋된 pending 행을 클레임한 뒤에만 일어난다 → v2 confirmed 인데 go 롤백/outbox
 *       소멸이 **원천적으로 불가능**(역 split-brain 불가).
 *
 * @returns pending: 이 트랜잭션에 pending outbox 행을 기록했는지(true 면 COMMIT 후 enqueue 대상)
 *          v2OrderId: v2 canonical order_id (없으면 null = v2 확정 대상 아님, outbox 미기록)
 */
export async function recordPaymentConfirmOutbox(
  client: PoolClient,
  goOrderId: string,
  opts: { amount?: number } = {},
): Promise<{ pending: boolean; v2OrderId: string | null }> {
  // go orders 앵커에서 v2 canonical order_id 해석.
  const { rows } = await client.query<{ v2_order_id: string | null; total_amount: string | number | null }>(
    "SELECT v2_order_id, total_amount FROM orders WHERE id = $1 LIMIT 1",
    [goOrderId],
  );
  const v2OrderId = rows[0]?.v2_order_id ?? null;
  if (!v2OrderId) {
    // 앵커 미연결(레거시/이관 전/NICE 주문) — v2 확정 대상 아님. outbox 미기록.
    logger.warn("recordPaymentConfirmOutbox: v2_order_id 누락 — v2 확정 스킵", { goOrderId });
    return { pending: false, v2OrderId: null };
  }

  const amount = opts.amount ?? (Number(rows[0]?.total_amount ?? 0) || undefined);
  const outboxAmount = Math.max(Math.trunc(amount ?? 0), 0);

  // 핵심 불변식: outbox 행을 **go COMMIT 과 동일 트랜잭션(client)** 에 기록한다. 외부호출 0.
  //   → "orders.status=completed 인데 outbox 행 없음"이 구조적으로 불가능(outbox 기록 실패 시
  //     go 트랜잭션 전체가 롤백되어 결제확정 자체가 안 일어남 = 역 split-brain 방지).
  //   → 항상 pending 으로 기록(외부호출을 안 하므로 confirmed 를 이 시점에 단언할 수 없다).
  //     실제 v2 confirm 은 COMMIT 후 워커/cron 이 이 pending 행을 클레임해 멱등키로 수행한다.
  //   → 재확정(웹훅 재전송 등)이 이미 confirmed 인 행을 pending 으로 되돌리지 않도록
  //     ON CONFLICT 시 status<>'confirmed' 인 경우에만 pending 재무장(confirmed 보존).
  try {
    await client.query(
      `
        INSERT INTO payment_confirm_outbox
          (order_id, v2_order_id, amount, status, attempts, next_retry_at, last_error)
        VALUES ($1, $2::uuid, $3, 'pending', 0, NOW(), NULL)
        ON CONFLICT (order_id) DO UPDATE SET
          v2_order_id   = EXCLUDED.v2_order_id,
          amount        = GREATEST(payment_confirm_outbox.amount, EXCLUDED.amount),
          status        = 'pending',
          attempts      = 0,
          last_error    = NULL,
          next_retry_at = NOW(),
          lease_token   = NULL,
          lease_expires_at = NULL,
          updated_at    = NOW()
        -- operator/manual-review is an explicit stop state; only an operator may re-arm it.
        -- 'superseded'(T9) 도 같은 성질이다 — v2 주문이 종결돼 확정이 무의미해진 행을
        -- 웹훅 중복배달 등으로 pending 재무장하면 불필요한 재조회 왕복만 생긴다.
        WHERE payment_confirm_outbox.status NOT IN ('confirmed', 'manual_review', 'superseded')
      `,
      [goOrderId, v2OrderId, outboxAmount],
    );
  } catch (err: unknown) {
    // outbox 기록 실패는 삼키지 않는다 — throw 하여 go 트랜잭션 전체를 롤백시킨다.
    // (completed 인데 outbox 없음 = 조용한 유실 을 원천 차단. 결제확정을 아예 안 한 것으로 되돌림.)
    logger.error("recordPaymentConfirmOutbox: outbox 기록 실패 — go 트랜잭션 롤백", {
      goOrderId,
      v2OrderId,
      error: err instanceof Error ? err.message : "unknown",
    });
    throw err;
  }

  return { pending: true, v2OrderId };
}
