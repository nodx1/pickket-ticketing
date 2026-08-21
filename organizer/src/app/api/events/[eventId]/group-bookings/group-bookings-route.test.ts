import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

/**
 * W5-COMMERCE — 단체예약 승인/거절 회귀.
 *
 * 여기서 고정하는 것(🔴 = 금전):
 *   1. 🔴 단가를 v2 티어에서 못 읽으면(`product_price: null`) **0원으로 승인하지 않는다** — 409.
 *   2. 승인 금액 = 단가 × 인원 × (1 − 할인율), 주문 생성에 그대로 전달된다.
 *   3. 주문 생성 **후** 예약을 확정한다. 확정 실패 시 재시도가 같은 멱등키로 같은 주문을
 *      재생하므로 중복 발권이 없다.
 *   4. 이미 승인/거절된 예약의 재승인은 주문을 만들기 전에 409 로 끊는다.
 *   5. v2 장애는 503(400/500 뭉개기 금지).
 */

const stubSession = { id: "u-1", accountId: "acct-1", role: "organizer" };
vi.mock("@/lib/auth/permissions", () => ({
  withRole:
    (
      _role: string,
      handler: (
        req: NextRequest,
        ctx: { session: typeof stubSession; params: { eventId: string; bookingId: string } },
      ) => Promise<Response>,
    ) =>
    (req: NextRequest) =>
      handler(req, {
        session: stubSession,
        params: { eventId: "event-1", bookingId: "booking-1" },
      }),
}));

vi.mock("@/lib/server/require-feature", () => ({ requireFeature: async () => null }));

const {
  getGroupBooking,
  patchGroupBooking,
  cancelOrder,
  refundOrder,
  V2CommerceError,
  createOrder,
  requireOwnedEvent,
  EventAccessError,
  query,
} = vi.hoisted(() => {
  class V2CommerceError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly body?: string,
    ) {
      super(message);
      this.name = "V2CommerceError";
    }
  }
  class EventAccessError extends Error {
    constructor(
      message: string,
      readonly reason: "not_found" | "unavailable",
      readonly status: number,
    ) {
      super(message);
      this.name = "EventAccessError";
    }
  }
  return {
    getGroupBooking: vi.fn(),
    patchGroupBooking: vi.fn(),
    cancelOrder: vi.fn(),
    refundOrder: vi.fn(),
    V2CommerceError,
    EventAccessError,
    createOrder: vi.fn(),
    requireOwnedEvent: vi.fn(),
    query: vi.fn(),
  };
});

vi.mock("@/lib/v2/commerce-client", () => ({
  getGroupBooking,
  patchGroupBooking,
  cancelOrder,
  refundOrder,
  V2CommerceError,
}));
vi.mock("@/lib/v2/event-access", () => ({ requireOwnedEvent, EventAccessError }));
vi.mock("@/lib/server/orders", () => ({ createOrder }));
vi.mock("@/lib/db/pool", () => ({ getPool: () => ({ query }) }));

const { PATCH } = await import("@/app/api/events/[eventId]/group-bookings/[bookingId]/route");

const ctx = { params: Promise.resolve({ eventId: "event-1", bookingId: "booking-1" }) };

function req(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

const BOOKING = {
  booking_id: "booking-1",
  event_id: "event-1",
  product_ref: "prod-1",
  product_name: "단체권",
  product_price: 10000,
  order_ref: null as string | null,
  order_number: null as string | null,
  organization_name: "테스트 학교",
  contact_name: "김담당",
  contact_email: "group@test.com",
  contact_phone: null,
  attendee_count: 20,
  discount_rate: 0,
  notes: null,
  rejection_reason: null,
  approved_by_ref: null,
  approved_at: null,
  status: "pending" as "pending" | "confirmed" | "cancelled",
  created_at: "2026-07-01T00:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  requireOwnedEvent.mockResolvedValue({ event_id: "v2-ev-1" });
  getGroupBooking.mockResolvedValue({ ...BOOKING });
  patchGroupBooking.mockResolvedValue({ ...BOOKING, status: "confirmed" });
  createOrder.mockResolvedValue({ id: "go-order-1", orderNumber: "ORD-1" });
  query.mockResolvedValue({ rows: [] });
});

describe("단체예약 승인 — 금액", () => {
  it("단가 × 인원 × (1−할인율) 을 주문 금액으로 전달한다", async () => {
    const res = await PATCH(req({ status: "confirmed", discountRate: 10 }), ctx);
    expect(res.status).toBe(200);
    // 10000 × 20 = 200,000 → 10% 할인 → 180,000
    expect(createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        paidAmount: 180000,
        totalAmountOverride: 180000,
        idempotencyToken: "group-booking:event-1:booking-1",
      }),
    );
  });

  it("🔴 단가를 못 읽으면(product_price=null) 0원 승인이 아니라 409 — 주문을 만들지 않는다", async () => {
    getGroupBooking.mockResolvedValue({ ...BOOKING, product_price: null });
    const res = await PATCH(req({ status: "confirmed" }), ctx);
    expect(res.status).toBe(409);
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("주문 생성 후 예약을 확정한다(순서 — 부분커밋이 중복 발권이 되지 않게)", async () => {
    const order: string[] = [];
    createOrder.mockImplementation(async () => {
      order.push("createOrder");
      return { id: "go-order-1", orderNumber: "ORD-1" };
    });
    patchGroupBooking.mockImplementation(async () => {
      order.push("patchBooking");
      return { ...BOOKING, status: "confirmed" };
    });
    await PATCH(req({ status: "confirmed" }), ctx);
    expect(order).toEqual(["createOrder", "patchBooking"]);
    expect(patchGroupBooking).toHaveBeenCalledWith("v2-ev-1", "booking-1", {
      status: "confirmed",
      discount_rate: 0,
      order_ref: "go-order-1",
      order_number: "ORD-1",
      approved_by_ref: "u-1",
    });
  });
});

describe("단체예약 상태 전이 가드", () => {
  it("이미 승인된 예약 재승인은 409 이고 주문을 만들지 않는다", async () => {
    getGroupBooking.mockResolvedValue({ ...BOOKING, status: "confirmed" });
    const res = await PATCH(req({ status: "confirmed" }), ctx);
    expect(res.status).toBe(409);
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("거절된 예약은 다시 승인할 수 없다(409)", async () => {
    getGroupBooking.mockResolvedValue({ ...BOOKING, status: "cancelled" });
    const res = await PATCH(req({ status: "confirmed" }), ctx);
    expect(res.status).toBe(409);
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("v2 가 전이를 거부(409)하면 그대로 409 로 노출한다(동시 승인 레이스)", async () => {
    patchGroupBooking.mockRejectedValue(new V2CommerceError("conflict", 409));
    const res = await PATCH(req({ status: "confirmed" }), ctx);
    expect(res.status).toBe(409);
  });
});

describe("단체예약 거절 — 주문 취소/환불 선행", () => {
  it("연결 주문이 결제완료면 v2 전액 환불 후 예약을 취소한다", async () => {
    getGroupBooking.mockResolvedValue({ ...BOOKING, status: "pending", order_ref: "go-order-1" });
    query.mockResolvedValue({ rows: [{ status: "completed", v2_order_id: "v2-ord-1" }] });
    refundOrder.mockResolvedValue({ status: "REFUNDED", total_refunded: 180000 });

    const res = await PATCH(req({ status: "cancelled", rejectionReason: "정원 초과" }), ctx);
    expect(res.status).toBe(200);
    expect(refundOrder).toHaveBeenCalled();
    expect(patchGroupBooking).toHaveBeenCalledWith("v2-ev-1", "booking-1", {
      status: "cancelled",
      rejection_reason: "정원 초과",
    });
  });

  it("미결제 주문이면 취소 경로를 탄다", async () => {
    getGroupBooking.mockResolvedValue({ ...BOOKING, status: "pending", order_ref: "go-order-1" });
    query.mockResolvedValue({ rows: [{ status: "pending", v2_order_id: "v2-ord-1" }] });
    cancelOrder.mockResolvedValue({ status: "CANCELLED" });

    const res = await PATCH(req({ status: "cancelled" }), ctx);
    expect(res.status).toBe(200);
    expect(cancelOrder).toHaveBeenCalled();
    expect(refundOrder).not.toHaveBeenCalled();
  });

  it("🔴 v2 환불이 실패하면 예약을 취소 처리하지 않는다(부분커밋 금지)", async () => {
    getGroupBooking.mockResolvedValue({ ...BOOKING, status: "pending", order_ref: "go-order-1" });
    query.mockResolvedValue({ rows: [{ status: "completed", v2_order_id: "v2-ord-1" }] });
    refundOrder.mockRejectedValue(new V2CommerceError("down", 500));

    const res = await PATCH(req({ status: "cancelled" }), ctx);
    expect(res.status).toBe(502);
    expect(patchGroupBooking).not.toHaveBeenCalled();
  });
});

describe("fail-closed", () => {
  it("미소유 이벤트는 404", async () => {
    requireOwnedEvent.mockRejectedValue(new EventAccessError("없음", "not_found", 404));
    const res = await PATCH(req({ status: "confirmed" }), ctx);
    expect(res.status).toBe(404);
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("v2 장애는 503", async () => {
    requireOwnedEvent.mockRejectedValue(new EventAccessError("불가", "unavailable", 502));
    const res = await PATCH(req({ status: "confirmed" }), ctx);
    expect(res.status).toBe(503);
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("예약 조회 실패(v2 5xx)는 503 이고 주문을 만들지 않는다", async () => {
    getGroupBooking.mockRejectedValue(new V2CommerceError("down", 500));
    const res = await PATCH(req({ status: "confirmed" }), ctx);
    expect(res.status).toBe(503);
    expect(createOrder).not.toHaveBeenCalled();
  });
});
