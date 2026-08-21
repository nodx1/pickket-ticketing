import { describe, expect, it, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  fetchOrganizerAccount: vi.fn(),
  patchOrganizerAccount: vi.fn(),
  V2AccountError: class V2AccountError extends Error {
    constructor(message: string, readonly status: number) {
      super(message);
      this.name = "V2AccountError";
    }
  },
}));

vi.mock("@/lib/v2/organizer-account-client", () => ({
  fetchOrganizerAccount: h.fetchOrganizerAccount,
  patchOrganizerAccount: h.patchOrganizerAccount,
  V2AccountError: h.V2AccountError,
}));
// 세션은 v2 SSOT 라 라우트 테스트에서는 통과시키고 session 만 주입한다.
vi.mock("@/lib/auth/withAuth", () => ({
  withAuth: (handler: unknown) => (request: Request, ctx: { session: unknown }) =>
    (handler as (r: Request, c: unknown) => Promise<Response>)(request, ctx),
}));
vi.mock("@/lib/auth/permissions", () => ({
  withRole: (_role: string, handler: unknown) => (request: Request, ctx: { session: unknown }) =>
    (handler as (r: Request, c: unknown) => Promise<Response>)(request, ctx),
}));

import { GET as accountGet, PATCH as accountPatch } from "./route";
import { GET as settingsGet } from "./settings/route";
import { GET as notifGet, PATCH as notifPatch } from "./notifications/route";

const session = { id: "u1", accountId: "acc-1", role: "owner" };
const ctx = { session } as never;

const V2_ACCOUNT = {
  id: "prof-1",
  name: "홍길동",
  email: "owner@pickket.kr",
  phone: "01012345678",
  company_name: "주식회사 피켓",
  business_number: "851-81-04102",
  representative_name: "곽민철",
  contact_email: "support@pickket.kr",
  contact_phone: "07080805606",
  slug: "pickket",
  status: "approved",
  timezone: "Asia/Seoul",
  currency: "KRW",
  is_active: true,
  notification_prefs: { orders: false },
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-27T00:00:00Z",
};

const call = (fn: unknown, body?: unknown) =>
  (fn as (r: Request, c: unknown) => Promise<Response>)(
    new Request("https://go.pickket.kr/api/account", {
      method: body ? "PATCH" : "GET",
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    }),
    ctx,
  );

/**
 * 레벨2 컷오버 T1 — 계정/설정/알림의 정본이 go `accounts` → v2 `organizer_profiles`.
 *
 * 🔴 이 파일이 고정하는 핵심 계약은 **실패 의미의 구분**이다.
 *    go accounts 가 비워졌을 때 "데이터 없음"과 "읽지 못함"이 똑같이 404 로 나와
 *    프로덕션 파손을 오래 찾지 못했다. 없음=404 / v2 장애=503 을 못박는다.
 */
describe("T1: 계정 화면 v2 전환", () => {
  beforeEach(() => vi.clearAllMocks());

  it("GET /account — v2 프로필을 기존 응답 계약으로 매핑한다", async () => {
    h.fetchOrganizerAccount.mockResolvedValue(V2_ACCOUNT);
    const res = await call(accountGet);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      name: "홍길동",
      email: "owner@pickket.kr",
      phone: "01012345678",
      companyName: "주식회사 피켓",
      businessNumber: "851-81-04102",
      contactEmail: "support@pickket.kr",
      contactPhone: "07080805606",
    });
    expect(h.fetchOrganizerAccount).toHaveBeenCalledWith("acc-1");
  });

  it("GET /account — 프로필이 없으면 404", async () => {
    h.fetchOrganizerAccount.mockResolvedValue(null);
    expect((await call(accountGet)).status).toBe(404);
  });

  it("🔴 GET /account — v2 장애는 404 가 아니라 503", async () => {
    h.fetchOrganizerAccount.mockRejectedValue(new h.V2AccountError("v2 down", 500));
    expect((await call(accountGet)).status).toBe(503);
  });

  it("PATCH /account — v2 로 수정 전달, 장애 시 503", async () => {
    const patch = {
      name: "홍길동",
      companyName: "주식회사 피켓",
      businessNumber: "851-81-04102",
      contactEmail: "support@pickket.kr",
      contactPhone: "07080805606",
    };
    h.patchOrganizerAccount.mockResolvedValue(V2_ACCOUNT);
    expect((await call(accountPatch, patch)).status).toBe(200);
    expect(h.patchOrganizerAccount).toHaveBeenCalledWith(
      "acc-1",
      expect.objectContaining({ company_name: "주식회사 피켓" }),
    );

    h.patchOrganizerAccount.mockRejectedValue(new h.V2AccountError("v2 down", 502));
    expect((await call(accountPatch, patch)).status).toBe(503);
  });

  it("GET /account/settings — 종전 필드 구성을 유지한다", async () => {
    h.fetchOrganizerAccount.mockResolvedValue(V2_ACCOUNT);
    const body = await (await call(settingsGet)).json();
    expect(body.data).toMatchObject({
      id: "prof-1",
      name: "주식회사 피켓",
      slug: "pickket",
      timezone: "Asia/Seoul",
      currency: "KRW",
      businessNumber: "851-81-04102",
      isActive: true,
    });
  });

  it("🔴 GET /account/settings — v2 장애는 503", async () => {
    h.fetchOrganizerAccount.mockRejectedValue(new h.V2AccountError("v2 down", 500));
    expect((await call(settingsGet)).status).toBe(503);
  });

  it("GET /account/notifications — 부분 저장값을 6키로 정규화한다", async () => {
    h.fetchOrganizerAccount.mockResolvedValue(V2_ACCOUNT); // orders:false 만 저장됨
    const body = await (await call(notifGet)).json();
    expect(body.data).toEqual({
      orders: false,
      sold_out: true,
      refunds: true,
      payment_failed: true,
      check_in: true,
      ai: true,
    });
  });

  it("PATCH /account/notifications — 부분 필드만 v2 로 보내고 결과를 정규화한다", async () => {
    h.patchOrganizerAccount.mockResolvedValue({
      ...V2_ACCOUNT,
      notification_prefs: { orders: false, ai: false },
    });
    const body = await (await call(notifPatch, { ai: false })).json();
    expect(h.patchOrganizerAccount).toHaveBeenCalledWith("acc-1", { notification_prefs: { ai: false } });
    expect(body.data).toMatchObject({ orders: false, ai: false, refunds: true });
  });

  it("🔴 PATCH /account/notifications — v2 장애는 503", async () => {
    h.patchOrganizerAccount.mockRejectedValue(new h.V2AccountError("v2 down", 503));
    expect((await call(notifPatch, { ai: false })).status).toBe(503);
  });
});
