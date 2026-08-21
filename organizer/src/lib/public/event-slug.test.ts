import { describe, expect, it } from "vitest";
import { normalizeEventSlug } from "./event-slug";

/**
 * 🔴 2026-07-27 prod 실결함 회귀 — 한글 slug 이벤트의 **구매 경로 전면 404**.
 *
 * 이벤트 상세 페이지에만 디코딩 방어가 있었고 checkout 계열 7개 라우트엔 없었다.
 * 상세는 열리는데 "티켓 구매하기"를 누르면 404 → 판매 전면 차단이면서 원인 짐작이 어렵다.
 */
describe("normalizeEventSlug", () => {
  it("percent-encoded 한글 slug 를 디코딩한다", () => {
    const raw = encodeURIComponent("bc카드한경-제48회-klpga-챔피언십");
    expect(normalizeEventSlug(raw)).toBe("bc카드한경-제48회-klpga-챔피언십");
  });

  it("이미 디코딩된 값은 그대로 둔다(이중 디코딩 금지)", () => {
    expect(normalizeEventSlug("bc카드한경-제48회")).toBe("bc카드한경-제48회");
  });

  it("영문 slug 는 변형하지 않는다", () => {
    expect(normalizeEventSlug("klpga-2026-championship")).toBe("klpga-2026-championship");
  });

  it("잘못된 인코딩은 던지지 않고 원본을 돌려준다(404 로 떨어지게 — 500 금지)", () => {
    expect(normalizeEventSlug("%E0%A4%A")).toBe("%E0%A4%A");
    expect(normalizeEventSlug("100%-할인")).toBe("100%-할인");
  });
});
