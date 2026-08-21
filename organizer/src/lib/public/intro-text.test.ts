/**
 * 🔴 판매 중인 행사에 「이벤트 소개가 준비 중입니다」가 떠 있던 것 (2026-08-01 대표 지적).
 *
 * 소개글을 안 넣었을 뿐인데 손님에게 **미완성이라고 말하고** 있었다. 정작 바로 아래
 * 안내 이미지에 내용이 다 들어 있다 — 글 대신 이미지로 넣은 것이다.
 *
 * 그리고 종전 코드는 `??` 라 **빈 문자열을 못 걸렀다**:
 *
 *     "" ?? "준비 중"  →  ""      ← 폴백도 안 타고 빈 문단만 남는다
 *
 * 소개글을 **지웠을 때** 저장되는 값이 정확히 그것이다.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveIntroText, showsIntroSection } from "./intro-text";

describe("resolveIntroText", () => {
  it("소개글이 있으면 그대로 — 줄바꿈·들여쓰기를 보존한다", () => {
    expect(resolveIntroText("첫 줄\n  둘째 줄", null)).toBe("첫 줄\n  둘째 줄");
  });

  it("🔴 빈 문자열·공백만은 '없음'이다 (`??` 가 못 걸렀던 자리)", () => {
    for (const empty of ["", "   ", "\n", "\t \n"]) {
      expect(resolveIntroText(empty, null), `${JSON.stringify(empty)} 를 본문으로 취급했다`).toBeNull();
    }
  });

  it("description 이 비면 summary 로 넘어간다", () => {
    expect(resolveIntroText("", "요약문")).toBe("요약문");
    expect(resolveIntroText(null, "요약문")).toBe("요약문");
    expect(resolveIntroText("   ", "요약문")).toBe("요약문");
  });

  it("둘 다 없으면 null — 대체 문구를 지어내지 않는다", () => {
    expect(resolveIntroText(null, null)).toBeNull();
    expect(resolveIntroText(undefined, undefined)).toBeNull();
    expect(resolveIntroText("", "")).toBeNull();
  });

  it("문자열이 아닌 값은 무시한다 (v2 응답이 흔들려도 화면이 안 깨지게)", () => {
    expect(resolveIntroText(123, null)).toBeNull();
    expect(resolveIntroText({}, ["x"])).toBeNull();
    expect(resolveIntroText(123, "요약문")).toBe("요약문");
  });
});

describe("showsIntroSection", () => {
  it("🔴 글이 없어도 이미지가 있으면 구획을 그린다 — 이미지가 곧 내용이다", () => {
    expect(showsIntroSection(null, 3)).toBe(true);
  });

  it("글만 있어도 그린다", () => {
    expect(showsIntroSection("소개", 0)).toBe(true);
  });

  it("🔴 둘 다 없으면 그리지 않는다 — 제목만 남은 빈 상자도 미완성으로 읽힌다", () => {
    expect(showsIntroSection(null, 0)).toBe(false);
  });
});

/**
 * 배선 가드 — 화면이 옛 폴백으로 되돌아가지 않는지.
 */
describe("배선 가드", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "..", "app", "(public)", "e", "[eventSlug]", "page.tsx"),
    "utf8",
  );

  it("§0 대상 파일을 실제로 읽었다", () => {
    expect(src.length).toBeGreaterThan(5000);
    expect(src).toContain("이벤트 안내");
  });

  it("🔴 「준비 중입니다」 문구가 화면에 없다", () => {
    const code = src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code, "판매 중인 행사가 스스로 미완성이라고 말한다").not.toContain("준비 중입니다");
  });

  it("🔴 `??` 폴백 체인으로 되돌아가지 않았다 (빈 문자열을 못 거른다)", () => {
    expect(src).not.toMatch(/event\.description\s*\?\?/);
    // ⚠️ "파일에 이름이 있다" 로는 부족하다 — **import 만 남기고 본문에서 안 써도** 통과한다
    //    (실측: 조건을 `true` 로 바꾸는 뮤테이션이 생존했다). **실제로 부르는지**를 본다.
    expect(src, "판정을 화면에서 하면 다음에 또 갈라진다").toMatch(
      /const introText = resolveIntroText\(/,
    );
    expect(src, "구획 렌더가 판정을 안 거친다 — 빈 상자가 다시 나온다").toMatch(
      /\{\s*showsIntroSection\([^)]*\)\s*\?\s*\(/,
    );
  });
});
