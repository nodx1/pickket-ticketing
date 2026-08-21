import { describe, it, expect } from "vitest";
import {
  getNiceMethods,
  isNiceCardOnly,
  normalizeAllowedNiceMethods,
  DEFAULT_NICE_METHOD,
  NICE_METHOD_ORDER,
  type NicePayMethod,
} from "@/lib/nicepay-methods";

describe("nicepay-methods — getNiceMethods (카드전용 게이팅)", () => {
  it("허용목록 미지정 → 전체 결제수단(카드 우선 순서) — NULL 무변", () => {
    expect(getNiceMethods()).toEqual([...NICE_METHOD_ORDER]);
    expect(getNiceMethods(null)).toEqual([...NICE_METHOD_ORDER]);
    expect(getNiceMethods([])).toEqual([...NICE_METHOD_ORDER]);
  });

  it("카드전용 게이팅 → 카드만 노출", () => {
    expect(getNiceMethods(["CARD"])).toEqual(["CARD"]);
  });

  it("허용목록 부분지정 → 정의된 순서 보존하며 필터", () => {
    const allowed: NicePayMethod[] = ["BANK", "CARD"];
    // 입력 순서와 무관하게 NICE_METHOD_ORDER(카드 우선) 순서로 반환.
    expect(getNiceMethods(allowed)).toEqual(["CARD", "BANK"]);
  });

  it("VBANK 은 실배선 전이라 노출 목록에서 제외(명시 허용돼도 미노출) — Wave3 복원", () => {
    // allowed 에 VBANK 가 있어도 NICE_METHOD_ORDER 필터로 걸러진다.
    expect(getNiceMethods(["VBANK", "CARD"])).toEqual(["CARD"]);
    // VBANK 단독 허용 → 유효 노출 수단 없음 → CARD 폴백(결제 진입 보장).
    expect(getNiceMethods(["VBANK"])).toEqual([DEFAULT_NICE_METHOD]);
  });

  it("허용목록이 전부 무효 → 전체 노출(게이팅 없음, 서버가 강제)", () => {
    // 화이트리스트 밖 값만 들어온 경우 — 정규화 결과 없음 → 게이팅 미적용(전체).
    expect(getNiceMethods(["FOO", "BAR"])).toEqual([...NICE_METHOD_ORDER]);
  });

  it("대소문자·공백 무시 파싱(백엔드 대문자 코드)", () => {
    // vbank 는 정규화되지만 노출 목록(NICE_METHOD_ORDER)에 없어 필터링됨 → CARD 만.
    expect(getNiceMethods([" card ", "vbank"])).toEqual(["CARD"]);
    // bank 는 실배선 → 유지.
    expect(getNiceMethods([" card ", "bank"])).toEqual(["CARD", "BANK"]);
  });

  it("CARDANDEASYPAY → 카드+간편결제 두 UI 수단으로 확장", () => {
    expect(getNiceMethods(["CARDANDEASYPAY"])).toEqual(["CARD", "EASYPAY"]);
  });

  it("기본 결제수단은 CARD(백엔드 기본값 정합)", () => {
    expect(DEFAULT_NICE_METHOD).toBe("CARD");
    expect(NICE_METHOD_ORDER[0]).toBe("CARD");
  });
});

describe("nicepay-methods — normalizeAllowedNiceMethods", () => {
  it("NULL/미제공/빈 배열 → null(게이팅 없음)", () => {
    expect(normalizeAllowedNiceMethods()).toBeNull();
    expect(normalizeAllowedNiceMethods(null)).toBeNull();
    expect(normalizeAllowedNiceMethods([])).toBeNull();
  });

  it("유효 코드가 하나도 없으면 null(전체 허용으로 폴백)", () => {
    expect(normalizeAllowedNiceMethods(["FOO"])).toBeNull();
  });

  it("중복 CARD/CARDANDEASYPAY → 카드 1회만", () => {
    expect(normalizeAllowedNiceMethods(["CARD", "CARDANDEASYPAY"])).toEqual([
      "CARD",
      "EASYPAY",
    ]);
  });
});

describe("nicepay-methods — isNiceCardOnly (카드 고정 판정)", () => {
  it("['CARD'] → true(선택 UI 숨김·카드 고정)", () => {
    expect(isNiceCardOnly(["CARD"])).toBe(true);
  });

  it("NULL/미제공 → false(전체 노출, 현행 무변)", () => {
    expect(isNiceCardOnly()).toBe(false);
    expect(isNiceCardOnly(null)).toBe(false);
    expect(isNiceCardOnly([])).toBe(false);
  });

  it("카드 외 실배선 수단 포함 → false", () => {
    expect(isNiceCardOnly(["CARD", "BANK"])).toBe(false);
    expect(isNiceCardOnly(["CARDANDEASYPAY"])).toBe(false);
  });

  it("CARD+VBANK → VBANK 미노출로 카드전용 판정(Wave3 전 실배선 반영)", () => {
    // VBANK 는 노출 목록에서 제외되므로 CARD 하나만 남아 카드 고정으로 판정된다.
    expect(isNiceCardOnly(["CARD", "VBANK"])).toBe(true);
  });
});
