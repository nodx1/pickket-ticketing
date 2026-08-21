import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * reconcileOrphanTossPendingPayments — P0-3 복구경로 + 레벨2 재감사 P0조건부/P1 + 재감사3차(race).
 *
 * toss confirm 이 PG 승인 전 payment_reference 를 durable 기록한다. 승인 성공 후 go 트랜잭션이
 * 실패하면 Toss=DONE·go=pending·outbox 없음 orphan 이 남는다. 이 스캐너가 provider 조회로
 * 캡처를 확인하고 취소 + 환불 보상큐로 회수한다.
 *
 * 재감사 반영:
 *  - P0조건부: v2 앵커가 없어도 Toss 는 provider_payment_key 로 환불 가능 → 보상큐에 항상 기록(유실 없음).
 *  - P1: 후보는 주문 상태가 아니라 payment_attempts 미정산 키에서 시작한다(완료 주문 비승자 포함).
 *  - 재감사3차(race): 후보 조회(락 없음)와 처리 사이 정상 confirm 이 pending→completed 로 전이할 수
 *    있다. 처리 직전 orders 행을 FOR UPDATE 로 잠그고 정본 상태·선점키를 재조회해:
 *      · 여전히 pending → 실제 orphan 회수(취소+보상큐)
 *      · completed 이고 이 키가 선점키(payment_reference) == 정상 완료건 → skip(오탐 차단, ledger settled)
 *      · completed 이고 이 키가 선점키와 다른 별도 DONE == 해당 paymentKey 자동환불 보상큐
 */
const {
  getPool,
  getTossPaymentByPaymentKey,
  enqueueExpiredPaymentCompensation,
  transitionOrder,
} = vi.hoisted(() => ({
  getPool: vi.fn(),
  getTossPaymentByPaymentKey: vi.fn(),
  enqueueExpiredPaymentCompensation: vi.fn(),
  transitionOrder: vi.fn(),
}));
vi.mock("@/lib/db/pool", () => ({ getPool }));
vi.mock("@/lib/payment/toss", () => ({ getTossPaymentByPaymentKey }));
vi.mock("@/lib/payment/compensation", () => ({ enqueueExpiredPaymentCompensation }));
vi.mock("@/lib/payment/confirm-outbox", () => ({ processPaymentConfirmOutbox: vi.fn() }));
vi.mock("@/lib/state-machine/order-state-machine", () => ({ transitionOrder }));

import { reconcileOrphanTossPendingPayments } from "@/lib/payment/reconcile";

// 스캐너가 반환하는 후보 shape(WITH keys ... SELECT DISTINCT ON): 주문+단일 시도 키.
function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: "order-1",
    v2OrderId: "v2-1",
    paymentKey: "toss_pk_live_1",
    paidAmount: null,
    totalAmount: 15000,
    ...overrides,
  };
}

/**
 * 트랜잭션 클라이언트 mock. 처리 직전 `SELECT ... FOR UPDATE` 는 orderRow 를 돌려주고,
 * payment_attempts UPDATE 는 attemptsRowCount 를 돌려준다. 그 외(BEGIN/COMMIT/ROLLBACK/기타 UPDATE)는 1.
 */
function makeClient(orderRow: { status: string; payment_reference: string | null } | null, attemptsRowCount = 1) {
  const query = vi.fn(async (sql: string) => {
    if (typeof sql === "string" && sql.includes("FOR UPDATE")) {
      return { rows: orderRow ? [orderRow] : [], rowCount: orderRow ? 1 : 0 };
    }
    if (typeof sql === "string" && sql.includes("payment_attempts")) {
      return { rowCount: attemptsRowCount };
    }
    return { rowCount: 1 };
  });
  return { release: vi.fn(), query };
}

describe("reconcileOrphanTossPendingPayments", () => {
  beforeEach(() => vi.clearAllMocks());

  it("PG 캡처(DONE) orphan(여전히 pending)을 취소 + 환불 보상큐로 회수한다", async () => {
    const client = makeClient({ status: "pending", payment_reference: "toss_pk_live_1" });
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
      query: vi.fn().mockResolvedValue({ rows: [candidate()] }),
    };
    getPool.mockReturnValue(pool);
    getTossPaymentByPaymentKey.mockResolvedValue({ status: "DONE", totalAmount: 15000 });
    transitionOrder.mockResolvedValue(true); // pending→cancelled 성공
    enqueueExpiredPaymentCompensation.mockResolvedValue("action-1");

    const summary = await reconcileOrphanTossPendingPayments();

    expect(summary).toEqual({ scanned: 1, refunding: 1, stillPending: 0, lookupFailed: 0 });
    expect(transitionOrder).toHaveBeenCalledWith(client, "order-1", "pending", "cancelled");
    expect(enqueueExpiredPaymentCompensation).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        orderId: "order-1",
        v2OrderId: "v2-1",
        amount: 15000,
        reason: "toss_captured_after_go_transaction_failed",
        providerPaymentKey: "toss_pk_live_1",
      }),
    );
    const candidateSql = String(pool.query.mock.calls[0]?.[0]);
    expect(candidateSql).toContain("FROM payment_attempts a");
    expect(candidateSql).not.toContain("WITH pending_toss");
    expect(client.query).toHaveBeenCalledWith("COMMIT");
  });

  it("미캡처(승인 미완)면 아무것도 취소/환불하지 않고 pending 유지한다", async () => {
    const client = makeClient({ status: "pending", payment_reference: "toss_pk_live_1" });
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
      query: vi.fn().mockResolvedValue({ rows: [candidate()] }),
    };
    getPool.mockReturnValue(pool);
    getTossPaymentByPaymentKey.mockResolvedValue({ status: "READY" }); // 캡처 안 됨

    const summary = await reconcileOrphanTossPendingPayments();

    expect(summary).toEqual({ scanned: 1, refunding: 0, stillPending: 1, lookupFailed: 0 });
    expect(transitionOrder).not.toHaveBeenCalled();
    expect(enqueueExpiredPaymentCompensation).not.toHaveBeenCalled();
  });

  it("provider 조회 실패는 lookupFailed 로 집계(다음 주기 재시도) — 절대 취소하지 않는다", async () => {
    const pool = {
      connect: vi.fn(),
      query: vi.fn().mockResolvedValue({ rows: [candidate()] }),
    };
    getPool.mockReturnValue(pool);
    getTossPaymentByPaymentKey.mockRejectedValue(new Error("network timeout"));

    const summary = await reconcileOrphanTossPendingPayments();

    expect(summary).toEqual({ scanned: 0, refunding: 0, stillPending: 0, lookupFailed: 1 });
    expect(transitionOrder).not.toHaveBeenCalled();
    expect(enqueueExpiredPaymentCompensation).not.toHaveBeenCalled();
  });

  it("[race 오탐 차단] 후보 조회 후 정상 confirm 으로 completed 됐고 이 키가 선점키면 skip(이중캡처 아님)", async () => {
    // DONE 키 == orders.payment_reference(선점키) → 정상 완료된 결제. duplicate_toss_capture 금지.
    const client = makeClient({ status: "completed", payment_reference: "toss_pk_live_1" });
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
      query: vi.fn().mockResolvedValue({ rows: [candidate()] }),
    };
    getPool.mockReturnValue(pool);
    getTossPaymentByPaymentKey.mockResolvedValue({ status: "DONE", totalAmount: 15000 });

    const summary = await reconcileOrphanTossPendingPayments();

    expect(summary).toEqual({ scanned: 1, refunding: 0, stillPending: 1, lookupFailed: 0 });
    // 정상 완료건이므로 취소도, 이중캡처 에스컬레이션도 없어야 한다.
    expect(transitionOrder).not.toHaveBeenCalled();
    expect(enqueueExpiredPaymentCompensation).not.toHaveBeenCalled();
    // ledger 를 settled 로 마감(재스캔 방지)했는지 확인.
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'settled'"),
      ["order-1", "toss_pk_live_1", "DONE"],
    );
    expect(client.query).toHaveBeenCalledWith("COMMIT");
  });

  it("[정탐] completed 주문의 비승자 DONE 키를 해당 paymentKey 보상큐로 보낸다", async () => {
    // 주문은 다른 키(winner-key)로 확정됐고, 이 키(toss_pk_live_1)는 별도 DONE 캡처 = 이중결제.
    const client = makeClient({ status: "completed", payment_reference: "winner-key" }, 1);
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
      query: vi.fn().mockResolvedValue({ rows: [candidate()] }),
    };
    getPool.mockReturnValue(pool);
    getTossPaymentByPaymentKey.mockResolvedValue({ status: "DONE", totalAmount: 15000 });

    const summary = await reconcileOrphanTossPendingPayments();

    expect(summary).toEqual({ scanned: 1, refunding: 1, stillPending: 0, lookupFailed: 0 });
    expect(transitionOrder).not.toHaveBeenCalled();
    expect(enqueueExpiredPaymentCompensation).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        orderId: "order-1",
        reason: "duplicate_toss_capture",
        providerPaymentKey: "toss_pk_live_1",
      }),
    );
    // 보상큐가 durable 기록된 시도는 settled 로 마킹해 재스캔을 막는다.
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'settled'"),
      ["order-1", "toss_pk_live_1", "DONE"],
    );
    expect(client.query).toHaveBeenCalledWith("COMMIT");
  });

  it("pending 주문의 비승자 DONE 키는 주문을 취소하지 않고 해당 키만 환불큐로 보낸다", async () => {
    const client = makeClient({ status: "pending", payment_reference: "winner-key" });
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
      query: vi.fn().mockResolvedValue({ rows: [candidate()] }),
    };
    getPool.mockReturnValue(pool);
    getTossPaymentByPaymentKey.mockResolvedValue({ status: "DONE", totalAmount: 15000 });

    const summary = await reconcileOrphanTossPendingPayments();

    expect(summary).toEqual({ scanned: 1, refunding: 1, stillPending: 0, lookupFailed: 0 });
    expect(transitionOrder).not.toHaveBeenCalled();
    expect(enqueueExpiredPaymentCompensation).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ providerPaymentKey: "toss_pk_live_1" }),
    );
    expect(client.query).toHaveBeenCalledWith("COMMIT");
  });

  it("[race] 주문이 completed 인데 선점키가 NULL(엣지)이면 오탐 방지 위해 이중캡처 판정하되 회수미완만", async () => {
    // payment_reference 가 NULL 이면 이 키가 선점키가 아님(!= 이므로 winning 아님) → 이중캡처 경로.
    // attempts 1행이면 escalate — 방어적으로 조용한 유실 금지(NULL 선점키는 이론상 드묾).
    const client = makeClient({ status: "completed", payment_reference: null }, 1);
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
      query: vi.fn().mockResolvedValue({ rows: [candidate()] }),
    };
    getPool.mockReturnValue(pool);
    getTossPaymentByPaymentKey.mockResolvedValue({ status: "DONE", totalAmount: 15000 });

    const summary = await reconcileOrphanTossPendingPayments();

    expect(summary).toEqual({ scanned: 1, refunding: 1, stillPending: 0, lookupFailed: 0 });
    expect(enqueueExpiredPaymentCompensation).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ providerPaymentKey: "toss_pk_live_1" }),
    );
  });

  it("v2_order_id 없는 orphan(여전히 pending)도 Toss provider_payment_key 로 환불 보상큐에 기록", async () => {
    const client = makeClient({ status: "pending", payment_reference: "toss_pk_live_1" });
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
      query: vi.fn().mockResolvedValue({ rows: [candidate({ v2OrderId: null })] }),
    };
    getPool.mockReturnValue(pool);
    getTossPaymentByPaymentKey.mockResolvedValue({ status: "DONE", totalAmount: 15000 });
    transitionOrder.mockResolvedValue(true);
    enqueueExpiredPaymentCompensation.mockResolvedValue("action-null-v2");

    const summary = await reconcileOrphanTossPendingPayments();

    expect(summary).toEqual({ scanned: 1, refunding: 1, stillPending: 0, lookupFailed: 0 });
    // 재감사 P0조건부: 과거엔 스킵했으나 이제 v2 앵커 없어도 보상큐에 durable 기록.
    expect(enqueueExpiredPaymentCompensation).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ orderId: "order-1", v2OrderId: null }),
    );
    expect(client.query).toHaveBeenCalledWith("COMMIT");
  });
});
