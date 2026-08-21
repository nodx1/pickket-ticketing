import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * finalizeOrderPayment — 레벨2 컷오버 T1 좌석/트랜잭션 계약.
 *
 * ── 이 파일이 검증하던 것(이전) ──
 * "결제 완료 후 좌석 홀드 만료 race"(verifyAndMarkSold=false)에서 환불 보상 앵커를 고르는 3분기.
 *
 * ── 왜 계약이 바뀌었나 ──
 * 그 경로의 입구는 `SELECT ... FROM seats WHERE reserved_order_id = $1 FOR UPDATE` 였는데,
 *   1. `reserved_order_id` 는 코드베이스 어디에서도 **write 되지 않는다**(빅뱅 flip 때 markReserved/
 *      markSold 폐기로 write 경로 소멸) → 항상 0행,
 *   2. T1 에서 좌석빌더가 go `seats` INSERT 를 끊어 그 테이블은 **항상 비어 있고**,
 *   3. 좌석 SOLD 확정은 v2 createOrder 가 원자 소유(홀드가 만료됐으면 주문 생성 자체가 4xx)
 * 라서 죽은 경로였다. 그래서 블록을 제거했고, 이 테스트는 그 자리에 **새 계약**을 고정한다:
 *   - 결제확정은 go `seats`/`seat_maps` 를 전혀 조회/갱신하지 않는다.
 *   - 좌석 사유의 환불 보상(seat_expired)은 더 이상 생산되지 않는다.
 *   - v2 confirm 트리거는 **COMMIT 이후**에만 나간다(외부호출/트랜잭션 경계).
 */
const h = vi.hoisted(() => ({
  transitionOrder: vi.fn(),
  transitionAttendees: vi.fn(),
  recordPaymentConfirmOutbox: vi.fn(),
  enqueuePaymentConfirm: vi.fn(),
  enqueueSeatExpiredPaymentCompensation: vi.fn(),
  enqueuePaymentCompensationManualReview: vi.fn(),
  alertPaymentManualReview: vi.fn(),
  connect: vi.fn(),
  poolQuery: vi.fn(),
}));

vi.mock("@/lib/db/pool", () => ({
  getPool: () => ({ connect: h.connect, query: h.poolQuery }),
}));
vi.mock("@/lib/state-machine/order-state-machine", () => ({ transitionOrder: h.transitionOrder }));
vi.mock("@/lib/state-machine/attendee-state-machine", () => ({ transitionAttendees: h.transitionAttendees }));
vi.mock("@/lib/payment/confirm-v2", () => ({ recordPaymentConfirmOutbox: h.recordPaymentConfirmOutbox }));
vi.mock("@/lib/queue/payment-confirm-queue", () => ({ enqueuePaymentConfirm: h.enqueuePaymentConfirm }));
vi.mock("@/lib/payment/compensation", () => ({
  enqueueSeatExpiredPaymentCompensation: h.enqueueSeatExpiredPaymentCompensation,
  enqueuePaymentCompensationManualReview: h.enqueuePaymentCompensationManualReview,
}));
vi.mock("@/lib/payment/payment-alert", () => ({ alertPaymentManualReview: h.alertPaymentManualReview }));
vi.mock("@/lib/notifications/create", () => ({ notifyNewOrder: vi.fn(), notifySoldOut: vi.fn() }));
vi.mock("@/lib/notification/transactional", () => ({ notifyPurchaseConfirm: vi.fn() }));
vi.mock("@/lib/notification/sold-out", () => ({ resolveSoldOutProductsForOrder: vi.fn(async () => []) }));
vi.mock("@/lib/webhook/dispatcher", () => ({ dispatchWebhook: vi.fn() }));

import { finalizeOrderPayment } from "@/lib/server/order-finalize";

/** 실행된 SQL 을 순서대로 기록하는 client 스텁. */
function makeClient(): {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
  sql: string[];
} {
  const sql: string[] = [];
  const query = vi.fn(async (text: string) => {
    const statement = String(text);
    sql.push(statement);
    if (/UPDATE orders\s+SET[\s\S]*payment_status = 'paid'/.test(statement)) {
      return {
        rows: [
          {
            id: "order-1",
            status: "completed",
            accountId: "acc",
            eventId: "ev",
            orderNumber: "N1",
            totalAmount: 15000,
          },
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 1 };
  });
  return { query, release: vi.fn(), sql };
}

describe("finalizeOrderPayment — T1 좌석 계약(go seats 미접근)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.transitionOrder.mockResolvedValue(true); // pending→completed 성공
    h.transitionAttendees.mockResolvedValue(undefined);
    h.recordPaymentConfirmOutbox.mockResolvedValue({ pending: false });
    h.poolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("결제확정이 go seats/seat_maps 를 조회·갱신하지 않는다(참조 0)", async () => {
    const client = makeClient();
    h.connect.mockResolvedValue(client);

    const outcome = await finalizeOrderPayment("order-1", "toss");

    expect(outcome.kind).toBe("completed");
    const seatSql = client.sql.filter((s) => /\b(from|into|update|join)\s+seats\b/i.test(s));
    expect(seatSql).toEqual([]);
    expect(client.sql.some((s) => /\bseat_maps\b/i.test(s))).toBe(false);
  });

  it("좌석 사유 환불 보상(seat_expired)은 더 이상 생산되지 않는다", async () => {
    const client = makeClient();
    h.connect.mockResolvedValue(client);

    const outcome = await finalizeOrderPayment("order-1", "toss");

    expect(outcome).toEqual({
      kind: "completed",
      order: expect.objectContaining({ id: "order-1", status: "completed" }),
    });
    expect(h.enqueueSeatExpiredPaymentCompensation).not.toHaveBeenCalled();
    expect(h.enqueuePaymentCompensationManualReview).not.toHaveBeenCalled();
    expect(h.alertPaymentManualReview).not.toHaveBeenCalled();
    // refund_requests(seat_expired_after_payment) 원장도 기록되지 않는다.
    expect(client.sql.some((s) => /INSERT INTO refund_requests/.test(s))).toBe(false);
  });

  it("v2 confirm 트리거는 COMMIT 이후에만 나간다(외부호출/트랜잭션 경계)", async () => {
    const client = makeClient();
    h.connect.mockResolvedValue(client);
    h.recordPaymentConfirmOutbox.mockResolvedValue({ pending: true });
    // enqueue 시점에 이미 COMMIT 이 실행돼 있어야 한다.
    let committedAtEnqueue: boolean | null = null;
    h.enqueuePaymentConfirm.mockImplementation(async () => {
      committedAtEnqueue = client.sql.includes("COMMIT");
    });

    const outcome = await finalizeOrderPayment("order-1", "toss");

    expect(outcome.kind).toBe("completed");
    expect(h.enqueuePaymentConfirm).toHaveBeenCalledWith("order-1");
    expect(committedAtEnqueue).toBe(true);
    // outbox 기록 자체는 트랜잭션 안(같은 client)에서 원자적으로 이뤄진다.
    expect(h.recordPaymentConfirmOutbox).toHaveBeenCalledWith(
      client,
      "order-1",
      expect.objectContaining({ amount: 15000 }),
    );
  });

  it("pending outbox 가 없으면 트리거하지 않는다(레거시/NICE — cron 안전망)", async () => {
    const client = makeClient();
    h.connect.mockResolvedValue(client);
    h.recordPaymentConfirmOutbox.mockResolvedValue({ pending: false });

    await finalizeOrderPayment("order-1", "bank_transfer");

    expect(h.enqueuePaymentConfirm).not.toHaveBeenCalled();
  });
});
