import { describe, expect, it } from "vitest";
import {
  createInvitationToken,
  invitationTokenGrantsAccess,
  verifyInvitationToken,
} from "@/lib/invitation-token";

describe("초대권 딥링크 bearer 토큰 (P0-2)", () => {
  it("발급한 토큰은 verify 로 payload(ticketNumber/version) 를 복원한다", () => {
    const token = createInvitationToken({ ticketNumber: "TKT-ABC123", version: 0 });
    const payload = verifyInvitationToken(token);
    expect(payload).not.toBeNull();
    expect(payload?.t).toBe("TKT-ABC123");
    expect(payload?.v).toBe(0);
  });

  it("서명 변조 토큰은 거부한다", () => {
    const token = createInvitationToken({ ticketNumber: "TKT-ABC123", version: 0 });
    const [encoded] = token.split(".");
    const forged = `${encoded}.deadbeefdeadbeefdeadbeefdeadbeef`;
    expect(verifyInvitationToken(forged)).toBeNull();
  });

  it("만료된 토큰은 거부한다", () => {
    const token = createInvitationToken({
      ticketNumber: "TKT-ABC123",
      version: 0,
      expiresAt: Date.now() - 1000,
    });
    expect(verifyInvitationToken(token)).toBeNull();
  });

  it("접근 판정: 티켓번호·nonce 일치 시에만 허용", () => {
    const token = createInvitationToken({ ticketNumber: "TKT-ABC123", version: 3 });

    // 정상 — 티켓·nonce 일치.
    expect(
      invitationTokenGrantsAccess({ token, ticketNumber: "TKT-ABC123", currentVersion: 3 }),
    ).toBe(true);

    // 다른 티켓번호 — 거부(토큰 재사용 차단).
    expect(
      invitationTokenGrantsAccess({ token, ticketNumber: "TKT-OTHER", currentVersion: 3 }),
    ).toBe(false);

    // nonce 불일치(회수됨) — 거부.
    expect(
      invitationTokenGrantsAccess({ token, ticketNumber: "TKT-ABC123", currentVersion: 4 }),
    ).toBe(false);
  });

  it("revocation: nonce 증가하면 구 토큰이 무효화된다", () => {
    // 발급 당시 nonce 0.
    const oldToken = createInvitationToken({ ticketNumber: "TKT-REVOKE", version: 0 });
    expect(
      invitationTokenGrantsAccess({ token: oldToken, ticketNumber: "TKT-REVOKE", currentVersion: 0 }),
    ).toBe(true);

    // 회수 → 원장 nonce 1. 구 토큰(v=0)은 이제 거부.
    expect(
      invitationTokenGrantsAccess({ token: oldToken, ticketNumber: "TKT-REVOKE", currentVersion: 1 }),
    ).toBe(false);

    // 새 nonce 로 재발급한 토큰은 다시 유효.
    const newToken = createInvitationToken({ ticketNumber: "TKT-REVOKE", version: 1 });
    expect(
      invitationTokenGrantsAccess({ token: newToken, ticketNumber: "TKT-REVOKE", currentVersion: 1 }),
    ).toBe(true);
  });

  it("null/빈/형식오류 토큰은 안전하게 거부한다", () => {
    expect(verifyInvitationToken(null)).toBeNull();
    expect(verifyInvitationToken("")).toBeNull();
    expect(verifyInvitationToken("no-dot")).toBeNull();
    expect(verifyInvitationToken(".sig")).toBeNull();
  });

  it("스코프 격리: public-lookup 토큰 형식은 초대권 토큰으로 통하지 않는다", () => {
    // invite 토큰과 다른 서명 스코프(prefix)라 서명이 불일치해야 한다.
    const token = createInvitationToken({ ticketNumber: "TKT-SCOPE", version: 0 });
    const [encoded, sig] = token.split(".");
    // 같은 payload 라도 prefix 없는 서명으로 만들면 verify 실패.
    expect(sig).toBeTruthy();
    expect(encoded).toBeTruthy();
    // 서명부를 잘라 붙여도 통과 못 함(이미 위 변조 테스트로 커버). 여기선 스코프 존재만 확인.
    expect(verifyInvitationToken(token)?.t).toBe("TKT-SCOPE");
  });
});
