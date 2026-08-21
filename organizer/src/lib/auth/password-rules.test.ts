import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PASSWORD_RULES, checkPasswordRules, unmetPasswordRules } from "./password-rules";

/**
 * 🔴 **"회원가입이 안 된다"** (2026-08-01 오픈일 신고) — 원인은 서버가 아니라 화면이었다.
 *
 *     가입 버튼이 `disabled={submitting || !isValid}`
 *     비밀번호 두 칸이 전부 `type="password"`      → 뭘 쳤는지 볼 수 없다
 *     규칙 안내는 placeholder 한 줄                 → 입력 시작하면 사라진다
 *     오류 문구는 제출해야 나옴                      → 제출이 안 되니 영영 안 나온다
 *
 * ⟹ 규칙(8자·대문자·숫자·특수문자 **네 가지**)을 못 맞추면 **버튼이 아무 말 없이 죽는다.**
 *    사용자에겐 "고장" 으로 보인다.
 */
describe("PASSWORD_RULES — v2 정책과 같아야 한다", () => {
  it("🔴 네 가지를 전부 요구한다 — 하나라도 빠지면 서버(v2)가 거부한다", () => {
    // v2 `core/password_policy.py`: 8~128자, 대문자 1+, 숫자 1+, 특수문자 1+.
    expect(PASSWORD_RULES.map((r) => r.label)).toEqual([
      "8자 이상",
      "대문자 1자",
      "숫자 1자",
      "특수문자 1자",
    ]);
  });

  it.each([
    ["Abcd123!", true, "네 조건 모두"],
    ["Abc123!", false, "7자 — 길이 미달"],
    ["abcd123!", false, "대문자 없음"],
    ["Abcdefg!", false, "숫자 없음"],
    ["Abcd1234", false, "특수문자 없음"],
    ["", false, "빈 값"],
  ])("%s → %s (%s)", (pw, ok) => {
    expect(unmetPasswordRules(pw).length === 0).toBe(ok);
  });

  it("🔴 못 맞춘 규칙을 **전부** 돌려준다 — 하나씩 알려주면 무한 반복처럼 느껴진다", () => {
    // 종전 zod 체인은 첫 실패 하나만 보여줬다: 대문자 넣으면 → 특수문자 → 숫자 → …
    expect(unmetPasswordRules("abc").map((r) => r.label)).toEqual([
      "8자 이상",
      "대문자 1자",
      "숫자 1자",
      "특수문자 1자",
    ]);
    // 길이만 맞추면 나머지 셋이 한 번에 보인다
    expect(unmetPasswordRules("abcdefgh").map((r) => r.label)).toEqual([
      "대문자 1자",
      "숫자 1자",
      "특수문자 1자",
    ]);
  });

  it("체크리스트는 항목별 충족 여부를 준다 — 화면이 실시간으로 그린다", () => {
    const checks = checkPasswordRules("Abcdefgh");
    expect(checks.find((c) => c.label === "8자 이상")?.ok).toBe(true);
    expect(checks.find((c) => c.label === "대문자 1자")?.ok).toBe(true);
    expect(checks.find((c) => c.label === "숫자 1자")?.ok).toBe(false);
    expect(checks).toHaveLength(PASSWORD_RULES.length);
  });

  it("한글·공백도 특수문자로 인정한다 — 실제로 쓰는 사람이 있다", () => {
    expect(checkPasswordRules("Abcd1234 ").find((c) => c.label === "특수문자 1자")?.ok).toBe(true);
  });
});

/**
 * 🔴 화면이 그 규칙을 **실제로 쓰는지**가 이 파일의 존재 이유다.
 *    규칙 함수가 아무리 정확해도 폼이 안 보여주면 사용자는 여전히 막힌다.
 */
const PAGE = path.join(process.cwd(), "src/app/(auth)/register/page.tsx");

function stripComments(src: string): string {
  return src
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("가입 폼이 사용자를 막다른 곳에 두지 않는다", () => {
  const code = stripComments(readFileSync(PAGE, "utf8"));

  it("🔴 비밀번호를 볼 수 있다 — 두 칸 모두 같은 토글을 따른다", () => {
    const toggles = code.match(/type=\{showPassword \? "text" : "password"\}/g) ?? [];
    expect(toggles.length, "비밀번호·확인 두 칸 모두여야 한다").toBe(2);
    expect(code).toMatch(/aria-label=\{showPassword \? "비밀번호 숨기기" : "비밀번호 표시"\}/);
  });

  it("🔴 규칙을 항상 표시한다 — placeholder 는 입력하면 사라진다", () => {
    expect(code).toMatch(/passwordChecks\.map/);
    expect(code).toMatch(/id="password-rules"/);
  });

  it("🔴 버튼이 죽어 있는 이유를 말해준다 — 회색 버튼만 두면 '고장' 으로 읽힌다", () => {
    expect(code).toMatch(/!isValid && !submitting/);
    expect(code).toMatch(/모두 입력하면 가입할 수 있습니다/);
  });

  it("확인란 불일치를 제출 전에 알려준다", () => {
    expect(code).toMatch(/confirmMismatch/);
    expect(code).toMatch(/비밀번호가 서로 일치하지 않습니다/);
  });

  it("🔴 규칙을 폼에 다시 적지 않는다 — 두 곳에 적으면 갈라진다", () => {
    // zod 스키마도 PASSWORD_RULES 에서 만들어야 한다.
    expect(code).toMatch(/PASSWORD_RULES\.reduce/);
    expect(
      code,
      "정규식을 폼에 직접 적으면 화면 체크리스트와 어긋난다",
    ).not.toMatch(/\.regex\(\/\[A-Z\]\//);
  });

  it("토글 버튼이 손가락으로 눌린다 — 44px 이상", () => {
    expect(code).toMatch(/size-11/);
  });
});
