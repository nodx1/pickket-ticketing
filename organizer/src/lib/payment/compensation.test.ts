import { beforeEach, describe, expect, it, vi } from "vitest";

const { getPool, refundOrder, V2CommerceError, getTossPaymentByPaymentKey, tossCancel } = vi.hoisted(() => ({
  getPool: vi.fn(),
  refundOrder: vi.fn(),
  V2CommerceError: class V2CommerceError extends Error {
    constructor(message: string, readonly status: number) { super(message); }
  },
  getTossPaymentByPaymentKey: vi.fn(),
  tossCancel: vi.fn(),
}));
vi.mock("@/lib/db/pool", () => ({ getPool }));
vi.mock("@/lib/v2/commerce-client", () => ({ refundOrder, V2CommerceError }));
vi.mock("@/lib/payment/toss", () => ({
  getTossPaymentByPaymentKey,
  tossProvider: { cancel: tossCancel },
}));

import {
  enqueueExpiredPaymentCompensation,
  processExpiredPaymentCompensations,
  enqueueSeatExpiredPaymentCompensation,
  enqueuePaymentCompensationManualReview,
} from "@/lib/payment/compensation";

describe("enqueueExpiredPaymentCompensation attempt idempotency", () => {
  it("명시한 Toss paymentKey를 환불 앵커와 보상 멱등키에 함께 결속한다", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: "action-duplicate" }] });
    const client = { query } as unknown as import("pg").PoolClient;

    await enqueueExpiredPaymentCompensation(client, {
      orderId: "order-duplicate",
      v2OrderId: "v2-duplicate",
      deliveryId: null,
      amount: 15000,
      reason: "duplicate_toss_capture",
      providerPaymentKey: "toss_loser_key",
    });

    const [sql, values] = query.mock.calls[0];
    expect(sql).toContain("ON CONFLICT (order_id, action, idempotency_key)");
    expect(values).toEqual([
      "order-duplicate",
      "v2-duplicate",
      "duplicate_toss_capture",
      null,
      15000,
      null,
      "toss_loser_key",
      "toss:toss_loser_key",
    ]);
  });
});

describe("enqueuePaymentCompensationManualReview", () => {
  beforeEach(() => vi.clearAllMocks());

  it("자동환불 앵커 없는 실결제를 manual_review 로 durable 기록한다(v2_order_id NULL)", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: "action-mr" }] });
    const client = { query } as unknown as import("pg").PoolClient;

    const id = await enqueuePaymentCompensationManualReview(client, {
      orderId: "order-noanchor",
      amount: 9000,
      reason: "seat_expired_after_payment",
      postRefundOrderStatus: "refunded",
    });

    expect(id).toBe("action-mr");
    const [sql, values] = query.mock.calls[0];
    // status='manual_review' 로 삽입 + no_refund_anchor 사유 + v2_order_id NULL.
    expect(sql).toContain("'manual_review'");
    expect(sql).toContain("no_refund_anchor");
    expect(sql).toContain("v2_order_id, action");
    // 파라미터: orderId, reason, amount, postRefundOrderStatus.
    expect(values).toEqual([
      "order-noanchor",
      "seat_expired_after_payment",
      9000,
      "refunded",
    ]);
  });
});

describe("enqueueSeatExpiredPaymentCompensation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("seat-expiry 보상 액션을 refund/seat 사유/post_refund_order_status=refunded 로 기록한다", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: "action-seat" }] });
    const client = { query } as unknown as import("pg").PoolClient;

    const id = await enqueueSeatExpiredPaymentCompensation(client, {
      orderId: "order-seat",
      v2OrderId: "v2-seat",
      amount: 12000,
    });

    expect(id).toBe("action-seat");
    const [sql, values] = query.mock.calls[0];
    // 항상 refund 액션 + post_refund_order_status 컬럼을 채운다.
    expect(sql).toContain("post_refund_order_status");
    expect(values).toEqual([
      "order-seat",
      "v2-seat",
      "seat_expired_after_payment",
      null, // deliveryId 없음
      12000,
      "refunded", // post_refund_order_status
      null, // providerPaymentKey — 일반 v2 보상은 order scope
      "order", // idempotencyKey
    ]);
  });
});

describe("expired payment compensation worker", () => {
  beforeEach(() => vi.clearAllMocks());

  it("claims and refunds with a stable action idempotency key", async () => {
    const client = {
      release: vi.fn(),
      query: vi.fn()
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // stale processing reset
        .mockResolvedValueOnce({}) // max attempt transition
        .mockResolvedValueOnce({ rows: [{ id: "action-1", order_id: "order-1", v2_order_id: "v2-1", requested_amount: "1000", attempts: 0, attempt_count: 0, max_attempts: 5 }] })
        .mockResolvedValueOnce({}) // mark processing
        .mockResolvedValueOnce({}) // COMMIT
        .mockResolvedValueOnce({}) // final BEGIN
        .mockResolvedValueOnce({ rows: [{ order_id: "order-1" }], rowCount: 1 }) // final action
        .mockResolvedValueOnce({}) // order projection
        .mockResolvedValueOnce({}), // final COMMIT
    };
    const pool = { connect: vi.fn().mockResolvedValue(client), query: vi.fn().mockResolvedValue({}) };
    getPool.mockReturnValue(pool);
    refundOrder.mockResolvedValue({ status: "refunded", order_id: "v2-1" });

    await expect(processExpiredPaymentCompensations()).resolves.toEqual({ claimed: 1, completed: 1, failed: 0, unknown: 0, manualReview: 0 });
    expect(refundOrder).toHaveBeenCalledWith(
      "v2-1",
      { full: true, reason: "payment_confirmed_after_order_expired" },
      { idempotencyKey: "payment-compensation:action-1" },
    );
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("status = 'completed'"), expect.any(Array));
  });

  it("seat-expiry(post_refund_order_status=refunded)는 환불 성공 후 completed→refunded + 티켓 취소를 투영한다", async () => {
    const finalQueries: [string, unknown[]?][] = [];
    const client = {
      release: vi.fn(),
      query: vi.fn()
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // stale processing reset
        .mockResolvedValueOnce({}) // max attempt transition
        .mockResolvedValueOnce({ rows: [{ id: "action-seat", order_id: "order-seat", v2_order_id: "v2-seat", requested_amount: "12000", attempts: 0, attempt_count: 0, max_attempts: 5, post_refund_order_status: "refunded" }] })
        .mockResolvedValueOnce({}) // mark processing
        .mockResolvedValueOnce({}) // COMMIT
        .mockResolvedValueOnce({}) // final BEGIN
        .mockResolvedValueOnce({ rows: [{ order_id: "order-seat" }], rowCount: 1 }) // final action -> completed
        .mockImplementation((text: string, values?: unknown[]) => {
          finalQueries.push([text, values]);
          return Promise.resolve({ rowCount: 1 });
        }),
    };
    const pool = { connect: vi.fn().mockResolvedValue(client), query: vi.fn().mockResolvedValue({}) };
    getPool.mockReturnValue(pool);
    refundOrder.mockResolvedValue({ status: "refunded", order_id: "v2-seat", total_refunded: 12000 });

    await expect(processExpiredPaymentCompensations()).resolves.toMatchObject({ claimed: 1, completed: 1 });
    // 유효 전이(completed→refunded)를 상태머신 조건으로 적용.
    const refundedUpdate = finalQueries.find(([sql]) => sql.includes("status = 'refunded'") && sql.includes("status = 'completed'"));
    expect(refundedUpdate).toBeDefined();
    // 전액 환불 → 티켓(attendees) 취소 cascade.
    const attendeeCancel = finalQueries.find(([sql]) => sql.includes("UPDATE attendees SET status = 'cancelled'"));
    expect(attendeeCancel).toBeDefined();
    // 만료(expired) 경로 SQL 은 나오면 안 된다.
    const expiredUpdate = finalQueries.find(([sql]) => sql.includes("status IN ('expired', 'cancelled')"));
    expect(expiredUpdate).toBeUndefined();
  });

  it("keeps a provider failure retryable with backoff metadata", async () => {
    const client = {
      release: vi.fn(),
      query: vi.fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ id: "action-2", order_id: "order-2", v2_order_id: "v2-2", requested_amount: "2000", attempts: 2, attempt_count: 2, max_attempts: 5 }] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({}),
    };
    const pool = { connect: vi.fn().mockResolvedValue(client), query: vi.fn().mockResolvedValue({}) };
    getPool.mockReturnValue(pool);
    refundOrder.mockRejectedValue(new V2CommerceError("v2 rate limited", 429));

    await expect(processExpiredPaymentCompensations()).resolves.toEqual({ claimed: 1, completed: 0, failed: 1, unknown: 0, manualReview: 0 });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("status = $2"),
      expect.arrayContaining(["action-2", "v2 rate limited", "failed_retryable"]),
    );
  });

  it("does not turn an ambiguous refund response into a retryable failure", async () => {
    const client = {
      release: vi.fn(),
      query: vi.fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ id: "action-unknown", order_id: "order-unknown", v2_order_id: "v2-unknown", requested_amount: "3000", attempts: 5, attempt_count: 5, max_attempts: 5 }] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({}),
    };
    const pool = { connect: vi.fn().mockResolvedValue(client), query: vi.fn().mockResolvedValue({}) };
    getPool.mockReturnValue(pool);
    const ambiguous = new (class extends Error { status = 0; })("response lost after provider accepted");
    refundOrder.mockRejectedValue(ambiguous);

    await expect(processExpiredPaymentCompensations()).resolves.toMatchObject({ claimed: 1, completed: 0, unknown: 1 });
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("status = $2"), expect.arrayContaining(["action-unknown", "unknown"]));
  });

  it("does not fall back to a V2 refund when a Toss payment key is missing", async () => {
    const client = {
      release: vi.fn(),
      query: vi.fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ id: "toss-missing-key", order_id: "order-toss", v2_order_id: "v2-toss", requested_amount: "3000", attempts: 0, attempt_count: 0, max_attempts: 5, provider_name: "toss", provider_payment_key: null }] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({}),
    };
    const pool = { connect: vi.fn().mockResolvedValue(client), query: vi.fn().mockResolvedValue({}) };
    getPool.mockReturnValue(pool);

    await expect(processExpiredPaymentCompensations()).resolves.toMatchObject({ claimed: 1, completed: 0, unknown: 1 });
    expect(refundOrder).not.toHaveBeenCalled();
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("status = $2"), expect.arrayContaining(["toss-missing-key", "unknown"]));
  });
});

/**
 * T2(레벨2 컷오버) — Toss provider 환불의 v2 전파.
 *
 * 예전엔 Toss 분기가 provider 취소 후 곧장 return 해 v2 `refundOrder` 를 건너뛰었다.
 * ⟹ go=refunded / v2=confirmed(티켓 ACTIVE) 로 영구 발산(환불받고도 입장 + 정산 과대계상).
 */
describe("T2: Toss 보상 환불의 v2 전파", () => {
  beforeEach(() => vi.clearAllMocks());

  /** claim 6쿼리(BEGIN/stale/max/claim/processing/COMMIT) + 확정 4쿼리 형태의 클라이언트. */
  function makeClient(row: Record<string, unknown>) {
    return {
      release: vi.fn(),
      query: vi.fn()
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // stale processing reset
        .mockResolvedValueOnce({}) // max attempt transition
        .mockResolvedValueOnce({ rows: [row] }) // claim
        .mockResolvedValueOnce({}) // mark processing
        .mockResolvedValueOnce({}) // COMMIT
        .mockResolvedValueOnce({}) // final BEGIN
        .mockResolvedValueOnce({ rows: [{ order_id: row.order_id }], rowCount: 1 }) // final action
        .mockResolvedValueOnce({}) // order projection
        .mockResolvedValueOnce({}), // final COMMIT
    };
  }

  const tossRow = {
    id: "act-toss", order_id: "order-toss", v2_order_id: "v2-toss",
    requested_amount: "5000", attempts: 0, attempt_count: 0, max_attempts: 5,
    provider_name: "toss", provider_payment_key: "tk_1",
  };

  it("provider 취소 성공 후 v2 refundOrder 를 동일 멱등키로 호출하고 completed 처리한다", async () => {
    const client = makeClient(tossRow);
    const pool = { connect: vi.fn().mockResolvedValue(client), query: vi.fn().mockResolvedValue({}) };
    getPool.mockReturnValue(pool);
    getTossPaymentByPaymentKey
      .mockResolvedValueOnce(null) // before
      .mockResolvedValueOnce({ status: "CANCELED", lastTransactionKey: "tx_1", cancels: [{ cancelAmount: 5000 }] }); // after
    tossCancel.mockResolvedValue({ success: true, cancelAmount: 5000 });
    refundOrder.mockResolvedValue({ status: "refunded", order_id: "v2-toss" });

    await expect(processExpiredPaymentCompensations()).resolves.toMatchObject({ claimed: 1, completed: 1, manualReview: 0 });
    expect(tossCancel).toHaveBeenCalledTimes(1);
    // 🔴 핵심: Toss 성공분이 v2 로 전파된다. 멱등키는 v2 provider 경로와 동일.
    expect(refundOrder).toHaveBeenCalledWith(
      "v2-toss",
      // T16: 이 경로는 Toss 취소를 이미 마쳤으므로 v2 가 PG 를 또 부르면 이중 환불이다.
      { full: true, reason: "payment_confirmed_after_order_expired", pg_already_voided: true },
      { idempotencyKey: "payment-compensation:act-toss" },
    );
  });

  it("🔴 provider 성공 + v2 전파 실패는 completed 가 아니라 manual_review 로 고정한다", async () => {
    const client = makeClient(tossRow);
    const pool = { connect: vi.fn().mockResolvedValue(client), query: vi.fn().mockResolvedValue({}) };
    getPool.mockReturnValue(pool);
    getTossPaymentByPaymentKey
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ status: "CANCELED", lastTransactionKey: "tx_1", cancels: [{ cancelAmount: 5000 }] });
    tossCancel.mockResolvedValue({ success: true, cancelAmount: 5000 });
    refundOrder.mockRejectedValue(new V2CommerceError("v2 unavailable", 503));

    await expect(processExpiredPaymentCompensations()).resolves.toMatchObject({ claimed: 1, completed: 0, manualReview: 1 });
    // 재시도(=2회 환불)로 흘리지 않는다.
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'manual_review'"),
      expect.arrayContaining(["act-toss", "v2_propagation_failed"]),
    );
    // completed 전이는 시도조차 하지 않는다.
    expect(client.query.mock.calls.some((call: unknown[]) => String(call[0]).includes("status = 'completed'"))).toBe(false);
  });

  it("v2 앵커가 없는 Toss 보상은 provider 환불 후 manual_review(v2_anchor_missing)로 남긴다", async () => {
    const client = makeClient({ ...tossRow, id: "act-noanchor", v2_order_id: null });
    const pool = { connect: vi.fn().mockResolvedValue(client), query: vi.fn().mockResolvedValue({}) };
    getPool.mockReturnValue(pool);
    getTossPaymentByPaymentKey
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ status: "CANCELED", lastTransactionKey: "tx_2", cancels: [{ cancelAmount: 5000 }] });
    tossCancel.mockResolvedValue({ success: true, cancelAmount: 5000 });

    await expect(processExpiredPaymentCompensations()).resolves.toMatchObject({ claimed: 1, completed: 0, manualReview: 1 });
    expect(refundOrder).not.toHaveBeenCalled();
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'manual_review'"),
      expect.arrayContaining(["act-noanchor", "v2_anchor_missing"]),
    );
  });

  it("이미 provider 에서 환불된 건도 v2 로 전파한다(과거 미전파분 회수·중복 취소 없음)", async () => {
    const client = makeClient({ ...tossRow, id: "act-already" });
    const pool = { connect: vi.fn().mockResolvedValue(client), query: vi.fn().mockResolvedValue({}) };
    getPool.mockReturnValue(pool);
    // before 조회에서 이미 요청액 이상 환불됨 → provider 재취소 없음.
    getTossPaymentByPaymentKey.mockResolvedValueOnce({ lastTransactionKey: "tx_old", cancels: [{ cancelAmount: 5000 }] });
    refundOrder.mockResolvedValue({ status: "refunded", order_id: "v2-toss" });

    await expect(processExpiredPaymentCompensations()).resolves.toMatchObject({ claimed: 1, completed: 1 });
    expect(tossCancel).not.toHaveBeenCalled();
    expect(refundOrder).toHaveBeenCalledWith(
      "v2-toss",
      expect.objectContaining({ full: true }),
      { idempotencyKey: "payment-compensation:act-already" },
    );
  });
});
