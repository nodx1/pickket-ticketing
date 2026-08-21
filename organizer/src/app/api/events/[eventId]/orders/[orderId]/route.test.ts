/**
 * 주문 PATCH — 환불 게이트·멱등키 회귀 (적대 감사 F-2).
 *
 * 🔴 이 라우트는 **테스트 파일 자체가 없었다**. 감사가 ① 입장 게이트를 `if (false)` 로
 *    무력화하고 ② 멱등키를 옛 체계로 되돌리는 뮤테이션을 넣었는데 1220개 테스트가
 *    **전부 통과**했다. 아래는 그 두 뮤테이션을 잡는 단언들이다 — 지우지 말 것.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  query: vi.fn(),
  getOrder: vi.fn(),
  refundOrder: vi.fn(),
  cancelOrder: vi.fn(),
  getOrderDetail: vi.fn(),
}));

vi.mock("@/lib/auth/permissions", () => ({
  withRole:
    (_role: string, handler: (request: Request, ctx: unknown) => Promise<Response>) =>
    (request: Request) =>
      handler(request, {
        session: { id: "user-1", accountId: "account-1", role: "organizer" },
        params: { eventId: "event-1", orderId: "go-order-1" },
      }),
}));
vi.mock("@/lib/db/pool", () => ({ getPool: () => ({ query: h.query }) }));
vi.mock("@/lib/server/orders", () => ({ getOrderDetail: h.getOrderDetail }));
vi.mock("@/lib/v2/commerce-client", () => {
  class V2CommerceError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return {
    getOrder: h.getOrder,
    refundOrder: h.refundOrder,
    cancelOrder: h.cancelOrder,
    V2CommerceError,
  };
});
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

function ticket(over: Record<string, unknown> = {}) {
  return { ticket_id: "t-1", status: "active", checked_in_at: null, ...over };
}

async function patchOrder(body: Record<string, unknown>) {
  const { PATCH } = await import("./route");
  const req = new Request("http://localhost/api/events/event-1/orders/go-order-1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return PATCH(req as never, { params: Promise.resolve({}) } as never);
}

describe("주문 PATCH — 환불 경로", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.query.mockResolvedValue({
      rows: [{ status: "completed", v2_order_id: "v2-order-1" }],
      rowCount: 1,
    });
    h.getOrderDetail.mockResolvedValue({ id: "go-order-1" });
    h.refundOrder.mockResolvedValue({ status: "refunded", total_refunded: 30000 });
    h.getOrder.mockResolvedValue({
      order_id: "v2-order-1",
      paid_amount: 30000,
      total_refunded: 0,
      tickets: [ticket()],
    });
  });

  // 🔴 뮤테이션 ①: 게이트를 `if (false)` 로 없애면 이 테스트가 죽어야 한다.
  it("입장한 티켓이 있으면 409 — 정본 환불 라우트와 같은 게이트", async () => {
    h.getOrder.mockResolvedValue({
      order_id: "v2-order-1",
      paid_amount: 30000,
      total_refunded: 0,
      tickets: [ticket({ status: "used", checked_in_at: "2026-08-20T01:00:00Z" })],
    });

    const res = await patchOrder({ status: "refunded" });

    expect(res.status).toBe(409);
    expect(h.refundOrder).not.toHaveBeenCalled();
  });

  it("예외 승인은 사유가 있어야 통과한다", async () => {
    h.getOrder.mockResolvedValue({
      order_id: "v2-order-1",
      paid_amount: 30000,
      total_refunded: 0,
      tickets: [ticket({ status: "used", checked_in_at: "2026-08-20T01:00:00Z" })],
    });

    const noReason = await patchOrder({ status: "refunded", allowAdmitted: true });
    expect(noReason.status).toBe(400);
    expect(h.refundOrder).not.toHaveBeenCalled();

    const withReason = await patchOrder({
      status: "refunded",
      allowAdmitted: true,
      reason: "우천 취소",
    });
    expect(withReason.status).toBe(200);
    expect(h.refundOrder).toHaveBeenCalledWith(
      "v2-order-1",
      expect.objectContaining({ allow_admitted: true }),
      expect.anything(),
    );
  });

  // 🔴 뮤테이션 ②: 멱등키를 옛 `:{status}:{amount}` 로 되돌리면 이 테스트가 죽어야 한다.
  //    두 환불 경로가 같은 키 체계를 써야 v2 가 같은 환불로 인식한다.
  it("멱등키는 주문 + 목표 누적환불액 체계다", async () => {
    await patchOrder({ status: "partially_refunded", refundAmount: 10000 });

    expect(h.refundOrder).toHaveBeenCalledWith(
      "v2-order-1",
      expect.anything(),
      expect.objectContaining({ idempotencyKey: "go-refund:go-order-1:10000" }),
    );
  });

  it("전액환불 멱등키는 결제액 기준", async () => {
    await patchOrder({ status: "refunded" });

    expect(h.refundOrder).toHaveBeenCalledWith(
      "v2-order-1",
      expect.objectContaining({ full: true }),
      expect.objectContaining({ idempotencyKey: "go-refund:go-order-1:30000" }),
    );
  });

  it("이미 환불된 금액 위에 부분환불하면 목표액이 누적된다", async () => {
    h.getOrder.mockResolvedValue({
      order_id: "v2-order-1",
      paid_amount: 30000,
      total_refunded: 10000,
      tickets: [ticket()],
    });

    await patchOrder({ status: "partially_refunded", refundAmount: 5000 });

    expect(h.refundOrder).toHaveBeenCalledWith(
      "v2-order-1",
      expect.anything(),
      expect.objectContaining({ idempotencyKey: "go-refund:go-order-1:15000" }),
    );
  });

  /**
   * 🔴 2026-07-31 — 코덱스 감사 P0-1 의 **잔여분**. 감사는 정본 환불 라우트만 지적했고
   * 거기만 고쳐졌는데, 이 경로에도 같은 구멍이 있었다.
   *
   * v2 는 `is_full` 또는 `cancel_all` 일 때만 티켓·좌석을 푼다. `status:"refunded"` 에
   * 금액을 지정하면 `isFull=false` 라 `amount` 로 나가고, **주문은 환불 종결인데
   * 티켓은 ACTIVE·좌석은 SOLD** 로 남는다 — 환불받은 손님이 그대로 입장한다.
   */
  it("🔴 status=refunded + 금액지정 → cancel_all 로 티켓·좌석을 함께 해제한다", async () => {
    h.getOrder.mockResolvedValue({
      order_id: "v2-order-1",
      paid_amount: 25000,
      total_refunded: 0,
      tickets: [ticket()],
    });

    // 🔴 잔액을 남긴 종결은 **명시 의사표시**가 있어야 통과한다(적대검수 H1).
    await patchOrder({
      status: "refunded",
      refundAmount: 17500,
      closeRemainder: true,
      reason: "수수료 차감",
    });

    expect(h.refundOrder).toHaveBeenCalledWith(
      "v2-order-1",
      expect.objectContaining({ amount: 17500, cancel_all: true }),
      expect.anything(),
    );
  });

  /**
   * 🔴 v2 는 `cancel_all` 이면 주문을 **REFUNDED(종결)** 로 확정하고, REFUNDED 는
   * `_REFUNDABLE` 에 없다 — 잔액이 남아 있어도 **다시 환불할 수 없다.**
   * 50,000원 주문에 `refundAmount:1000` 오타 하나면 손님은 돈도 티켓도 잃는다.
   * 이 경로는 `withRole("organizer")` 라 **발주처 팀원(manager)** 도 호출할 수 있다.
   */
  it("🔴 잔액을 남긴 채 종결하려 하면 400 — v2 를 부르지 않는다", async () => {
    h.getOrder.mockResolvedValue({
      order_id: "v2-order-1",
      paid_amount: 50000,
      total_refunded: 0,
      tickets: [ticket()],
    });

    const res = await patchOrder({ status: "refunded", refundAmount: 1000 });

    expect(res.status).toBe(400);
    expect(h.refundOrder).not.toHaveBeenCalled();
  });

  it("잔액이 0이면 의사표시 없이도 통과한다 — 전액을 금액으로 명시한 경우", async () => {
    h.getOrder.mockResolvedValue({
      order_id: "v2-order-1",
      paid_amount: 25000,
      total_refunded: 0,
      tickets: [ticket()],
    });

    await patchOrder({ status: "refunded", refundAmount: 25000 });

    expect(h.refundOrder).toHaveBeenCalledWith(
      "v2-order-1",
      expect.objectContaining({ amount: 25000, cancel_all: true }),
      expect.anything(),
    );
  });

  it("partially_refunded 는 진짜 부분환불이므로 cancel_all 을 켜지 않는다", async () => {
    h.getOrder.mockResolvedValue({
      order_id: "v2-order-1",
      paid_amount: 30000,
      total_refunded: 0,
      tickets: [ticket()],
    });

    await patchOrder({ status: "partially_refunded", refundAmount: 5000 });

    expect(h.refundOrder).toHaveBeenCalledWith(
      "v2-order-1",
      expect.objectContaining({ amount: 5000, cancel_all: false }),
      expect.anything(),
    );
  });

  // 🔴 T20b: v2 는 status 를 안 받고 `amount is None → 전액환불` 이다.
  //    partially_refunded + 금액누락을 통과시키면 **부분 환불 요청이 전액환불로 집행**된다.
  //    (게다가 `{amount: undefined}` 는 JSON 직렬화에서 키째 사라져 "둘 다 없음"이 된다.)
  it("partially_refunded + 금액누락 → 400, v2 를 부르지 않는다", async () => {
    const res = await patchOrder({ status: "partially_refunded" });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("금액");
    expect(h.refundOrder).not.toHaveBeenCalled();
  });

  it("전액환불은 status=refunded 로 명시할 때만 — 그 경로는 그대로 통과", async () => {
    const res = await patchOrder({ status: "refunded" });

    expect(res.status).toBe(200);
    expect(h.refundOrder).toHaveBeenCalledWith(
      "v2-order-1",
      expect.objectContaining({ full: true }),
      expect.anything(),
    );
  });

  // 🔴 F-9: 비-JSON 본문이 500 이 아니라 400 이어야 한다.
  it("본문이 JSON 이 아니면 400", async () => {
    const { PATCH } = await import("./route");
    const req = new Request("http://localhost/api/events/event-1/orders/go-order-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "not-json{",
    });
    const res = await PATCH(req as never, { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(400);
  });
});
