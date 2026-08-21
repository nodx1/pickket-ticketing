import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 구매자 자력환불 **제출** 라우트 — 시점 가드 회귀.
 *
 * 🔴 종전엔 `canRefund` 검사가 **없었다**. 환불 불가 시점(KLPGA 는 행사 당일 00:00 KST
 *    부터 수수료 100%)에도 0원짜리 신청이 `pending` 으로 접수되고 "접수되었습니다" 메일까지
 *    나갔다. 반면 주최자 경로는 같은 조건을 400 으로 막는다 ⟹ **접수는 되는데 처리는
 *    불가능한 신청**이 쌓이고 손님은 접수됐다고 믿고 기다린다.
 *
 *    화면은 `canRefund` 로 버튼을 잠그고 있었지만 그건 방어가 아니다 — 직접 POST 하면
 *    그대로 통과했다. 서버가 막아야 한다.
 */
const h = vi.hoisted(() => {
  class MockV2CommerceError extends Error {
    constructor(message: string, readonly status: number) {
      super(message);
      this.name = "V2CommerceError";
    }
  }
  return {
    getOrderByExternalRef: vi.fn(),
    resolvePublicEventById: vi.fn(),
    verifyPublicLookupToken: vi.fn(() => ({ email: "buyer@example.com", phone: "01011112222" })),
    matchesPublicLookup: vi.fn(() => true),
    sendEmail: vi.fn(),
    query: vi.fn(),
    clientQuery: vi.fn(),
    refundOrder: vi.fn(),
    notifyRefundRequest: vi.fn(),
    cookieGet: vi.fn(() => ({ value: "cookie" })),
    MockV2CommerceError,
  };
});

vi.mock("@/lib/db/pool", () => ({
  getPool: () => ({
    query: h.query,
    connect: async () => ({ query: h.clientQuery, release: vi.fn() }),
  }),
}));
vi.mock("@/lib/v2/commerce-client", () => ({
  V2CommerceError: h.MockV2CommerceError,
  getOrderByExternalRef: h.getOrderByExternalRef,
  refundOrder: h.refundOrder,
}));
vi.mock("@/lib/notifications/create", () => ({ notifyRefundRequest: h.notifyRefundRequest }));
vi.mock("@/lib/v2/public-event", () => ({
  PUBLIC_ANY_STATUS: [],
  resolvePublicEventById: h.resolvePublicEventById,
}));
vi.mock("@/lib/public-access", () => ({
  PUBLIC_LOOKUP_COOKIE: "pkt_lookup",
  verifyPublicLookupToken: h.verifyPublicLookupToken,
  matchesPublicLookup: h.matchesPublicLookup,
}));
vi.mock("@/lib/notification/email", () => ({ sendEmail: h.sendEmail }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: h.cookieGet }) }));
vi.mock("@/lib/auth/withRateLimit", () => ({ withRateLimit: () => (fn: unknown) => fn }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { POST as submitRefund } from "./route";

const ORDER_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
// prod KLPGA 실설정 — 행사 당일 00:00 KST 부터 수수료 100%.
const TIERS = [{ days_before: 0, fee_pct: 100 }];
const EVENT_DATE = "2026-08-20T07:00:00+09:00";

function req() {
  return new Request("https://go.pickket.kr/api/public/refund", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      orderId: ORDER_ID,
      buyerEmail: "buyer@example.com",
      buyerPhone: "01011112222",
      reason: "개인사정",
    }),
  });
}

function at(iso: string) {
  vi.setSystemTime(new Date(iso));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  h.getOrderByExternalRef.mockResolvedValue({
    order_number: "ORD-260731-002",
    event_id: "ev-1",
    paid_amount: 15000,
    total_refunded: 0,
    buyer: { email: "buyer@example.com", phone: "01011112222" },
    order_id: "99999999-8888-4777-8666-555555555555",
    tickets: [{ ticket_id: "t1", status: "active", checked_in_at: null, seat_id: null, tier_id: null }],
  });
  h.refundOrder.mockResolvedValue({ status: "refunded", refunded: 15000, total_refunded: 15000, seats_released: 1 });
  h.notifyRefundRequest.mockResolvedValue(undefined);
  h.clientQuery.mockImplementation(async (sql: string) => {
    if (String(sql).includes("FOR UPDATE")) return { rows: [{ id: ORDER_ID, account_id: "acc-1", event_id: "ev-1" }] };
    if (String(sql).includes("FROM refund_requests")) return { rows: [] };
    if (String(sql).includes("INSERT INTO refund_requests")) return { rows: [{ id: "req-1" }] };
    return { rows: [] };
  });
  h.resolvePublicEventById.mockResolvedValue({
    ok: true,
    event: { event_date: EVENT_DATE, cancellation_fee_tiers: TIERS },
  });
  h.query.mockResolvedValue({ rows: [] });
});

describe("시점 가드", () => {
  it("전날까지는 **즉시 환불된다**(전액환불 구간)", async () => {
    // 🔴 2026-08-01 계약 변경: 종전엔 201 접수였다. 그런데 그 접수를 읽는 코드도 화면도
    //    없어서 손님이 무한정 기다렸다 ⟹ 즉시 집행으로 바꿨다.
    at("2026-08-19T23:59:00+09:00");
    const res = await submitRefund(req());
    expect(res.status).toBe(200);
    expect((await res.json()).data.status).toBe("completed");
    expect(h.refundOrder).toHaveBeenCalledTimes(1);
    const inserts = h.clientQuery.mock.calls.filter((c) => String(c[0]).includes("INSERT INTO refund_requests"));
    expect(inserts).toHaveLength(1);
  });

  it("🔴 행사 당일 00:00 부터는 접수 자체를 막는다", async () => {
    at("2026-08-20T00:00:00+09:00");
    const res = await submitRefund(req());
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("환불이 불가능합니다");
  });

  it("🔴 막힌 요청은 원장에 남기지 않는다(처리 불가능한 pending 금지)", async () => {
    at("2026-08-20T09:00:00+09:00");
    await submitRefund(req());
    const inserts = h.clientQuery.mock.calls.filter((c) => String(c[0]).includes("INSERT INTO refund_requests"));
    expect(inserts).toHaveLength(0);
  });

  it("🔴 막힌 요청은 v2 환불을 부르지 않는다(돈이 나가면 안 된다)", async () => {
    at("2026-08-20T09:00:00+09:00");
    await submitRefund(req());
    expect(h.refundOrder).not.toHaveBeenCalled();
  });
});
