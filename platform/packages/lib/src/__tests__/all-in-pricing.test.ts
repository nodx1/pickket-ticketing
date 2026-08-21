import { describe, it, expect } from "vitest";
import {
  calcAllInPrice,
  isAllInPriceEqual,
  formatAllInBreakdown,
} from "../all-in-pricing";

describe("calcAllInPrice", () => {
  it("KRW 기본 — 수수료율 3.3% 반올림", () => {
    const b = calcAllInPrice({ basePrice: 100_000, serviceFeeRate: 0.033 });
    expect(b.basePrice).toBe(100_000);
    expect(b.serviceFee).toBe(3_300);
    expect(b.total).toBe(103_300);
    expect(b.currency).toBe("KRW");
  });

  it("수수료 0원 — 무료 행사", () => {
    const b = calcAllInPrice({ basePrice: 0 });
    expect(b.total).toBe(0);
  });

  it("배송비 + 할인 반영", () => {
    const b = calcAllInPrice({
      basePrice: 50_000,
      serviceFeeRate: 0.033,
      deliveryFee: 3_000,
      discount: 5_000,
    });
    // 50000 + 1650 + 3000 - 5000 = 49650
    expect(b.serviceFee).toBe(1_650);
    expect(b.total).toBe(49_650);
  });

  it("수수료 상한 20% 기본 캡", () => {
    const b = calcAllInPrice({ basePrice: 10_000, serviceFeeRate: 0.5 });
    // 5000 원이지만 20% cap = 2000
    expect(b.serviceFee).toBe(2_000);
  });

  it("USD — 소수 둘째 자리 반올림", () => {
    const b = calcAllInPrice({
      basePrice: 19.99,
      serviceFeeRate: 0.1,
      currency: "USD",
    });
    expect(b.serviceFee).toBe(2);
    expect(b.total).toBe(21.99);
  });

  it("basePrice 음수면 throw", () => {
    expect(() => calcAllInPrice({ basePrice: -100 })).toThrow();
  });

  it("최종가 음수 방지", () => {
    const b = calcAllInPrice({ basePrice: 1000, discount: 5000 });
    expect(b.total).toBe(0);
  });
});

describe("isAllInPriceEqual", () => {
  it("같은 입력이면 true", () => {
    const a = calcAllInPrice({ basePrice: 100_000, serviceFeeRate: 0.033 });
    const b = calcAllInPrice({ basePrice: 100_000, serviceFeeRate: 0.033 });
    expect(isAllInPriceEqual(a, b)).toBe(true);
  });

  it("수수료율이 다르면 false", () => {
    const a = calcAllInPrice({ basePrice: 100_000, serviceFeeRate: 0.033 });
    const b = calcAllInPrice({ basePrice: 100_000, serviceFeeRate: 0.05 });
    expect(isAllInPriceEqual(a, b)).toBe(false);
  });
});

describe("formatAllInBreakdown", () => {
  const fmt = (v: number, c: string) => `${c} ${v.toLocaleString()}`;

  it("full breakdown 텍스트 생성", () => {
    const b = calcAllInPrice({
      basePrice: 100_000,
      serviceFeeRate: 0.033,
      deliveryFee: 3_000,
      discount: 5_000,
    });
    const text = formatAllInBreakdown(b, fmt);
    expect(text).toContain("기본가");
    expect(text).toContain("예매수수료");
    expect(text).toContain("발권비");
    expect(text).toContain("할인");
    expect(text).toContain("최종");
  });

  it("수수료 0원 생략", () => {
    const b = calcAllInPrice({ basePrice: 50_000 });
    const text = formatAllInBreakdown(b, fmt);
    expect(text).not.toContain("예매수수료");
  });
});
