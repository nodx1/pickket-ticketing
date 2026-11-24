/**
 * 피켓에서 결제한 주문(go orders 행 없음)도 피켓고 「환불」로 처리된다.
 * 소유 확인은 findV2OnlyOrder 가 한다(이벤트 소유 + 주문이 그 이벤트 것).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORDER = "22222222-2222-4222-8222-222222222222";

const h = vi.hoisted(() => ({
  getOrder: vi.fn(),
  refundOrder: vi.fn(),
  query: vi.fn(),
  getEventForRefund: vi.fn(),
  getOwnedEvent: vi.fn(),
  findV2OnlyOrder: vi.fn(),
}));

vi.mock("@/lib/auth/permissions", () => ({
  withRole:
    (_role: string, handler: (request: Request, ctx: unknown) => Promise<Response>) =>
    (request: Request) =>
      handler(request, {
        session: { id: "user-1", accountId: "account-1", role: "organizer" },
        params: { eventId: "event-1", orderId: "22222222-2222-4222-8222-222222222222" },
      }),
}));
vi.mock("@/lib/db/pool", () => ({ getPool: () => ({ query: h.query }) }));
vi.mock("@/lib/v2/commerce-client", () => {
  class V2CommerceError extends Error {
    constructor(message: string, readonly status: number) {
      super(message);
    }
  }
  return { getOrder: h.getOrder, refundOrder: h.refundOrder, V2CommerceError };
});
vi.mock("@/lib/v2/event-access", () => {
  class EventAccessError extends Error {}
  return { EventAccessError, getOwnedEvent: h.getOwnedEvent };
});
vi.mock("@/lib/server/orders", () => ({ findV2OnlyOrder: h.findV2OnlyOrder }));
vi.mock("@/lib/refund/policy", () => ({
  getEventForRefund: h.getEventForRefund,
  refundPolicyErrorStatus: () => null,
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/notifications/create", () => ({ notifyRefundRequest: vi.fn() }));
vi.mock("@/lib/webhook/dispatcher", () => ({ dispatchWebhook: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

async function callRefund() {
  const { POST } = await import("./route");
  const req = new Request(`http://localhost/api/events/event-1/orders/${ORDER}/refund`, { method: "POST" });
  return POST(req as never, { params: Promise.resolve({}) } as never);
}

const v2Order = {
  order_id: ORDER,
  order_number: "ORD-20261124-0001",
  status: "completed",
  paid_amount: 1000,
  total_refunded: 0,
  tickets: [{ ticket_id: "t-1", status: "active", seat_id: null, tier_id: "tier-1", checked_in_at: null }],
};

describe("환불 — 피켓에서 결제한 주문", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.query.mockResolvedValue({ rows: [], rowCount: 0 }); // go 앵커 없음
    h.getOwnedEvent.mockResolvedValue({ event_id: "event-1", event_date: "2099-12-31T07:00:00Z" });
    h.getEventForRefund.mockResolvedValue({ cancellation_fee_tiers: null });
    h.getOrder.mockResolvedValue(v2Order);
    h.refundOrder.mockResolvedValue({ status: "refunded", total_refunded: 1000, refunded: 1000, seats_released: 0 });
  });

  it("go 앵커가 없으면 v2 주문으로 환불한다", async () => {
    h.findV2OnlyOrder.mockResolvedValue(v2Order);

    const res = await callRefund();

    expect(res.status).toBe(200);
    expect(h.findV2OnlyOrder).toHaveBeenCalledWith("account-1", "event-1", ORDER);
    expect(h.refundOrder).toHaveBeenCalledWith(ORDER, expect.objectContaining({ full: true }), expect.anything());
  });

  it("이 이벤트 주문이 아니면 404 이고 환불을 부르지 않는다", async () => {
    h.findV2OnlyOrder.mockResolvedValue(null);

    const res = await callRefund();

    expect(res.status).toBe(404);
    expect(h.refundOrder).not.toHaveBeenCalled();
  });

  it("이미 환불된 주문이면 400 이다(v2 상태를 그대로 본다)", async () => {
    h.findV2OnlyOrder.mockResolvedValue({ ...v2Order, status: "refunded" });

    const res = await callRefund();

    expect(res.status).toBe(400);
    expect(h.refundOrder).not.toHaveBeenCalled();
  });
});
