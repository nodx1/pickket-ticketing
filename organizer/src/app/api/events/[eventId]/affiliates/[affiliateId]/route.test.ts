import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

// 레벨2 B2-1 affiliate 상세 read-flip + write cutover:
//   ① GET 상세: v2 getAffiliateDetail(단건+전환) live read, 표시 주문번호만 go orders 앵커 매핑.
//   ② PATCH/DELETE: go 앵커 write + v2 write-through(dual-write). v2 장애→502.

const stubSession = { id: "u-1", accountId: "acct-1", role: "organizer" };
vi.mock("@/lib/auth/permissions", () => ({
  withRole:
    (
      _role: string,
      handler: (
        req: NextRequest,
        ctx: { session: typeof stubSession; params: { eventId: string; affiliateId: string } },
      ) => Promise<Response>,
    ) =>
    (req: NextRequest) =>
      handler(req, { session: stubSession, params: { eventId: "event-1", affiliateId: "go-a1" } }),
}));

const { getPool } = vi.hoisted(() => ({ getPool: vi.fn() }));
vi.mock("@/lib/db/pool", () => ({ getPool }));

const { getAffiliateDetail, patchAffiliate, deleteAffiliate, V2CommerceError } = vi.hoisted(() => {
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
  return {
    getAffiliateDetail: vi.fn(),
    patchAffiliate: vi.fn(),
    deleteAffiliate: vi.fn(),
    V2CommerceError,
  };
});
vi.mock("@/lib/v2/commerce-client", () => ({
  getAffiliateDetail,
  patchAffiliate,
  deleteAffiliate,
  V2CommerceError,
}));

// 레벨2 컷오버 T2-EVT: 이벤트 소유격리가 go events 앵커 → v2 organizer_ref 로 이동.
const { resolveOwnedV2EventId, EventAccessError } = vi.hoisted(() => {
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
  return { resolveOwnedV2EventId: vi.fn(), EventAccessError };
});
vi.mock("@/lib/v2/event-access", () => ({ resolveOwnedV2EventId, EventAccessError }));

import { GET, PATCH, DELETE } from "@/app/api/events/[eventId]/affiliates/[affiliateId]/route";

function req(body?: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

const ctx = { params: Promise.resolve({ eventId: "event-1", affiliateId: "go-a1" }) };

beforeEach(() => {
  getPool.mockReset();
  getAffiliateDetail.mockReset();
  patchAffiliate.mockReset();
  deleteAffiliate.mockReset();
  resolveOwnedV2EventId.mockReset();
  resolveOwnedV2EventId.mockResolvedValue("v2-ev-1");
});

describe("affiliate 상세 GET — v2 read-flip + go orders 주문번호 매핑", () => {
  it("v2 getAffiliateDetail + go orders 앵커에서 표시 주문번호 매핑", async () => {
    getPool.mockReturnValue({
      query: vi.fn(async (sql: string) => {
        if (sql.includes("v2_event_id")) return { rows: [{ v2_event_id: "v2-ev-1" }] };
        if (sql.includes("order_number")) return { rows: [{ id: "ord-1", order_number: "ORD-100" }] };
        return { rows: [] };
      }),
    });
    getAffiliateDetail.mockResolvedValue({
      affiliate: {
        affiliate_id: "v2-a1",
        external_ref: "go-a1",
        name: "N",
        code: "C",
        commission_rate: 10,
        status: "active",
        created_at: "2026-01-01T00:00:00Z",
      },
      conversions: [
        { id: "cv-1", order_ref: "ord-1", order_amount: 10000, commission_amount: 1000, created_at: "2026-01-02T00:00:00Z" },
      ],
    });
    const res = await GET(req(), ctx);
    const body = await res.json();
    expect(getAffiliateDetail).toHaveBeenCalledWith("v2-ev-1", "go-a1");
    expect(body.data.id).toBe("go-a1");
    expect(body.data.conversions[0]).toMatchObject({
      orderNumber: "ORD-100",
      orderAmount: 10000,
      commissionAmount: 1000,
    });
  });

  it("미소유(v2 404 → null)면 404·v2 미호출", async () => {
    resolveOwnedV2EventId.mockResolvedValue(null);
    getPool.mockReturnValue({ query: vi.fn(async () => ({ rows: [] })) });
    const res = await GET(req(), ctx);
    expect(res.status).toBe(404);
    expect(getAffiliateDetail).not.toHaveBeenCalled();
    // 테넌트 경계가 v2 로 전달되는지.
    expect(resolveOwnedV2EventId).toHaveBeenCalledWith("event-1", "acct-1");
  });

  it("v2 AFFILIATE_NOT_FOUND(404)면 404", async () => {
    getPool.mockReturnValue({
      query: vi.fn(async () => ({ rows: [] })),
    });
    getAffiliateDetail.mockRejectedValue(new V2CommerceError("nf", 404));
    const res = await GET(req(), ctx);
    expect(res.status).toBe(404);
  });

  it("이벤트 확인 불가(v2 장애)면 503 — 404 로 뭉개지 않는다", async () => {
    resolveOwnedV2EventId.mockRejectedValue(
      new EventAccessError("커머스 서버에 연결할 수 없습니다", "unavailable", 502),
    );
    getPool.mockReturnValue({ query: vi.fn(async () => ({ rows: [] })) });
    const res = await GET(req(), ctx);
    expect(res.status).toBe(503);
    expect(getAffiliateDetail).not.toHaveBeenCalled();
  });
});

describe("affiliate PATCH/DELETE — dual-write(go 앵커 + v2 write-through)", () => {
  it("PATCH: go update 후 v2 patchAffiliate 위임(commissionRate→commission_rate)", async () => {
    getPool.mockReturnValue({
      query: vi.fn(async (sql: string) => {
        if (sql.includes("v2_event_id")) return { rows: [{ v2_event_id: "v2-ev-1" }] };
        // 코덱스 v2-first dual-write: 롤백용 before(PATCH)/current(DELETE) 조회.
        if (sql.includes("commission_rate") || sql.includes("SELECT status"))
          return { rows: [{ name: "N", commission_rate: "10", status: "active" }] };
        return { rows: [] };
      }),
    });
    patchAffiliate.mockResolvedValue({ affiliate_id: "v2-a1", updated: true });
    const res = await PATCH(req({ name: "New", commissionRate: 15, status: "active" }), ctx);
    expect(res.status).toBe(200);
    expect(patchAffiliate).toHaveBeenCalledWith("v2-ev-1", "go-a1", {
      name: "New",
      commission_rate: 15,
      status: "active",
    });
  });

  it("PATCH: v2 write-through 실패면 502", async () => {
    getPool.mockReturnValue({
      query: vi.fn(async (sql: string) => {
        if (sql.includes("v2_event_id")) return { rows: [{ v2_event_id: "v2-ev-1" }] };
        // 코덱스 v2-first dual-write: 롤백용 before(PATCH)/current(DELETE) 조회.
        if (sql.includes("commission_rate") || sql.includes("SELECT status"))
          return { rows: [{ name: "N", commission_rate: "10", status: "active" }] };
        return { rows: [] };
      }),
    });
    patchAffiliate.mockRejectedValue(new V2CommerceError("down", 502));
    const res = await PATCH(req({ name: "New" }), ctx);
    expect(res.status).toBe(502);
  });

  it("DELETE: go delete 후 v2 deleteAffiliate 위임", async () => {
    getPool.mockReturnValue({
      query: vi.fn(async (sql: string) => {
        if (sql.includes("v2_event_id")) return { rows: [{ v2_event_id: "v2-ev-1" }] };
        // 코덱스 v2-first dual-write: 롤백용 before(PATCH)/current(DELETE) 조회.
        if (sql.includes("commission_rate") || sql.includes("SELECT status"))
          return { rows: [{ name: "N", commission_rate: "10", status: "active" }] };
        return { rows: [] };
      }),
    });
    deleteAffiliate.mockResolvedValue({ deleted: true });
    const res = await DELETE(req(), ctx);
    expect(res.status).toBe(200);
    expect(deleteAffiliate).toHaveBeenCalledWith("v2-ev-1", "go-a1");
  });
});
