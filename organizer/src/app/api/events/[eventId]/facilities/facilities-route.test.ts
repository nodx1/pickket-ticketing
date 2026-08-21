/**
 * 시설 · 출연진 · 브릿지 페이지 라우트 — 레벨2 컷오버 **W5-CONTENT** 회귀.
 *
 * 세 기능 모두 `withAuth` + `requireFeature`(플랜 게이트) + v2 정본 조합이다.
 * 고정하는 계약:
 *   ① go DB 미사용 · 테넌트 경계(organizer_ref)
 *   ② 기능 게이트가 막으면 v2 를 아예 호출하지 않는다(과금 대상 기능 무료 개방 차단)
 *   ③ 🔴 목록 실패를 빈 배열로 폴백하지 않는다 / DELETE 를 200 으로 흡수하지 않는다
 *   ④ 내부 필드(vendor/cost/notes)는 주최자 응답에 그대로 남는다(소비자 투영에만 빠진다)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const stubSession = { id: "u-1", accountId: "acct-1", role: "organizer" };
vi.mock("@/lib/auth/withAuth", () => ({
  withAuth:
    (handler: (req: NextRequest, ctx: unknown) => Promise<Response>) =>
    (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) =>
      handler(req, { session: stubSession, params: ctx.params }),
}));

const { requireFeature } = vi.hoisted(() => ({ requireFeature: vi.fn() }));
vi.mock("@/lib/server/require-feature", () => ({ requireFeature }));

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
    listOrganizerFacilities: vi.fn(),
    createOrganizerFacility: vi.fn(),
    patchOrganizerFacility: vi.fn(),
    deleteOrganizerFacility: vi.fn(),
    listOrganizerParticipants: vi.fn(),
    createOrganizerParticipant: vi.fn(),
    getOrganizerBridgePage: vi.fn(),
    putOrganizerBridgePage: vi.fn(),
    V2CommerceError,
  };
});
vi.mock("@/lib/v2/commerce-client", () => ({
  listOrganizerFacilities: h.listOrganizerFacilities,
  createOrganizerFacility: h.createOrganizerFacility,
  patchOrganizerFacility: h.patchOrganizerFacility,
  deleteOrganizerFacility: h.deleteOrganizerFacility,
  listOrganizerParticipants: h.listOrganizerParticipants,
  createOrganizerParticipant: h.createOrganizerParticipant,
  getOrganizerBridgePage: h.getOrganizerBridgePage,
  putOrganizerBridgePage: h.putOrganizerBridgePage,
  V2CommerceError: h.V2CommerceError,
}));

import { GET as facGET, POST as facPOST } from "@/app/api/events/[eventId]/facilities/route";
import {
  PATCH as facPATCH,
  DELETE as facDELETE,
} from "@/app/api/events/[eventId]/facilities/[facilityId]/route";
import { GET as partGET, POST as partPOST } from "@/app/api/events/[eventId]/participants/route";
import { GET as bridgeGET, PUT as bridgePUT } from "@/app/api/events/[eventId]/bridge-page/route";

function req(body: unknown): NextRequest {
  return { json: async () => body, headers: new Headers() } as unknown as NextRequest;
}
const listCtx = { params: Promise.resolve({ eventId: "event-1" }) };
const facCtx = { params: Promise.resolve({ eventId: "event-1", facilityId: "f-1" }) };

function v2Facility(over: Record<string, unknown> = {}) {
  return {
    id: "f-1", event_id: "event-1", name: "무대", category: "stage", quantity: 1,
    status: "planned", vendor: "대행사", cost: 1500000, notes: "메모",
    created_at: "2026-07-27T00:00:00Z", updated_at: "2026-07-27T00:00:00Z", ...over,
  };
}

beforeEach(() => {
  poolQuery.mockReset();
  requireFeature.mockReset();
  requireFeature.mockResolvedValue(null); // 기본: 기능 활성
  for (const fn of [
    h.listOrganizerFacilities, h.createOrganizerFacility, h.patchOrganizerFacility,
    h.deleteOrganizerFacility, h.listOrganizerParticipants, h.createOrganizerParticipant,
    h.getOrganizerBridgePage, h.putOrganizerBridgePage,
  ]) fn.mockReset();
});

describe("facilities — W5-CONTENT", () => {
  it("목록: 내부 필드(vendor/cost/notes) 포함 화면 계약을 유지하고 go DB 를 쓰지 않는다", async () => {
    h.listOrganizerFacilities.mockResolvedValue({ facilities: [v2Facility()] });
    const res = await facGET(req({}), listCtx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(body.data[0]).toMatchObject({
      id: "f-1", name: "무대", category: "stage", quantity: 1, status: "planned",
      vendor: "대행사", cost: 1500000, notes: "메모",
    });
    expect(poolQuery).not.toHaveBeenCalled();
    expect(h.listOrganizerFacilities).toHaveBeenCalledWith("event-1", "acct-1");
  });

  it("기능 게이트가 막으면 v2 를 호출하지 않는다", async () => {
    requireFeature.mockResolvedValue(new Response("blocked", { status: 403 }));
    expect((await facGET(req({}), listCtx)).status).toBe(403);
    expect(h.listOrganizerFacilities).not.toHaveBeenCalled();
  });

  it("🔴 목록의 v2 장애는 503 — 빈 배열(=시설 0건)로 폴백하지 않는다", async () => {
    h.listOrganizerFacilities.mockRejectedValue(new h.V2CommerceError("boom", 502));
    expect((await facGET(req({}), listCtx)).status).toBe(503);
  });

  it("생성: 잘못된 카테고리는 400, 정상은 item_id 로 멱등 생성", async () => {
    expect((await facPOST(req({ name: "무대", category: "bad" }), listCtx)).status).toBe(400);
    expect((await facPOST(req({ name: "" }), listCtx)).status).toBe(400);
    expect(h.createOrganizerFacility).not.toHaveBeenCalled();

    h.createOrganizerFacility.mockResolvedValue(v2Facility());
    const res = await facPOST(req({ name: "무대", category: "stage", cost: 1500000 }), listCtx);
    expect(res.status).toBe(200);
    const [, organizerRef, itemId, input] = h.createOrganizerFacility.mock.calls[0]!;
    expect(organizerRef).toBe("acct-1");
    expect(String(itemId)).toMatch(/^[0-9a-f-]{36}$/);
    expect(input).toMatchObject({ name: "무대", category: "stage", cost: 1500000, quantity: 1 });
  });

  it("수정: 전달된 키만 patch, 잘못된 상태는 400", async () => {
    expect((await facPATCH(req({ status: "bad" }), facCtx)).status).toBe(400);
    h.patchOrganizerFacility.mockResolvedValue(v2Facility({ status: "confirmed" }));
    const res = await facPATCH(req({ status: "confirmed" }), facCtx);
    expect(res.status).toBe(200);
    expect(h.patchOrganizerFacility).toHaveBeenCalledWith("event-1", "acct-1", "f-1", {
      status: "confirmed",
    });
  });

  it("삭제: 없는 시설(v2 404)은 404, 🔴 v2 장애는 503(200 흡수 금지)", async () => {
    h.deleteOrganizerFacility.mockResolvedValue({ deleted: true, id: "f-1" });
    expect((await facDELETE(req({}), facCtx)).status).toBe(200);
    h.deleteOrganizerFacility.mockRejectedValue(new h.V2CommerceError("not found", 404));
    expect((await facDELETE(req({}), facCtx)).status).toBe(404);
    h.deleteOrganizerFacility.mockRejectedValue(new h.V2CommerceError("boom", 500));
    expect((await facDELETE(req({}), facCtx)).status).toBe(503);
  });
});

describe("participants 목록/생성 — W5-CONTENT", () => {
  it("주최자 목록은 숨김(is_visible=false) 항목도 포함해 내려준다(편집 화면)", async () => {
    h.listOrganizerParticipants.mockResolvedValue({
      participants: [
        { id: "p-1", name: "A", role: "performer", bio: null, image_url: null,
          sort_order: 0, is_visible: false, created_at: null, updated_at: null },
      ],
    });
    const body = (await (await partGET(req({}), listCtx)).json()) as {
      data: Array<Record<string, unknown>>;
    };
    expect(body.data[0]).toMatchObject({ id: "p-1", is_visible: false, sort_order: 0 });
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it("🔴 목록의 v2 장애는 503 — 빈 배열(=출연진 0명)로 폴백하지 않는다", async () => {
    h.listOrganizerParticipants.mockRejectedValue(new h.V2CommerceError("boom", 0));
    expect((await partGET(req({}), listCtx)).status).toBe(503);
  });

  it("생성: 이름 필수·역할 화이트리스트는 400, 정상은 item_id 멱등 생성", async () => {
    expect((await partPOST(req({ name: "" }), listCtx)).status).toBe(400);
    expect((await partPOST(req({ name: "A", role: "hacker" }), listCtx)).status).toBe(400);
    expect(h.createOrganizerParticipant).not.toHaveBeenCalled();

    h.createOrganizerParticipant.mockResolvedValue({
      id: "p-1", name: "A", role: "mc", bio: null, image_url: null,
      sort_order: 2, is_visible: true, created_at: null, updated_at: null,
    });
    const res = await partPOST(req({ name: "A", role: "mc", sortOrder: 2 }), listCtx);
    expect(res.status).toBe(200);
    const [, organizerRef, itemId, input] = h.createOrganizerParticipant.mock.calls[0]!;
    expect(organizerRef).toBe("acct-1");
    expect(String(itemId)).toMatch(/^[0-9a-f-]{36}$/);
    expect(input).toMatchObject({ name: "A", role: "mc", sort_order: 2 });
  });
});

describe("bridge-page — W5-CONTENT", () => {
  it("GET: v2 응답을 camelCase 화면 계약으로 매핑한다", async () => {
    h.getOrganizerBridgePage.mockResolvedValue({
      configured: true, is_active: true, title: "곧 시작", description: null,
      countdown_target: "2026-09-01T10:00:00Z", background_color: "#111", logo_url: null,
    });
    const body = (await (await bridgeGET(req({}), listCtx)).json()) as {
      data: Record<string, unknown>;
    };
    expect(body.data).toEqual({
      isActive: true, title: "곧 시작", description: null,
      countdownTarget: "2026-09-01T10:00:00Z", backgroundColor: "#111", logoUrl: null,
    });
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it("PUT: 빈 카운트다운 문자열은 null 로 저장(지움)", async () => {
    h.putOrganizerBridgePage.mockResolvedValue({
      configured: true, is_active: false, title: "", description: null,
      countdown_target: null, background_color: "#6C5CE7", logo_url: null,
    });
    await bridgePUT(req({ countdownTarget: "" }), listCtx);
    expect(h.putOrganizerBridgePage).toHaveBeenCalledWith("event-1", "acct-1", {
      is_active: false, title: "", description: null,
      countdown_target: null, background_color: "#6C5CE7", logo_url: null,
    });
  });

  it("🔴 v2 장애는 503, 미소유는 404", async () => {
    h.getOrganizerBridgePage.mockRejectedValue(new h.V2CommerceError("boom", 502));
    expect((await bridgeGET(req({}), listCtx)).status).toBe(503);
    h.getOrganizerBridgePage.mockRejectedValue(new h.V2CommerceError("not found", 404));
    expect((await bridgeGET(req({}), listCtx)).status).toBe(404);
  });
});
