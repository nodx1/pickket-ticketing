import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const h = vi.hoisted(() => {
  class MockV2CommerceError extends Error {
    constructor(message: string, readonly status: number) {
      super(message);
      this.name = "V2CommerceError";
    }
  }
  return {
    getPool: vi.fn(),
    listAttendees: vi.fn(),
    createOrder: vi.fn(),
    getEvent: vi.fn(),
    getEventBySlug: vi.fn(),
    MockV2CommerceError,
  };
});

vi.mock("@/lib/auth/permissions", () => ({
  withRole: (_role: string, handler: (request: Request, ctx: unknown) => Promise<Response>) =>
    (request: Request) =>
      handler(request, {
        session: { accountId: "account-1", role: "organizer" },
        params: { eventId: "event-1" },
      }),
}));
vi.mock("@/lib/db/pool", () => ({ getPool: h.getPool }));
vi.mock("@/lib/server/orders", () => ({ createOrder: h.createOrder }));
vi.mock("@/lib/v2/commerce-client", () => ({
  listAttendees: h.listAttendees,
  createOrder: h.createOrder,
  // T2-EVT: 소유 검증(event-access)이 v2 getEvent 로 이동 — go events 앵커 SQL 없음.
  getEvent: h.getEvent,
  getEventBySlug: h.getEventBySlug,
  V2CommerceError: h.MockV2CommerceError,
}));

import { GET } from "@/app/api/events/[eventId]/attendees/route";

const context = { params: Promise.resolve({ eventId: "event-1" }) };

beforeEach(() => {
  h.getPool.mockReset();
  h.listAttendees.mockReset();
  h.createOrder.mockReset();
  h.getEvent.mockReset();
  h.getEvent.mockResolvedValue({ event_id: "v2-event-1" });
});

describe("attendees v2 read failure handling", () => {
  it("returns 502 instead of an empty success when v2 is unavailable", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    h.getPool.mockReturnValue({ query });
    h.listAttendees.mockRejectedValue(new h.MockV2CommerceError("timeout", 503));

    const response = await GET(new Request("http://localhost/api/events/event-1/attendees") as unknown as NextRequest, context);

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: "참석자 데이터를 불러오지 못했습니다" });
  });

  // ── W4-ORD 회귀: 티켓번호 앵커 JOIN 폐기 ──
  it("v2 ticket_number 를 그대로 쓰고 go attendees 앵커 SQL 을 실행하지 않는다", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    h.getPool.mockReturnValue({ query });
    h.listAttendees.mockResolvedValue({
      attendees: [{
        ticket_id: "0f8fad5b-d9cb-469f-a165-70867728950e",
        order_id: "order-1",
        owner_user_id: null,
        name: "홍길동",
        email: "hong@example.com",
        phone: null,
        status: "active",
        checked_in_at: null,
        seat_id: null,
        product_name: "티켓",
        ticket_number: "TKT-0F8FAD5BD9CB",
      }],
      total: 1,
    });

    const response = await GET(new Request("http://localhost/api/events/event-1/attendees") as unknown as NextRequest, context);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data[0]).toMatchObject({
      id: "0f8fad5b-d9cb-469f-a165-70867728950e",
      ticketNumber: "TKT-0F8FAD5BD9CB",
    });
    // go DB 접근 0 — 앵커 JOIN 이 사라졌다.
    expect(query).not.toHaveBeenCalled();
  });

  it("v2 ticket_number 가 비어도 ticket_id 에서 같은 공식으로 파생한다(UUID 노출 금지)", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    h.getPool.mockReturnValue({ query });
    h.listAttendees.mockResolvedValue({
      attendees: [{
        ticket_id: "0f8fad5b-d9cb-469f-a165-70867728950e",
        order_id: "order-1",
        owner_user_id: null,
        name: "홍길동",
        email: null,
        phone: null,
        status: "active",
        checked_in_at: null,
        seat_id: null,
        product_name: "티켓",
        ticket_number: null,
      }],
      total: 1,
    });

    const response = await GET(new Request("http://localhost/api/events/event-1/attendees") as unknown as NextRequest, context);
    const body = await response.json();
    // 파생식 고정 계약: TKT- + uuid 하이픈제거 앞12자 대문자.
    expect(body.data[0].ticketNumber).toBe("TKT-0F8FAD5BD9CB");
  });
});

// ── T2-EVT 회귀: 테넌트 경계가 go events SQL(AND account_id) → v2 organizer_ref 로 이동했다 ──
describe("attendees 이벤트 소유 경계(T2-EVT)", () => {
  it("세션 계정을 organizer_ref 로 넘겨 v2 가 테넌트 경계를 강제한다 + go events 앵커 SQL 미실행", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    h.getPool.mockReturnValue({ query });
    h.listAttendees.mockResolvedValue({ attendees: [], total: 0 });

    const response = await GET(
      new Request("http://localhost/api/events/event-1/attendees") as unknown as NextRequest,
      context,
    );

    expect(response.status).toBe(200);
    expect(h.getEvent).toHaveBeenCalledWith("event-1", { organizerRef: "account-1" });
    const sqls = (query.mock.calls as unknown as Array<[string, unknown[]]>).map(([sql]) => String(sql));
    expect(sqls.some((sql) => sql.includes("v2_event_id"))).toBe(false);
  });

  it("이벤트가 없거나 타 계정 소유면 빈 목록(200)을 반환하고 참석자 read 를 하지 않는다", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    h.getPool.mockReturnValue({ query });
    h.getEvent.mockRejectedValue(new h.MockV2CommerceError("not found", 404));

    const response = await GET(
      new Request("http://localhost/api/events/event-1/attendees") as unknown as NextRequest,
      context,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: [], meta: { total: 0 } });
    expect(h.listAttendees).not.toHaveBeenCalled();
  });

  it("소유 확인 중 v2 장애면 빈 목록이 아니라 503 을 반환한다(참석자 0명 위장 금지)", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    h.getPool.mockReturnValue({ query });
    h.getEvent.mockRejectedValue(new h.MockV2CommerceError("bad gateway", 502));

    const response = await GET(
      new Request("http://localhost/api/events/event-1/attendees") as unknown as NextRequest,
      context,
    );

    expect(response.status).toBe(503);
    expect(h.listAttendees).not.toHaveBeenCalled();
  });
});
