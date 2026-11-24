/**
 * 피켓에서 결제한 주문(go orders 행 없음, v2 에만 있음)을 피켓고 주문 상세가 연다.
 *
 * 🔴 2026-11-24 나이스 실결제 시험: 주문 목록은 v2 에서 읽어 피켓 주문의 링크가 v2 order_id 인데,
 *    상세는 go orders 만 찾아 목록으로 튕겼다 → 피켓고에서 그 주문을 보거나 환불할 수 없었다.
 * 🔴 v2 내부 주문 조회는 주최자 스코프가 없다 — **남의 이벤트 주문은 열리면 안 된다.**
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  getOrder: vi.fn(),
  resolveOwnedV2EventId: vi.fn(),
  class_V2CommerceError: class V2CommerceError extends Error {
    constructor(message: string, readonly status: number) {
      super(message);
    }
  },
  class_EventAccessError: class EventAccessError extends Error {},
}));

vi.mock("@/lib/db/pool", () => ({ getPool: () => ({ query: h.poolQuery }) }));
vi.mock("@/lib/v2/commerce-client", () => ({
  createOrder: vi.fn(),
  listTierCatalog: vi.fn(),
  getOrder: (...a: unknown[]) => h.getOrder(...a),
  V2CommerceError: h.class_V2CommerceError,
}));
vi.mock("@/lib/v2/event-access", () => ({
  requireOwnedEvent: vi.fn(),
  resolveOwnedV2EventId: (...a: unknown[]) => h.resolveOwnedV2EventId(...a),
  EventAccessError: h.class_EventAccessError,
}));
vi.mock("@/lib/payment/confirm-v2", () => ({ recordPaymentConfirmOutbox: vi.fn() }));
vi.mock("@/lib/queue/payment-confirm-queue", () => ({ enqueuePaymentConfirm: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { findV2OnlyOrder, getOrderDetail } from "@/lib/server/orders";

const ACC = "account-1";
const EVT = "11111111-1111-4111-8111-111111111111";
const ORDER = "22222222-2222-4222-8222-222222222222";
const TICKET = "33333333-3333-4333-8333-333333333333";

function v2Order(over: Record<string, unknown> = {}) {
  return {
    order_id: ORDER,
    external_order_id: null,
    order_number: "ORD-20261124-0001",
    event_id: EVT,
    buyer: { name: "응모자1", email: "fan@example.com", phone: null },
    status: "refunded",
    status_v2: "refunded",
    total_amount: 1000,
    total_refunded: 1000,
    paid_amount: 1000,
    platform_fee: null,
    net_amount: null,
    payment_method: "nicepay",
    has_pg_payment: true,
    is_invitation: false,
    is_manual_issue: false,
    ordered_at: "2026-11-24T06:44:00Z",
    items: [{ tier_id: "tier-1", external_ref: null, product_name: "일반", quantity: 1, unit_price: 1000, line_amount: 1000, seat_id: null }],
    tickets: [{ ticket_id: TICKET, status: "cancelled", seat_id: null, tier_id: "tier-1", checked_in_at: null }],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // go orders·attendees 둘 다 0행 — 피켓 주문은 go 앵커가 없다.
  h.poolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  h.resolveOwnedV2EventId.mockResolvedValue(EVT);
  h.getOrder.mockResolvedValue(v2Order());
});

describe("getOrderDetail — 피켓에서 결제한 주문", () => {
  it("go 앵커가 없으면 v2 주문으로 상세를 만든다(구매자·금액·항목·표)", async () => {
    const detail = await getOrderDetail(ACC, EVT, ORDER);

    expect(detail).not.toBeNull();
    expect(detail).toMatchObject({
      source: "v2",
      id: ORDER,
      orderNumber: "ORD-20261124-0001",
      buyerName: "응모자1",
      status: "refunded",
      paidAmount: 1000,
      refundAmount: 1000,
      paymentMethod: "nicepay",
      v2OrderId: ORDER,
      hasPgPayment: true,
    });
    expect(detail!.items).toHaveLength(1);
    expect(detail!.attendees).toEqual([
      expect.objectContaining({ id: TICKET, ticketNumber: "TKT-333333333333", status: "cancelled" }),
    ]);
    // 이미 읽은 v2 주문을 다시 읽지 않는다.
    expect(h.getOrder).toHaveBeenCalledTimes(1);
  });

  it("결제 전 주문은 결제금액을 0 으로 보인다(v2 paid_amount 는 결제 전에도 총액과 같다)", async () => {
    h.getOrder.mockResolvedValue(v2Order({ status: "pending", total_refunded: 0 }));

    const detail = await getOrderDetail(ACC, EVT, ORDER);
    expect(detail?.paidAmount).toBe(0);
  });

  it("🔴 다른 이벤트의 주문이면 열지 않는다(v2 조회는 주최자 스코프가 없다)", async () => {
    h.getOrder.mockResolvedValue(v2Order({ event_id: "99999999-9999-4999-8999-999999999999" }));

    expect(await getOrderDetail(ACC, EVT, ORDER)).toBeNull();
  });

  it("🔴 이 계정 소유 이벤트가 아니면 v2 주문을 읽지도 않는다", async () => {
    h.resolveOwnedV2EventId.mockResolvedValue(null);

    expect(await getOrderDetail(ACC, EVT, ORDER)).toBeNull();
    expect(h.getOrder).not.toHaveBeenCalled();
  });

  it("go 앵커가 있으면 종전대로 go 주문을 쓴다(v2 직접 조회로 가지 않는다)", async () => {
    h.poolQuery
      .mockResolvedValueOnce({
        rows: [{ id: "go-order-1", orderNumber: "ORD-GO", status: "completed", v2OrderId: null }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const detail = await getOrderDetail(ACC, EVT, "go-order-1");
    expect(detail?.source).toBe("go");
    expect(h.resolveOwnedV2EventId).not.toHaveBeenCalled();
  });
});

describe("findV2OnlyOrder", () => {
  it("UUID 가 아니면 v2 를 부르지 않고 null", async () => {
    expect(await findV2OnlyOrder(ACC, EVT, "ORD-1")).toBeNull();
    expect(h.resolveOwnedV2EventId).not.toHaveBeenCalled();
  });

  it("v2 404 는 없는 주문(null), 그 밖의 v2 오류는 던진다", async () => {
    h.getOrder.mockRejectedValueOnce(new h.class_V2CommerceError("not found", 404));
    expect(await findV2OnlyOrder(ACC, EVT, ORDER)).toBeNull();

    h.getOrder.mockRejectedValueOnce(new h.class_V2CommerceError("down", 503));
    await expect(findV2OnlyOrder(ACC, EVT, ORDER)).rejects.toThrow("down");
  });
});
