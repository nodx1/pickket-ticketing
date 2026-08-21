import { beforeEach, describe, expect, it } from "vitest";

import {
  createTicketAccessCookie,
  ticketAccessCookieGrants,
  TICKET_ACCESS_TTL_MS,
} from "./access-cookie";
import { createInvitationToken } from "@/lib/invitation-token";
import { createTicketLinkToken } from "@/lib/ticket-link-token";

/**
 * 🔴 티켓 접근 쿠키 (2026-07-29 실사고 대응)
 *
 * 티켓 페이지는 딥링크 토큰을 인정했는데 아티팩트 API 4개는 세션·조회쿠키만 봤다.
 * 초대권 손님은 둘 다 없어 403 → **30초 뒤 QR 갱신이 죽고 게이트 스캔이 거부**됐다.
 * 이 쿠키가 그 간극을 메운다.
 */
beforeEach(() => {
  process.env.SESSION_SIGNING_KEY = "test-signing-key-0123456789abcdef";
});

const A = "TKT-AAAAAAAAAAAA";
const B = "TKT-BBBBBBBBBBBB";

describe("티켓 접근 쿠키", () => {
  it("발급한 티켓에는 접근을 허용한다", () => {
    expect(ticketAccessCookieGrants(createTicketAccessCookie({ ticketNumber: A }), A)).toBe(true);
  });

  it("🔴 다른 티켓에는 통하지 않는다 — 쿠키가 새도 그 한 장만 노출된다", () => {
    // 티켓번호 대조를 빼면 쿠키 하나로 **모든 티켓**이 열린다.
    expect(ticketAccessCookieGrants(createTicketAccessCookie({ ticketNumber: A }), B)).toBe(false);
  });

  it("🔴 만료된 쿠키는 거부", () => {
    const expired = createTicketAccessCookie({ ticketNumber: A, expiresAt: Date.now() - 1 });
    expect(ticketAccessCookieGrants(expired, A)).toBe(false);
  });

  it("🔴 서명을 조작하면 거부", () => {
    const [enc] = createTicketAccessCookie({ ticketNumber: A }).split(".");
    expect(ticketAccessCookieGrants(`${enc}.forged`, A)).toBe(false);
  });

  it("🔴 페이로드를 바꿔치기하면 서명이 깨진다(다른 티켓으로 위조 불가)", () => {
    const [, sig] = createTicketAccessCookie({ ticketNumber: A }).split(".");
    const forged = Buffer.from(JSON.stringify({ t: B, e: Date.now() + 60_000 })).toString("base64url");
    expect(ticketAccessCookieGrants(`${forged}.${sig}`, B)).toBe(false);
  });

  it("빈 값·형식 불량은 거부", () => {
    for (const bad of [null, undefined, "", "nodot", "a.b.c"]) {
      expect(ticketAccessCookieGrants(bad, A)).toBe(false);
    }
  });

  it("🔴 다른 종류의 토큰을 쿠키 자리에 넣어도 통하지 않는다(서명 스코프 격리)", () => {
    // 같은 서명키를 쓰지만 스코프 prefix 가 다르다. 섞이면 한쪽 취약점이 번진다.
    expect(ticketAccessCookieGrants(createInvitationToken({ ticketNumber: A, version: 0 }), A)).toBe(false);
    expect(ticketAccessCookieGrants(createTicketLinkToken({ ticketNumber: A }), A)).toBe(false);
  });

  it("기본 수명은 2시간 — 게이트 입장 한 세션을 덮는다", () => {
    expect(TICKET_ACCESS_TTL_MS).toBe(2 * 60 * 60 * 1000);
  });
});
