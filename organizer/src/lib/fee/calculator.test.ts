import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ getOrganizerFeePlan: vi.fn() }));
vi.mock("@/lib/v2/commerce-client", () => ({ getOrganizerFeePlan: h.getOrganizerFeePlan }));

import { calculatePlatformFee, getAccountFeePlan, type FeePlan } from "@/lib/fee/calculator";

/**
 * 레벨2 컷오버 T3 — 수수료 정본을 go `platform_fee_plans` → v2 `fee_schedules` 로 이관.
 *
 * 🔴 이관의 합격 기준은 "동작"이 아니라 **금액이 한 원도 달라지지 않는 것**이다.
 *    prod go 유일 플랜(기본 플랜: percentage_plus_fixed · 3.00% · ₩300 · min 0 · max NULL)을
 *    그대로 고정해 숫자로 단언한다.
 */
const PROD_PLAN: FeePlan = {
  id: "0fdd635e-75e4-4f74-ba35-1ebe2f2fbc8e",
  feeType: "percentage_plus_fixed",
  feePercentage: 3.0,
  feeFixed: 300,
  minFee: 0,
  maxFee: null,
};

describe("T3: 수수료 계산 — 이관 전후 금액 고정(prod 기본 플랜 3% + ₩300)", () => {
  it.each([
    // [주문금액, 기대 수수료]  ← 3% + 300원, 반올림
    [0, 300],
    [10_000, 600],
    [15_000, 750], // KLPGA 주중권
    [25_000, 1_050], // KLPGA 주말권
    [33_333, 1_300], // round(999.99)=1000 + 300
    [1_000_000, 30_300],
  ])("주문 %i원 → 수수료 %i원", (amount, expected) => {
    expect(calculatePlatformFee(PROD_PLAN, amount)).toBe(expected);
  });

  it("음수 주문금액은 0원으로 취급한다(정액분만 부과)", () => {
    expect(calculatePlatformFee(PROD_PLAN, -5000)).toBe(300);
  });

  it("percentage / fixed 타입도 종전 계약 그대로 계산한다", () => {
    expect(calculatePlatformFee({ ...PROD_PLAN, feeType: "percentage" }, 15_000)).toBe(450);
    expect(calculatePlatformFee({ ...PROD_PLAN, feeType: "fixed" }, 15_000)).toBe(300);
  });

  it("min/max 경계는 종전대로 적용된다", () => {
    expect(calculatePlatformFee({ ...PROD_PLAN, minFee: 1_000 }, 10_000)).toBe(1_000);
    expect(calculatePlatformFee({ ...PROD_PLAN, maxFee: 500 }, 1_000_000)).toBe(500);
  });

  it("문자열로 들어온 금액도 숫자화해 계산한다(BIGINT 문자열 오염 방지 — 감사 P0)", () => {
    const dirty = { ...PROD_PLAN, feeFixed: "300" as unknown as number, feePercentage: "3.00" as unknown as number };
    expect(calculatePlatformFee(dirty, 15_000)).toBe(750);
  });
});

describe("T3: getAccountFeePlan — v2 fee_schedules 정본 조회", () => {
  it("v2 응답을 go 계약(FeePlan)으로 매핑한다 — fee_percentage 는 백분율 그대로", async () => {
    h.getOrganizerFeePlan.mockReset().mockResolvedValue({
      id: "fs-1",
      scope: "organizer",
      fee_type: "percentage_plus_fixed",
      fee_percentage: 3.0, // v2 가 0.0300 → ×100 해서 내려준 값
      fee_fixed: 300,
      min_fee: 0,
      max_fee: null,
    });

    const plan = await getAccountFeePlan("acc-1");
    expect(plan).toEqual({
      id: "fs-1",
      feeType: "percentage_plus_fixed",
      feePercentage: 3,
      feeFixed: 300,
      minFee: 0,
      maxFee: null,
    });
    // 이관 후에도 금액이 동일해야 한다.
    expect(calculatePlatformFee(plan!, 15_000)).toBe(750);
    expect(h.getOrganizerFeePlan).toHaveBeenCalledWith("acc-1");
  });

  it("유효 플랜이 없으면 null 을 돌려준다(정책 미설정 — 호출측 판단)", async () => {
    h.getOrganizerFeePlan.mockReset().mockResolvedValue(null);
    await expect(getAccountFeePlan("acc-none")).resolves.toBeNull();
  });

  it("🔴 v2 조회 실패는 삼키지 않고 전파한다(fail-closed — 수수료 0원 확정 금지)", async () => {
    h.getOrganizerFeePlan.mockReset().mockRejectedValue(new Error("v2 unavailable"));
    await expect(getAccountFeePlan("acc-1")).rejects.toThrow("v2 unavailable");
  });
});
