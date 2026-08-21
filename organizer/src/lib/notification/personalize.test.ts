import { describe, expect, it } from "vitest";

import { personalizeName } from "./personalize";

/** M-09 회귀: {이름}/{name}/{{name}} 3표기 모두 치환, {{name}} 우선(중괄호 잔존 없음). */
describe("personalizeName (M-09 개인화 3표기 통일)", () => {
  it("세 표기 모두 이름으로 치환한다", () => {
    expect(personalizeName("{이름}님 안녕", "홍길동")).toBe("홍길동님 안녕");
    expect(personalizeName("Hi {name}", "홍길동")).toBe("Hi 홍길동");
    expect(personalizeName("Hi {{name}}", "홍길동")).toBe("Hi 홍길동");
  });

  it("{{name}} 을 {name} 보다 먼저 매칭해 중괄호가 남지 않는다", () => {
    expect(personalizeName("{{name}}", "A")).toBe("A"); // "{A}" 아님
  });

  it("이름 없으면 기본값 '고객'", () => {
    expect(personalizeName("{name}님", null)).toBe("고객님");
    expect(personalizeName("{이름}님", "")).toBe("고객님");
  });

  it("혼합 표기를 한 번에 치환한다", () => {
    expect(personalizeName("{이름}/{name}/{{name}}", "김")).toBe("김/김/김");
  });
});
