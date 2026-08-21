/**
 * 환불 라우트 — 입장 완료 티켓 차단 회귀 (2026-07-28 prod 실측 결함).
 *
 * prod E2E 에서 체크인해 `used` 가 된 티켓 2장이 그대로 환불돼 `cancelled` 이 됐다.
 * 관람을 마친 입장권을 환불하면 매출이 새고 재고까지 되돌아간다(초과판매).
 *
 * 🔴 게이트가 **v2 호출 전**에 걸려야 한다. 뒤에서 막으면 PG 취소는 끝났는데 원장만
 *    안 바뀌는 부분성공이 되고, 이 프로젝트에서 반복해서 터진 유형이 정확히 그것이다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  getOrder: vi.fn(),
  refundOrder: vi.fn(),
  query: vi.fn(),
  getEventForRefund: vi.fn(),
  getOwnedEvent: vi.fn(),
}));

vi.mock("@/lib/auth/permissions", () => ({
  withRole:
    (_role: string, handler: (request: Request, ctx: unknown) => Promise<Response>) =>
    (request: Request) =>
      handler(request, {
        session: { accountId: "account-1", role: "organizer" },
        params: { eventId: "event-1", orderId: "go-order-1" },
      }),
}));
vi.mock("@/lib/db/pool", () => ({ getPool: () => ({ query: h.query }) }));
vi.mock("@/lib/v2/commerce-client", () => {
  class V2CommerceError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return { getOrder: h.getOrder, refundOrder: h.refundOrder, V2CommerceError };
});
vi.mock("@/lib/v2/event-access", () => {
  class EventAccessError extends Error {
    status = 404;
  }
  return { EventAccessError, getOwnedEvent: h.getOwnedEvent };
});
vi.mock("@/lib/refund/policy", () => ({
  getEventForRefund: h.getEventForRefund,
  refundPolicyErrorStatus: () => null,
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/notifications/create", () => ({ notifyRefundRequest: vi.fn() }));
vi.mock("@/lib/webhook/dispatcher", () => ({ dispatchWebhook: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

function ticket(over: Record<string, unknown> = {}) {
  return {
    ticket_id: "t-1",
    status: "active",
    seat_id: null,
    tier_id: "tier-1",
    checked_in_at: null,
    ...over,
  };
}

function v2Order(tickets: ReturnType<typeof ticket>[]) {
  return {
    order_id: "v2-order-1",
    paid_amount: 30000,
    total_refunded: 0,
    tickets,
  };
}

async function callRefund(body: Record<string, unknown> = {}) {
  const { POST } = await import("./route");
  const req = new Request("http://localhost/api/events/event-1/orders/go-order-1/refund", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return POST(req as never, { params: Promise.resolve({}) } as never);
}

describe("환불 — 입장 완료 티켓 차단", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.query.mockResolvedValue({
      rows: [{ status: "completed", orderNumber: "ORD-1", v2OrderId: "v2-order-1" }],
      rowCount: 1,
    });
    h.getOwnedEvent.mockResolvedValue({ event_id: "event-1", event_date: "2026-08-20T07:00:00Z" });
    h.getEventForRefund.mockResolvedValue({ cancellation_fee_tiers: null });
    h.refundOrder.mockResolvedValue({
      status: "refunded",
      total_refunded: 30000,
      refunded: 30000,
      seats_released: 1,
    });
  });

  it("입장한 티켓이 있으면 409 로 막고 v2 환불을 호출하지 않는다", async () => {
    h.getOrder.mockResolvedValue(
      v2Order([ticket(), ticket({ ticket_id: "t-2", status: "used", checked_in_at: "2026-08-20T01:00:00Z" })]),
    );

    const res = await callRefund();

    expect(res.status).toBe(409);
    expect(await res.text()).toContain("이미 입장한 티켓");
    // 🔴 핵심: 돈이 움직이기 전에 멈춰야 한다.
    expect(h.refundOrder).not.toHaveBeenCalled();
  });

  it("status 는 active 인데 checked_in_at 만 있어도 막는다", async () => {
    h.getOrder.mockResolvedValue(
      v2Order([ticket({ checked_in_at: "2026-08-20T01:00:00Z" })]),
    );

    const res = await callRefund();

    expect(res.status).toBe(409);
    expect(h.refundOrder).not.toHaveBeenCalled();
  });

  it("아무도 입장하지 않았으면 종전대로 환불이 진행된다", async () => {
    h.getOrder.mockResolvedValue(v2Order([ticket(), ticket({ ticket_id: "t-2" })]));

    const res = await callRefund();

    expect(res.status).toBe(200);
    expect(h.refundOrder).toHaveBeenCalledTimes(1);
  });
});

/**
 * 🔴 감사 F4 — 게이트에 **빠져나갈 문이 없으면 그것대로 사고**다.
 * v2 는 `allow_admitted` 우회를 제공하는데 호출자가 0이었다 — 우천취소로 입장객까지
 * 환불해야 하는 상황에서 운영자가 DB 를 직접 수술하는 것 외에 방법이 없었다.
 */
describe("환불 — 입장객 예외 승인", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.query.mockResolvedValue({
      rows: [{ status: "completed", orderNumber: "ORD-1", v2OrderId: "v2-order-1" }],
      rowCount: 1,
    });
    h.getOwnedEvent.mockResolvedValue({ event_id: "event-1", event_date: "2026-08-20T07:00:00Z" });
    h.getEventForRefund.mockResolvedValue({ cancellation_fee_tiers: null });
    h.refundOrder.mockResolvedValue({
      status: "refunded",
      total_refunded: 30000,
      refunded: 30000,
      seats_released: 1,
    });
    h.getOrder.mockResolvedValue(
      v2Order([ticket({ status: "used", checked_in_at: "2026-08-20T01:00:00Z" })]),
    );
  });

  it("allowAdmitted + 사유가 있으면 통과하고 v2 에 allow_admitted 를 전달한다", async () => {
    const res = await callRefund({ allowAdmitted: true, reason: "우천 취소 전원 환불" });

    expect(res.status).toBe(200);
    expect(h.refundOrder).toHaveBeenCalledWith(
      "v2-order-1",
      expect.objectContaining({ allow_admitted: true, reason: "우천 취소 전원 환불" }),
      expect.anything(),
    );
  });

  it("사유 없는 예외 승인은 거부한다 — 근거 없이 입장객을 환불할 수 없다", async () => {
    const res = await callRefund({ allowAdmitted: true });

    expect(res.status).toBe(400);
    expect(h.refundOrder).not.toHaveBeenCalled();
  });

  it("allowAdmitted 를 안 보내면 종전대로 차단 — 실수로 켜지지 않는다", async () => {
    const res = await callRefund({ reason: "그냥 환불" });

    expect(res.status).toBe(409);
    expect(h.refundOrder).not.toHaveBeenCalled();
  });

  it("입장 이력이 없으면 allow_admitted=false 로 나간다", async () => {
    h.getOrder.mockResolvedValue(v2Order([ticket()]));

    const res = await callRefund();

    expect(res.status).toBe(200);
    expect(h.refundOrder).toHaveBeenCalledWith(
      "v2-order-1",
      expect.objectContaining({ allow_admitted: false }),
      expect.anything(),
    );
  });
});

describe("환불 — 수수료 차감 주문 전체 취소", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.query.mockResolvedValue({
      rows: [{ status: "completed", orderNumber: "ORD-1", v2OrderId: "v2-order-1" }],
      rowCount: 1,
    });
    h.getOwnedEvent.mockResolvedValue({ event_id: "event-1", event_date: "2099-08-20T07:00:00Z" });
    h.getEventForRefund.mockResolvedValue({
      cancellation_fee_tiers: [{ days_before: 100000, fee_pct: 30 }],
    });
    h.getOrder.mockResolvedValue(v2Order([ticket()]));
    h.refundOrder.mockResolvedValue({
      status: "refunded",
      total_refunded: 21000,
      refunded: 21000,
      seats_released: 1,
    });
  });

  it("지급액은 수수료만큼 줄이되 cancel_all 로 티켓·좌석 해제를 지시한다", async () => {
    const res = await callRefund();

    expect(res.status).toBe(200);
    expect(h.refundOrder).toHaveBeenCalledWith(
      "v2-order-1",
      expect.objectContaining({ amount: 21000, cancel_all: true }),
      expect.anything(),
    );
  });
});
