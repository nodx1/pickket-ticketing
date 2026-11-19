import { describe, expect, it } from "vitest";
import { needsLoginRedirect } from "@/lib/login-redirect-policy";

describe("needsLoginRedirect — 세션 만료 시 로그인 화면으로 보낼 화면", () => {
  it("공개 화면은 보내지 않는다(홈 화면 앱 첫 화면이 로그인으로 튕기지 않게)", () => {
    for (const p of ["/", "/en", "/events", "/events/abc", "/events/abc/booking", "/fairness/certificates/PKT-FC-2026-000007", "/ja/events/abc"]) {
      expect(needsLoginRedirect(p)).toBe(false);
    }
  });

  it("로그인이 꼭 필요한 화면은 보낸다(언어 경로 포함)", () => {
    for (const p of ["/mypage", "/mypage/edit", "/orders/1", "/tickets/1", "/en/notifications", "/zh-CN/orders", "/events/abc/edit", "/events/create"]) {
      expect(needsLoginRedirect(p)).toBe(true);
    }
  });

  it("비슷한 이름의 공개 화면과 헷갈리지 않는다", () => {
    expect(needsLoginRedirect("/ordersx")).toBe(false);
    expect(needsLoginRedirect("/mypages")).toBe(false);
  });
});
