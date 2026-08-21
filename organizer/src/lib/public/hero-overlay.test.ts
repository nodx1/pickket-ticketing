import { describe, expect, it } from "vitest";

import { showsHeroOverlay } from "./hero-overlay";

describe("showsHeroOverlay", () => {
  it("명시적 false 일 때만 끈다", () => {
    expect(showsHeroOverlay(false)).toBe(false);
  });

  it("true 면 켠다", () => {
    expect(showsHeroOverlay(true)).toBe(true);
  });

  it.each([undefined, null, "", "false", 0, {}])(
    "미설정·잘못된 값(%s)은 켠다 — 기존 행사가 한꺼번에 바뀌면 안 된다",
    (raw) => {
      expect(showsHeroOverlay(raw)).toBe(true);
    },
  );

  it('🔴 문자열 "false" 를 끔으로 읽지 않는다', () => {
    // 폼·쿼리스트링에서 문자열로 들어오면 조용히 꺼져 제목이 사라진다.
    expect(showsHeroOverlay("false")).toBe(true);
  });
});
