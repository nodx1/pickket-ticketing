/**
 * 결제 확정 대사(payment confirm reconciliation) — "단일 SoT" 무결성의 마지막 전제.
 *
 * 배경(P0 pending-first 재배선): recordPaymentConfirmOutbox 는 PG 결제완료 시 v2 confirm 을
 *   **하지 않고** go COMMIT 과 동일 트랜잭션에 **pending** outbox 행만 원자 기록한다. 실제 v2 confirm 은
 *   COMMIT 후 워커/cron(트랜잭션 밖) 의 drain 이 멱등키로 수행한다.
 *   → "go orders.completed 인데 v2 미확정" 은 outbox 의 pending/failed 행으로 정확히 표상된다.
 *     이 잡은 (1)outbox 없는 완료주문을 pending 으로 백필하고 (2)그 행을 drain 해 confirmed 로 수렴시킨다.
 *
 * ⚠️ 스캔 소스 전환(레벨2 재감사 P1):
 *   과거: orders 를 status='completed' AND v2_order_id NOT NULL 로 폴링 → 매 주기 v2 getOrder 호출.
 *     문제 ①넓다(정상 주문까지 매번 조회) ②NICE 등 v2 앵커 없는 주문이 섞여 오탐 소지.
 *   현재: payment_confirm_outbox(status IN pending/failed) 만 스캔. 좁고 정확하며,
 *     v2_order_id 가 없는 주문(레거시/NICE)은 애초에 outbox 행이 없어 자동 제외된다.
 *
 * 소유: go(자기 결제경로가 만든 드리프트를 go 가 책임지고 메움). v2 코드 변경 0.
 * 이 잡은 워커(payment-confirm-worker)와 **동일한 drain 로직**을 호출하는 이중 안전망 —
 *   큐(Redis)가 죽어도 cron 이 outbox 를 비운다.
 *
 * NOTE: 환불 드리프트(refund write-through 누락)는 별도 — refundOrder 는 에러 전파(throw)라
 *   조용한 드리프트가 안 생긴다. 이 잡 범위는 결제확정 누락에 한정.
 */
import { getPool } from "@/lib/db/pool";
import { processPaymentConfirmOutbox } from "@/lib/payment/confirm-outbox";
import { enqueueExpiredPaymentCompensation } from "@/lib/payment/compensation";
import { getTossPaymentByPaymentKey } from "@/lib/payment/toss";
import { transitionOrder } from "@/lib/state-machine/order-state-machine";
import { logger } from "@/lib/logger";

export interface ReconcileDetail {
  goOrderId: string;
  v2OrderId: string;
  orderNumber: string;
  amount: number;
  outcome: "repaired" | "failed" | "lookup_failed";
  error?: string;
}

export interface ReconcileSummary {
  scanned: number; // drain 이 클레임한 outbox 행 수
  healthy: number; // (호환 유지) outbox 스캔에선 미확정 행만 클레임하므로 항상 0
  mismatched: number; // 드리프트(=클레임된 pending/failed) 수 = scanned
  repaired: number; // 재confirm 성공(=confirmed)
  failed: number; // 재confirm 실패(다음 주기 재시도) — ALERT
  lookupFailed: number; // (호환 유지) outbox 경로엔 별도 조회단계 없음 → 0
  manualReview: number; // max_attempts 소진 → manual_review 격리 — ALERT(에스컬레이션됨)
  // T9: v2 주문이 이미 종결(취소·환불)돼 확정이 무의미해진 행. **실패가 아니다** —
  // failed/manualReview 에 섞으면 정상 취소가 운영 실패 큐를 오염시킨다.
  superseded: number;
  /** 드레인 루프 밖 sweep 으로 manual_review 격리된 행(루프 알림 미도달 경로). */
  sweptToManualReview: number;
  backfilled: number; // 구형 스캐너가 outbox 없는 완료주문을 pending 으로 백필한 수(224 전 completed)
  details: ReconcileDetail[];
}

/**
 * 레거시 백필(구형 스캐너 병행 — P1 재감사).
 *
 * 224 마이그가 적용 시점에 completed 주문을 일회성 백필하지만, 그 사이(마이그 적용~코드 배포)
 * 혹은 outbox 미기록으로 완료된 엣지(예: order-finalize already_completed COMMIT 경로)를 대비해
 * cron 이 매 주기 **outbox 없는 completed·v2 앵커 주문**을 pending 으로 채운다.
 *   → drain 이 이 pending 을 곧이어(같은 주기) 멱등키로 confirm → v2 확정 누락이 영구화되지 않는다.
 *   → 가산·멱등: ON CONFLICT DO NOTHING(이미 행이 있으면 손대지 않음, confirmed 도 안전).
 *
 * NOTE: pending-first 재배선에서 completed 주문은 정상적으로 outbox 를 갖는다. 이 백필은 오직
 *   224 이전 completed(테이블 부재기) + 이론상 outbox 미기록 엣지만 대상 — 정상 운영에선 0 이다.
 */
async function backfillMissingOutbox(limit: number): Promise<number> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `
      INSERT INTO payment_confirm_outbox (order_id, v2_order_id, amount, status, attempts, next_retry_at)
      SELECT o.id, o.v2_order_id, GREATEST(COALESCE(o.total_amount, 0)::bigint, 0), 'pending', 0, NOW()
        FROM orders o
        LEFT JOIN payment_confirm_outbox x ON x.order_id = o.id
       WHERE o.status = 'completed'
         AND o.v2_order_id IS NOT NULL
         AND x.order_id IS NULL
       ORDER BY o.updated_at
       LIMIT $1
      ON CONFLICT (order_id) DO NOTHING
    `,
    [limit],
  );
  return rowCount ?? 0;
}

export interface OrphanTossPendingSummary {
  scanned: number; // provider 조회한 orphan pending 주문 수
  refunding: number; // 캡처 확인 → 취소 + 환불 보상큐 기록
  stillPending: number; // provider 미캡처(승인 안 됨) → 그대로 pending 유지
  lookupFailed: number; // provider 조회 실패 → 다음 주기 재시도 — ALERT
}

/**
 * P0-3 복구경로(레벨2 재감사): orphan Toss pending 결제 회수.
 *
 * toss confirm 라우트가 PG 승인 **전에** payment_reference(paymentKey) 를 pending 주문에 durable
 * 기록한다. 승인 성공 후 go 트랜잭션(전이/attendee/outbox)이 실패하면 주문은 pending 인데 PG 는
 * 캡처된 상태로 남는다(orphan). 이 스캐너가:
 *   1) status='pending' + payment_method='toss' + payment_reference 존재 + 충분히 오래된(승인
 *      in-flight 가 아닌) 주문을 클레임(FOR UPDATE SKIP LOCKED)한다.
 *   2) paymentKey 로 Toss 결제를 조회한다(정본=토스 서버).
 *   3) DONE(캡처됨) → 주문 pending→cancelled 로 전이(never-completed) + payment_status='paid' 기록
 *      후 provider별 환불 보상큐(enqueueExpiredPaymentCompensation, provider=toss)에 기록.
 *      실제 환불·payment_status='refunded' 투영은 보상 워커가 멱등키로 수행 → 이중환불 불가.
 *   4) 미캡처(승인 자체가 실패/미완) → 아무것도 하지 않음(주문은 그대로 pending, 만료 reaper 소관).
 *
 * 멱등/동시성:
 *   - 후보 목록은 락 없이 읽되(외부 provider 조회를 DB 락 밖에 두기 위함), **처리 직전** 주문 행을
 *     `SELECT ... FOR UPDATE` 로 잠그고 정본 상태·선점키(payment_reference)를 재조회한다. 후보 조회와
 *     처리 사이에 정상 confirm 이 pending→completed 로 전이한 race 를 이 재확인이 직렬화·차단한다.
 *     동시 2회 실행 시에도 행 락으로 같은 주문을 두 번 회수하지 않는다(둘째는 completed 를 관측 후 skip).
 *   - pending→cancelled 는 락 하에서 pending 을 확인한 뒤에만 수행하므로 정상 완료건을 취소하지 않는다.
 *   - duplicate_toss_capture 는 **선점키(payment_reference)와 다른 별도 paymentKey 가 DONE** 인 실제
 *     이중 캡처만 판정한다. DONE 키가 선점키와 같으면(정상 완료건) 절대 오탐하지 않는다.
 *   - 보상 액션은 UNIQUE(order_id, action, idempotency_key)라 paymentKey별 재기록/이중환불 불가.
 *   - "provider 조회 후 crash": 다음 주기가 같은 orphan 을 다시 조회(조회는 부수효과 없음) → 안전.
 *
 * ⚠️ pending 창을 좁히지 않으려고 grace 를 둔다(기본 10분): 정상 confirm 은 수 초 내에 completed 로
 *   전이되므로, 10분 넘게 pending·payment_reference 존재인 toss 주문만 orphan 으로 간주한다.
 *   (짧으면 in-flight 정상 승인을 오인 취소할 위험.)
 */
const ORPHAN_TOSS_PENDING_GRACE_MINUTES = 10;

export async function reconcileOrphanTossPendingPayments(limit = 100): Promise<OrphanTossPendingSummary> {
  const pool = getPool();
  const summary: OrphanTossPendingSummary = { scanned: 0, refunding: 0, stillPending: 0, lookupFailed: 0 };

  // 후보를 먼저 읽고(락 없이 목록), 각 건을 개별 트랜잭션으로 원자 처리한다.
  //
  // 시도별 ledger 통합(레벨2 재감사 P1): 과거엔 orders.payment_reference(주문당 단일 키)만 스캔해,
  // 동시 재시도로 첫 결제키가 덮어써지면 그 키로 캡처된 실결제를 영영 못 찾았다. 이제 pending toss
  // 주문 상태와 무관하게 payment_attempts의 **미정산 시도 키**를 기준으로 조회한다.
  // completed 주문의 비승자 키도 실제 이중캡처일 수 있으므로 반드시 후보에 남겨야 한다.
  // ledger 도입 전 pending 주문은 orders.payment_reference를 fallback 후보로 포함한다.
  const candidates = await pool.query<{
    id: string;
    v2OrderId: string | null;
    paymentKey: string;
    paidAmount: string | number | null;
    totalAmount: string | number | null;
  }>(
    `WITH keys AS (
       SELECT o.id, o.v2_order_id, o.paid_amount, o.total_amount,
              a.payment_key, a.updated_at AS candidate_updated_at
         FROM payment_attempts a
         JOIN orders o ON o.id = a.order_id
        WHERE o.payment_method = 'toss'
          AND a.provider = 'toss'
          AND a.status IN ('pending', 'won', 'captured')
       UNION ALL
       SELECT o.id, o.v2_order_id, o.paid_amount, o.total_amount,
              o.payment_reference AS payment_key, o.updated_at AS candidate_updated_at
         FROM orders o
        WHERE o.status = 'pending'
          AND o.payment_method = 'toss'
          AND o.payment_reference IS NOT NULL
          AND NOT EXISTS (
                SELECT 1 FROM payment_attempts a
                 WHERE a.order_id = o.id AND a.payment_key = o.payment_reference
              )
     )
     SELECT id, v2_order_id AS "v2OrderId", payment_key AS "paymentKey",
            paid_amount AS "paidAmount", total_amount AS "totalAmount"
       FROM keys
      WHERE candidate_updated_at < NOW() - ($1 || ' minutes')::interval
      ORDER BY candidate_updated_at
      LIMIT $2`,
    [String(ORPHAN_TOSS_PENDING_GRACE_MINUTES), limit],
  );

  for (const candidate of candidates.rows) {
    const paymentKey = candidate.paymentKey;
    if (!paymentKey) continue;

    // provider 조회는 트랜잭션 밖에서(외부호출을 DB 락 안에 두지 않음).
    let payment: Record<string, unknown> | null;
    try {
      payment = await getTossPaymentByPaymentKey(paymentKey);
    } catch (err: unknown) {
      summary.lookupFailed++;
      logger.error("[orphan-toss] provider 조회 실패 — 다음 주기 재시도", {
        orderId: candidate.id,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    summary.scanned++;

    // 조회 불가(mock/시크릿 미설정) 또는 미캡처 → orphan 아님. 그대로 둔다.
    const providerStatus = payment ? String(payment.status ?? "") : null;
    if (!payment) {
      summary.stillPending++;
      continue;
    }
    const captured = providerStatus === "DONE";
    if (!captured) {
      // 승인 자체가 실패/취소/미완 → PG 캡처 없음. 주문은 그대로 pending(만료 reaper 소관).
      summary.stillPending++;
      continue;
    }

    // 캡처됨(DONE)인데 go 는 pending = orphan. 취소 전이 + 환불 보상큐로 회수.
    const totalAmount = Number(payment.totalAmount ?? candidate.paidAmount ?? candidate.totalAmount ?? 0) || 0;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // ── race 재확인(레벨2 재감사3차): 후보 조회(락 없음)와 처리 사이에 정상 confirm 이 이 주문을
      //    pending→completed 로 전이했을 수 있다. 그 창에서 orders 행을 FOR UPDATE 로 잠그고
      //    **처리 직전 정본 상태·선점키(payment_reference)를 재조회**한다.
      //    → confirm 트랜잭션이 in-flight 면 여기서 대기(직렬화) 후 확정된 상태를 읽는다.
      //    이로써 "정상 완료된 결제"를 duplicate_toss_capture 로 오탐하는 경로를 원천 차단한다.
      const cur = await client.query<{ status: string; payment_reference: string | null }>(
        `SELECT status, payment_reference FROM orders WHERE id = $1 FOR UPDATE`,
        [candidate.id],
      );
      const curRow = cur.rows[0];
      if (!curRow) {
        // 주문이 사라짐(이론상 불가 — CASCADE 없음). 안전하게 스킵.
        await client.query("COMMIT");
        summary.stillPending++;
        continue;
      }

      const isWinningKey =
        curRow.payment_reference !== null && curRow.payment_reference === paymentKey;

      if (curRow.status !== "pending") {
        // 주문이 이미 다른 경로로 확정됨(completed/refunded/cancelled/expired). 두 갈래:
        //   (A 정상 완료) 이 DONE 키가 주문의 선점키(payment_reference)와 **같다** = 정상 confirm 을
        //     유발한 그 결제다. orphan 도 이중캡처도 아님 → 이 시도 ledger 를 settled 로 마감(재스캔
        //     중단)하고 stillPending 으로 집계. duplicate_toss_capture 오탐 금지.
        //   (B 이중 캡처) 이 DONE 키가 선점키와 **다르다** = 별도 paymentKey 로도 실캡처됨.
        //     주문 상태는 유지하고 해당 paymentKey 전용 보상행으로 자동환불한다.
        if (isWinningKey) {
          // 정상 완료건 — 이 시도는 orphan 이 아니다. ledger 를 settled 로 마감(재스캔 방지).
          await client.query(
            `UPDATE payment_attempts
                SET status = 'settled', provider_status = $3, last_looked_up_at = NOW(), updated_at = NOW()
              WHERE order_id = $1 AND payment_key = $2 AND status <> 'settled'`,
            [candidate.id, paymentKey, providerStatus],
          );
          await client.query("COMMIT");
          summary.stillPending++;
          continue;
        }

        // 선점키와 다른 별도 DONE 캡처 = 실제 이중 캡처. 그 키만 시도별 보상큐에 넣는다.
        // 큐 INSERT와 ledger settled가 같은 트랜잭션이라 재스캔/보상 유실이 없다.
        await enqueueExpiredPaymentCompensation(client, {
          orderId: candidate.id,
          v2OrderId: candidate.v2OrderId,
          deliveryId: null,
          amount: totalAmount,
          reason: "duplicate_toss_capture",
          providerPaymentKey: paymentKey,
        });
        await client.query(
          `UPDATE payment_attempts
              SET status = 'settled', provider_status = $3, last_looked_up_at = NOW(), updated_at = NOW()
            WHERE order_id = $1 AND payment_key = $2 AND status IN ('pending', 'won', 'captured')`,
          [candidate.id, paymentKey, providerStatus],
        );
        await client.query("COMMIT");
        summary.refunding++;
        logger.error("[orphan-toss] 이중 캡처 확정 — 비승자 paymentKey 환불 보상큐 기록", {
          orderId: candidate.id,
          paymentKey,
          winningKey: curRow.payment_reference,
          providerStatus,
        });
        continue;
      }

      if (!isWinningKey) {
        // 주문은 아직 pending이지만 이 DONE 키가 선점키가 아니면 별도 이중캡처다.
        // 정상 승자 주문은 취소하지 않고 candidate key만 환불한다.
        await enqueueExpiredPaymentCompensation(client, {
          orderId: candidate.id,
          v2OrderId: candidate.v2OrderId,
          deliveryId: null,
          amount: totalAmount,
          reason: "duplicate_toss_capture",
          providerPaymentKey: paymentKey,
        });
        await client.query(
          `UPDATE payment_attempts
              SET status = 'settled', provider_status = $3, last_looked_up_at = NOW(), updated_at = NOW()
            WHERE order_id = $1 AND payment_key = $2 AND status IN ('pending', 'won', 'captured')`,
          [candidate.id, paymentKey, providerStatus],
        );
        await client.query("COMMIT");
        summary.refunding++;
        logger.error("[orphan-toss] pending 주문의 비승자 캡처 — 주문 유지 + 해당 키 환불큐 기록", {
          orderId: candidate.id,
          paymentKey,
          winningKey: curRow.payment_reference,
          providerStatus,
        });
        continue;
      }

      // 여기 도달 = 락 하에서도 여전히 pending 인 실제 orphan. 취소 전이(락 보유로 100% 적용).
      const cancelled = await transitionOrder(client, candidate.id, "pending", "cancelled");
      if (!cancelled) {
        // FOR UPDATE 로 잠근 뒤 pending 을 확인했으므로 정상 경로에선 도달 불가. 방어적으로 롤백-스킵.
        await client.query("ROLLBACK").catch(() => undefined);
        summary.stillPending++;
        continue;
      }
      await client.query(
        `UPDATE orders
            SET payment_status = 'paid', paid_amount = GREATEST(COALESCE(paid_amount, 0), $2),
                updated_at = NOW()
          WHERE id = $1`,
        [candidate.id, totalAmount],
      );
      // 레벨2 재감사 P0조건부: orphan 은 정의상 Toss 캡처건(payment_reference=paymentKey 존재)이라
      // v2 앵커가 없어도 provider_payment_key 로 Toss cancel 환불이 가능하다(mig230). 따라서
      // v2_order_id 유무와 무관하게 보상큐에 durable 기록한다 — 조용한 유실(과거 else 로그-only) 제거.
      // enqueue 헬퍼가 orders.payment_method='toss' → provider=toss·provider_payment_key 로 채운다.
      await enqueueExpiredPaymentCompensation(client, {
        orderId: candidate.id,
        v2OrderId: candidate.v2OrderId,
        deliveryId: null,
        amount: totalAmount,
        reason: "toss_captured_after_go_transaction_failed",
        providerPaymentKey: paymentKey,
      });
      // 이 시도의 ledger 행(있으면)을 settled 로 마킹 — 회수 완료 추적(멱등: 행 없으면 no-op).
      await client.query(
        `UPDATE payment_attempts
            SET status = 'settled', updated_at = NOW()
          WHERE order_id = $1 AND payment_key = $2 AND status <> 'settled'`,
        [candidate.id, paymentKey],
      );
      await client.query("COMMIT");
      summary.refunding++;
      logger.error("[orphan-toss] PG 캡처·go pending orphan 회수 — 취소 + 환불 보상큐 기록", {
        orderId: candidate.id,
        v2OrderId: candidate.v2OrderId,
        amount: totalAmount,
        providerStatus,
      });
    } catch (err: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      summary.lookupFailed++;
      logger.error("[orphan-toss] orphan 회수 트랜잭션 실패 — 다음 주기 재시도", {
        orderId: candidate.id,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      client.release();
    }
  }

  return summary;
}

export interface ReconcileOptions {
  /** (호환 유지) 과거 orders 폴링 윈도우. outbox 스캔에선 무시된다. */
  windowHours?: number;
  /** true 면 drain 하지 않고 no-op 리턴(점검용). */
  dryRun?: boolean;
  /** 한 주기 최대 처리 건수(폭주 방지). 기본 500. */
  limit?: number;
}

/**
 * 결제확정 누락 대사 1회 실행. 호출자(cron/스크립트)가 주기 반복.
 * 멱등: 같은 드리프트를 여러 번 돌려도 pay-confirm 멱등키로 이중확정 없음.
 *   동시 2회 실행해도 FOR UPDATE SKIP LOCKED + lease 로 같은 행을 두 번 잡지 않는다.
 */
export async function reconcilePayments(
  opts: ReconcileOptions = {},
): Promise<ReconcileSummary> {
  const limit = opts.limit ?? 500;
  const dryRun = opts.dryRun ?? false;

  const empty: ReconcileSummary = {
    scanned: 0,
    healthy: 0,
    mismatched: 0,
    repaired: 0,
    failed: 0,
    lookupFailed: 0,
    manualReview: 0,
    superseded: 0,
    sweptToManualReview: 0,
    backfilled: 0,
    details: [],
  };

  if (dryRun) {
    // outbox drain 은 부수효과가 크므로 dry-run 에선 실행하지 않는다(점검 no-op).
    return empty;
  }

  // 1) 구형 스캐너: outbox 없는 completed·v2 앵커 주문을 pending 으로 백필(224 이전 completed 대비).
  const backfilled = await backfillMissingOutbox(limit);

  // 2) drain: 백필분 포함 pending/failed 를 클레임해 멱등키로 재confirm.
  const drained = await processPaymentConfirmOutbox(limit);

  const summary: ReconcileSummary = {
    scanned: drained.claimed,
    healthy: 0,
    mismatched: drained.claimed,
    repaired: drained.confirmed,
    failed: drained.failed,
    lookupFailed: 0,
    manualReview: drained.manualReview,
    superseded: drained.superseded,
    sweptToManualReview: drained.sweptToManualReview,
    backfilled,
    details: [],
  };

  if (
    summary.failed > 0 ||
    summary.manualReview > 0 ||
    summary.sweptToManualReview > 0 ||
    summary.backfilled > 0 ||
    summary.superseded > 0
  ) {
    logger.warn("결제확정 대사 요약", {
      scanned: summary.scanned,
      mismatched: summary.mismatched,
      repaired: summary.repaired,
      failed: summary.failed,
      manualReview: summary.manualReview,
      superseded: summary.superseded,
      sweptToManualReview: summary.sweptToManualReview,
      backfilled: summary.backfilled,
    });
  }

  return summary;
}
