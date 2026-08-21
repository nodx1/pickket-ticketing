import crypto from "node:crypto";
import type { PoolClient } from "pg";
import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db/pool";
import { logger } from "@/lib/logger";
import { notifyRefundConfirm } from "@/lib/notification/transactional";
import {
  PURCHASE_CONFIRM_ORDER_SELECT,
  sendPurchaseConfirm,
  type PurchaseConfirmOrderRow,
} from "@/lib/notification/purchase-confirm-sender";
import {
  canTransitionOrder,
  transitionOrderDetailed,
} from "@/lib/state-machine/order-state-machine";
import { repairPaidOrder } from "@/lib/orders/repair-paid-order";
import { askV2AboutOrder } from "@/lib/orders/v2-authority";
import { enqueueExpiredPaymentCompensation } from "@/lib/payment/compensation";
import type { OrderStatus } from "@/lib/types";

const TIMESTAMP_TOLERANCE_SECONDS = 60;
const REPLAY_TTL_SECONDS = 7 * 24 * 60 * 60; // 7일
const PENDING_ORDER_MAX_ATTEMPTS = 8;
const PENDING_ORDER_MAX_AGE_HOURS = 24;
const PENDING_ORDER_BACKOFF_SECONDS = [60, 300, 900, 1800, 3600, 7200, 14400, 28800];

// ── Redis ──

async function getRedis() {
  const mod = await import("@/lib/redis");
  return mod.getRedis();
}

// ── 서명 검증 (WEBHOOK_STANDARD: timestamp.body HMAC-SHA256) ──

function verifySignature(secret: string, timestamp: string, body: string, signature: string): boolean {
  const message = `${timestamp}.${body}`;
  const expected = crypto.createHmac("sha256", secret).update(message).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"));
  } catch {
    return false;
  }
}

// ── 이벤트 타입 ──

const SUPPORTED_EVENTS = new Set([
  "order.payment.confirmed",
  "order.payment.failed",
  "order.cancelled",
  "order.refunded",
]);

// ── 이벤트 핸들러 ──

interface EventPayload {
  event: string;
  delivery_id: string;
  timestamp: string;
  // v2 Order.id 는 UUID 다. v2 는 웹훅에 order_id 를 `str(order.id)`(UUID 문자열)로 보낸다
  // (payment_service.py). 이전엔 number 로 선언 + external_order_id(go 자체 앵커) 컬럼으로
  // 매칭해 항상 불일치 → v2→go 주문상태 전파가 조용히 전면 실패했다. (감사 P0-4)
  order_id: string;
  data: Record<string, unknown>;
}

/**
 * v2 order_id(UUID)로 go orders.v2_order_id(UUID)를 매칭한다. orders.ts 가 주문 생성 시
 * v2_order_id 를 채운다. external_order_id 는 go 자체 멱등 앵커라 매칭 키가 아니다.
 * FOR UPDATE 잠금 + 상태머신 경유. 늦은 이벤트는 강제 UPDATE로 상태머신을 우회하지
 * 않고 무시하며, 결제확정이 만료 주문에 도착한 경우에는 별도 보상 큐로 보낸다.
 */
interface OrderLookup {
  id: string;
  status: OrderStatus;
  expiresAt: Date | null;
  totalAmount: number | string;
  v2OrderId: string;
}

async function lookupOrder(
  client: PoolClient,
  v2OrderId: string,
): Promise<OrderLookup | null> {
  const { rows } = await client.query<OrderLookup>(
    `SELECT id, status, expires_at AS "expiresAt", total_amount AS "totalAmount",
            v2_order_id AS "v2OrderId"
       FROM orders WHERE v2_order_id = $1::uuid FOR UPDATE`,
    [v2OrderId],
  );
  return rows[0] ?? null;
}

type TransitionOutcome = "state-machine" | "idempotent" | "stale" | "expired";

/** 상태머신 밖의 강제 UPDATE는 금지한다. 순서가 늦은 이벤트는 감사 후 무시한다. */
async function transitionSafely(
  client: PoolClient,
  order: OrderLookup,
  to: OrderStatus,
  event: string,
): Promise<TransitionOutcome> {
  if (order.status === to) {
    logger.info("[internal-webhook] 이미 목표 상태", { orderId: order.id, status: to, event });
    return "idempotent";
  }
  if (!canTransitionOrder(order.status, to)) {
    logger.warn("[internal-webhook] 순서가 늦거나 무효인 전이 — 상태 변경 생략", {
      orderId: order.id,
      from: order.status,
      to,
      event,
    });
    return "stale";
  }

  const result = await transitionOrderDetailed(client, order.id, order.status, to);
  if (result.status === "applied") return "state-machine";
  if (result.status === "condition_failed" && result.reason === "expired") return "expired";
  logger.warn("[internal-webhook] 상태 전이 경합 — 상태 변경 생략", {
    orderId: order.id,
    from: order.status,
    to,
    event,
    result: result.status === "condition_failed" ? result.reason : result.status,
  });
  return "stale";
}

function isExpiredOrder(order: OrderLookup): boolean {
  return order.status === "expired" ||
    (order.status === "pending" && order.expiresAt !== null &&
      new Date(order.expiresAt).getTime() <= Date.now());
}

/**
 * 결제 페이로드에서 원장에 적을 값을 뽑는다.
 *
 * 보상 경로와 repair 경로가 **같은 값**을 써야 한다 — 갈라지면 한쪽 주문만
 * `payment_method` 가 비거나 금액이 달라진다.
 */
function extractPaymentFacts(order: OrderLookup, payload: EventPayload) {
  const rawAmount = payload.data.amount ?? payload.data.paid_amount;
  const parsedAmount = typeof rawAmount === "number" ? rawAmount : Number(rawAmount);
  const amount = Number.isFinite(parsedAmount) && parsedAmount >= 0
    ? parsedAmount
    : Number(order.totalAmount) || 0;
  const method = typeof payload.data.method === "string" ? payload.data.method : null;
  const paymentReference = ["payment_reference", "payment_id", "paymentKey", "payment_key"]
    .map((key) => payload.data[key])
    .find((value): value is string => typeof value === "string" && value.length > 0) ?? null;
  return { amount, method, paymentReference };
}

async function handleExpiredPaymentConfirmation(
  client: PoolClient,
  order: OrderLookup,
  payload: EventPayload,
) {
  if (order.status === "pending") {
    const expired = await transitionOrderDetailed(client, order.id, "pending", "expired");
    if (
      expired.status !== "applied" &&
      !(expired.status === "condition_failed" && expired.reason === "expired")
    ) {
      logger.warn("[internal-webhook] 만료 주문 전이 실패 — 보상 큐 생략", {
        orderId: order.id,
        result: expired.status,
      });
      return;
    }
  }

  const { amount, method, paymentReference } = extractPaymentFacts(order, payload);

  await client.query(
    `UPDATE orders
        SET payment_status = 'paid',
            paid_amount = GREATEST(COALESCE(paid_amount, 0), $2),
            payment_method = COALESCE($3, payment_method),
            payment_reference = COALESCE($4, payment_reference),
            updated_at = NOW()
      WHERE id = $1`,
    [order.id, amount, method, paymentReference],
  );
  const actionId = await enqueueExpiredPaymentCompensation(client, {
    orderId: order.id,
    v2OrderId: order.v2OrderId,
    deliveryId: payload.delivery_id || null,
    amount,
  });
  logger.error("[internal-webhook] 만료 주문 결제확정 거부 — 보상 환불 큐 기록", {
    orderId: order.id,
    v2OrderId: order.v2OrderId,
    actionId,
    amount,
    deliveryId: payload.delivery_id,
  });
  return { status: "expired_compensation_pending" as const };
}


/**
 * 만료로 보이는 주문에 결제확정이 왔다 — **v2 에 다시 물어본 뒤에** 갈래를 정한다.
 *
 * 🔴 2026-07-31 — 종전엔 곧장 보상환불 큐로 갔다. 그 판정은 **go 자기 시계**
 *    (`expires_at`)만 본다. v2→go 전파가 유실돼 결제 주문이 go 에서 만료돼 있던 동안
 *    파이프를 복구하면, 적체된 결제확정이 여기 도착해 **정당한 결제를 자동 전액환불**한다
 *    (`compensation.ts` → `refundOrder({full:true})` = 실 PG 취소).
 *    게다가 전파 태스크는 timestamp 를 **실행 시각**에 만들어 오래된 이벤트도
 *    freshness 검사를 통과한다 — "오래된 이벤트라 무시" 로는 못 막는다.
 *
 * ⚠️ 진입점이 **둘**이다(사전 `isExpiredOrder` 판정 / 전이 SQL 이 expired 로 거절).
 *    하나만 고치면 나머지가 v2 대조 없이 환불 큐로 간다 — 실제로 그럴 뻔했다.
 */
async function handleExpiredWithV2Check(
  client: PoolClient,
  order: OrderLookup,
  payload: EventPayload,
): Promise<HandlerResult> {
  const verdict = await askV2AboutOrder(order.id);
  if (verdict.kind === "paid") {
    const facts = extractPaymentFacts(order, payload);
    const outcome = await repairPaidOrder(client, order.id, {
      v2Status: verdict.v2Status,
      v2OrderId: verdict.v2OrderId,
      amount: facts.amount,
      method: facts.method,
      paymentReference: facts.paymentReference,
    });
    // 🔴 이번 호출이 실제로 되돌렸을 때만 알림톡. 재전달·중복 tick 에서는 repair 가
    //    noop 이므로 `shouldNotify` 가 false 다 — 같은 구매자에게 반복 발송하지 않는다.
    const afterCommit = outcome.shouldNotify
      ? await buildPurchaseConfirmAfterCommit(client, order.id)
      : null;
    return { status: "repaired", ...(afterCommit ? { afterCommit } : {}) };
  }
  if (verdict.kind !== "terminal") {
    // 🔴 fail-closed. 못 물어봤으면 환불 큐에 **넣지 않는다**. 넣으면 5분 뒤 돈이 나간다.
    //    아무것도 안 하면 다음 전파/대사가 다시 본다.
    logger.error("🔴 만료 주문 결제확정 — v2 판정이 terminal 이 아니라 보상환불을 보류한다", {
      orderId: order.id,
      v2OrderId: order.v2OrderId,
      verdict: verdict.kind,
      reason: verdict.kind === "unknown" ? verdict.reason : undefined,
    });
    return { status: "compensation_deferred" };
  }
  return (await handleExpiredPaymentConfirmation(client, order, payload)) ?? {};
}

async function handlePaymentConfirmed(client: PoolClient, payload: EventPayload) {
  const order = await lookupOrder(client, payload.order_id);
  if (!order) {
    logger.error("[internal-webhook] v2 주문상태 전파 실패 — go 에 매칭 주문 없음(v2_order_id 불일치)", {
      v2OrderId: payload.order_id,
      event: payload.event,
    });
    return { status: "pending_order" as const };
  }
  if (isExpiredOrder(order)) {
    return handleExpiredWithV2Check(client, order, payload);
  }

  const via = await transitionSafely(client, order, "completed", payload.event);
  if (via === "stale" || via === "expired") {
    // 🔴 여기도 **v2 대조를 거쳐야 한다**. `isExpiredOrder` 는 ms 비교이고 SQL 가드는
    //    NOW() 기준이라, 그 사이에 만료 시각이 넘어가면 위 분기를 통과한 요청이
    //    여기로 떨어진다. 종전엔 이 자리가 곧장 보상환불 큐로 갔다 —
    //    **방금 v2 가 confirmed 라고 보낸 결제**가 검증 없이 환불 대상이 되는 사각이었다.
    if (via === "expired") return handleExpiredWithV2Check(client, order, payload);
    return { status: "ignored_stale" as const };
  }
  // 결제 메타데이터는 상태와 분리하여 항상 동기화.
  // 🔴 종전엔 `payment_status`·`payment_method` 만 적어서, 정상 전파로 확정된 주문은
  //    `paid_amount = 0` · `payment_reference = NULL` 로 남았다. 만료 repair 경로는
  //    금액·PG 식별자를 투영하는데 **정상 경로가 안 하는** 비대칭이었다 —
  //    정산·대사·CS 조회가 전부 그 값을 본다. 같은 추출기를 쓴다.
  const facts = extractPaymentFacts(order, payload);
  await client.query(
    `UPDATE orders SET payment_status = 'paid',
       paid_amount = GREATEST(COALESCE(paid_amount, 0), COALESCE($3, 0)),
       payment_method = COALESCE($2, payment_method),
       payment_reference = COALESCE($4, payment_reference),
       updated_at = NOW()
     WHERE id = $1`,
    [order.id, facts.method, facts.amount, facts.paymentReference],
  );
  logger.info("[internal-webhook] order.payment.confirmed 처리", { orderId: order.id, via });

  // H-02: 구매자 구매확정 알림 — 기존엔 order-finalize 경로에만 있어 토스·v2 확정 경로의 구매자는
  // 알림을 못 받았다. 최초 전이(state-machine)일 때만 발송(웹훅 재전달 시 중복 방지), COMMIT 후.
  if (via !== "state-machine") return;
  // W2-ORD: 옛 `JOIN events e` 제거 — 행사 제목/일시 정본은 v2 다.
  //   트랜잭션 안에서 외부(v2) 호출을 하지 않도록 **go 행만 트랜잭션 내 일관 읽기**로 캡처하고,
  //   v2 이벤트 조회는 afterCommit 콜백에서 한다(H-02 원칙 유지).
  const afterCommit = await buildPurchaseConfirmAfterCommit(client, order.id);
  return afterCommit ? { afterCommit } : undefined;
}

/**
 * 구매확정 알림톡 발송 콜백을 만든다(COMMIT 후 실행용).
 *
 * 🔴 정상 전파 경로와 **repair 경로가 같은 함수를 써야 한다**. 갈라지면 전파가 유실됐다가
 *    대사로 복구된 구매자만 알림톡을 못 받는다 — 그리고 그건 아무도 모른다
 *    (2026-07-31 실사고: 카드 구매자에게 구매확정 알림톡이 한 번도 안 나갔다).
 *
 * ⚠️ 트랜잭션 안에서는 **go 행만 일관 읽기**로 캡처하고, v2 조회·발송은 콜백에서 한다.
 */
async function buildPurchaseConfirmAfterCommit(
  client: PoolClient,
  orderId: string,
): Promise<(() => Promise<void>) | null> {
  // 🔴 2026-07-31 — 종전 이 자리는 `notifyPurchaseConfirm` 을 직접 부르면서
  //    `ticketNumber`·`venueName`·`linkExpiresAt` 을 **하나도 안 넘겼다**.
  //    승인 템플릿에 '모바일 티켓' 버튼이 있어 버튼 없이 보내면 접수는 A000 인데
  //    카카오가 전달을 거부한다(3027, 2026-07-28 실측). 즉 **카드 구매자는 알림톡을
  //    못 받는데 로그에는 성공으로 남았다.** 공통 발송기로 합쳐 이 결함을 끊는다.
  const buyer = await client.query<PurchaseConfirmOrderRow>(
    PURCHASE_CONFIRM_ORDER_SELECT,
    [orderId],
  );
  const b = buyer.rows[0];
  if (!b) return null;
  return async () => {
    const result = await sendPurchaseConfirm(b);
    if (!result.sent) {
      // 조용히 넘기지 않는다 — 안 나간 사실이 어디에도 안 남으면 아무도 모른다.
      logger.warn("[internal-webhook] 구매확정 알림 미발송", {
        orderId,
        orderNumber: b.orderNumber,
        reason: result.reason,
      });
    }
  };
}

/**
 * 알림 문구용 행사 정보(v2). COMMIT 후 best-effort 경로에서만 쓴다.
 *
 * afterCommit 콜백의 예외는 호출측이 "커밋후 알림 실패(무시)"로 삼키므로, 여기서 던지면
 * **알림 전체가 조용히 누락**된다. 제목을 못 읽었다고 결제확정 알림 자체를 버리는 것보다
 * 중립 폴백("행사")으로 보내는 편이 구매자에게 낫다(상태 왜곡 없음 — 주문번호가 식별자다).
 */
async function resolveEventForNotice(
  eventId: string,
): Promise<{ title: string; startsAt: string | null }> {
  try {
    const { getEvent } = await import("@/lib/v2/commerce-client");
    const ev = await getEvent(eventId);
    return { title: ev.title, startsAt: ev.event_date };
  } catch (err: unknown) {
    logger.warn("[internal-webhook] 알림용 행사 정보 조회 실패 — 중립 문구로 발송", {
      eventId,
      error: err instanceof Error ? err.message : "unknown",
    });
    return { title: "행사", startsAt: null };
  }
}

async function handlePaymentFailed(client: PoolClient, payload: EventPayload) {
  const order = await lookupOrder(client, payload.order_id);
  if (!order) {
    logger.error("[internal-webhook] v2 주문상태 전파 실패 — go 에 매칭 주문 없음(v2_order_id 불일치)", {
      v2OrderId: payload.order_id,
      event: payload.event,
    });
    return { status: "pending_order" as const };
  }
  const via = await transitionSafely(client, order, "cancelled", payload.event);
  if (via === "stale" || via === "expired") return { status: "ignored_stale" as const };
  await client.query(
    `UPDATE orders SET payment_status = 'failed', updated_at = NOW() WHERE id = $1`,
    [order.id],
  );
  logger.info("[internal-webhook] order.payment.failed 처리", { orderId: order.id, via });
}

async function handleCancelled(client: PoolClient, payload: EventPayload) {
  const order = await lookupOrder(client, payload.order_id);
  if (!order) {
    logger.error("[internal-webhook] v2 주문상태 전파 실패 — go 에 매칭 주문 없음(v2_order_id 불일치)", {
      v2OrderId: payload.order_id,
      event: payload.event,
    });
    return { status: "pending_order" as const };
  }
  const via = await transitionSafely(client, order, "cancelled", payload.event);
  if (via === "stale" || via === "expired") return { status: "ignored_stale" as const };
  // 주문 취소 시 attendee 도 취소 cascade — confirmed 로 남으면 취소된 주문의 티켓으로
  // 체크인이 가능해진다. v2 SSOT 강제 적용이므로 상태머신 우회 직접 UPDATE. (감사 P1-12)
  await client.query(
    `UPDATE attendees SET status = 'cancelled', updated_at = NOW()
     WHERE order_id = $1 AND status <> 'cancelled'`,
    [order.id],
  );
  logger.info("[internal-webhook] order.cancelled 처리", { orderId: order.id, via });
}

async function handleRefunded(client: PoolClient, payload: EventPayload) {
  const order = await lookupOrder(client, payload.order_id);
  if (!order) {
    logger.error("[internal-webhook] v2 주문상태 전파 실패 — go 에 매칭 주문 없음(v2_order_id 불일치)", {
      v2OrderId: payload.order_id,
      event: payload.event,
    });
    return { status: "pending_order" as const };
  }
  const isFullRefund = payload.data.is_full_refund === true;
  /** 이번 건의 환불액(건별) — 구매자 통지 문구에 쓴다("₩15,000 환불되었습니다"). */
  const refundAmount = Number(payload.data.refund_amount ?? 0);
  /**
   * 원장에 적을 **누계**. v2 가 `total_refunded` 로 보낸다(건별과 별개 필드).
   *
   * 🔴 건별을 원장에 SET 하면 부분환불 2회째에 누계가 **줄어든다**.
   * ⚠️ 두 서비스가 타입이 갈려 있다(refund_service=str, partial_refund_service=float)
   *    — `Number()` 로 통일해 읽는다. 없으면(옛 v2) 건별로 폴백한다.
   */
  const totalRefunded = Number(payload.data.total_refunded ?? payload.data.refund_amount ?? 0);
  const targetStatus: OrderStatus = isFullRefund ? "refunded" : "partially_refunded";
  const via = await transitionSafely(client, order, targetStatus, payload.event);
  if (via === "stale" || via === "expired") return { status: "ignored_stale" as const };
  // 🔴 **주석이 거짓이었다** (2026-08-01 교정).
  //    "refund_amount 는 v2 가 권위 '누계'값으로 보낸다" 고 적혀 있었으나 사실이 아니다:
  //      refund_service.py:780          "refund_amount":  float(refund.amount)         ← **건별**
  //      partial_refund_service.py:455  동일                                            ← **건별**
  //    누계는 별도 필드로 이미 온다:
  //      refund_service.py:781          "total_refunded": str(order.total_refunded)
  //      partial_refund_service.py:456  "total_refunded": float(...)    ← 타입이 다르다
  //
  //    건별을 SET 하면 **부분환불 2회 시 두 번째 금액으로 덮여** 누계가 줄어든다.
  //    ⟹ 누계 필드(`total_refunded`)를 정본으로 쓰고, 없을 때만 건별로 폴백한다.
  //    (두 서비스의 타입이 str/float 로 갈려 있어 Number() 로 통일해 읽는다.)
  //
  //    이전엔 additive(+=)라 웹훅 재배달·부분환불 반복 시 이중 계상됐다. SET 이 멱등한 것은
  //    맞고, 0..paid_amount 클램프로 부호/상한을 강제하는 것도 유지한다. (감사 P1-13)
  await client.query(
    `UPDATE orders
       SET refund_amount = LEAST(GREATEST($2, 0), COALESCE(paid_amount, 0)),
           updated_at = NOW()
     WHERE id = $1`,
    [order.id, totalRefunded],
  );
  // 전액 환불 시 attendee 취소 cascade(체크인 차단). (감사 P1-12)
  if (isFullRefund) {
    await client.query(
      `UPDATE attendees SET status = 'cancelled', updated_at = NOW()
       WHERE order_id = $1 AND status <> 'cancelled'`,
      [order.id],
    );
  }
  logger.info("[internal-webhook] order.refunded 처리", {
    orderId: order.id,
    isFullRefund,
    refundAmount,
    via,
  });

  // H-02: 구매자 환불완료 알림(정보성)은 COMMIT 후 발송해야 한다 — 트랜잭션 롤백 시
  // "환불 완료" 알림만 나가고 실제 환불은 취소되는 불일치 방지. 데이터는 트랜잭션 내 일관 읽기로
  // 캡처하고, 실제 발송은 after-commit 콜백으로 반환한다.
  // W2-ORD: 옛 `JOIN events e` 제거(위 handlePaymentConfirmed 와 동일 근거).
  const info = await client.query<{
    accountId: string; eventId: string; email: string | null; phone: string | null; name: string;
    orderNumber: string;
  }>(
    `SELECT o.account_id AS "accountId", o.event_id AS "eventId", o.buyer_email AS email,
            o.buyer_phone AS phone, o.buyer_name AS name, o.order_number AS "orderNumber"
     FROM orders o WHERE o.id = $1`,
    [order.id],
  );
  const r = info.rows[0];
  if (!r) return;
  return {
    afterCommit: async () => {
      // ── 통지 멱등 (2026-08-01) ────────────────────────────────────────────
      //
      // 🔴 `via` 로 판정하면 안 된다. 즉시환불(`public/refund/route.ts`)이 go 주문을
      //    **먼저** refunded 로 갱신하므로 뒤따라오는 전파는 **항상** `idempotent` 로
      //    도착한다 — 그게 정상 경로다. `via !== "state-machine"` 을 중복 판정
      //    대리값으로 쓰면 **알림톡이 영영 안 나간다.**
      //    ⟹ 멱등은 전이 결과가 아니라 **알림 자체**에 건다.
      //
      // 🔴 선점 후 발송, 실패 시 해제. 발송 **전** 표식만 하면 실패 시 영영 안 가고,
      //    발송 **후** 표식은 동시 도착 시 둘 다 나간다. 조건부 UPDATE 가 원자적으로
      //    한쪽만 통과시킨다(같은 리포 `payment_confirm_outbox.lease_token` 과 동형).
      //
      // ⚠️ afterCommit 은 트랜잭션 **밖**이라 별도 쿼리다. 그래도 조건부 UPDATE 라
      //    원자성은 보장된다.
      const claimed = await client.query<{ id: string }>(
        `UPDATE orders SET refund_notified_at = NOW()
          WHERE id = $1 AND refund_notified_at IS NULL
          RETURNING id`,
        [order.id],
      );
      if (claimed.rowCount === 0) {
        logger.info("[internal-webhook] 환불완료 통지 이미 발송됨 — 재발송 생략", {
          orderId: order.id,
        });
        return;
      }

      try {
        const ev = await resolveEventForNotice(r.eventId);
        const sent = await notifyRefundConfirm({
          accountId: r.accountId, orderId: order.id,
          email: r.email, phone: r.phone, buyerName: r.name || "고객",
          eventTitle: ev.title, orderNumber: r.orderNumber,
          refundAmount: `₩${refundAmount.toLocaleString("ko-KR")}`,
        });
        // 🔴 `notifyRefundConfirm` 은 **예외를 던지지 않는다** — `fanout` 이 채널별 실패를
        //    삼키고 `{attempted, failed}` 로만 돌려준다(transactional.ts 의 H-02 주석).
        //    반환값을 안 보면 아래 catch 가 영영 안 돌고, **전 채널이 실패해도 표식이 남아**
        //    구매자가 통지를 영영 못 받는다 — 선점·해제 구조가 통째로 무력해진다.
        //
        // ⚠️ `failed > 0` 으로 던지면 안 된다. 알림톡 템플릿 **승인 전에는 카카오 채널이
        //    항상 실패**하는데, 그때 표식을 풀면 다음 전달마다 **이메일이 재발송**된다.
        //    ⟹ **전 채널이 실패했을 때만** 실패로 본다(한 채널이라도 나갔으면 통지 성립).
        if (sent.attempted > 0 && sent.failed >= sent.attempted) {
          throw new Error(`환불완료 통지 전 채널 실패 (${sent.failed}/${sent.attempted})`);
        }
        // 시도가 0 인 경우는 실패가 아니다 — 보낼 연락처가 애초에 없다.
        // 표식은 남긴다(재시도해도 보낼 곳이 없으므로 무한 재시도만 만든다).
        if (sent.attempted === 0) {
          logger.warn("[internal-webhook] 환불완료 통지 대상 연락처 없음", { orderId: order.id });
        }
      } catch (err: unknown) {
        // 🔴 발송 실패면 표식을 되돌린다 — 안 그러면 "보낸 적 없는데 보냈다고 기록" 되어
        //    다음 전달도 건너뛴다(구매자가 영영 못 받는다).
        await client
          .query(`UPDATE orders SET refund_notified_at = NULL WHERE id = $1`, [order.id])
          .catch(() => undefined);
        logger.error("[internal-webhook] 환불완료 통지 실패 — 표식 해제(재시도 가능)", {
          orderId: order.id,
          error: err instanceof Error ? err.message : "unknown",
        });
        throw err;
      }
    },
  };
}

// 핸들러는 COMMIT 후 실행할 콜백(예: 구매자 알림)을 선택적으로 반환할 수 있다(H-02).
type HandlerResult = {
  afterCommit?: () => Promise<void>;
  status?:
    | "expired_compensation_pending"
    | "ignored_stale"
    | "pending_order"
    /** v2 가 결제 유효로 확인해 만료 앵커를 되돌렸다(보상환불 아님). */
    | "repaired"
    /** 🔴 v2 에 못 물어봐 보상환불을 **보류**했다. 다음 전파·대사가 다시 본다. */
    | "compensation_deferred";
};
const EVENT_HANDLERS: Record<string, (client: PoolClient, payload: EventPayload) => Promise<HandlerResult | void>> = {
  "order.payment.confirmed": handlePaymentConfirmed,
  "order.payment.failed": handlePaymentFailed,
  "order.cancelled": handleCancelled,
  "order.refunded": handleRefunded,
};

type ExistingDelivery = {
  id: string;
  event: string;
  payload: EventPayload;
};

type ExistingDeliveryResult = {
  status:
    | "ok"
    | "expired_compensation_pending"
    | "ignored_stale"
    | "pending_order"
    | "retrying"
    | "dead_lettered"
    | "repaired"
    | "compensation_deferred";
  httpStatus: number;
};

/** 감사 row를 이미 가진 이벤트를 트랜잭션으로 처리한다(초기 수신·보류 재시도 공용). */
export async function processExistingStateChangedDelivery(
  delivery: ExistingDelivery,
): Promise<ExistingDeliveryResult> {
  const pool = getPool();
  const handler = EVENT_HANDLERS[delivery.event];
  if (!handler) {
    await pool.query(
      "UPDATE inter_service_webhook_deliveries SET status = 'ignored', error_message = NULL WHERE id = $1",
      [delivery.id],
    );
    return { status: "ignored_stale", httpStatus: 200 };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const handlerResult = await handler(client, delivery.payload);
    await client.query("COMMIT");

    if (handlerResult?.afterCommit) {
      try {
        await handlerResult.afterCommit();
      } catch (notifyErr) {
        logger.warn("[internal-webhook] 커밋후 알림 실패(무시)", {
          event: delivery.event,
          error: notifyErr instanceof Error ? notifyErr.message : "unknown",
        });
      }
    }

    if (handlerResult?.status === "pending_order") {
      const { rows } = await pool.query<{ retryCount: number; createdAt: Date }>(
        `SELECT retry_count AS "retryCount", created_at AS "createdAt"
           FROM inter_service_webhook_deliveries WHERE id = $1`,
        [delivery.id],
      );
      const retryCount = Number(rows[0]?.retryCount ?? 0);
      const createdAt = rows[0]?.createdAt ? new Date(rows[0].createdAt).getTime() : Date.now();
      const agedOut = Date.now() - createdAt > PENDING_ORDER_MAX_AGE_HOURS * 60 * 60 * 1000;
      if (retryCount >= PENDING_ORDER_MAX_ATTEMPTS || agedOut) {
        await pool.query(
          `UPDATE inter_service_webhook_deliveries
              SET status = 'dead_lettered', error_message = 'order_not_found_max_retries',
                  dead_letter_reason = 'order_not_found_max_retries', dead_lettered_at = NOW(),
                  replay_status = CASE WHEN replay_status = 'processing' THEN 'dead_lettered' ELSE replay_status END,
                  next_attempt_at = NULL, last_attempt_at = NOW()
            WHERE id = $1`,
          [delivery.id],
        );
        return { status: "dead_lettered", httpStatus: 202 };
      }
      const delay = PENDING_ORDER_BACKOFF_SECONDS[Math.min(retryCount, PENDING_ORDER_BACKOFF_SECONDS.length - 1)]!;
      await pool.query(
        `UPDATE inter_service_webhook_deliveries
            SET status = 'pending', error_message = 'order_not_found',
                replay_status = CASE WHEN replay_status = 'processing' THEN 'pending' ELSE replay_status END,
                next_attempt_at = NOW() + ($2 || ' seconds')::interval,
                last_attempt_at = NOW()
          WHERE id = $1`,
        [delivery.id, String(delay)],
      );
      return { status: "pending_order", httpStatus: 202 };
    }

    const ignored = handlerResult?.status === "ignored_stale";
    await pool.query(
        `UPDATE inter_service_webhook_deliveries
          SET status = $2, error_message = $3,
              replay_status = CASE WHEN replay_status = 'processing' THEN $4 ELSE replay_status END,
              next_attempt_at = NULL, last_attempt_at = NOW()
        WHERE id = $1`,
      [delivery.id, ignored ? "ignored" : "processed", ignored ? "stale_event" : handlerResult?.status === "expired_compensation_pending" ? "compensation_pending" : null, ignored ? "ignored_stale" : "processed"],
    );
    return { status: handlerResult?.status ?? "ok", httpStatus: 200 };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    const message = err instanceof Error ? err.message : String(err);
    logger.error("[internal-webhook] 이벤트 처리 실패", { event: delivery.event, error: message });
    const { rows } = await pool.query<{ retryCount: number; createdAt: Date }>(
      `SELECT retry_count AS "retryCount", created_at AS "createdAt"
         FROM inter_service_webhook_deliveries WHERE id = $1`,
      [delivery.id],
    );
    const retryCount = Number(rows[0]?.retryCount ?? 0);
    const createdAt = rows[0]?.createdAt ? new Date(rows[0].createdAt).getTime() : Date.now();
    const agedOut = Date.now() - createdAt > PENDING_ORDER_MAX_AGE_HOURS * 60 * 60 * 1000;
    if (retryCount >= PENDING_ORDER_MAX_ATTEMPTS || agedOut) {
      await pool.query(
        `UPDATE inter_service_webhook_deliveries
            SET status = 'dead_lettered', error_message = $2,
                dead_letter_reason = $2, dead_lettered_at = NOW(),
                replay_status = CASE WHEN replay_status = 'processing' THEN 'dead_lettered' ELSE replay_status END,
                next_attempt_at = NULL, last_attempt_at = NOW()
          WHERE id = $1`,
        [delivery.id, message],
      );
      return { status: "dead_lettered", httpStatus: 500 };
    }
    const delay = PENDING_ORDER_BACKOFF_SECONDS[Math.min(retryCount, PENDING_ORDER_BACKOFF_SECONDS.length - 1)]!;
    await pool.query(
      `UPDATE inter_service_webhook_deliveries
          SET status = 'retrying', retry_count = retry_count + 1, error_message = $2,
              replay_status = CASE WHEN replay_status = 'processing' THEN 'pending' ELSE replay_status END,
              next_attempt_at = NOW() + ($3 || ' seconds')::interval, last_attempt_at = NOW()
        WHERE id = $1`,
      [delivery.id, message, String(delay)],
    );
    return { status: "retrying", httpStatus: 503 };
  } finally {
    client.release();
  }
}

/** pending/retrying inbox를 한 번 drain한다. 만료/초과분은 명시적으로 DLQ로 남긴다. */
export async function processPendingOrderWebhooks(limit = 50) {
  const pool = getPool();
  let processed = 0;
  let pending = 0;
  let deadLettered = 0;
  let failed = 0;

  for (let i = 0; i < limit; i += 1) {
    const client = await pool.connect();
    let row: ExistingDelivery & { retryCount: number; createdAt: Date } | null = null;
    try {
      await client.query("BEGIN");
      const result = await client.query<ExistingDelivery & { retryCount: number; createdAt: Date }>(
        `SELECT id, event, payload, retry_count AS "retryCount", created_at AS "createdAt"
           FROM inter_service_webhook_deliveries
          WHERE source = 'v2' AND direction = 'inbound'
            AND status IN ('pending', 'retrying')
            AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
          ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
      );
      if (!result.rows[0]) {
        await client.query("COMMIT");
        break;
      }
      row = result.rows[0];
      const agedOut = Date.now() - new Date(row.createdAt).getTime() > PENDING_ORDER_MAX_AGE_HOURS * 60 * 60 * 1000;
      if (row.retryCount >= PENDING_ORDER_MAX_ATTEMPTS || agedOut) {
        await client.query(
          `UPDATE inter_service_webhook_deliveries
              SET status = 'dead_lettered', error_message = 'order_not_found_max_retries',
                  dead_letter_reason = 'order_not_found_max_retries', dead_lettered_at = NOW(),
                  next_attempt_at = NULL, last_attempt_at = NOW()
            WHERE id = $1`,
          [row.id],
        );
        await client.query("COMMIT");
        deadLettered += 1;
        continue;
      }
      await client.query(
        `UPDATE inter_service_webhook_deliveries
            SET status = 'retrying', retry_count = retry_count + 1,
                next_attempt_at = NOW() + INTERVAL '15 minutes', last_attempt_at = NOW()
          WHERE id = $1`,
        [row.id],
      );
      await client.query("COMMIT");
    } catch (_err) {
      await client.query("ROLLBACK").catch(() => undefined);
      failed += 1;
      continue;
    } finally {
      client.release();
    }

    const result = await processExistingStateChangedDelivery({
      id: row.id,
      event: row.event,
      payload: row.payload,
    });
    if (result.status === "pending_order" || result.status === "retrying") pending += 1;
    else if (result.status === "dead_lettered") deadLettered += 1;
    else {
      processed += 1;
      if (result.httpStatus >= 500) failed += 1;
    }
  }
  return { processed, pending, deadLettered, failed };
}

// ── POST 핸들러 ──

export async function POST(request: NextRequest) {
  const secret = process.env.GO_WEBHOOK_SECRET;
  if (!secret) {
    logger.error("[internal-webhook] GO_WEBHOOK_SECRET 미설정");
    return NextResponse.json({ error: "서버 설정 오류" }, { status: 503 });
  }

  // 1. 헤더 추출
  const signatureHeader = request.headers.get("x-pickket-signature") ?? "";
  const timestamp = request.headers.get("x-pickket-timestamp") ?? "";
  const event = request.headers.get("x-pickket-event") ?? "";
  const deliveryId = request.headers.get("x-pickket-delivery-id") ?? "";

  if (!signatureHeader || !timestamp) {
    return NextResponse.json({ error: "서명 또는 타임스탬프 누락" }, { status: 400 });
  }

  // 2. raw body
  const rawBody = await request.text();

  // 3. 서명에서 sha256= prefix 제거
  const signature = signatureHeader.startsWith("sha256=")
    ? signatureHeader.slice(7)
    : signatureHeader;

  // 4. HMAC 검증
  if (!verifySignature(secret, timestamp, rawBody, signature)) {
    logger.warn("[internal-webhook] 서명 검증 실패", { deliveryId, event });
    return NextResponse.json({ error: "서명 검증 실패" }, { status: 400 });
  }

  // 5. Timestamp freshness (±60초)
  const now = Math.floor(Date.now() / 1000);
  const ts = Number(timestamp) || Math.floor(new Date(timestamp).getTime() / 1000);
  if (Math.abs(now - ts) > TIMESTAMP_TOLERANCE_SECONDS) {
    logger.warn("[internal-webhook] 타임스탬프 만료", { deliveryId, skew: Math.abs(now - ts) });
    return NextResponse.json({ error: "타임스탬프 만료" }, { status: 400 });
  }

  // 6. Replay guard (Redis SETNX)
  if (deliveryId) {
    try {
      const redis = await getRedis();
      const key = `go:webhook:inbound:${deliveryId}`;
      const set = await redis.set(key, "1", "EX", REPLAY_TTL_SECONDS, "NX");
      if (!set) {
        logger.info("[internal-webhook] 중복 delivery_id", { deliveryId });
        const existing = await getPool().query<{ status: string }>(
          `SELECT status FROM inter_service_webhook_deliveries
             WHERE delivery_id = $1 AND direction = 'inbound' LIMIT 1`,
          [deliveryId],
        );
        if (existing.rows[0]?.status === "pending" || existing.rows[0]?.status === "retrying") {
          return NextResponse.json({ success: true, data: { status: "pending" } }, { status: 202 });
        }
        if (existing.rows[0]) {
          return NextResponse.json({ success: true, data: { status: "duplicate" } }, { status: 200 });
        }
        // Redis marker가 감사 원장 INSERT보다 먼저 남은 뒤 DB 장애가 난 경우다.
        // 원장이 없으면 durable replay 기록이 아니므로 marker를 버리고 재수신을 허용한다.
        await redis.del(key).catch(() => undefined);
      }
    } catch (err) {
      logger.warn("[internal-webhook] Redis replay guard 실패, 계속 진행", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 7. Payload 파싱
  let payload: EventPayload;
  try {
    payload = JSON.parse(rawBody) as EventPayload;
  } catch {
    return NextResponse.json({ error: "페이로드 파싱 실패" }, { status: 400 });
  }

  // 8. envelope ↔ header 일치 검증
  if (event && payload.event && event !== payload.event) {
    return NextResponse.json({ error: "이벤트 헤더/바디 불일치" }, { status: 400 });
  }
  if (deliveryId && payload.delivery_id && deliveryId !== payload.delivery_id) {
    return NextResponse.json({ error: "delivery_id 헤더/바디 불일치" }, { status: 400 });
  }

  const eventName = payload.event || event;
  const actualDeliveryId = payload.delivery_id || deliveryId;

  // 9. 지원 이벤트 확인
  if (!SUPPORTED_EVENTS.has(eventName)) {
    logger.warn("[internal-webhook] 미지원 이벤트", { event: eventName });
    return NextResponse.json({ error: `미지원 이벤트: ${eventName}` }, { status: 400 });
  }

  // 10. 감사 로그 (inter_service_webhook_deliveries)
  const pool = getPool();
  let auditRowId: string | null = null;
  try {
    const { rows } = await pool.query(
      `INSERT INTO inter_service_webhook_deliveries
         (delivery_id, event, source, direction, signature, timestamp_sent, payload, payload_fingerprint, status)
       VALUES ($1, $2, 'v2', 'inbound', $3, $4, $5::jsonb, md5($5::jsonb::text), 'received')
       ON CONFLICT (delivery_id, direction) DO UPDATE
         SET status = CASE
           WHEN inter_service_webhook_deliveries.status IN ('pending', 'retrying')
             THEN inter_service_webhook_deliveries.status
           WHEN inter_service_webhook_deliveries.status IN ('dead_lettered', 'ignored', 'processed', 'duplicate')
             THEN inter_service_webhook_deliveries.status
           ELSE 'duplicate'
         END
       RETURNING id, status, (xmax = 0) AS is_new`,
      [actualDeliveryId, eventName, signature, new Date(ts * 1000).toISOString(), rawBody],
    );
    auditRowId = String(rows[0]?.id);
    if (!rows[0]?.is_new && (rows[0]?.status === "pending" || rows[0]?.status === "retrying")) {
      return NextResponse.json({ success: true, data: { status: "pending" } }, { status: 202 });
    }
    if (!rows[0]?.is_new) {
      return NextResponse.json({ success: true, data: { status: "duplicate" } }, { status: 200 });
    }
  } catch (err) {
    logger.warn("[internal-webhook] 감사 로그 write 실패", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (!auditRowId) {
    return NextResponse.json({ error: "웹훅 수신 원장 기록 실패" }, { status: 503 });
  }

  // 11. 이벤트 처리 (트랜잭션 + FOR UPDATE로 감싸 race 차단)
  const result = await processExistingStateChangedDelivery({ id: auditRowId, event: eventName, payload });
  return NextResponse.json(
    { success: result.httpStatus < 500, data: { status: result.status } },
    { status: result.httpStatus },
  );
}
