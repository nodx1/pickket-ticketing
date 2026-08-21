import { beforeEach, describe, expect, it } from "vitest";

import {
  buildTicketLinkUrl,
  createTicketLinkToken,
  ticketLinkGrantsAccess,
  verifyTicketLinkToken,
} from "./ticket-link-token";
import { createInvitationToken } from "./invitation-token";

beforeEach(() => {
  process.env.SESSION_SIGNING_KEY = "test-signing-key-0123456789abcdef";
});

const TKT = "TKT-ABCDEF123456";

describe("ticket-link-token — 유료 티켓 딥링크", () => {
  it("정상 토큰 + active 티켓이면 열람 허용", () => {
    const token = createTicketLinkToken({ ticketNumber: TKT });
    expect(ticketLinkGrantsAccess({ token, ticketNumber: TKT, status: "active" })).toBe(true);
  });

  it("체크인 완료(used) 티켓도 열람 가능 — 입장 후에도 본인 티켓을 봐야 한다", () => {
    const token = createTicketLinkToken({ ticketNumber: TKT });
    expect(ticketLinkGrantsAccess({ token, ticketNumber: TKT, status: "used" })).toBe(true);
  });

  it.each(["cancelled", "expired", "transferred"])(
    "🔴 %s 티켓은 링크가 있어도 열리지 않는다 — 상태가 곧 무효화 장치다",
    (status) => {
      // 환불했는데 QR 이 계속 보이면 현장에서 분쟁이 난다.
      const token = createTicketLinkToken({ ticketNumber: TKT });
      expect(ticketLinkGrantsAccess({ token, ticketNumber: TKT, status })).toBe(false);
    },
  );

  it("🔴 pending 티켓도 열람 가능 — 결제확정 비동기 outbox 중 클릭한 손님을 막지 않는다 (2026-08-20 실사고)", () => {
    const token = createTicketLinkToken({ ticketNumber: TKT });
    expect(ticketLinkGrantsAccess({ token, ticketNumber: TKT, status: "pending" })).toBe(true);
  });

  it("🔴 다른 티켓번호에는 통하지 않는다(바인딩)", () => {
    const token = createTicketLinkToken({ ticketNumber: TKT });
    expect(
      ticketLinkGrantsAccess({ token, ticketNumber: "TKT-OTHER0000000", status: "active" }),
    ).toBe(false);
  });

  // 🔴 2026-08-21 계약 변경 — 만료에 **유예**를 둔다.
  //    종전 계약("만료 즉시 거부")이 대회 둘째 날 아침에 이미 나간 링크를 전부 죽였다.
  //    발급 만료가 `event_date`(시작일) + 1일이었기 때문이다. 발급은 종료일 기준으로
  //    고쳤지만, **이미 나간 토큰은 못 바꾼다** — 검증 유예가 유일한 복구 경로다.
  it("🔴 만료 직후에는 유예로 통과 — 대회 중 손님이 갇히면 안 된다", () => {
    const token = createTicketLinkToken({ ticketNumber: TKT, expiresAt: Date.now() - 1000 });
    expect(verifyTicketLinkToken(token)).not.toBeNull();
    expect(ticketLinkGrantsAccess({ token, ticketNumber: TKT, status: "active" })).toBe(true);
  });

  it("🔴 유예를 한참 지나면 거부 — 무제한이 아니다", () => {
    const old = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const token = createTicketLinkToken({ ticketNumber: TKT, expiresAt: old });
    expect(verifyTicketLinkToken(token)).toBeNull();
    expect(ticketLinkGrantsAccess({ token, ticketNumber: TKT, status: "active" })).toBe(false);
  });

  it("🔴 서명이 조작되면 거부", () => {
    const token = createTicketLinkToken({ ticketNumber: TKT });
    const [encoded] = token.split(".");
    expect(ticketLinkGrantsAccess({ token: `${encoded}.forged`, ticketNumber: TKT, status: "active" })).toBe(false);
  });

  it("🔴 페이로드를 바꾸면 서명이 깨진다(다른 티켓으로 위조 불가)", () => {
    const token = createTicketLinkToken({ ticketNumber: TKT });
    const [, signature] = token.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({ t: "TKT-VICTIM00000", e: Date.now() + 60_000 }),
    ).toString("base64url");
    expect(
      ticketLinkGrantsAccess({
        token: `${forgedPayload}.${signature}`,
        ticketNumber: "TKT-VICTIM00000",
        status: "active",
      }),
    ).toBe(false);
  });

  it("빈 토큰·형식 불량은 거부", () => {
    for (const bad of [null, undefined, "", "nodot", "a.b.c.d"]) {
      expect(ticketLinkGrantsAccess({ token: bad, ticketNumber: TKT, status: "active" })).toBe(false);
    }
  });

  it("🔴 초대권 토큰으로 유료 티켓을 열 수 없다(서명 스코프 격리)", () => {
    // 같은 서명키를 쓰지만 prefix 가 다르다. 섞이면 한쪽 취약점이 다른 쪽으로 번진다.
    const inviteToken = createInvitationToken({ ticketNumber: TKT, version: 0 });
    expect(ticketLinkGrantsAccess({ token: inviteToken, ticketNumber: TKT, status: "active" })).toBe(false);
  });

  it("URL 은 승인 템플릿 링크 형식과 같다", () => {
    const token = createTicketLinkToken({ ticketNumber: TKT });
    const url = buildTicketLinkUrl({ origin: "https://go.pickket.kr/", ticketNumber: TKT, token });
    // 승인본: https://go.pickket.kr/tickets/#{티켓번호}?t=#{토큰}
    expect(url).toBe(`https://go.pickket.kr/tickets/${TKT}?t=${token}`);
  });
});
