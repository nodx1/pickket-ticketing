/**
 * `/api/events/[eventId]/organizers` — 레벨2 컷오버 W2-EVT 회귀.
 *
 * go `event_organizers` → v2 `event_host_links`. 옛 코드는 모든 실패를 `catch { 500 }` 으로
 * 뭉갰다 — 미소유(404)/입력오류(400)/v2 장애(503)를 구분하는지가 이 파일의 핵심 관심사다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const h = vi.hoisted(() => {
  class V2CommerceError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return { listEventHostLinks: vi.fn(), putEventHostLinks: vi.fn(), V2CommerceError };
});

vi.mock("@/lib/auth/withAuth", () => ({
  withAuth: (handler: (request: Request, ctx: unknown) => Promise<Response>) =>
    (request: Request) =>
      handler(request, {
        session: { accountId: "account-1", role: "organizer" },
        params: { eventId: "event-1" },
      }),
}));
vi.mock("@/lib/v2/commerce-client", () => ({
  listEventHostLinks: h.listEventHostLinks,
  putEventHostLinks: h.putEventHostLinks,
  V2CommerceError: h.V2CommerceError,
}));

import { GET, PUT } from "@/app/api/events/[eventId]/organizers/route";

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_HOST_ID = "22222222-2222-4222-8222-222222222222";

function link(overrides: Record<string, unknown> = {}) {
  return {
    link_id: "l1",
    host_id: HOST_ID,
    role: "host",
    display_order: 0,
    name: "주최자A",
    slug: "host-a",
    logo_url: null,
    contact_public: false,
    email: null,
    phone: null,
    ...overrides,
  };
}

const ctx = { params: Promise.resolve({ eventId: "event-1" }) };
function req(method: string, body?: unknown) {
  return new Request("http://localhost/api/events/event-1/organizers", {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }) as unknown as NextRequest;
}

beforeEach(() => {
  h.listEventHostLinks.mockReset().mockResolvedValue({ hosts: [link()] });
  h.putEventHostLinks.mockReset().mockResolvedValue({ hosts: [link()] });
});

describe("GET (이벤트 주최자 목록)", () => {
  it("옛 go 행 shape 을 유지한다", async () => {
    const res = await GET(req("GET"), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0]).toEqual({
      id: "l1",
      eventId: "event-1",
      organizerId: HOST_ID,
      role: "host",
      displayOrder: 0,
      organizerName: "주최자A",
      organizerLogoUrl: null,
    });
    // 🔴 테넌트 경계
    expect(h.listEventHostLinks).toHaveBeenCalledWith("account-1", "event-1");
  });

  it("🔴 크로스테넌트 차단: 타 계정 이벤트는 404 (옛 500 아님)", async () => {
    h.listEventHostLinks.mockRejectedValue(new h.V2CommerceError("nope", 404));
    expect((await GET(req("GET"), ctx)).status).toBe(404);
  });

  it("🔴 v2 장애는 503 (옛 500/빈배열 아님)", async () => {
    h.listEventHostLinks.mockRejectedValue(new h.V2CommerceError("boom", 502));
    expect((await GET(req("GET"), ctx)).status).toBe(503);
  });
});

describe("PUT (주최자 전체 교체)", () => {
  const validBody = {
    organizers: [{ organizerId: HOST_ID, role: "host", displayOrder: 0 }],
  };

  it("v2 링크 PUT 으로 위임하고 갱신된 목록을 반환한다", async () => {
    const res = await PUT(req("PUT", validBody), ctx);
    expect(res.status).toBe(200);
    expect(h.putEventHostLinks).toHaveBeenCalledWith("account-1", "event-1", [
      { host_id: HOST_ID, role: "host", display_order: 0 },
    ]);
  });

  it("host 역할이 없으면 400 — v2 호출 없음", async () => {
    const res = await PUT(
      req("PUT", { organizers: [{ organizerId: HOST_ID, role: "sponsor", displayOrder: 0 }] }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(h.putEventHostLinks).not.toHaveBeenCalled();
  });

  it("🔴 타 계정 주최자 id 포함(v2 400)은 400 — 부분 반영 없음", async () => {
    h.putEventHostLinks.mockRejectedValue(new h.V2CommerceError("HOST_NOT_OWNED", 400));
    const res = await PUT(
      req("PUT", {
        organizers: [
          { organizerId: HOST_ID, role: "host", displayOrder: 0 },
          { organizerId: OTHER_HOST_ID, role: "sponsor", displayOrder: 1 },
        ],
      }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("🔴 크로스테넌트 차단: 타 계정 이벤트는 404", async () => {
    h.putEventHostLinks.mockRejectedValue(new h.V2CommerceError("nope", 404));
    expect((await PUT(req("PUT", validBody), ctx)).status).toBe(404);
  });

  it("🔴 v2 장애는 503", async () => {
    h.putEventHostLinks.mockRejectedValue(new h.V2CommerceError("boom", 500));
    expect((await PUT(req("PUT", validBody), ctx)).status).toBe(503);
  });

  it("빈 배열은 400", async () => {
    expect((await PUT(req("PUT", { organizers: [] }), ctx)).status).toBe(400);
  });
});
