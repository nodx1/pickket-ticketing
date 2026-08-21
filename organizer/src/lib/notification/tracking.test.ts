import { describe, it, expect, beforeAll } from "vitest";
import {
  makeTrackingToken,
  verifyTrackingToken,
  injectEmailTracking,
  makeClickToken,
  verifyClickToken,
} from "./tracking";
import { maskPII } from "@/lib/logger";

beforeAll(() => {
  process.env.MESSAGE_TRACKING_SECRET = "test-secret-fixed";
});

describe("트래킹 토큰", () => {
  it("서명 왕복 — messageId·contact 복원", () => {
    const t = makeTrackingToken("msg-123", "user@example.com");
    expect(verifyTrackingToken(t)).toEqual({ messageId: "msg-123", contact: "user@example.com" });
  });

  it("변조 토큰 거부", () => {
    const t = makeTrackingToken("msg-123", "user@example.com");
    const mid = Math.floor(t.length / 2);
    const flipped = t.slice(0, mid) + (t[mid] === "A" ? "B" : "A") + t.slice(mid + 1);
    expect(verifyTrackingToken(flipped)).toBeNull();
    expect(verifyTrackingToken("garbage")).toBeNull();
  });

  it("다른 시크릿으로 만든 토큰은 거부", () => {
    const t = makeTrackingToken("m", "c@c.com");
    process.env.MESSAGE_TRACKING_SECRET = "other-secret";
    expect(verifyTrackingToken(t)).toBeNull();
    process.env.MESSAGE_TRACKING_SECRET = "test-secret-fixed";
  });
});

describe("injectEmailTracking", () => {
  it("</body> 앞에 픽셀 주입 + http 링크 래핑", () => {
    const html = `<html><body><p>hi</p><a href="https://pickket.kr/e/1">보기</a></body></html>`;
    const out = injectEmailTracking(html, "m1", "c@c.com");
    expect(out).toContain("/api/track/open?t=");
    expect(out).toContain("/api/track/click?t=");
    expect(out).toContain(encodeURIComponent("https://pickket.kr/e/1"));
    // 픽셀은 body 닫기 전.
    expect(out.indexOf("/api/track/open")).toBeLessThan(out.indexOf("</body>"));
  });

  it("수신거부·트래킹 링크는 래핑하지 않음", () => {
    const html = `<a href="https://go.pickket.kr/api/public/unsubscribe?token=x">수신거부</a>`;
    const out = injectEmailTracking(html, "m1", "c@c.com");
    expect(out).toContain("/api/public/unsubscribe?token=x");
    expect(out).not.toContain("/api/track/click?t=");
  });
});

describe("verifyClickToken (H-04 오픈 리다이렉트 방어 — URL 바인딩)", () => {
  const MSG = "msg-uuid";
  const CONTACT = "buyer@example.com";
  const GOOD = "https://pickket.kr/e/my-event";
  const EVIL = "https://evil.com/phish";

  it("서명된 URL 과 동일하면 검증 통과", () => {
    const token = makeClickToken(MSG, CONTACT, GOOD);
    expect(verifyClickToken(token, GOOD)).toEqual({ messageId: MSG, contact: CONTACT });
  });

  it("다른 URL(피싱)로는 검증 실패 → 리다이렉트 금지", () => {
    const token = makeClickToken(MSG, CONTACT, GOOD);
    expect(verifyClickToken(token, EVIL)).toBeNull();
  });

  it("변조·쓰레기 토큰 거부", () => {
    const token = makeClickToken(MSG, CONTACT, GOOD);
    // 중간 문자 뒤집기(append 는 base64url 정렬상 동일 디코드가 될 수 있어 사용 안 함).
    const mid = Math.floor(token.length / 2);
    const flipped = token.slice(0, mid) + (token[mid] === "A" ? "B" : "A") + token.slice(mid + 1);
    expect(verifyClickToken(flipped, GOOD)).toBeNull();
    expect(verifyClickToken("garbage", GOOD)).toBeNull();
  });

  it("다른 시크릿으로 위조한 토큰 거부", () => {
    process.env.MESSAGE_TRACKING_SECRET = "attacker-guess";
    const forged = makeClickToken(MSG, CONTACT, EVIL);
    process.env.MESSAGE_TRACKING_SECRET = "test-secret-fixed";
    expect(verifyClickToken(forged, EVIL)).toBeNull();
  });
});

describe("PII 마스킹", () => {
  it("전화번호", () => {
    expect(maskPII("010-1234-5678")).toBe("010****5678");
  });
  it("이메일", () => {
    expect(maskPII("honggildong@example.com")).toBe("ho***@example.com");
  });
  it("일반 문자열은 그대로", () => {
    expect(maskPII("고객명")).toBe("고객명");
  });
});
