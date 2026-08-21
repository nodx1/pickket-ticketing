/**
 * 결제 확정(confirm) outbox drain — v2 write-through 재조정의 실행 본체.
 *
 * recordPaymentConfirmOutbox 가 go COMMIT 과 원자적으로 기록한 outbox pending 행(및 재시도 failed)을
 * 클레임해 **트랜잭션 밖·커밋 후** 동일 멱등키(pay-confirm:{orderId})로 v2 confirm → confirmed 로 수렴.
 *
 * ⚠️ P0 재배선: v2 confirmOrderPayment(외부호출)는 오직 이 drain 에서만 일어난다(go 트랜잭션 안 아님).
 *    즉 v2 confirmed 는 항상 이미 커밋된 pending 행에 대해서만 발생 → 역 split-brain 불가.
 *
 * 소비자 둘:
 *   1) scripts/payment-confirm-worker.ts (상시 워커, BullMQ 트리거 후 즉시 drain)
 *   2) src/app/api/cron/payment-reconcile (5분 cron, 큐가 죽어도 도는 이중 안전망)
 *
 * 동시성/멱등 증명:
 *   - 클레임은 FOR UPDATE SKIP LOCKED + lease_token 으로 이중 클레임을 차단한다
 *     (동시 2회 실행해도 같은 행을 두 워커가 잡지 않는다).
 *   - 재confirm 은 v2 confirmOrderPayment(멱등키) 라 외부호출 후 crash 해도 이중 확정이 없다
 *     (다음 클레임이 같은 키로 재호출 → v2 already 반환 → confirmed 로 마감).
 *   - 최종 상태 갱신은 lease_token 일치 조건(WHERE lease_token=$)으로 stale 워커의 덮어쓰기를 막는다.
 */
import crypto from "node:crypto";
import { getPool } from "@/lib/db/pool";
import { confirmOrderPayment, getOrder, V2CommerceError } from "@/lib/v2/commerce-client";
import { alertPaymentManualReview } from "@/lib/payment/payment-alert";
import { logger } from "@/lib/logger";

export interface ConfirmOutboxSummary {
  claimed: number;
  confirmed: number;
  failed: number;
  manualReview: number;
  /** v2 주문이 이미 종결돼 확정이 무의미해진 행(T9). 실패가 아니다. */
  superseded: number;
  /**
   * 🔴 드레인 루프 **밖에서**(선행 sweep) manual_review 로 격리된 행 수.
   *
   * 이 값이 따로 있는 이유: sweep 은 `attempts >= max_attempts` 인 행을 격리하는데,
   * 그 행은 곧바로 claim 대상(`status IN ('pending','failed')`)에서 빠진다.
   * ⟹ 루프 안의 알림·집계에 **영원히 도달하지 않는다.** 종전에는 이 경로가
   *    건수도 알림도 없이 조용히 삼켜졌다(2026-07-30 발견).
   */
  sweptToManualReview: number;
}

/**
 * confirm 가부 판정 — **v2 핸들러 규칙을 그대로 옮긴다** (지시서 #4 T9).
 *
 * 정본: `platform/backend/app/api/v1/internal_commerce.py:_do_confirm_payment`
 *   ```python
 *   if order.status in (CONFIRMED, PAID):                           return already=True   # 멱등 200
 *   if order.status not in (PENDING, PAYMENT_REQUIRED, AUTHORIZED): raise 422             # 영구 거절
 *   ```
 *
 * ⚠️ 처음엔 전이표(`models/order.py:VALID_ORDER_TRANSITIONS`)의 "나가는 전이가 없는 종결 상태"로
 *    집합을 도출했는데 **파생 근거가 틀렸다**. 실제 판정은 위 화이트리스트다. 그래서
 *    `partially_refunded`(전이표상 종결 아님 — REFUNDED 로 갈 수 있다)와 `deposit_held`
 *    (DEPOSIT_* 로만 간다)가 빠져 있었다. 둘 다 CONFIRMED 로 가는 길이 없어 **영구 422** 다.
 *    ⟹ 열거하지 말고 규칙을 그대로 반영한다.
 */
/** confirm 이 성공할 수 있는 출발 상태. */
const V2_CONFIRMABLE_STATUSES = new Set(["pending", "payment_required", "authorized"]);
/** 이미 확정됨 — v2 가 멱등 200(`already:true`)을 준다. 기존 경로로 보내면 confirmed 로 마감된다. */
const V2_ALREADY_CONFIRMED_STATUSES = new Set(["confirmed", "paid"]);
/**
 * v2 OrderStatus enum 전체(`models/order.py:OrderStatus`).
 *
 * 🔴 **모르는 상태를 종결로 단정하지 않기 위해** 필요하다. v2 에 새 상태가 추가됐는데 여기
 *    목록이 낡았다면, 그 상태는 이 집합에 없으므로 supersede 하지 않고 기존 confirm 경로로
 *    흘러간다(= 종전 동작). 반대로 했다면 새 상태의 주문이 조용히 폐기됐을 것이다.
 */
const V2_KNOWN_ORDER_STATUSES = new Set([
  "pending", "payment_required", "authorized", "paid", "confirmed",
  "cancelled", "expired", "partially_refunded", "refunded",
  "deposit_held", "deposit_refunded", "deposit_forfeited",
]);

/** 이 상태의 주문에 confirm 을 보내면 v2 가 **영원히 422** 를 준다. */
function isConfirmImpossible(status: string): boolean {
  return (
    V2_KNOWN_ORDER_STATUSES.has(status) &&
    !V2_CONFIRMABLE_STATUSES.has(status) &&
    !V2_ALREADY_CONFIRMED_STATUSES.has(status)
  );
}

type OutboxRow = {
  order_id: string;
  v2_order_id: string;
  amount: string | number;
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
 * outbox 를 한 번 drain 한다. 호출자(워커/cron)가 주기를 관장.
 *
 * 트랜잭션 경계: 클레임(BEGIN..COMMIT)에서 lease 를 잡고, **외부호출(v2 confirm)은 트랜잭션 밖**에서
 *   수행한 뒤 결과를 별도 UPDATE 로 반영한다(외부호출을 DB 락 안에 두지 않음).
 */
export async function processPaymentConfirmOutbox(limit = 100): Promise<ConfirmOutboxSummary> {
  // 🔴 sweep 격리 건수 — sweep 이 아래 트랜잭션 안에서 채우므로 함수 스코프에 둔다.
  let sweptToManualReview = 0;
  const pool = getPool();
  const client = await pool.connect();
  let rows: OutboxRow[] = [];
  try {
    await client.query("BEGIN");

    // 만료 lease 회수: 크래시한 워커가 잡고 있던 행을 다시 pending 으로. 재confirm 은 멱등이라
    // (외부호출 후 crash 했더라도) 재호출이 안전하다 → 곧장 pending 으로 되돌려도 무방.
    await client.query(
      `UPDATE payment_confirm_outbox
          SET status = 'pending', lease_token = NULL, lease_expires_at = NULL,
              next_retry_at = NOW(), updated_at = NOW()
        WHERE status = 'pending' AND lease_token IS NOT NULL
          AND lease_expires_at IS NOT NULL AND lease_expires_at < NOW()`,
    );

    // max_attempts 소진분 → manual_review 로 격리.
    //
    // 🔴 여기서 **직접 알려야 한다.** 종전 주석은 "아래에서 알림" 이었지만 거짓이었다:
    //    이 UPDATE 로 manual_review 가 된 행은 바로 아래 claim 의
    //    `WHERE status IN ('pending','failed')` 에서 제외돼 **루프에 들어오지 못하고**,
    //    루프 안의 alertPaymentManualReview(:306) 에 영원히 도달하지 않는다.
    //    ⟹ 실돈 매출 누락 가능 건이 **건수도 알림도 없이** 격리되고 있었다.
    //       (prod 실측: 30,000원 1건이 2일간 방치, 감사에서 처음 발견)
    //
    // ⚠️ next_retry_at 은 **NOT NULL**(mig 224:28) 이다. 종결 상태에서 NULL 을 쓰면 23502 로
    //    터진다. 종결 행은 status 조건만으로 드레인에서 제외되므로 값을 그대로 둔다.
    const swept = await client.query<{
      order_id: string;
      v2_order_id: string | null;
      amount: string | number | null;
      attempts: number;
      last_error: string | null;
    }>(
      `UPDATE payment_confirm_outbox
          SET status = 'manual_review', last_error = COALESCE(last_error, 'max_attempts_exceeded'),
              lease_token = NULL, lease_expires_at = NULL, updated_at = NOW()
        WHERE status IN ('pending', 'failed') AND attempts >= max_attempts
        RETURNING order_id, v2_order_id, amount, attempts, last_error`,
    );
    // ⚠️ rows 를 낙관적으로 읽지 않는다 — 여기서 터지면 드레인 **전체**가 실패한다.
    //    격리 알림은 부가 기능이고, 그것 때문에 결제확정 드레인을 멈추게 할 수는 없다.
    const sweptRows = swept.rows ?? [];
    sweptToManualReview = swept.rowCount ?? sweptRows.length;
    for (const row of sweptRows) {
      logger.error(
        "[payment-confirm] sweep 으로 manual_review 격리 — 실결제 v2 미확정 가능, 즉시 조사",
        {
          orderId: row.order_id,
          v2OrderId: row.v2_order_id,
          amount: Number(row.amount ?? 0),
          attempts: row.attempts,
          error: row.last_error ?? "max_attempts_exceeded",
          via: "sweep",
        },
      );
      alertPaymentManualReview({
        source: "confirm_outbox_sweep",
        orderId: row.order_id,
        v2OrderId: row.v2_order_id ?? undefined,
        amount: Number(row.amount ?? 0),
        reason: row.last_error ?? "max_attempts_exceeded",
        attempts: row.attempts,
      });
    }

    const claimed = await client.query<OutboxRow>(
      `
        SELECT order_id, v2_order_id, amount, attempts, max_attempts
          FROM payment_confirm_outbox
         WHERE status IN ('pending', 'failed')
           AND next_retry_at <= NOW()
           AND attempts < max_attempts
           AND lease_token IS NULL
         ORDER BY next_retry_at
         FOR UPDATE SKIP LOCKED
         LIMIT $1
      `,
      [limit],
    );

    if (claimed.rows.length > 0) {
      rows = claimed.rows.map((row) => ({ ...row, lease_token: crypto.randomUUID() }));
      for (const row of rows) {
        await client.query(
          `UPDATE payment_confirm_outbox
              SET status = 'pending', attempts = attempts + 1,
                  lease_token = $2::uuid, lease_expires_at = NOW() + INTERVAL '10 minutes',
                  updated_at = NOW()
            WHERE order_id = $1 AND status IN ('pending', 'failed')`,
          [row.order_id, row.lease_token],
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

  let confirmed = 0;
  let failed = 0;
  let manualReview = 0;
  let superseded = 0;

  for (const row of rows) {
    const amount = Number(row.amount) || 0;

    // ── T9: v2 주문이 이미 종결됐는지 **먼저** 본다 ─────────────────────────────
    // 종결 상태면 confirm 은 영원히 성공할 수 없다. 시도 자체를 하지 않고 행을 닫는다.
    //   · 'confirmed' 로 닫지 않는다 — 확정된 적 없는 주문이 확정으로 집계되면 재무가 틀어진다.
    //   · 'failed'/'manual_review' 로도 닫지 않는다 — 정상 취소가 실패 큐를 오염시키면
    //     운영자가 진짜 실패를 못 본다.
    // 선확인이 실패하면(네트워크·5xx) 그건 그 자체로 결함이 아니므로 **기존 confirm 경로로
    // 그대로 진행**한다. 선확인이 새로운 실패 원인이 되어서는 안 된다.
    let terminalStatus: string | null = null;
    try {
      const order = await getOrder(row.v2_order_id, {
        // 선확인은 재시도하지 않는다(retries: 0). 실패해도 어차피 기존 confirm 경로로 흘리므로
        // 재시도는 드레인 지연만 늘린다 — 이 호출이 정상 경로의 v2 왕복을 2배로 만들기 때문에
        // 최악 지연을 짧게 유지하는 편이 중요하다.
        idempotencyKey: `pay-confirm-precheck:${row.order_id}`,
        retries: 0,
      });
      const current = String(order.status_v2 ?? order.status ?? "").toLowerCase();
      if (isConfirmImpossible(current)) terminalStatus = current;
    } catch (err: unknown) {
      logger.warn("[payment-confirm] v2 종결상태 선확인 실패 — 기존 confirm 경로로 진행", {
        orderId: row.order_id,
        v2OrderId: row.v2_order_id,
        error: summarizeError(err instanceof Error ? err.message : String(err)),
      });
    }
    if (terminalStatus) {
      // 🔴 이 UPDATE 를 try 로 감싸는 이유: status='superseded' 는 마이그레이션 254 가
      //    선적용돼야 CHECK 를 통과한다. 마이그 없이 코드만 배포되면 23514 가 나는데,
      //    감싸지 않으면 예외가 드레인 전체를 뚫고 나가 **남은 행이 전부 미처리**된다.
      //    한 행의 실패가 큐 전체를 멈추게 두지 않는다(드레인 크래시 금지).
      try {
        const updated = await pool.query(
          // next_retry_at 은 NOT NULL — 종결 행에 NULL 을 쓰지 않는다(T4 와 동일 원칙).
          `UPDATE payment_confirm_outbox
              SET status = 'superseded', last_error = $3,
                  lease_token = NULL, lease_expires_at = NULL, updated_at = NOW()
            WHERE order_id = $1 AND lease_token = $2::uuid`,
          [row.order_id, row.lease_token, `v2_order_terminal:${terminalStatus}`],
        );
        if ((updated.rowCount ?? 0) > 0) {
          superseded++;
          logger.info("[payment-confirm] v2 주문이 이미 종결됨 — 확정 폐기(superseded)", {
            orderId: row.order_id,
            v2OrderId: row.v2_order_id,
            v2Status: terminalStatus,
            amount,
          });
        }
      } catch (err: unknown) {
        // 여기 오는 대표 원인은 마이그 254 미적용(23514). 상태를 못 바꿨을 뿐 데이터는 안전하고,
        // 다음 드레인이 같은 판정을 반복한다. 원인을 명시적으로 남긴다.
        logger.error("[payment-confirm] superseded 기록 실패 — 마이그레이션 254 적용 여부 확인 필요", {
          orderId: row.order_id,
          v2OrderId: row.v2_order_id,
          v2Status: terminalStatus,
          error: summarizeError(err instanceof Error ? err.message : String(err)),
        });
      }
      continue;
    }

    // 🔴 v2 확정이 끝난 뒤의 로컬 기록 실패를 "결제 실패" 로 뒤집지 않기 위한 표식.
    //    (실측 사고: 성공 UPDATE 가 next_retry_at NOT NULL 위반으로 터지자 catch 가
    //     status 를 failed 로 바꿔, **확정된 주문이 영원한 재시도 대상**이 됐다.)
    let v2Confirmed = false;
    try {
      // E2E fault 주입(테스트 전용 훅): v2 backend 무변경 방식으로 drain 의 v2 confirm 을 실패시킨다.
      // 프로덕션 무영향 — E2E_V2_FAULT_CONFIRM=1 일 때만 발동(스텁/스테이징 실패 시뮬). (레벨2 P0 E2E)
      if (process.env.E2E_V2_FAULT_CONFIRM === "1") {
        throw new V2CommerceError("E2E_V2_FAULT_CONFIRM: 강제 실패(테스트 주입)", 503);
      }
      // 동일 멱등키 재confirm — recordPaymentConfirmOutbox 와 같은 키 → 이중 확정 불가.
      await confirmOrderPayment(
        row.v2_order_id,
        { amount: amount || undefined },
        { idempotencyKey: `pay-confirm:${row.order_id}` },
      );
      v2Confirmed = true;
      const updated = await pool.query(
        // next_retry_at 은 NOT NULL — 종결 행에 NULL 을 쓰면 23502. status='confirmed' 가
        // 드레인 조건에서 이미 제외하므로 값은 건드리지 않는다.
        `UPDATE payment_confirm_outbox
            SET status = 'confirmed', confirmed_at = NOW(), last_error = NULL,
                lease_token = NULL, lease_expires_at = NULL,
                updated_at = NOW()
          WHERE order_id = $1 AND lease_token = $2::uuid`,
        [row.order_id, row.lease_token],
      );
      if ((updated.rowCount ?? 0) > 0) confirmed++;
      logger.info("[payment-confirm] outbox 재confirm 성공", {
        orderId: row.order_id,
        v2OrderId: row.v2_order_id,
        amount,
      });
    } catch (err: unknown) {
      // 🔴 v2 확정은 이미 성공했고 로컬 기록만 실패한 경우 — 이건 **결제 실패가 아니라 기록 실패**다.
      //    failed 로 뒤집으면 확정된 주문이 재시도 대상이 되고 결국 manual_review 로 가서
      //    운영자가 정상 주문을 조사하게 된다. 상태를 건드리지 않고 두면 lease 만료 후
      //    재드레인되며, 재confirm 은 같은 멱등키라 안전하다(이중 확정 불가).
      if (v2Confirmed) {
        logger.error("[payment-confirm] v2 확정 성공 · outbox 기록 실패 — 상태 유지(다음 드레인 재시도)", {
          orderId: row.order_id,
          v2OrderId: row.v2_order_id,
          amount,
          error: summarizeError(err instanceof Error ? err.message : String(err)),
        });
        continue;
      }
      const message = summarizeError(err instanceof Error ? err.message : String(err));
      const status = err instanceof V2CommerceError ? err.status : undefined;
      const exhausted = row.attempts + 1 >= row.max_attempts;
      // 지수 백오프(분): 2^n, 최대 60분.
      const delayMinutes = Math.min(60, 2 ** Math.min(row.attempts, 5));
      const targetStatus = exhausted ? "manual_review" : "failed";
      await pool.query(
        // 종결(manual_review)에는 NULL 대신 기존 값을 유지한다 — next_retry_at 은 NOT NULL.
        `UPDATE payment_confirm_outbox
            SET status = $2, last_error = $3,
                next_retry_at = CASE WHEN $2 = 'failed' THEN NOW() + ($4 || ' minutes')::interval ELSE next_retry_at END,
                lease_token = NULL, lease_expires_at = NULL, updated_at = NOW()
          WHERE order_id = $1 AND lease_token = $5::uuid`,
        [row.order_id, targetStatus, message, String(delayMinutes), row.lease_token],
      );
      if (targetStatus === "manual_review") {
        manualReview++;
        // 조용한 실패 금지 — manual_review 는 실돈 매출 누락이므로 즉시 에스컬레이션(Sentry).
        logger.error("[payment-confirm] outbox max_attempts 소진 — manual_review(실결제 v2 미확정, 즉시 조사)", {
          orderId: row.order_id,
          v2OrderId: row.v2_order_id,
          amount,
          attempts: row.attempts + 1,
          status,
          error: message,
        });
        alertPaymentManualReview({
          source: "confirm_outbox",
          orderId: row.order_id,
          v2OrderId: row.v2_order_id,
          amount,
          reason: "max_attempts_exceeded",
          attempts: row.attempts + 1,
        });
      } else {
        failed++;
        logger.warn("[payment-confirm] outbox 재confirm 실패 — 재시도 대기", {
          orderId: row.order_id,
          v2OrderId: row.v2_order_id,
          amount,
          attempts: row.attempts + 1,
          nextRetryMinutes: delayMinutes,
          status,
          error: message,
        });
      }
    }
  }

  return {
    claimed: rows.length,
    confirmed,
    failed,
    manualReview,
    superseded,
    sweptToManualReview,
  };
}
