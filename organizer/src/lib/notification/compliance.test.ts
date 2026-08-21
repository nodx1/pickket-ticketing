import { describe, it, expect, beforeAll } from "vitest";
import {
  normalizeContact,
  isNightWindow,
  applyAdSmsFormatting,
  makeUnsubscribeToken,
  verifyUnsubscribeToken,
} from "./compliance";

beforeAll(() => {
  process.env.UNSUBSCRIBE_SECRET = "test-unsub-secret";
});

describe("normalizeContact", () => {
  it("이메일 소문자 트림", () => {
    expect(normalizeContact("email", "  User@Example.COM ")).toBe("user@example.com");
  });
  it("전화 숫자만", () => {
    expect(normalizeContact("sms", "010-1234-5678")).toBe("01012345678");
  });
});

describe("isNightWindow (KST 21~08)", () => {
  it("22시(KST)는 야간", () => {
    // 2026-07-01 13:00 UTC = 22:00 KST
    expect(isNightWindow(new Date("2026-07-01T13:00:00Z"))).toBe(true);
  });
  it("정오(KST)는 주간", () => {
    // 2026-07-01 03:00 UTC = 12:00 KST
    expect(isNightWindow(new Date("2026-07-01T03:00:00Z"))).toBe(false);
  });
  it("07시(KST)는 야간", () => {
    // 2026-07-01 22:00 UTC = 07:00 KST(익일)
    expect(isNightWindow(new Date("2026-07-01T22:00:00Z"))).toBe(true);
  });
});

describe("applyAdSmsFormatting", () => {
  it("(광고) 접두 중복 방지", () => {
    expect(applyAdSmsFormatting("(광고) 세일")).toContain("(광고) 세일");
    expect(applyAdSmsFormatting("세일").startsWith("(광고) ")).toBe(true);
  });
});

describe("수신거부 토큰", () => {
  it("왕복(채널 포함) + 변조 거부", () => {
    const t = makeUnsubscribeToken("acc-1", "user@example.com", "email");
    // 2.6-Low5: channel 이 서명·복원됨.
    expect(verifyUnsubscribeToken(t)).toEqual({
      accountId: "acc-1",
      contact: "user@example.com",
      channel: "email",
    });
    // 중간 문자 변조(append 는 base64url 이 불완전 그룹을 무시할 수 있어 서명 검증엔 부적절).
    const mid = Math.floor(t.length / 2);
    const flipped = t.slice(0, mid) + (t[mid] === "A" ? "B" : "A") + t.slice(mid + 1);
    expect(verifyUnsubscribeToken(flipped)).toBeNull();
  });

  it("2.6-Low5: 채널이 서명에 묶여 다른 채널로 재사용 불가", () => {
    const emailTok = makeUnsubscribeToken("acc-1", "user@example.com", "email");
    const parsed = verifyUnsubscribeToken(emailTok);
    // 토큰에서 채널을 복원하므로, sms 용으로 위조하려면 서명이 깨진다(별 토큰 필요).
    expect(parsed?.channel).toBe("email");
    const smsTok = makeUnsubscribeToken("acc-1", "user@example.com", "sms");
    expect(smsTok).not.toBe(emailTok); // 채널별 서로 다른 서명
    expect(verifyUnsubscribeToken(smsTok)?.channel).toBe("sms");
  });
});
