import crypto from "node:crypto";
import type { PoolClient } from "pg";
import { getPool } from "@/lib/db/pool";
import { getOrder, refundOrder, V2CommerceError } from "@/lib/v2/commerce-client";
import { getTossPaymentByPaymentKey, tossProvider } from "@/lib/payment/toss";
import { alertPaymentManualReview } from "@/lib/payment/payment-alert";
import { logger } from "@/lib/logger";

export type CompensationStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "failed_retryable"
  | "unknown"
  | "manual_review"
  | "cancelled";

export async function enqueueExpiredPaymentCompensation(
  client: PoolClient,
  input: {
    orderId: string;
    /**
     * v2 order 앵커. v2 provider 환불엔 필수, toss provider 환불엔 불필요(NULL 허용).
     * (mig230: v2_order_id NOT NULL 완화 — Toss 는 provider_payment_key 만으로 환불 가능.)
     */
    v2OrderId: string | null;
    deliveryId: string | null;
    amount: number;
    reason?: string;
    /** Toss 시도별 정확한 환불 대상. 지정되면 orders.payment_reference를 재조회하지 않는다. */
    providerPaymentKey?: string | null;
    /**
     * 환불 성공 후 go 주문에 투영할 상태.
     *  - undefined/null(기본): 레거시 만료(order expired) 경로 — payment_status 만 갱신(WHERE status='expired').
     *  - 'refunded': seat-expiry 경로 — 환불 성공 후에만 completed→refunded(상태머신) + 티켓 취소 cascade.
     */
    postRefundOrderStatus?: "refunded" | null;
  },
) {
  const providerPaymentKey = input.providerPaymentKey ?? null;
  const idempotencyKey = providerPaymentKey ? `toss:${providerPaymentKey}` : "order";
  const result = await client.query<{ id: string }>(
    `
      INSERT INTO payment_compensation_actions
        (order_id, v2_order_id, action, reason, source_delivery_id, requested_amount,
         requested_refund_amount, original_payment_amount, status, max_attempts,
         provider_name, provider_payment_key, post_refund_order_status, idempotency_key)
      VALUES ($1, $2::uuid, 'refund', $3, $4::uuid, GREATEST($5, 0),
              GREATEST($5, 0), GREATEST($5, 0), 'pending', 5,
              CASE WHEN $7::text IS NOT NULL THEN 'toss'
                   ELSE COALESCE((SELECT CASE WHEN payment_method = 'toss' THEN 'toss' ELSE 'v2' END FROM orders WHERE id = $1), 'v2')
              END,
              COALESCE($7::text, (SELECT payment_reference FROM orders WHERE id = $1)),
              $6, $8)
      ON CONFLICT (order_id, action, idempotency_key) DO UPDATE SET
        requested_amount = GREATEST(payment_compensation_actions.requested_amount, EXCLUDED.requested_amount),
        requested_refund_amount = GREATEST(COALESCE(payment_compensation_actions.requested_refund_amount, 0), EXCLUDED.requested_refund_amount),
        source_delivery_id = COALESCE(payment_compensation_actions.source_delivery_id, EXCLUDED.source_delivery_id),
        provider_name = COALESCE(payment_compensation_actions.provider_name, EXCLUDED.provider_name),
        provider_payment_key = COALESCE(payment_compensation_actions.provider_payment_key, EXCLUDED.provider_payment_key),
        post_refund_order_status = COALESCE(payment_compensation_actions.post_refund_order_status, EXCLUDED.post_refund_order_status),
        updated_at = NOW()
      RETURNING id
    `,
    [
      input.orderId,
      input.v2OrderId,
      input.reason ?? "payment_confirmed_after_order_expired",
      input.deliveryId,
      input.amount,
      input.postRefundOrderStatus ?? null,
      providerPaymentKey,
      idempotencyKey,
    ],
  );
  return result.rows[0]?.id ?? null;
}

/**
 * 자동환불이 불가능한 실결제 보상을 **manual_review** 로 hard-record 한다(레벨2 재감사 P0조건부, 옵션 b).
 *
 * 대상: v2 앵커도 없고 provider_payment_key(Toss paymentKey)도 없어 어떤 provider 로도 자동환불을
 *   부를 수 없는 주문(레거시/오프라인/NICE 미앵커 등). 과거엔 이 경우 console.error 로그만 남기고
 *   조용히 흘려보냈다(실돈 유실 위험). 이제:
 *     ① payment_compensation_actions 에 status='manual_review' 로 durable 기록(운영 큐 = 기존
 *        ix_payment_compensation_review 인덱스로 조회) → 유실이 아니라 **처리 대기 원장**이 된다.
 *     ② 호출측이 alertPaymentManualReview(Sentry) 로 즉시 에스컬레이션.
 *   → "조용한 유실" 금지. 자동환불은 없지만(앵커 부재), 운영자가 반드시 인지·처리하도록 강제.
 *
 * 멱등: UNIQUE(order_id, action) 로 재기록해도 1행. 이미 다른 상태(pending/completed 등)면
 *   manual_review 로 덮지 않는다(진행 중인 자동환불을 되돌리지 않도록 DO UPDATE 가드).
 */
export async function enqueuePaymentCompensationManualReview(
  client: PoolClient,
  input: {
    orderId: string;
    amount: number;
    reason: string;
    /** 만료(expired) vs seat-expiry(completed→refunded) 투영 목표 — 운영자 수동 환불 후 참고용. */
    postRefundOrderStatus?: "refunded" | null;
  },
) {
  const result = await client.query<{ id: string }>(
    `
      INSERT INTO payment_compensation_actions
        (order_id, v2_order_id, action, reason, source_delivery_id, requested_amount,
         requested_refund_amount, original_payment_amount, status, max_attempts,
         provider_name, provider_payment_key, post_refund_order_status,
         manual_review_reason, idempotency_key)
      VALUES ($1, NULL, 'refund', $2, NULL, GREATEST($3, 0),
              GREATEST($3, 0), GREATEST($3, 0), 'manual_review', 5,
              COALESCE((SELECT CASE WHEN payment_method = 'toss' THEN 'toss' ELSE 'v2' END FROM orders WHERE id = $1), 'v2'),
              NULL, $4, 'no_refund_anchor', 'order')
      ON CONFLICT (order_id, action, idempotency_key) DO UPDATE SET
        requested_amount = GREATEST(payment_compensation_actions.requested_amount, EXCLUDED.requested_amount),
        requested_refund_amount = GREATEST(COALESCE(payment_compensation_actions.requested_refund_amount, 0), EXCLUDED.requested_refund_amount),
        post_refund_order_status = COALESCE(payment_compensation_actions.post_refund_order_status, EXCLUDED.post_refund_order_status),
        -- 이미 자동환불 진행/완료 중인 행은 manual_review 로 되돌리지 않는다(pending 이 남은 극단만 승격).
        status = CASE WHEN payment_compensation_actions.status = 'pending' THEN 'manual_review' ELSE payment_compensation_actions.status END,
        manual_review_reason = CASE WHEN payment_compensation_actions.status = 'pending' THEN 'no_refund_anchor' ELSE payment_compensation_actions.manual_review_reason END,
        updated_at = NOW()
      RETURNING id
    `,
    [
      input.orderId,
      input.reason,
      input.amount,
      input.postRefundOrderStatus ?? null,
    ],
  );
  return result.rows[0]?.id ?? null;
}

/**
 * 결제완료 후 좌석 홀드 만료 race(seat-expiry)의 환불을 결제 보상 큐에 durable 하게 기록한다.
 * (레벨2 재감사 P0-2)
 *
 * 만료(order expired) 보상과 같은 provider별 환불 outbox 를 재사용하되, go 주문이 completed 라는
 * 점이 다르다. 따라서 postRefundOrderStatus='refunded' 로 표기해, 보상 워커가 **외부 환불(Toss
 * cancel / v2 refundOrder)에 성공한 뒤에만** go completed→refunded(상태머신) 를 투영하도록 한다.
 *
 * ⚠️ 이 함수는 호출자의 트랜잭션(client)에 액션 행만 기록한다(외부호출 0). go orders.completed·
 *    attendees.confirmed 와 **동일 트랜잭션**에서 원자 커밋되므로 "completed 인데 보상 액션 없음"이
 *    구조적으로 불가능하다. 실제 환불·상태 투영은 COMMIT 후 payment-reconcile cron 의 drain 이 수행.
 */
export async function enqueueSeatExpiredPaymentCompensation(
  client: PoolClient,
  input: { orderId: string; v2OrderId: string | null; amount: number },
) {
  return enqueueExpiredPaymentCompensation(client, {
    orderId: input.orderId,
    v2OrderId: input.v2OrderId,
    deliveryId: null,
    amount: input.amount,
    reason: "seat_expired_after_payment",
    postRefundOrderStatus: "refunded",
  });
}

/**
 * 환불 성공/대사 확정 후 go 주문 상태를 투영한다(멱등, 동일 트랜잭션 client 내부에서 호출).
 *  - postRefundOrderStatus === 'refunded'(seat-expiry): completed→refunded(상태머신 유효 전이) +
 *    티켓(attendees) 취소 cascade. 이미 refunded 면 no-op(멱등).
 *  - 그 외(레거시 만료): status='expired' 조건으로 payment_status='refunded' 만 갱신.
 */
async function projectRefundedOrder(
  client: PoolClient,
  input: {
    orderId: string;
    requested: number;
    confirmed: number | null;
    postRefundOrderStatus: string | null;
  },
) {
  if (input.postRefundOrderStatus === "refunded") {
    // completed→refunded 유효 전이만 적용. 이미 refunded/그 외 상태면 0행(멱등 no-op).
    const transitioned = await client.query(
      `UPDATE orders
          SET status = 'refunded',
              payment_status = 'refunded',
              refund_amount = LEAST(GREATEST(COALESCE($2, refund_amount, 0), 0), COALESCE(paid_amount, total_amount)),
              updated_at = NOW()
        WHERE id = $1 AND status = 'completed'`,
      [input.orderId, input.confirmed ?? input.requested],
    );
    if ((transitioned.rowCount ?? 0) > 0) {
      // 전액 환불 → 티켓 취소 cascade(체크인 차단). internal webhook handleRefunded 와 동일 원칙.
      await client.query(
        `UPDATE attendees SET status = 'cancelled', updated_at = NOW()
          WHERE order_id = $1 AND status <> 'cancelled'`,
        [input.orderId],
      );
    }
    return;
  }
  // 레거시 경로: 만료(expired) 또는 orphan-toss 복구로 취소(cancelled)된 주문의 결제상태만 갱신.
  // 상태 전이는 이미 호출측(webhook/orphan 스캐너)이 완료했으므로 여기선 payment_status 만 수렴.
  await client.query(
    `UPDATE orders
        SET payment_status = 'refunded',
            refund_amount = GREATEST(COALESCE(refund_amount, 0), $2),
            updated_at = NOW()
      WHERE id = $1 AND status IN ('expired', 'cancelled')`,
    [input.orderId, input.requested],
  );
}

export interface CompensationSummary {
  claimed: number;
  completed: number;
  failed: number;
  unknown: number;
  manualReview: number;
}

type CompensationRow = {
  id: string;
  order_id: string;
  v2_order_id: string | null;
  requested_amount: string | number;
  attempts: number;
  attempt_count: number;
  max_attempts: number;
  lease_token: string;
  provider_name?: "v2" | "toss";
  provider_payment_key?: string | null;
  post_refund_order_status?: string | null;
};

function summarizeError(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[phone]")
    .slice(0, 300);
}

function classifyProviderError(err: unknown): "unknown" | "retryable" | "permanent" {
  const status = err instanceof V2CommerceError || (typeof err === "object" && err !== null && "status" in err)
    ? Number((err as { status?: unknown }).status)
    : Number.NaN;
  if (Number.isFinite(status)) {
    if (status === 0 || status >= 500) return "unknown";
    if (status === 429) return "retryable";
    if (status >= 400 && status < 500) return "permanent";
  }
  // A non-provider Error may happen after the request was written. Treat it as
  // ambiguous; a duplicate refund is worse than manual review.
  return "unknown";
}

function resultRefundAmount(result: { refunded?: number; total_refunded?: number }): number | null {
  const value = result.total_refunded ?? result.refunded;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function tossRefundedAmount(payment: Record<string, unknown>): number {
  const cancels = Array.isArray(payment.cancels) ? payment.cancels : [];
  return cancels.reduce((sum, cancel) => {
    if (!cancel || typeof cancel !== "object") return sum;
    const amount = Number((cancel as Record<string, unknown>).cancelAmount ?? 0);
    return sum + (Number.isFinite(amount) ? amount : 0);
  }, 0);
}

/**
 * provider 환불은 **성공했는데** v2 반영이 실패한 상태 전용 예외.
 *
 * 🔴 이 상태를 일반 실패로 재시도하면 **두 번 환불**되고, 성공으로 처리하면 v2 가 CONFIRMED 로
 *    남아 **환불받고도 입장 가능 + 정산 과대계상**이 된다. 둘 다 돈이 틀어지므로 재시도·완료
 *    어느 쪽으로도 흘리지 않고 `manual_review` 로 고정한다(사람이 v2 를 맞춘다).
 */
export class V2RefundPropagationError extends Error {
  constructor(
    readonly reason:
      | "v2_anchor_missing"
      | "v2_propagation_failed"
      // 게이트가 우회된 뒤(=v2 조회 실패) provider 는 나갔는데 v2 가 입장이력을 이유로 거절한 경우.
      | "ticket_already_admitted_after_provider",
    readonly providerResult: Record<string, unknown>,
    readonly cause?: unknown,
  ) {
    super(
      reason === "v2_anchor_missing"
        ? "provider refund succeeded but the v2 order anchor is missing"
        : reason === "ticket_already_admitted_after_provider"
          ? "provider refund succeeded but v2 rejected it: ticket already admitted"
          : "provider refund succeeded but the v2 refund propagation failed",
    );
    this.name = "V2RefundPropagationError";
  }
}

/**
 * v2 가 "이미 입장한 티켓" 을 이유로 환불을 거절했는가(422).
 *
 * 정본: `platform/backend/app/api/v1/internal_commerce.py` `_do_refund_order` 의 입장 게이트.
 * 이 판정이 필요한 이유 — T10 게이트는 `getOrder` 실패 시 통과시킨다(v2 장애를 환불 중단
 * 사유로 승격시키지 않으려고). 그 좁은 창에서 provider 는 나가고 v2 가 422 로 거절하는데,
 * 그때 사유가 `v2_propagation_failed` 로 뭉개지면 운영자가 **"v2 장애"로 오독**한다.
 * 실제로는 "돈은 나갔고 v2 는 멀쩡하며 티켓이 입장 상태" 라는 전혀 다른 처리 대상이다.
 */
function isAdmittedTicketRejection(err: unknown): boolean {
  if (!(err instanceof V2CommerceError) || err.status !== 422) return false;
  return /already[_ ]?admitted|입장/i.test(`${err.message} ${err.body ?? ""}`);
}

/**
 * 입장(체크인)한 티켓이 있어 자동 환불을 중단해야 하는 상태 (지시서 #4 T10).
 *
 * 🔴 `V2RefundPropagationError` 와 **반드시 구분**한다. 그쪽은 "돈은 이미 나갔는데 v2 반영이
 *    실패" 이고, 이쪽은 **provider 를 아직 부르지 않았다**. 사유를 뭉개면 운영자가
 *    "v2 장애"로 오해하고 잘못된 복구(재전파)를 시도한다.
 */
export class AdmittedTicketRefundBlocked extends Error {
  constructor(readonly admittedCount: number) {
    super(`refund blocked: ${admittedCount} ticket(s) already admitted`);
    this.name = "AdmittedTicketRefundBlocked";
  }
}

/**
 * 입장 이력이 있으면 provider 를 **부르기 전에** 막는다 (T10).
 *
 * v2 `_do_refund_order` 에 "입장한 티켓이 있으면 422" 불변식이 들어갔다. 그런데 이 보상 경로는
 * provider 취소를 **먼저** 하고 v2 전파를 나중에 하므로, 그대로 두면
 *   Toss cancel 성공(실돈 나감) → v2 422 → manual_review
 * 로 착지한다. 안전망이 받아내긴 하지만 **애초에 실돈을 내보내지 않는 게 맞다**.
 *
 * 판정 데이터는 이미 손에 있는 것과 동일하다 — go 환불 라우트가 쓰는 `getOrder` 응답의
 * `tickets[].checked_in_at` / `status === "used"`. 추가 왕복은 없다.
 *
 * ⚠️ 조회 자체가 실패하면 **막지 않는다**(기존 경로 진행). 이 게이트는 알려진 입장 이력을
 *    차단하기 위한 것이지, v2 장애를 환불 중단 사유로 승격시키기 위한 것이 아니다.
 *    (v2 가 죽어 있으면 어차피 뒤의 propagateRefundToV2 에서 걸린다.)
 */
async function assertNoAdmittedTickets(row: CompensationRow): Promise<void> {
  if (!row.v2_order_id) return;
  let admitted = 0;
  try {
    const order = await getOrder(row.v2_order_id, {
      idempotencyKey: `payment-compensation-admission:${row.id}`,
    });
    admitted = (order.tickets ?? []).filter(
      (t) => t.checked_in_at !== null || String(t.status ?? "").toLowerCase() === "used",
    ).length;
  } catch (err: unknown) {
    logger.warn("[payment-compensation] 입장 이력 확인 실패 — 게이트 미적용(기존 경로 진행)", {
      actionId: row.id,
      v2OrderId: row.v2_order_id,
      error: summarizeError(err instanceof Error ? err.message : String(err)),
    });
    return;
  }
  if (admitted > 0) throw new AdmittedTicketRefundBlocked(admitted);
}

/**
 * provider(=Toss) 환불 성공분을 v2 로 반영한다.
 *
 * 멱등키는 v2 provider 경로와 **동일한 `payment-compensation:{actionId}`** 를 쓴다 —
 * 워커 재시도·크래시 후 재실행에도 v2 가 같은 키를 dedup 해 2회 환불이 생기지 않는다.
 */
async function propagateRefundToV2(
  row: CompensationRow,
  providerResult: Record<string, unknown>,
): Promise<void> {
  if (!row.v2_order_id) {
    // 앵커가 없으면 v2 를 맞출 방법이 없다. 돈은 이미 나갔으므로 조용히 완료시키지 않는다.
    throw new V2RefundPropagationError("v2_anchor_missing", providerResult);
  }
  try {
    await refundOrder(
      row.v2_order_id,
      // 🔴 T16: 이 경로는 **위에서 Toss 취소를 이미 마쳤다**. v2 가 PG 를 또 부르면
      //    이중 환불이다. 반대로 아래 v2-provider 경로는 v2 가 환불 주체라 켜면 안 된다.
      { full: true, reason: "payment_confirmed_after_order_expired", pg_already_voided: true },
      { idempotencyKey: `payment-compensation:${row.id}` },
    );
  } catch (err: unknown) {
    // 입장이력 거절(422)은 "v2 장애" 가 아니다 — 사유를 분리해 운영자가 다른 처리를 하게 한다.
    throw new V2RefundPropagationError(
      isAdmittedTicketRejection(err) ? "ticket_already_admitted_after_provider" : "v2_propagation_failed",
      providerResult,
      err,
    );
  }
}

async function refundWithProvider(row: CompensationRow, requested: number) {
  // 🔴 T10: provider 를 부르기 **전에** 입장 이력을 본다. 실돈이 나간 뒤에 v2 가 422 로
  //    거절하면 되돌릴 수 없다(안전망이 manual_review 로 받지만 돈은 이미 나갔다).
  //    `allow_admitted` 플래그는 여기서 켜지 않는다 — 자동 보상 경로에는 "주최자가
  //    판단했다"는 근거가 없다. 그 플래그는 사람이 명시 판단한 경로 전용이다.
  await assertNoAdmittedTickets(row);
  if (row.provider_name === "toss") {
    if (!row.provider_payment_key) {
      throw new Error("Toss compensation payment key is missing; provider refund is ambiguous");
    }
    const before = await getTossPaymentByPaymentKey(row.provider_payment_key);
    if (before) {
      const alreadyRefunded = tossRefundedAmount(before);
      if (alreadyRefunded >= requested) {
        const result = {
          status: "refunded",
          refund_id: String(before.lastTransactionKey ?? "") || null,
          refunded: alreadyRefunded,
          total_refunded: alreadyRefunded,
        };
        // 이미 환불된 건도 v2 는 아직 CONFIRMED 일 수 있다(과거 미전파분 회수). 멱등키로 안전.
        await propagateRefundToV2(row, result);
        return result;
      }
    }
    const cancelled = await tossProvider.cancel({
      paymentKey: row.provider_payment_key,
      reason: "payment_confirmed_after_order_expired",
      amount: Math.max(requested - (before ? tossRefundedAmount(before) : 0), 0) || undefined,
    });
    const after = await getTossPaymentByPaymentKey(row.provider_payment_key);
    if (!after) {
      throw new Error("Toss cancel accepted but payment lookup is unavailable");
    }
    const totalRefunded = tossRefundedAmount(after);
    const result = {
      status: String(after.status ?? (cancelled.success ? "refunded" : "unknown")),
      refund_id: String(after.lastTransactionKey ?? "") || null,
      refunded: cancelled.cancelAmount,
      total_refunded: totalRefunded,
    };
    // 🔴 여기서 반드시 v2 로 전파한다. 예전엔 이 return 이 v2 refundOrder 를 건너뛰어
    //    go=refunded / v2=confirmed(티켓 ACTIVE) 로 영구 발산했다.
    await propagateRefundToV2(row, result);
    return result;
  }
  if (!row.v2_order_id) {
    throw new Error("v2 compensation order anchor is missing");
  }
  return refundOrder(
    row.v2_order_id,
    { full: true, reason: "payment_confirmed_after_order_expired" },
    { idempotencyKey: `payment-compensation:${row.id}` },
  );
}

/**
 * 만료 주문 결제 보상 큐를 한 번 drain한다.
 *
 * 외부 환불 호출은 트랜잭션 밖에서 수행하고, 먼저 processing을 기록한다.
 * v2 환불 API는 idempotency key를 받아 워커 재시작/네트워크 재시도에도
 * 중복 환불을 만들지 않는다. 오래된 processing은 다음 실행에서 다시 회수한다.
 */
export async function processExpiredPaymentCompensations(limit = 50): Promise<CompensationSummary> {
  const pool = getPool();
  const client = await pool.connect();
  let rows: CompensationRow[] = [];
  try {
    await client.query("BEGIN");
    // A crashed worker may have sent the request already. Never recycle an
    // expired processing lease directly to retryable; move it to unknown so a
    // provider reconciliation or owner decision is required first.
    await client.query(
      `UPDATE payment_compensation_actions
          SET status = 'unknown', unknown_since = COALESCE(unknown_since, NOW()),
              manual_review_reason = 'compensation_lease_expired', lease_token = NULL,
              lease_expires_at = NULL, next_retry_at = NULL, updated_at = NOW()
        WHERE status = 'processing'
          AND (lease_expires_at < NOW() OR (lease_expires_at IS NULL AND updated_at < NOW() - INTERVAL '15 minutes'))`,
    );
    await client.query(
      `UPDATE payment_compensation_actions
          SET status = 'manual_review', manual_review_reason = 'max_attempts_exceeded',
              reviewed_at = NULL, reviewed_by = NULL, updated_at = NOW()
        WHERE status IN ('pending', 'failed_retryable')
          AND attempt_count >= max_attempts`,
    );
    const claimed = await client.query<CompensationRow>(
      `
        SELECT id, order_id, v2_order_id, requested_amount, attempts, attempt_count, max_attempts,
               provider_name, provider_payment_key, post_refund_order_status
          FROM payment_compensation_actions
         WHERE status IN ('pending', 'failed_retryable')
           AND COALESCE(next_retry_at, next_attempt_at) <= NOW()
           AND attempt_count < max_attempts
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT $1
      `,
      [limit],
    );
    if (claimed.rows.length > 0) {
      rows = claimed.rows.map((row) => ({ ...row, lease_token: crypto.randomUUID() }));
      for (const row of rows) {
        await client.query(
          `UPDATE payment_compensation_actions
              SET status = 'processing', attempts = attempts + 1,
                  attempt_count = attempt_count + 1, lease_token = $2::uuid,
                  lease_expires_at = NOW() + INTERVAL '15 minutes',
                  first_attempted_at = COALESCE(first_attempted_at, NOW()),
                  last_attempted_at = NOW(), lock_version = lock_version + 1,
                  updated_at = NOW()
            WHERE id = $1 AND status IN ('pending', 'failed_retryable')`,
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

  let completed = 0;
  let failed = 0;
  let unknown = 0;
  let manualReview = 0;
  for (const row of rows) {
    try {
      const requested = Number(row.requested_amount) || 0;
      const result = await refundWithProvider(row, requested);
      const confirmed = resultRefundAmount(result);
      const resultStatus = String(result.status ?? "").toLowerCase();
      if (confirmed !== null && confirmed < requested) {
        await pool.query(
          `UPDATE payment_compensation_actions
              SET status = 'manual_review', manual_review_reason = 'partial_refund',
                  confirmed_refund_amount = $2, provider_status = $3,
                  lease_token = NULL, lease_expires_at = NULL, updated_at = NOW()
            WHERE id = $1 AND status = 'processing' AND lease_token = $4::uuid`,
          [row.id, confirmed, resultStatus, row.lease_token],
        );
        manualReview++;
        continue;
      }
      if (confirmed === null && !resultStatus.includes("refund")) {
        await pool.query(
          `UPDATE payment_compensation_actions
              SET status = 'manual_review', manual_review_reason = 'provider_result_unrecognized',
                  provider_status = $2, lease_token = NULL, lease_expires_at = NULL, updated_at = NOW()
            WHERE id = $1 AND status = 'processing' AND lease_token = $3::uuid`,
          [row.id, resultStatus || "unknown", row.lease_token],
        );
        manualReview++;
        continue;
      }

      const finalClient = await pool.connect();
      try {
        await finalClient.query("BEGIN");
        const updated = await finalClient.query(
          `UPDATE payment_compensation_actions
              SET status = 'completed', provider_reference = $2,
              provider_refund_id = $3, provider_cancel_id = COALESCE($3, provider_cancel_id),
                  confirmed_refund_amount = COALESCE($4, requested_refund_amount),
                  provider_status = $5, completed_at = NOW(), last_error = NULL,
                  lease_token = NULL, lease_expires_at = NULL, updated_at = NOW()
            WHERE id = $1 AND status = 'processing' AND lease_token = $6::uuid
            RETURNING order_id`,
          [row.id, result.status || (result as { order_id?: string }).order_id || null, (result as { refund_id?: string }).refund_id ?? null,
            confirmed, resultStatus, row.lease_token],
        );
        if ((updated.rowCount ?? 0) > 0) {
          await projectRefundedOrder(finalClient, {
            orderId: row.order_id,
            requested,
            confirmed,
            postRefundOrderStatus: row.post_refund_order_status ?? null,
          });
          completed++;
        }
        await finalClient.query("COMMIT");
      } catch (error) {
        await finalClient.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        finalClient.release();
      }
      logger.info("[payment-compensation] 만료 주문 결제 환불 완료", {
        actionId: row.id,
        orderId: row.order_id,
        v2OrderId: row.v2_order_id,
        amount: Number(row.requested_amount),
      });
    } catch (err: unknown) {
      // 🔴 T10: 입장한 티켓이 있어 **provider 를 부르지 않고** 멈춘 경우.
      //    돈은 나가지 않았다 — 재시도해도 결과가 같으므로 즉시 사람에게 넘긴다.
      //    사유를 `v2_propagation_failed` 와 섞지 않는다(그건 "돈은 나갔다"는 뜻이라
      //    운영자가 완전히 다른 복구를 하게 된다).
      if (err instanceof AdmittedTicketRefundBlocked) {
        await pool.query(
          `UPDATE payment_compensation_actions
              SET status = 'manual_review', manual_review_reason = 'ticket_already_admitted',
                  last_error = $2, last_error_summary = $2,
                  lease_token = NULL, lease_expires_at = NULL, updated_at = NOW()
            WHERE id = $1 AND status = 'processing' AND lease_token = $3::uuid`,
          [row.id, summarizeError(err.message), row.lease_token],
        );
        manualReview++;
        logger.error("[payment-compensation] 입장한 티켓 있음 — provider 미호출 · manual_review", {
          actionId: row.id,
          orderId: row.order_id,
          v2OrderId: row.v2_order_id,
          admittedCount: err.admittedCount,
        });
        alertPaymentManualReview({
          source: "compensation",
          orderId: row.order_id,
          v2OrderId: row.v2_order_id,
          amount: Number(row.requested_amount) || 0,
          reason: "ticket_already_admitted",
          attempts: row.attempt_count + 1,
        });
        continue;
      }
      // 🔴 provider 환불 성공 + v2 반영 실패 — 재시도(2회 환불)도 완료(정산 과대계상)도 금지.
      //    돈이 이미 나간 상태이므로 manual_review 로 고정하고 즉시 운영 알림을 올린다.
      if (err instanceof V2RefundPropagationError) {
        const providerRefundId =
          typeof err.providerResult.refund_id === "string" ? err.providerResult.refund_id : null;
        const providerStatus = String(err.providerResult.status ?? "refunded").toLowerCase();
        const providerRefunded = resultRefundAmount(err.providerResult);
        await pool.query(
          `UPDATE payment_compensation_actions
              SET status = 'manual_review', manual_review_reason = $2,
                  provider_refund_id = COALESCE($3, provider_refund_id),
                  provider_cancel_id = COALESCE($3, provider_cancel_id),
                  provider_status = $4,
                  confirmed_refund_amount = COALESCE($5, confirmed_refund_amount),
                  last_error = $6, last_error_summary = $6,
                  lease_token = NULL, lease_expires_at = NULL, updated_at = NOW()
            WHERE id = $1 AND status = 'processing' AND lease_token = $7::uuid`,
          [
            row.id,
            err.reason,
            providerRefundId,
            providerStatus,
            providerRefunded,
            summarizeError(err.message),
            row.lease_token,
          ],
        );
        manualReview++;
        logger.error("[payment-compensation] provider 환불 성공 · v2 반영 실패 — manual_review 고정", {
          actionId: row.id,
          orderId: row.order_id,
          v2OrderId: row.v2_order_id,
          reason: err.reason,
          providerRefundId,
        });
        alertPaymentManualReview({
          source: "compensation",
          orderId: row.order_id,
          v2OrderId: row.v2_order_id,
          amount: Number(row.requested_amount) || 0,
          reason: err.reason,
          attempts: row.attempt_count,
        });
        continue;
      }
      // 🔴 T18: provider='v2' 경로의 입장거절(422)이 조용히 묻히던 지점.
      //    이 경로는 `refundOrder` 를 직접 부르므로 422 가 propagateRefundToV2 를 거치지 않고
      //    그대로 여기로 온다 → classifyProviderError 가 4xx 를 permanent 로 보고 `failed`.
      //    `failed` 는 운영 큐 인덱스(ix_payment_compensation_review = unknown/manual_review)에도
      //    `alertPaymentManualReview` 에도 안 잡히고, 관리자 목록 기본 탭도 'unknown' 이라
      //    **아무도 보지 않는 종착역**이다. 실돈은 안 나갔지만 "환불이 안 됐다"는 사실이 사라진다.
      //    Toss 경로(T10)와 같은 곳으로 수렴시킨다 — 사람이 판단해야 하는 같은 종류의 일이다.
      if (isAdmittedTicketRejection(err)) {
        await pool.query(
          `UPDATE payment_compensation_actions
              SET status = 'manual_review', manual_review_reason = 'ticket_already_admitted',
                  last_error = $2, last_error_summary = $2,
                  lease_token = NULL, lease_expires_at = NULL, updated_at = NOW()
            WHERE id = $1 AND status = 'processing' AND lease_token = $3::uuid`,
          [row.id, summarizeError(err instanceof Error ? err.message : String(err)), row.lease_token],
        );
        manualReview++;
        logger.error("[payment-compensation] v2 가 입장이력을 이유로 환불 거절 — manual_review", {
          actionId: row.id,
          orderId: row.order_id,
          v2OrderId: row.v2_order_id,
          providerName: row.provider_name,
        });
        alertPaymentManualReview({
          source: "compensation",
          orderId: row.order_id,
          v2OrderId: row.v2_order_id,
          amount: Number(row.requested_amount) || 0,
          reason: "ticket_already_admitted",
          attempts: row.attempt_count,
        });
        continue;
      }
      const message = summarizeError(err instanceof Error ? err.message : String(err));
      const kind = classifyProviderError(err);
      const exhausted = row.attempt_count >= row.max_attempts;
      const nextDelayMinutes = Math.min(60, 2 ** Math.min(row.attempt_count, 5));
      const targetStatus = kind === "unknown" ? "unknown" : kind === "permanent" ? "failed" : exhausted ? "manual_review" : "failed_retryable";
      await pool.query(
        `UPDATE payment_compensation_actions
            SET status = $2, last_error = $3, last_error_summary = $3,
                manual_review_reason = CASE WHEN $2 = 'manual_review' THEN 'max_attempts_exceeded' ELSE manual_review_reason END,
                unknown_since = CASE WHEN $2 = 'unknown' THEN COALESCE(unknown_since, NOW()) ELSE unknown_since END,
                next_retry_at = CASE WHEN $2 = 'failed_retryable' THEN NOW() + ($4 || ' minutes')::interval ELSE NULL END,
                next_attempt_at = CASE WHEN $2 = 'failed_retryable' THEN NOW() + ($4 || ' minutes')::interval ELSE next_attempt_at END,
                lease_token = NULL, lease_expires_at = NULL, updated_at = NOW()
          WHERE id = $1 AND status = 'processing' AND lease_token = $5::uuid`,
        [row.id, targetStatus, message, String(nextDelayMinutes), row.lease_token],
      );
      if (targetStatus === "unknown") unknown++;
      else if (targetStatus === "manual_review") manualReview++;
      else failed++;
      logger.error("[payment-compensation] 만료 주문 결제 환불 실패 — 재시도 대기", {
        actionId: row.id,
        orderId: row.order_id,
        v2OrderId: row.v2_order_id,
        status: typeof err === "object" && err !== null && "status" in err ? Number((err as { status?: unknown }).status) : undefined,
        error: message,
      });
      if (targetStatus === "manual_review") {
        alertPaymentManualReview({
          source: "compensation",
          orderId: row.order_id,
          v2OrderId: row.v2_order_id,
          amount: Number(row.requested_amount) || 0,
          reason: "max_attempts_exceeded",
          attempts: row.attempt_count,
        });
      }
    }
  }

  return { claimed: rows.length, completed, failed, unknown, manualReview };
}

export interface CompensationReconciliationSummary {
  checked: number;
  resolved: number;
  manualReview: number;
  remaining: number;
}

const COMPENSATION_UNKNOWN_MAX_AGE_MINUTES = 120;

/** Provider order read로 unknown 환불을 대사한다. 0원/부분 환불을 성공으로 추측하지 않는다. */
export async function reconcileUnknownCompensations(limit = 50): Promise<CompensationReconciliationSummary> {
  const pool = getPool();
  const { rows } = await pool.query<{
    id: string;
    order_id: string;
    v2_order_id: string | null;
    requested_amount: string | number;
    unknown_since: string;
    provider_name: "v2" | "toss";
    provider_payment_key: string | null;
    provider_lookup_count: number;
    post_refund_order_status: string | null;
  }>(
    `WITH claim AS (
       SELECT id
         FROM payment_compensation_actions
        WHERE status = 'unknown'
          AND (next_retry_at IS NULL OR next_retry_at <= NOW())
        ORDER BY COALESCE(unknown_since, created_at)
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
       UPDATE payment_compensation_actions a
        SET next_retry_at = NOW() + INTERVAL '5 minutes',
            provider_lookup_count = provider_lookup_count + 1,
            provider_last_lookup_at = NOW(), updated_at = NOW()
       FROM claim
      WHERE a.id = claim.id
      RETURNING a.id, a.order_id, a.v2_order_id, a.requested_amount,
                COALESCE(a.unknown_since, a.created_at) AS unknown_since,
                a.provider_name, a.provider_payment_key, a.provider_lookup_count,
                a.post_refund_order_status`,
    [limit],
  );

  let resolved = 0;
  let manualReview = 0;
  for (const row of rows) {
    const requested = Number(row.requested_amount) || 0;
    const ageMinutes = (Date.now() - new Date(row.unknown_since).getTime()) / 60_000;
    const lookupCount = Number(row.provider_lookup_count ?? 0);
    try {
      let providerStatus: string | null = null;
      let refunded = 0;
      if (row.provider_name === "toss" && row.provider_payment_key) {
        const payment = await getTossPaymentByPaymentKey(row.provider_payment_key);
        if (!payment) throw new Error("Toss payment lookup unavailable");
        refunded = tossRefundedAmount(payment);
        providerStatus = String(payment.status ?? "unknown");
      } else {
        if (!row.v2_order_id) throw new Error("v2 compensation order anchor is missing");
        const order = await getOrder(row.v2_order_id, { idempotencyKey: `payment-compensation-reconcile:${row.id}` });
        refunded = Number(order.total_refunded ?? 0);
        providerStatus = order.status_v2 ?? order.status;
      }
      if (refunded >= requested && requested > 0) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const updated = await client.query(
            `UPDATE payment_compensation_actions
                SET status = 'completed', confirmed_refund_amount = $2,
                    provider_status = $3, completed_at = NOW(),
                    lease_token = NULL, lease_expires_at = NULL, next_retry_at = NULL,
                    updated_at = NOW()
              WHERE id = $1 AND status = 'unknown'`,
            [row.id, refunded, providerStatus],
          );
          if ((updated.rowCount ?? 0) > 0) {
            await projectRefundedOrder(client, {
              orderId: row.order_id,
              requested,
              confirmed: refunded,
              postRefundOrderStatus: row.post_refund_order_status ?? null,
            });
            resolved++;
          }
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
        continue;
      }

      const partial = refunded > 0 && refunded < requested;
      const terminal = partial || ageMinutes >= COMPENSATION_UNKNOWN_MAX_AGE_MINUTES || lookupCount >= 5;
      await pool.query(
        `UPDATE payment_compensation_actions
            SET status = $2,
                manual_review_reason = CASE WHEN $2 = 'manual_review' THEN $3 ELSE manual_review_reason END,
                confirmed_refund_amount = $4,
                provider_status = $5,
                next_retry_at = CASE WHEN $2 = 'unknown' THEN NOW() + INTERVAL '15 minutes' ELSE NULL END,
                updated_at = NOW()
          WHERE id = $1 AND status = 'unknown'`,
        [row.id, terminal ? "manual_review" : "unknown", partial ? "partial_refund" : "provider_not_refunded", refunded, providerStatus],
      );
      if (terminal) manualReview++;
    } catch (err) {
      const terminal = ageMinutes >= COMPENSATION_UNKNOWN_MAX_AGE_MINUTES;
      await pool.query(
        `UPDATE payment_compensation_actions
            SET status = $2,
                manual_review_reason = CASE WHEN $2 = 'manual_review' THEN 'provider_reconciliation_failed' ELSE manual_review_reason END,
                last_error_summary = $3,
                next_retry_at = CASE WHEN $2 = 'unknown' THEN NOW() + INTERVAL '15 minutes' ELSE NULL END,
                updated_at = NOW()
          WHERE id = $1 AND status = 'unknown'`,
        [row.id, terminal ? "manual_review" : "unknown", summarizeError(err instanceof Error ? err.message : String(err))],
      );
      if (terminal) manualReview++;
    }
  }

  return { checked: rows.length, resolved, manualReview, remaining: Math.max(rows.length - resolved - manualReview, 0) };
}
