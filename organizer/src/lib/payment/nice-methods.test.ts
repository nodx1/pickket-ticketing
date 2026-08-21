import { describe, it, expect } from "vitest";
import {
  getNiceMethods,
  isNiceCardOnly,
  normalizeAllowedNiceMethods,
  DEFAULT_NICE_METHOD,
  NICE_METHOD_ORDER,
} from "@/lib/payment/nice-methods";

describe("nice-methods — getNiceMethods (카드전용 게이팅)", () => {
  it("허용목록 미지정/NULL/빈 → 전체 결제수단(카드 우선 순서, 현행 무변)", () => {
    expect(getNiceMethods()).toEqual([...NICE_METHOD_ORDER]);
    expect(getNiceMethods(null)).toEqual([...NICE_METHOD_ORDER]);
    expect(getNiceMethods([])).toEqual([...NICE_METHOD_ORDER]);
  });

  it("카드전용 게이팅 → 카드만 노출", () => {
    expect(getNiceMethods(["CARD"])).toEqual(["CARD"]);
  });

  it("부분지정 → 정의된 순서 보존하며 필터", () => {
    expect(getNiceMethods(["VBANK", "CARD"])).toEqual(["CARD", "VBANK"]);
  });

  it("대소문자·공백 무시 파싱", () => {
    expect(getNiceMethods([" card ", "vbank"])).toEqual(["CARD", "VBANK"]);
  });

  it("CARDANDEASYPAY → 카드+간편결제 확장", () => {
    expect(getNiceMethods(["CARDANDEASYPAY"])).toEqual(["CARD", "EASYPAY"]);
  });

  it("전부 무효 → 전체 노출(게이팅 없음, 서버가 강제)", () => {
    expect(getNiceMethods(["FOO", "BAR"])).toEqual([...NICE_METHOD_ORDER]);
  });

  it("기본 결제수단은 CARD", () => {
    expect(DEFAULT_NICE_METHOD).toBe("CARD");
    expect(NICE_METHOD_ORDER[0]).toBe("CARD");
  });
});

describe("nice-methods — normalizeAllowedNiceMethods", () => {
  it("NULL/미제공/빈/전부무효 → null", () => {
    expect(normalizeAllowedNiceMethods()).toBeNull();
    expect(normalizeAllowedNiceMethods(null)).toBeNull();
    expect(normalizeAllowedNiceMethods([])).toBeNull();
    expect(normalizeAllowedNiceMethods(["FOO"])).toBeNull();
  });

  it("중복 CARD/CARDANDEASYPAY → 카드 1회만", () => {
    expect(normalizeAllowedNiceMethods(["CARD", "CARDANDEASYPAY"])).toEqual([
      "CARD",
      "EASYPAY",
    ]);
  });
});

describe("nice-methods — isNiceCardOnly", () => {
  it("['CARD'] → true(선택 UI 숨김·카드 고정)", () => {
    expect(isNiceCardOnly(["CARD"])).toBe(true);
  });

  it("NULL/미제공 → false(전체 노출, 현행 무변)", () => {
    expect(isNiceCardOnly()).toBe(false);
    expect(isNiceCardOnly(null)).toBe(false);
    expect(isNiceCardOnly([])).toBe(false);
  });

  it("카드 외 수단 포함 → false", () => {
    expect(isNiceCardOnly(["CARD", "VBANK"])).toBe(false);
    expect(isNiceCardOnly(["CARDANDEASYPAY"])).toBe(false);
  });
});
