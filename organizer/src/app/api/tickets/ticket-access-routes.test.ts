import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 🔴 티켓 접근 교환 + 아티팩트 접근 판정.
 *
 * 이 두 곳은 이번 변경에서 **보안이 가장 중요한 자리**인데 테스트가 없었다.
 * 실측(뮤테이션): 교환 라우트에서 토큰 검증을 통째로 지워도, 아티팩트 판정에서
 * 티켓 대조를 지워도 **1478건이 전부 초록불**이었다.
 * "테스트가 없다" 가 아니라 **"테스트가 닿지 않는다"** 는 게 더 위험하다 —
 * 커버리지 숫자로는 안 보인다.
 *
 * 배경 실사고(2026-07-29): 티켓 페이지는 딥링크 토큰을 인정하는데 아티팩트 API 4개는
 * 세션·조회쿠키만 봐서 403 → 30초 뒤 QR 갱신이 죽고 게이트 스캔이 거부됐다.
 */

const h = vi.hoisted(() => {
  class FakeV2Error extends Error {
    status: number;
    constructor(msg: string, status: number) {
      super(msg);
      this.status = status;
    }
  }
  return {
  FakeV2Error,
  cookieGet: vi.fn(),
  resolveTicketArtifactContext: vi.fn(),
  getInvitationByTicketNumber: vi.fn(),
  verifySession: vi.fn(),
  verifyPublicLookupToken: vi.fn(),
  matchesPublicLookup: vi.fn(),
  };
});

vi.mock("next/headers", () => ({ cookies: async () => ({ get: h.cookieGet }) }));
vi.mock("@/lib/ticket/artifact-context", () => ({
  resolveTicketArtifactContext: (...a: unknown[]) => h.resolveTicketArtifactContext(...a),
  TicketArtifactNotFoundError: class extends Error {},
  TicketArtifactUpstreamError: class extends Error {},
}));
vi.mock("@/lib/v2/commerce-client", () => ({
  getInvitationByTicketNumber: (...a: unknown[]) => h.getInvitationByTicketNumber(...a),
  V2CommerceError: h.FakeV2Error,
}));
vi.mock("@/lib/auth/session", () => ({ verifySession: (...a: unknown[]) => h.verifySession(...a) }));
vi.mock("@/lib/public-access", () => ({
  PUBLIC_LOOKUP_COOKIE: "pkt_lookup",
  verifyPublicLookupToken: (...a: unknown[]) => h.verifyPublicLookupToken(...a),
  matchesPublicLookup: (...a: unknown[]) => h.matchesPublicLookup(...a),
}));

import { POST as accessRoute } from "./[ticketNumber]/access/route";
import { canAccessTicketArtifact } from "@/lib/ticket/access";
import { createInvitationToken } from "@/lib/invitation-token";
import { createTicketLinkToken } from "@/lib/ticket-link-token";
import { createTicketAccessCookie, TICKET_ACCESS_COOKIE } from "@/lib/ticket/access-cookie";

const TKT = "TKT-AAAAAAAAAAAA";
const OTHER = "TKT-BBBBBBBBBBBB";

function req(body: unknown) {
  return new Request(`http://localhost/api/tickets/${TKT}/access`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof accessRoute>[0];
}
const params = { params: Promise.resolve({ ticketNumber: TKT }) };

beforeEach(() => {
  process.env.SESSION_SIGNING_KEY = "test-signing-key-0123456789abcdef";
  h.cookieGet.mockReset().mockReturnValue(undefined);
  h.verifySession.mockReset().mockResolvedValue(null);
  h.verifyPublicLookupToken.mockReset().mockReturnValue(null);
  h.matchesPublicLookup.mockReset().mockReturnValue(false);
  h.resolveTicketArtifactContext.mockReset().mockResolvedValue({
    ticketNumber: TKT, status: "active", buyerEmail: "a@b.c", buyerPhone: "01011112222",
    eventAccountId: "acc-1",
  });
  h.getInvitationByTicketNumber.mockReset().mockResolvedValue({ invitation: { token_version: 0 } });
});

describe("POST /api/tickets/[n]/access — 딥링크 → 접근 쿠키 교환", () => {
  it("유효한 초대권 토큰이면 쿠키를 발급한다", async () => {
    const res = await accessRoute(req({ token: createInvitationToken({ ticketNumber: TKT, version: 0 }) }), params);
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain(TICKET_ACCESS_COOKIE);
  });

  it("🔴 토큰이 없으면 400 — 쿠키를 주지 않는다", async () => {
    const res = await accessRoute(req({}), params);
    expect(res.status).toBe(400);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("🔴 서명이 틀린 토큰은 403 — 아무 문자열로 접근권을 얻을 수 없다", async () => {
    const res = await accessRoute(req({ token: "bogus.token" }), params);
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("🔴 다른 티켓의 토큰으로는 이 티켓 접근권을 못 얻는다", async () => {
    const res = await accessRoute(req({ token: createInvitationToken({ ticketNumber: OTHER, version: 0 }) }), params);
    expect(res.status).toBe(403);
  });

  it("🔴 회수된 초대권(nonce 불일치)은 403", async () => {
    // 주최자가 회수하면 원장의 token_version 이 오른다 — 옛 링크는 죽어야 한다.
    h.getInvitationByTicketNumber.mockResolvedValue({ invitation: { token_version: 3 } });
    const res = await accessRoute(req({ token: createInvitationToken({ ticketNumber: TKT, version: 0 }) }), params);
    expect(res.status).toBe(403);
  });

  it("만료된 토큰은 403", async () => {
    const t = createInvitationToken({ ticketNumber: TKT, version: 0, expiresAt: Date.now() - 1000 });
    expect((await accessRoute(req({ token: t }), params)).status).toBe(403);
  });

  it("유료 티켓(초대권 원장 없음)은 티켓 딥링크 토큰으로 통과한다", async () => {
    h.getInvitationByTicketNumber.mockResolvedValue({ invitation: null });
    const res = await accessRoute(req({ token: createTicketLinkToken({ ticketNumber: TKT }) }), params);
    expect(res.status).toBe(200);
  });

  it("🔴 환불·양도된 유료 티켓은 링크가 있어도 403 — 상태가 무효화 장치다", async () => {
    h.getInvitationByTicketNumber.mockResolvedValue({ invitation: null });
    h.resolveTicketArtifactContext.mockResolvedValue({
      ticketNumber: TKT, status: "cancelled", buyerEmail: null, buyerPhone: null, eventAccountId: "acc-1",
    });
    const res = await accessRoute(req({ token: createTicketLinkToken({ ticketNumber: TKT }) }), params);
    expect(res.status).toBe(403);
  });

  it("🔴 초대 원장 조회 실패는 502 — '초대권 아님'으로 흘리지 않는다", async () => {
    // 조용히 거부하면 정당한 초대객이 막히고 그 이유가 어디에도 안 남는다.
    h.getInvitationByTicketNumber.mockRejectedValue(new h.FakeV2Error("down", 503));
    const res = await accessRoute(req({ token: createInvitationToken({ ticketNumber: TKT, version: 0 }) }), params);
    expect(res.status).toBe(502);
  });
});

describe("canAccessTicketArtifact — 접근 쿠키 판정", () => {
  it("이 티켓의 접근 쿠키면 허용한다", async () => {
    h.cookieGet.mockImplementation((k: string) =>
      k === TICKET_ACCESS_COOKIE ? { value: createTicketAccessCookie({ ticketNumber: TKT }) } : undefined,
    );
    expect(await canAccessTicketArtifact(null, null, "acc-1", TKT)).toBe(true);
  });

  it("🔴 다른 티켓의 쿠키로는 열리지 않는다 — 쿠키 하나로 전 티켓이 열리면 안 된다", async () => {
    h.cookieGet.mockImplementation((k: string) =>
      k === TICKET_ACCESS_COOKIE ? { value: createTicketAccessCookie({ ticketNumber: OTHER }) } : undefined,
    );
    expect(await canAccessTicketArtifact(null, null, "acc-1", TKT)).toBe(false);
  });

  it("🔴 티켓번호를 안 넘기면 쿠키 경로가 적용되지 않는다(호출부 누락 감지)", async () => {
    h.cookieGet.mockImplementation((k: string) =>
      k === TICKET_ACCESS_COOKIE ? { value: createTicketAccessCookie({ ticketNumber: TKT }) } : undefined,
    );
    expect(await canAccessTicketArtifact(null, null, "acc-1")).toBe(false);
  });

  it("위조된 쿠키는 거부", async () => {
    h.cookieGet.mockImplementation((k: string) =>
      k === TICKET_ACCESS_COOKIE ? { value: "forged.value" } : undefined,
    );
    expect(await canAccessTicketArtifact(null, null, "acc-1", TKT)).toBe(false);
  });

  it("쿠키가 없어도 주최자 세션이면 기존대로 허용(회귀)", async () => {
    h.verifySession.mockResolvedValue({ accountId: "acc-1" });
    expect(await canAccessTicketArtifact(null, null, "acc-1", TKT)).toBe(true);
  });

  it("쿠키가 없어도 구매자 조회쿠키가 맞으면 기존대로 허용(회귀)", async () => {
    h.verifyPublicLookupToken.mockReturnValue({ email: "a@b.c", phone: "01011112222" });
    h.matchesPublicLookup.mockReturnValue(true);
    expect(await canAccessTicketArtifact("a@b.c", "01011112222", "acc-1", TKT)).toBe(true);
  });
});
