import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 구매자 **즉시환불** — 돈이 나가는 경로의 계약 회귀.
 *
 * 🔴 여기서 지켜야 하는 것은 세 가지다:
 *   ① `full: true` 만 보낸다 — `amount` 를 보내면 v2 의 이중집행 방어가 무력해진다
 *      (전액환불만 `with_for_update()` 로 막힌다. 부분은 갱신된 잔여액으로 재검증을 통과해
 *       같은 델타가 두 번 나간다.) **이것이 돈의 마지막 방어선이다.**
 *   ② `allow_admitted` 를 절대 안 보낸다 — 입장자 환불 강행이 된다
 *   ③ 실패를 성공으로 위장하지 않는다
 */
const h = vi.hoisted(() => {
  class MockV2CommerceError extends Error {
    constructor(message: string, readonly status: number) { super(message); this.name = "V2CommerceError"; }
  }
  return {
    getOrderByExternalRef: vi.fn(),
    refundOrder: vi.fn(),
    resolvePublicEventById: vi.fn(),
    verifyPublicLookupToken: vi.fn(() => ({ email: "buyer@example.com", phone: "01011112222" })),
    matchesPublicLookup: vi.fn(() => true),
    notifyRefundRequest: vi.fn(),
    query: vi.fn(),
    clientQuery: vi.fn(),
    release: vi.fn(),
    MockV2CommerceError,
  };
});

vi.mock("@/lib/db/pool", () => ({
  getPool: () => ({
    query: h.query,
    connect: async () => ({ query: h.clientQuery, release: h.release }),
  }),
}));
vi.mock("@/lib/v2/commerce-client", () => ({
  V2CommerceError: h.MockV2CommerceError,
  getOrderByExternalRef: h.getOrderByExternalRef,
  refundOrder: h.refundOrder,
}));
vi.mock("@/lib/v2/public-event", () => ({
  PUBLIC_ANY_STATUS: [], resolvePublicEventById: h.resolvePublicEventById,
}));
vi.mock("@/lib/public-access", () => ({
  PUBLIC_LOOKUP_COOKIE: "pkt_lookup",
  verifyPublicLookupToken: h.verifyPublicLookupToken,
  matchesPublicLookup: h.matchesPublicLookup,
}));
vi.mock("@/lib/notifications/create", () => ({ notifyRefundRequest: h.notifyRefundRequest }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "c" }) }) }));
vi.mock("@/lib/auth/withRateLimit", () => ({ withRateLimit: () => (fn: unknown) => fn }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { POST as submitRefund } from "./route";

const GO_ORDER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const V2_ORDER = "99999999-8888-4777-8666-555555555555";
const EVENT_DATE = "2026-08-20T07:00:00+09:00";
const TIERS = [{ days_before: 0, fee_pct: 100 }];

function req() {
  return new Request("https://go.pickket.kr/api/public/refund", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      orderId: GO_ORDER, buyerEmail: "buyer@example.com",
      buyerPhone: "01011112222", reason: "개인사정",
    }),
  });
}

function v2OrderFixture(over: Record<string, unknown> = {}) {
  return {
    order_id: V2_ORDER, order_number: "ORD-260731-002", event_id: "ev-1",
    paid_amount: 15000, total_refunded: 0,
    buyer: { email: "buyer@example.com", phone: "01011112222" },
    tickets: [{ ticket_id: "t1", status: "active", checked_in_at: null, seat_id: null, tier_id: null }],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-10T12:00:00+09:00"));   // 전액환불 구간
  h.getOrderByExternalRef.mockResolvedValue(v2OrderFixture());
  h.resolvePublicEventById.mockResolvedValue({
    ok: true, event: { event_date: EVENT_DATE, cancellation_fee_tiers: TIERS },
  });
  h.refundOrder.mockResolvedValue({ status: "refunded", refunded: 15000, total_refunded: 15000, seats_released: 1 });
  h.clientQuery.mockImplementation(async (sql: string) => {
    if (sql.includes("FOR UPDATE")) return { rows: [{ id: GO_ORDER, account_id: "acc-1", event_id: "ev-1" }] };
    if (sql.includes("FROM refund_requests")) return { rows: [] };          // 중복 없음
    if (sql.includes("INSERT INTO refund_requests")) return { rows: [{ id: "req-1" }] };
    return { rows: [] };
  });
  h.query.mockResolvedValue({ rows: [] });
});

describe("즉시 집행", () => {
  it("🔴 전액·미입장이면 v2 환불을 즉시 호출하고 completed 를 돌려준다", async () => {
    const res = await submitRefund(req());
    expect(res.status).toBe(200);
    expect((await res.json()).data.status).toBe("completed");
    expect(h.refundOrder).toHaveBeenCalledTimes(1);
  });

  it("🔴 첫 인자는 **v2 order_id** 다 (go id 를 넘기면 404 난다)", async () => {
    await submitRefund(req());
    expect(h.refundOrder.mock.calls[0][0]).toBe(V2_ORDER);
    expect(h.refundOrder.mock.calls[0][0]).not.toBe(GO_ORDER);
  });

  it("🔴 `full: true` 만 보낸다 — amount 를 보내면 이중집행 방어가 무력해진다", async () => {
    await submitRefund(req());
    const payload = h.refundOrder.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.full).toBe(true);
    expect(payload).not.toHaveProperty("amount");
    expect(payload).not.toHaveProperty("cancel_all");
  });

  it("🔴 `allow_admitted` 를 절대 보내지 않는다 (입장자 환불 강행 방지)", async () => {
    await submitRefund(req());
    const payload = h.refundOrder.mock.calls[0][1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("allow_admitted");
    expect(payload).not.toHaveProperty("pg_already_voided");
  });

  it("go 앵커를 refunded 로 투영한다", async () => {
    await submitRefund(req());
    const upd = h.query.mock.calls.filter((c) => String(c[0]).includes("UPDATE orders"));
    expect(upd).toHaveLength(1);
  });
});

describe("차단", () => {
  it("🔴 입장한 티켓은 즉시환불하지 않는다", async () => {
    h.getOrderByExternalRef.mockResolvedValue(v2OrderFixture({
      tickets: [{ ticket_id: "t1", status: "used", checked_in_at: "2026-08-20T09:00:00Z", seat_id: null, tier_id: null }],
    }));
    const res = await submitRefund(req());
    expect(res.status).toBe(409);
    expect(h.refundOrder).not.toHaveBeenCalled();
  });

  it("🔴 환불 불가 시점(당일)에는 v2 를 부르지 않는다", async () => {
    vi.setSystemTime(new Date("2026-08-20T00:00:00+09:00"));
    const res = await submitRefund(req());
    expect(res.status).toBe(400);
    expect(h.refundOrder).not.toHaveBeenCalled();
  });

  it("🔴 동시 제출 — 이미 처리중이면 두 번째는 집행하지 않는다", async () => {
    h.clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FOR UPDATE")) return { rows: [{ id: GO_ORDER, account_id: "acc-1", event_id: "ev-1" }] };
      if (sql.includes("FROM refund_requests")) return { rows: [{ id: "already" }] };   // 선점됨
      return { rows: [] };
    });
    const res = await submitRefund(req());
    expect(res.status).toBe(409);
    expect(h.refundOrder).not.toHaveBeenCalled();
  });

  it("🔴 주문 행 잠금이 실제로 걸린다(FOR UPDATE)", async () => {
    await submitRefund(req());
    const locked = h.clientQuery.mock.calls.filter((c) => String(c[0]).includes("FOR UPDATE"));
    expect(locked).toHaveLength(1);
  });
});

describe("실패 처리", () => {
  it("🔴 PG 실패를 성공으로 위장하지 않는다", async () => {
    h.refundOrder.mockRejectedValue(new h.MockV2CommerceError("PG_REFUND_FAILED", 502));
    h.getOrderByExternalRef.mockResolvedValue(v2OrderFixture());   // 재조회도 미변동
    const res = await submitRefund(req());
    expect(res.status).toBe(502);
    const upd = h.query.mock.calls.filter((c) => String(c[0]).includes("UPDATE orders"));
    expect(upd).toHaveLength(0);                                    // go 투영 안 함
  });

  it("🔴 실패는 manual_review 로 남긴다 (failed 면 재제출이 무한 재집행)", async () => {
    h.refundOrder.mockRejectedValue(new h.MockV2CommerceError("boom", 502));
    await submitRefund(req());
    const upd = h.query.mock.calls.find((c) => String(c[0]).includes("UPDATE refund_requests"));
    expect(upd?.[1]).toContain("manual_review");
  });

  it("🔴 실패 시 실재 채널(인앱)로 알린다", async () => {
    h.refundOrder.mockRejectedValue(new h.MockV2CommerceError("boom", 502));
    await submitRefund(req());
    expect(h.notifyRefundRequest).toHaveBeenCalledWith("acc-1", "ev-1", "ORD-260731-002");
  });

  it("🔴 타임아웃 후 **사실은 성공**이면 완료로 정정한다(split-brain 방지)", async () => {
    h.refundOrder.mockRejectedValue(new Error("aborted"));
    // 재조회에서 누적환불액이 올라가 있다 = v2 는 커밋했다
    h.getOrderByExternalRef
      .mockResolvedValueOnce(v2OrderFixture())
      .mockResolvedValueOnce(v2OrderFixture({ total_refunded: 15000, status: "refunded" }));
    const res = await submitRefund(req());
    expect(res.status).toBe(200);
    expect((await res.json()).data.status).toBe("completed");
  });
});
