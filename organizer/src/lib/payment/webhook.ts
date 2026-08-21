import type { PoolClient } from "pg";
import { getPool } from "@/lib/db/pool";
import { logger } from "@/lib/logger";
import { recordPaymentConfirmOutbox } from "@/lib/payment/confirm-v2";
import { notifyNewOrder, notifySoldOut } from "@/lib/notifications/create";
import { transitionAttendees } from "@/lib/state-machine/attendee-state-machine";
import { transitionOrder } from "@/lib/state-machine/order-state-machine";
import type { PaymentMethod } from "@/lib/types";
import { dispatchWebhook } from "@/lib/webhook/dispatcher";
import { resolveSoldOutProductsForOrder } from "@/lib/notification/sold-out";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type PaymentOutcome = "paid" | "ignored";
type JsonObject = Record<string, unknown>;

interface ApplySuccessfulPaymentInput {
  orderId: string;
  amount?: number;
  paymentMethod: PaymentMethod;
  paymentReference?: string | null;
}

interface ApplySuccessfulPaymentResult {
  status: "applied" | "already_completed" | "ignored";
  reason?: string;
  orderId?: string;
}

interface CompletedOrderRow {
  accountId: string;
  eventId: string;
  orderNumber: string;
  totalAmount: number;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getPathValue(payload: JsonObject, path: string[]): unknown {
  let current: unknown = payload;
  for (const key of path) {
    if (!isObject(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function pickString(payload: JsonObject, paths: string[][]): string | undefined {
  for (const path of paths) {
    const value = getPathValue(payload, path);
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function pickNumber(payload: JsonObject, paths: string[][]): number | undefined {
  for (const path of paths) {
    const value = getPathValue(payload, path);
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function normalizeToken(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
}

function detectPaymentOutcome(payload: JsonObject): { outcome: PaymentOutcome; reason: string } {
  const rawToken =
    pickString(payload, [
      ["status"],
      ["eventType"],
      ["event_type"],
      ["type"],
      ["paymentStatus"],
      ["payment_status"],
      ["data", "status"],
      ["data", "eventType"],
      ["data", "event_type"],
      ["data", "type"],
      ["payment", "status"],
      ["payment", "eventType"],
      ["payment", "event_type"],
    ]) ?? "";

  const token = normalizeToken(rawToken);
  if (!token) {
    return { outcome: "ignored", reason: "status_missing" };
  }

  // 부정/미완료 상태를 먼저 차단한다. 정규화 토큰은 '_'로 구분되므로
  // "unpaid"/"payment_failed"/"not_paid" 등이 아래 positive .includes("paid")에
  // 오분류되는 것을 막는다(예: "unpaid".includes("paid") === true). (감사 P1-19)
  const NEGATIVE = [
    "fail", "cancel", "refund", "expire", "void", "declin",
    "error", "unpaid", "pending", "ready", "waiting", "not_",
  ];
  if (NEGATIVE.some((n) => token.includes(n))) {
    return { outcome: "ignored", reason: token };
  }

  // virtual_account_issued(가상계좌 '발급')는 실입금 전 상태다. paid 로 분류하면
  // 입금 전에 티켓이 발급되고 v2 매출이 오집계된다. 실제 입금완료(paid/done/…) 웹훅에서만
  // 확정한다 — virtual_account_issued 는 아래 어느 positive 토큰에도 걸리지 않아 ignored. (감사 P0-1)
  if (
    token.includes("paid") ||
    token.includes("done") ||
    token.includes("completed") ||
    token.includes("approved") ||
    token.includes("success")
  ) {
    return { outcome: "paid", reason: token };
  }

  return { outcome: "ignored", reason: token };
}

function extractOrderId(payload: JsonObject): string | undefined {
  const orderId = pickString(payload, [
    ["orderId"],
    ["order_id"],
    ["merchantOrderId"],
    ["merchant_order_id"],
    ["data", "orderId"],
    ["data", "order_id"],
    ["payment", "orderId"],
    ["payment", "order_id"],
  ]);

  if (!orderId || !UUID_PATTERN.test(orderId)) {
    return undefined;
  }

  return orderId;
}

function extractPaymentReference(payload: JsonObject): string | null {
  return (
    pickString(payload, [
      ["paymentKey"],
      ["payment_key"],
      ["paymentId"],
      ["payment_id"],
      ["transactionId"],
      ["transaction_id"],
      ["txId"],
      ["tx_id"],
      ["receiptId"],
      ["receipt_id"],
      ["data", "paymentKey"],
      ["data", "payment_key"],
      ["data", "paymentId"],
      ["data", "payment_id"],
      ["payment", "paymentKey"],
      ["payment", "paymentId"],
      ["payment", "transactionId"],
      ["id"],
      ["eventId"],
      ["event_id"],
    ]) ?? null
  );
}

function extractAmount(payload: JsonObject): number | undefined {
  return pickNumber(payload, [
    ["amount"],
    ["totalAmount"],
    ["total_amount"],
    ["paidAmount"],
    ["paid_amount"],
    ["payment", "amount"],
    ["payment", "totalAmount"],
    ["payment", "total_amount"],
    ["payment", "amount", "total"],
    ["data", "amount"],
    ["data", "totalAmount"],
    ["data", "total_amount"],
    ["data", "amount", "total"],
  ]);
}

export function extractWebhookTimestamp(
  payload: JsonObject,
  headers: Headers,
  extraHeaderNames: string[] = [],
): number | string | null {
  const payloadValue =
    pickString(payload, [
      ["createdAt"],
      ["created_at"],
      ["timestamp"],
      ["eventTime"],
      ["event_time"],
      ["occurredAt"],
      ["occurred_at"],
      ["paidAt"],
      ["paid_at"],
      ["approvedAt"],
      ["approved_at"],
      ["data", "createdAt"],
      ["data", "created_at"],
      ["data", "timestamp"],
      ["payment", "createdAt"],
      ["payment", "created_at"],
      ["payment", "paidAt"],
      ["payment", "paid_at"],
      ["payment", "approvedAt"],
      ["payment", "approved_at"],
    ]) ??
    pickNumber(payload, [
      ["createdAt"],
      ["created_at"],
      ["timestamp"],
      ["data", "createdAt"],
      ["data", "created_at"],
      ["data", "timestamp"],
      ["payment", "createdAt"],
      ["payment", "created_at"],
    ]);

  if (payloadValue !== undefined) {
    return payloadValue;
  }

  for (const headerName of extraHeaderNames) {
    const headerValue = headers.get(headerName);
    if (headerValue && headerValue.trim().length > 0) {
      return headerValue.trim();
    }
  }

  return null;
}

/**
 * 결제 성공 후처리 본체 — 큐 워커가 직접 호출. 웹훅 핸들러에서는 enqueue만.
 */
export async function finalizePaymentEffects(orderId: string) {
  const pool = getPool();
  const [orderResult, soldOutProducts] = await Promise.all([
    pool.query<CompletedOrderRow>(
      `
        SELECT
          account_id AS "accountId",
          event_id AS "eventId",
          order_number AS "orderNumber",
          total_amount AS "totalAmount"
        FROM orders
        WHERE id = $1
        LIMIT 1
      `,
      [orderId],
    ),
    // 레벨2 read-flip: 매진 상품은 v2 티어(capacity vs sold_count)로 산출 — go order_items/products.stock 폐기.
    resolveSoldOutProductsForOrder(orderId),
  ]);

  const order = orderResult.rows[0];
  if (!order) {
    return;
  }

  try {
    await notifyNewOrder(
      order.accountId,
      order.eventId,
      order.orderNumber,
      Number(order.totalAmount),
    );
    await Promise.all(
      soldOutProducts.map((product) =>
        notifySoldOut(product.accountId, product.eventId, product.productName),
      ),
    );
    await dispatchWebhook("order.completed", order);
  } catch (err: unknown) {
    logger.error("[payment-webhook] 후처리 실패", {
      orderId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err; // 워커가 재시도할 수 있도록
  }
}

/**
 * H6: 웹훅 핸들러에서 즉시 반환하기 위한 enqueue 헬퍼.
 * BullMQ 실패 시(Redis 장애 등) 동기 실행으로 폴백 — 데이터 유실 방지.
 */
async function scheduleFinalizePaymentEffects(orderId: string) {
  try {
    const { enqueuePaymentEffects } = await import("@/lib/queue/payment-effects-queue");
    await enqueuePaymentEffects(orderId);
  } catch (err: unknown) {
    logger.warn("[payment-webhook] effects 큐 enqueue 실패 — 동기 폴백", {
      orderId,
      error: err instanceof Error ? err.message : String(err),
    });
    // 동기 폴백: 큐가 죽어도 후처리는 실행. 웹훅 타임아웃 가능성은 있지만 데이터 일관성 우선.
    await finalizePaymentEffects(orderId).catch(() => undefined);
  }
}

async function loadOrderForUpdate(client: PoolClient, orderId: string) {
  const result = await client.query<{ status: string; total_amount: string }>(
    `
      SELECT status, total_amount
      FROM orders
      WHERE id = $1
      LIMIT 1
      FOR UPDATE
    `,
    [orderId],
  );

  return result.rows[0] ?? null;
}

export async function applySuccessfulPayment(
  input: ApplySuccessfulPaymentInput,
): Promise<ApplySuccessfulPaymentResult> {
  const pool = getPool();
  const client = await pool.connect();
  let transitioned = false;
  let outboxPending = false;

  try {
    await client.query("BEGIN");
    const order = await loadOrderForUpdate(client, input.orderId);
    if (!order) {
      await client.query("ROLLBACK");
      return { status: "ignored", reason: "order_not_found", orderId: input.orderId };
    }

    const expectedAmount = Number(order.total_amount);
    // P0: 결제 확정은 실결제액 검증이 필수다. amount 미추출(undefined) 시 이전 코드는
    // 검증을 건너뛰고 그대로 확정 → 금액 조작/누락 웹훅이 무검증 통과했다. fail-closed 로
    // 전환: 금액을 확인할 수 없으면 확정하지 않고 경보성 로그를 남긴다. (감사 P0-2)
    if (input.amount === undefined) {
      await client.query("ROLLBACK");
      logger.error("[payment-webhook] 결제 금액 미추출 — 검증 불가로 확정 거부(fail-closed)", {
        orderId: input.orderId,
        paymentReference: input.paymentReference ?? null,
      });
      return { status: "ignored", reason: "amount_unverifiable", orderId: input.orderId };
    }
    if (input.amount !== expectedAmount) {
      throw new Error("결제 금액이 주문 금액과 일치하지 않습니다");
    }

    if (order.status === "completed") {
      await client.query("ROLLBACK");
      return { status: "already_completed", orderId: input.orderId };
    }

    if (order.status !== "pending") {
      await client.query("ROLLBACK");
      return {
        status: "ignored",
        reason: `status_${order.status}`,
        orderId: input.orderId,
      };
    }

    transitioned = await transitionOrder(client, input.orderId, "pending", "completed");
    if (!transitioned) {
      await client.query("ROLLBACK");
      return { status: "already_completed", orderId: input.orderId };
    }

    await client.query(
      `
        UPDATE orders
        SET
          payment_method = $2,
          payment_status = 'paid',
          paid_amount = $3,
          payment_reference = COALESCE($4, payment_reference),
          updated_at = NOW()
        WHERE id = $1
      `,
      [
        input.orderId,
        input.paymentMethod,
        input.amount ?? expectedAmount,
        input.paymentReference ?? null,
      ],
    );

    await transitionAttendees(client, input.orderId, "pending", "confirmed");

    // B1(P0 재배선): PG 결제완료 → v2 결제확정을 위한 **pending outbox 행만** 이 트랜잭션에 기록.
    // 외부 v2 호출은 여기서 하지 않는다(원자화 불가 → 역 split-brain 방지). 실제 confirm 은
    // COMMIT 후 워커/cron 이 pending 행을 클레임해 멱등키로 수행한다.
    const outboxResult = await recordPaymentConfirmOutbox(client, input.orderId, { amount: input.amount });
    outboxPending = outboxResult.pending;

    await client.query("COMMIT");
  } catch (err: unknown) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  if (transitioned) {
    // H6: 동기 실행 대신 큐로 위임 → 웹훅 핸들러 200ms 이내 반환 가능.
    await scheduleFinalizePaymentEffects(input.orderId);
    // COMMIT 후: pending outbox 행이 있으면 재조정 워커 트리거(v2 confirm 은 여기서·트랜잭션 밖).
    // enqueue 실패는 cron 이중 안전망이 drain. v2OrderId 없음(NICE/레거시)=outbox 미기록이라 스킵.
    if (outboxPending) {
      const { enqueuePaymentConfirm } = await import("@/lib/queue/payment-confirm-queue");
      await enqueuePaymentConfirm(input.orderId);
    }
  }

  return { status: transitioned ? "applied" : "already_completed", orderId: input.orderId };
}

/**
 * payment_reference(PG 발급 식별자)로 orders.id를 fallback 조회.
 * Toss paymentKey 형식 불일치로 UUID 추출이 실패한 경우 사용.
 */
async function resolveOrderIdByPaymentReference(
  paymentReference: string,
): Promise<string | null> {
  const pool = getPool();
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM orders WHERE payment_reference = $1 LIMIT 1`,
    [paymentReference],
  );
  return rows[0]?.id ?? null;
}

export async function processWebhookPaymentEvent(input: {
  provider: "toss";
  paymentMethod: PaymentMethod;
  payload: JsonObject;
}): Promise<ApplySuccessfulPaymentResult> {
  const outcome = detectPaymentOutcome(input.payload);
  if (outcome.outcome !== "paid") {
    return { status: "ignored", reason: outcome.reason };
  }

  const paymentReference = extractPaymentReference(input.payload);

  // 1차: UUID 형식의 orderId 직접 추출 (Toss/Kakao/Naver 표준 경로)
  let orderId = extractOrderId(input.payload);

  // 2차: UUID 매칭 실패 시 payment_reference로 fallback 조회
  if (!orderId && paymentReference) {
    const resolved = await resolveOrderIdByPaymentReference(paymentReference);
    if (resolved) {
      orderId = resolved;
      logger.info("[payment-webhook] payment_reference fallback으로 주문 해결", {
        provider: input.provider,
        paymentReference,
        orderId,
      });
    }
  }

  if (!orderId) {
    logger.warn("[payment-webhook] 주문 식별자 없음 — UUID·payment_reference 모두 불일치", {
      provider: input.provider,
      reason: outcome.reason,
      paymentReference,
    });
    return { status: "ignored", reason: "order_id_missing" };
  }

  return applySuccessfulPayment({
    orderId,
    amount: extractAmount(input.payload),
    paymentMethod: input.paymentMethod,
    paymentReference,
  });
}
