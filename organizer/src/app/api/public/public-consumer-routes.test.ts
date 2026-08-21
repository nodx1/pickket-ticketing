import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

/**
 * W2-PUB — 소비자 공개 라우트(목록·티켓·내 티켓·환불 미리보기) 회귀.
 *
 * 공통 축: **정상 / 미존재 404 / v2 장애 503**.
 * 🔴 특히 "v2 장애 → 빈 목록/성공 위장" 을 금지한다. 목록이 비면 판매중 이벤트가 사라지고,
 *    내 티켓이 비면 사용자는 티켓을 잃었다고 판단한다.
 */
const h = vi.hoisted(() => {
  class MockV2CommerceError extends Error {
    constructor(message: string, readonly status: number) {
      super(message);
      this.name = "V2CommerceError";
    }
  }
  return {
    listPublicEventsV2: vi.fn(),
    lookupPublicTicketsV2: vi.fn(),
    getTicketByNumber: vi.fn(),
    getOrderByExternalRef: vi.fn(),
    getEvent: vi.fn(),
    getEventBySlug: vi.fn(),
    getPool: vi.fn(),
    canAccessTicketArtifact: vi.fn(),
    verifyPublicLookupToken: vi.fn(),
    matchesPublicLookup: vi.fn(),
    createMagicLinkToken: vi.fn(() => "magic-token"),
    sendEmail: vi.fn(),
    cookieGet: vi.fn<(name: string) => { value: string } | undefined>(() => undefined),
    MockV2CommerceError,
  };
});

vi.mock("@/lib/db/pool", () => ({ getPool: h.getPool }));
vi.mock("@/lib/v2/commerce-client", () => ({
  V2CommerceError: h.MockV2CommerceError,
  listPublicEventsV2: h.listPublicEventsV2,
  lookupPublicTicketsV2: h.lookupPublicTicketsV2,
  getTicketByNumber: h.getTicketByNumber,
  getOrderByExternalRef: h.getOrderByExternalRef,
  getEvent: h.getEvent,
  getEventBySlug: h.getEventBySlug,
}));
vi.mock("@/lib/ticket/access", () => ({
  canAccessTicketArtifact: h.canAccessTicketArtifact,
}));
vi.mock("@/lib/public-access", () => ({
  PUBLIC_LOOKUP_COOKIE: "pkt_lookup",
  verifyPublicLookupToken: h.verifyPublicLookupToken,
  matchesPublicLookup: h.matchesPublicLookup,
  createMagicLinkToken: h.createMagicLinkToken,
}));
vi.mock("@/lib/notification/email", () => ({ sendEmail: h.sendEmail }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: h.cookieGet }),
}));
vi.mock("@/lib/auth/withRateLimit", () => ({
  withRateLimit: () => (handler: unknown) => handler,
  SEAT_RATE_LIMITS: {},
}));

import { GET as publicEventsRoute } from "./events/route";
import { GET as publicTicketRoute } from "./tickets/[ticketNumber]/route";
import { GET as myTicketsGet, POST as myTicketsPost } from "./my-tickets/route";
import { POST as refundCheckRoute } from "./refund/check/route";

const EVENT_ID = "11111111-2222-4333-8444-555555555555";
const ORDER_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

beforeEach(() => {
  vi.clearAllMocks();
  h.getPool.mockReturnValue({ query: vi.fn().mockResolvedValue({ rows: [] }) });
  h.canAccessTicketArtifact.mockResolvedValue(true);
  h.verifyPublicLookupToken.mockReturnValue({ email: "b@t.com", phone: "01012345678" });
  h.matchesPublicLookup.mockReturnValue(true);
  h.sendEmail.mockResolvedValue(undefined);
});

// ── GET /api/public/events ───────────────────────────────────────────────

describe("GET /api/public/events", () => {
  function req(qs = "") {
    return new Request(`http://localhost/api/public/events${qs}`) as NextRequest;
  }

  it("marketplace 채널 필터로 v2 공개 목록을 읽는다(go DB 미사용)", async () => {
    h.listPublicEventsV2.mockResolvedValue({
      events: [{
        event_id: EVENT_ID, slug: "e1", title: "이벤트", summary: null, description: null,
        venue: "홀", venue_address: null, event_type: "concert", category: "concert",
        age_rating: null, is_online: false, event_date: "2026-09-01T00:00:00Z",
        event_date_end: null, image_url: null, image_variants: null, status: "live",
        sale_channels: ["self", "marketplace"], total_seats: 100, attendee_count: 3,
        tier_count: 2, updated_at: "2026-08-01T00:00:00Z",
      }],
      total: 1, limit: 20, offset: 0,
    });

    const res = await publicEventsRoute(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.total).toBe(1);
    expect(body.data.events[0]).toMatchObject({ id: EVENT_ID, slug: "e1", status: "live" });
    expect(h.listPublicEventsV2).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "marketplace" }),
    );
    expect(h.getPool).not.toHaveBeenCalled();
  });

  it("🔴 v2 장애를 빈 목록으로 위장하지 않는다 → 503", async () => {
    h.listPublicEventsV2.mockRejectedValue(new h.MockV2CommerceError("down", 500));
    const res = await publicEventsRoute(req());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it("format=v2 는 상태 어휘만 바꾼다", async () => {
    h.listPublicEventsV2.mockResolvedValue({
      events: [{
        event_id: EVENT_ID, slug: "e1", title: "이벤트", summary: null, description: null,
        venue: null, venue_address: null, event_type: null, category: "concert",
        age_rating: null, is_online: false, event_date: null, event_date_end: null,
        image_url: null, image_variants: null, status: "live", sale_channels: [],
        total_seats: null, attendee_count: 0, tier_count: 0, updated_at: null,
      }],
      total: 1, limit: 20, offset: 0,
    });
    const res = await publicEventsRoute(req("?format=v2"));
    const body = await res.json();
    expect(body.data.events[0].status).toBe("APPROVED");
  });
});

// ── GET /api/public/tickets/[ticketNumber] ───────────────────────────────

describe("GET /api/public/tickets/[ticketNumber]", () => {
  const ctx = { params: Promise.resolve({ ticketNumber: "PK-1" }) };

  function v2Ticket() {
    return {
      ticket_id: "t1", ticket_number: "PK-1", status: "active", raffle_number: 7,
      product_name: "VIP", event_id: EVENT_ID,
      event: { starts_at: "2026-09-01T00:00:00Z", title: "이벤트", organizer_id: "o1", external_ref: null },
      order: {
        id: "v2-order", order_number: ORDER_ID, external_ref: ORDER_ID,
        buyer: { name: "홍길동", email: "buyer@example.com", phone: "01012345678" },
      },
    };
  }

  it("v2 티켓+이벤트로 마스킹 응답을 만든다(go DB 미사용)", async () => {
    h.getTicketByNumber.mockResolvedValue(v2Ticket());
    h.getEvent.mockResolvedValue({
      event_id: EVENT_ID, status: "live", title: "이벤트", venue: "홀",
      event_date: "2026-09-01T00:00:00Z", go_account_id: "acc-1",
    });

    const res = await publicTicketRoute(new Request("http://localhost/t"), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.email).toBe("buy***@example.com");
    expect(body.data.phone).toBe("010-****-5678");
    expect(body.data.venueName).toBe("홀");
    expect(body.data.productName).toBe("VIP");
    // 구매자 이메일 원문·전화 원문이 새지 않는다.
    expect(JSON.stringify(body)).not.toContain("buyer@example.com");
    expect(h.getPool).not.toHaveBeenCalled();
  });

  it("미존재 티켓 404 / v2 장애 503", async () => {
    h.getTicketByNumber.mockRejectedValueOnce(new h.MockV2CommerceError("nope", 404));
    expect((await publicTicketRoute(new Request("http://localhost/t"), ctx)).status).toBe(404);

    h.getTicketByNumber.mockRejectedValueOnce(new h.MockV2CommerceError("down", 500));
    expect((await publicTicketRoute(new Request("http://localhost/t"), ctx)).status).toBe(503);
  });

  it("🔴 경계 확인 실패를 403 으로 강등하지 않는다(이벤트 조회 503 → 503)", async () => {
    h.getTicketByNumber.mockResolvedValue(v2Ticket());
    h.getEvent.mockRejectedValue(new h.MockV2CommerceError("down", 500));

    const res = await publicTicketRoute(new Request("http://localhost/t"), ctx);
    expect(res.status).toBe(503);
    expect(h.canAccessTicketArtifact).not.toHaveBeenCalled();
  });

  it("접근권이 없으면 403", async () => {
    h.getTicketByNumber.mockResolvedValue(v2Ticket());
    h.getEvent.mockResolvedValue({
      event_id: EVENT_ID, status: "live", title: "이벤트", venue: "홀",
      event_date: null, go_account_id: "acc-1",
    });
    h.canAccessTicketArtifact.mockResolvedValue(false);

    const res = await publicTicketRoute(new Request("http://localhost/t"), ctx);
    expect(res.status).toBe(403);
  });
});

// ── /api/public/my-tickets ───────────────────────────────────────────────

describe("/api/public/my-tickets", () => {
  const lookupRow = {
    ticket_id: "t1", ticket_number: "PK-1", name: "홍길동", status: "active",
    product_name: "VIP", event_id: EVENT_ID, event_title: "이벤트",
    event_starts_at: "2026-09-01T00:00:00Z", event_venue: "홀",
  };

  it("GET — 쿠키 세션으로 이벤트별 그룹을 돌려준다(go DB 미사용)", async () => {
    h.cookieGet.mockReturnValue({ value: "cookie" });
    h.lookupPublicTicketsV2.mockResolvedValue({ tickets: [lookupRow], total: 1 });

    const res = await myTicketsGet();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ eventTitle: "이벤트", venueName: "홀" });
    expect(body.data[0].tickets[0]).toMatchObject({ ticketNumber: "PK-1", productName: "VIP" });
    expect(h.getPool).not.toHaveBeenCalled();
  });

  it("🔴 GET — v2 장애를 빈 목록으로 위장하지 않는다 → 503", async () => {
    h.cookieGet.mockReturnValue({ value: "cookie" });
    h.lookupPublicTicketsV2.mockRejectedValue(new h.MockV2CommerceError("down", 500));

    const res = await myTicketsGet();
    expect(res.status).toBe(503);
  });

  it("GET — 조회 세션 없으면 401", async () => {
    h.verifyPublicLookupToken.mockReturnValue(null);
    const res = await myTicketsGet();
    expect(res.status).toBe(401);
  });

  it("POST — 티켓이 있으면 매직링크를 보내고, 없어도 동일 응답(열거 방지)", async () => {
    h.lookupPublicTicketsV2.mockResolvedValueOnce({ tickets: [lookupRow], total: 1 });
    const withTickets = await myTicketsPost(
      new Request("http://localhost/mt", {
        method: "POST",
        body: JSON.stringify({ email: "b@t.com", phone: "01012345678" }),
      }),
    );
    expect(withTickets.status).toBe(200);
    expect(h.sendEmail).toHaveBeenCalledTimes(1);

    h.lookupPublicTicketsV2.mockResolvedValueOnce({ tickets: [], total: 0 });
    const without = await myTicketsPost(
      new Request("http://localhost/mt", {
        method: "POST",
        body: JSON.stringify({ email: "b@t.com", phone: "01012345678" }),
      }),
    );
    expect(without.status).toBe(200);
    expect(await without.json()).toEqual(await withTickets.clone().json());
    expect(h.sendEmail).toHaveBeenCalledTimes(1); // 두 번째는 발송 없음
  });

  it("🔴 POST — v2 장애 시 '메일 보냈습니다'로 위장하지 않는다 → 503", async () => {
    h.lookupPublicTicketsV2.mockRejectedValue(new h.MockV2CommerceError("down", 500));
    const res = await myTicketsPost(
      new Request("http://localhost/mt", {
        method: "POST",
        body: JSON.stringify({ email: "b@t.com", phone: "01012345678" }),
      }),
    );
    expect(res.status).toBe(503);
    expect(h.sendEmail).not.toHaveBeenCalled();
  });
});

// ── POST /api/public/refund/check ────────────────────────────────────────

describe("POST /api/public/refund/check", () => {
  function req(body: unknown) {
    return new Request("http://localhost/api/public/refund/check", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  it("go order id 로 v2 주문을 찾아 환불 미리보기를 만든다(go DB 미사용)", async () => {
    h.getOrderByExternalRef.mockResolvedValue({
      order_id: "v2-order", external_order_id: ORDER_ID, order_number: ORDER_ID,
      event_id: EVENT_ID, paid_amount: 30000, total_refunded: 0,
      buyer: { name: "홍길동", email: "b@t.com", phone: "01012345678" },
    });
    h.getEvent.mockResolvedValue({
      event_id: EVENT_ID, status: "live", title: "E",
      event_date: new Date(Date.now() + 30 * 86400000).toISOString(),
    });

    const res = await refundCheckRoute(req({ orderId: ORDER_ID, email: "b@t.com" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.data.refundAmount).toBe("number");
    expect(h.getOrderByExternalRef).toHaveBeenCalledWith(ORDER_ID);
    expect(h.getPool).not.toHaveBeenCalled();
  });

  it("미존재 주문 404 / v2 장애 503", async () => {
    h.getOrderByExternalRef.mockRejectedValueOnce(new h.MockV2CommerceError("nope", 404));
    expect((await refundCheckRoute(req({ orderId: ORDER_ID, email: "b@t.com" }))).status).toBe(404);

    h.getOrderByExternalRef.mockRejectedValueOnce(new h.MockV2CommerceError("down", 500));
    expect((await refundCheckRoute(req({ orderId: ORDER_ID, email: "b@t.com" }))).status).toBe(503);
  });

  it("구매자 이메일이 다르면 404(존재 사실 비노출)", async () => {
    h.getOrderByExternalRef.mockResolvedValue({
      order_id: "v2-order", external_order_id: ORDER_ID, order_number: ORDER_ID,
      event_id: EVENT_ID, paid_amount: 30000, total_refunded: 0,
      buyer: { name: "홍길동", email: "owner@t.com", phone: "01012345678" },
    });
    const res = await refundCheckRoute(req({ orderId: ORDER_ID, email: "other@t.com" }));
    expect(res.status).toBe(404);
    expect(h.getEvent).not.toHaveBeenCalled();
  });
});
