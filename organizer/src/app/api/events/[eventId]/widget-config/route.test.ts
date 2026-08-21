/**
 * 주최자 위젯 설정 + 티켓 디자인 라우트 — 레벨2 컷오버 **W5-CONTENT** 회귀.
 *
 * 두 라우트 모두 `withRole("organizer")` + v2 `organizer-content` 정본을 쓴다.
 * 고정하는 계약:
 *   ① go DB 미사용(6테이블 SQL 0 의 런타임 증거)
 *   ② 테넌트 경계 — 모든 v2 호출에 `organizer_ref`(= session.accountId)가 실린다
 *   ③ 미소유/미존재(v2 404) → 404
 *   ④ 🔴 v2 장애 → **503**. 절대 400(입력오류)·404(없음)·기본값으로 뭉개지 않는다.
 *      특히 위젯은 조회 실패를 기본값(allowedDomains=[] = 제한 없음)으로 흘리면
 *      화이트리스트가 무력화된다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/auth/permissions", () => ({
  withRole:
    (_role: string, handler: (request: Request, ctx: unknown) => Promise<Response>) =>
    (request: Request) =>
      handler(request, {
        session: { id: "user-1", accountId: "acct-1", role: "organizer" },
        params: { eventId: "event-1" },
      }),
}));

const { getPool, poolQuery } = vi.hoisted(() => {
  const poolQuery = vi.fn();
  return { getPool: vi.fn(() => ({ query: poolQuery })), poolQuery };
});
vi.mock("@/lib/db/pool", () => ({ getPool }));

const h = vi.hoisted(() => {
  class V2CommerceError extends Error {
    constructor(message: string, readonly status: number, readonly body?: string) {
      super(message);
      this.name = "V2CommerceError";
    }
  }
  return {
    getOrganizerWidgetConfig: vi.fn(),
    putOrganizerWidgetConfig: vi.fn(),
    getOrganizerTicketDesign: vi.fn(),
    putOrganizerTicketDesign: vi.fn(),
    V2CommerceError,
  };
});
vi.mock("@/lib/v2/commerce-client", () => ({
  getOrganizerWidgetConfig: h.getOrganizerWidgetConfig,
  putOrganizerWidgetConfig: h.putOrganizerWidgetConfig,
  getOrganizerTicketDesign: h.getOrganizerTicketDesign,
  putOrganizerTicketDesign: h.putOrganizerTicketDesign,
  V2CommerceError: h.V2CommerceError,
}));

import { GET as widgetGET, PUT as widgetPUT } from "@/app/api/events/[eventId]/widget-config/route";
import { GET as designGET, PUT as designPUT } from "@/app/api/events/[eventId]/ticket-design/route";

function req(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}
const ctx = { params: Promise.resolve({ eventId: "event-1" }) };

beforeEach(() => {
  poolQuery.mockReset();
  h.getOrganizerWidgetConfig.mockReset();
  h.putOrganizerWidgetConfig.mockReset();
  h.getOrganizerTicketDesign.mockReset();
  h.putOrganizerTicketDesign.mockReset();
});

describe("widget-config(주최자) — W5-CONTENT", () => {
  it("설정 미등록(configured=false)이면 go 시절과 동일한 기본값을 준다", async () => {
    h.getOrganizerWidgetConfig.mockResolvedValue({
      configured: false, mode: "button", theme: {}, allowed_domains: [], is_active: true,
    });
    const res = await widgetGET(req({}), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toEqual({
      mode: "button",
      theme: { primaryColor: "#6C5CE7", buttonText: "티켓 구매", borderRadius: 100, fontFamily: "" },
      allowedDomains: [],
      isActive: true,
    });
    expect(poolQuery).not.toHaveBeenCalled();
    expect(h.getOrganizerWidgetConfig).toHaveBeenCalledWith("event-1", "acct-1");
  });

  it("저장된 설정은 camelCase 계약으로 매핑한다", async () => {
    h.getOrganizerWidgetConfig.mockResolvedValue({
      configured: true, mode: "inline", theme: { primaryColor: "#000" },
      allowed_domains: ["a.com"], is_active: false, updated_at: "2026-07-27T00:00:00Z",
    });
    const body = (await (await widgetGET(req({}), ctx)).json()) as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({
      mode: "inline", allowedDomains: ["a.com"], isActive: false,
    });
  });

  it("🔴 GET 의 v2 장애는 503 — 기본값(제한 없음)으로 폴백하지 않는다", async () => {
    h.getOrganizerWidgetConfig.mockRejectedValue(new h.V2CommerceError("boom", 502));
    const res = await widgetGET(req({}), ctx);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(false);
  });

  it("미소유 이벤트(v2 404)는 404", async () => {
    h.getOrganizerWidgetConfig.mockRejectedValue(new h.V2CommerceError("not found", 404));
    expect((await widgetGET(req({}), ctx)).status).toBe(404);
  });

  it("PUT: 화이트리스트를 전체교체로 저장하고 organizer_ref 를 싣는다", async () => {
    h.putOrganizerWidgetConfig.mockResolvedValue({
      configured: true, mode: "mini", theme: { primaryColor: "#111" },
      allowed_domains: ["b.com"], is_active: true,
    });
    const res = await widgetPUT(
      req({ mode: "mini", theme: { primaryColor: "#111" }, allowedDomains: ["b.com"] }), ctx,
    );
    expect(res.status).toBe(200);
    expect(h.putOrganizerWidgetConfig).toHaveBeenCalledWith("event-1", "acct-1", {
      mode: "mini", theme: { primaryColor: "#111" }, allowed_domains: ["b.com"], is_active: true,
    });
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it("PUT: 잘못된 mode 는 400(사용자 입력 오류만 400)", async () => {
    const res = await widgetPUT(req({ mode: "popup" }), ctx);
    expect(res.status).toBe(400);
    expect(h.putOrganizerWidgetConfig).not.toHaveBeenCalled();
  });

  it("🔴 PUT 의 v2 장애는 503 — 400 으로 뭉개지 않는다(주최자가 입력값을 고치는 헛수고 방지)", async () => {
    h.putOrganizerWidgetConfig.mockRejectedValue(new h.V2CommerceError("boom", 500));
    expect((await widgetPUT(req({ mode: "button" }), ctx)).status).toBe(503);
  });
});

describe("ticket-design — W5-CONTENT", () => {
  it("GET: v2 canvas_json 을 그대로 준다(go DB 미사용)", async () => {
    h.getOrganizerTicketDesign.mockResolvedValue({ canvas_json: { accentColor: "#abc" } });
    const body = (await (await designGET(req({}), ctx)).json()) as { data: Record<string, unknown> };
    expect(body.data).toEqual({ accentColor: "#abc" });
    expect(poolQuery).not.toHaveBeenCalled();
    expect(h.getOrganizerTicketDesign).toHaveBeenCalledWith("event-1", "acct-1");
  });

  it("PUT: 넘어온 키만 v2 에 보낸다(병합은 v2 담당)", async () => {
    h.putOrganizerTicketDesign.mockResolvedValue({ canvas_json: {} });
    const res = await designPUT(req({ accentColor: "#112233", showGallery: true }), ctx);
    expect(res.status).toBe(200);
    expect(h.putOrganizerTicketDesign).toHaveBeenCalledWith("event-1", "acct-1", {
      accentColor: "#112233", showGallery: true,
    });
  });

  it("PUT: 잘못된 색상 형식은 400", async () => {
    const res = await designPUT(req({ accentColor: "red" }), ctx);
    expect(res.status).toBe(400);
    expect(h.putOrganizerTicketDesign).not.toHaveBeenCalled();
  });

  it("🔴 v2 장애는 503, 미소유는 404", async () => {
    h.getOrganizerTicketDesign.mockRejectedValue(new h.V2CommerceError("boom", 0));
    expect((await designGET(req({}), ctx)).status).toBe(503);
    h.putOrganizerTicketDesign.mockRejectedValue(new h.V2CommerceError("not found", 404));
    expect((await designPUT(req({ showGallery: true }), ctx)).status).toBe(404);
  });
});
