import { describe, expect, it } from "vitest";

import { deriveMessageType } from "./message-purpose";

/**
 * §3-1 회귀(C-03): messageType 은 채널·목적으로 서버가 강제한다. 클라이언트가 유형을 직접
 * 못 정하므로, 마케팅 목적을 정보성으로 위장해 동의·(광고)표기·야간가드를 우회할 수 없다.
 */
describe("deriveMessageType (§3-1 messageType 서버강제)", () => {
  it("알림톡은 목적과 무관하게 정보성 고정", () => {
    expect(deriveMessageType("kakao", "promotion").messageType).toBe("informational");
    expect(deriveMessageType("kakao", "sale").messageType).toBe("informational");
  });

  it("프로모션/판매촉진 → 광고성(우회 불가)", () => {
    expect(deriveMessageType("email", "promotion").messageType).toBe("advertising");
    expect(deriveMessageType("sms", "sale").messageType).toBe("advertising");
  });

  it("체크인/공지/리마인드 → 정보성", () => {
    expect(deriveMessageType("email", "checkin").messageType).toBe("informational");
    expect(deriveMessageType("email", "notice").messageType).toBe("informational");
    expect(deriveMessageType("sms", "reminder").messageType).toBe("informational");
  });

  it("목적 미지정은 안전하게 정보성으로 폴백하고 근거를 남긴다", () => {
    const r = deriveMessageType("email", undefined);
    expect(r.messageType).toBe("informational");
    expect(r.reason).toContain("미지정");
  });

  it("판정 근거를 항상 문자열로 반환(감사 기록용)", () => {
    expect(deriveMessageType("email", "promotion").reason).toContain("advertising");
    expect(deriveMessageType("kakao", "promotion").reason).toContain("정보성");
  });
});
