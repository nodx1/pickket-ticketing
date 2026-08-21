import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

// 레벨2 B2-1 affiliate read-flip: 목록을 v2 listAffiliates 위임(전환집계 포함),
//   account 소유격리는 v2_event_id 선조회(미소유→409), v2 장애→502.
// 레벨2 컷오버 T2-EVT: 그 선조회가 go events 테이블 → v2 resolveOwnedV2EventId 로 이동.
//   (경계는 v2 organizer_ref. 이벤트 확인 자체가 불가한 v2 장애는 409 아닌 503.)

const stubSession = { id: "u-1", accountId: "acct-1", role: "organizer" };
vi.mock("@/lib/auth/permissions", () => ({
  withRole:
    (
      _role: string,
      handler: (
        req: NextRequest,
        ctx: { session: typeof stubSession; params: { eventId: string } },
      ) => Promise<Response>,
    ) =>
    (req: NextRequest) =>
      handler(req, { session: stubSession, params: { eventId: "event-1" } }),
}));

const { getPool } = vi.hoisted(() => ({ getPool: vi.fn() }));
vi.mock("@/lib/db/pool", () => ({ getPool }));

const { listAffiliates, upsertAffiliates, V2CommerceError } = vi.hoisted(() => {
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
  return { listAffiliates: vi.fn(), upsertAffiliates: vi.fn(), V2CommerceError };
});
vi.mock("@/lib/v2/commerce-client", () => ({ listAffiliates, upsertAffiliates, V2CommerceError }));

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

import { GET } from "@/app/api/events/[eventId]/affiliates/route";

function req(): NextRequest {
  return {} as unknown as NextRequest;
}

const ctx = { params: Promise.resolve({ eventId: "event-1" }) };

beforeEach(() => {
  getPool.mockReset();
  listAffiliates.mockReset();
  resolveOwnedV2EventId.mockReset();
});

describe("affiliates GET 목록 — v2 read-flip(B2-1)", () => {
  it("소유 이벤트면 v2 listAffiliates 집계를 목록으로 반환(go 조인 제거)", async () => {
    resolveOwnedV2EventId.mockResolvedValue("v2-ev-1");
    listAffiliates.mockResolvedValue({
      affiliates: [
        {
          affiliate_id: "v2-a1",
          external_ref: "go-a1",
          name: "N",
          code: "C",
          commission_rate: 10,
          status: "active",
          conversion_count: 3,
          commission_total: 5000,
        },
      ],
      total: 1,
    });
    const res = await GET(req(), ctx);
    const body = await res.json();
    expect(listAffiliates).toHaveBeenCalledWith("v2-ev-1");
    // 테넌트 경계가 v2 로 전달되는지(계정 누락 = 크로스테넌트 누출).
    expect(resolveOwnedV2EventId).toHaveBeenCalledWith("event-1", "acct-1");
    // 목록 경로는 go DB 를 전혀 열지 않는다(T2-EVT).
    expect(getPool).not.toHaveBeenCalled();
    // id = go affiliate id(external_ref), 전환집계 정합
    expect(body.data[0]).toMatchObject({
      id: "go-a1",
      commissionRate: 10,
      conversionCount: 3,
      commissionTotal: 5000,
    });
  });

  it("미소유(v2 404 → null)면 409·v2 미호출", async () => {
    resolveOwnedV2EventId.mockResolvedValue(null);
    const res = await GET(req(), ctx);
    expect(res.status).toBe(409);
    expect(listAffiliates).not.toHaveBeenCalled();
  });

  it("v2 장애면 502(빈목록 위장 금지)", async () => {
    resolveOwnedV2EventId.mockResolvedValue("v2-ev-1");
    listAffiliates.mockRejectedValue(new V2CommerceError("down", 502));
    const res = await GET(req(), ctx);
    expect(res.status).toBe(502);
  });

  it("이벤트 확인 자체가 불가(v2 장애)면 503 — 미소유(409)로 뭉개지 않는다", async () => {
    resolveOwnedV2EventId.mockRejectedValue(
      new EventAccessError("커머스 서버에 연결할 수 없습니다", "unavailable", 502),
    );
    const res = await GET(req(), ctx);
    expect(res.status).toBe(503);
    expect(listAffiliates).not.toHaveBeenCalled();
  });
});
