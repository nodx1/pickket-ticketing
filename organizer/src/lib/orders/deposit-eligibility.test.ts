import { describe, expect, it } from "vitest";

import { checkDepositEligibility, showsDepositConfirmAction } from "./deposit-eligibility";

function input(over: Partial<Parameters<typeof checkDepositEligibility>[0]> = {}) {
  return { status: "pending", paymentMethod: "offline", hasPgPayment: false, ...over };
}

describe("checkDepositEligibility", () => {
  it("진짜 무통장 주문은 확정할 수 있다", () => {
    expect(checkDepositEligibility(input()).ok).toBe(true);
    expect(checkDepositEligibility(input({ paymentMethod: "bank_transfer" })).ok).toBe(true);
  });

  it("🔴 PG 결제가 걸린 주문은 막는다 — 확정하면 돈을 안 받고 티켓이 나간다", () => {
    const r = checkDepositEligibility(input({ hasPgPayment: true }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(409);
    expect(r.reason).toContain("결제");
  });

  it("🔴 PG 결제 여부를 모르면(undefined) 막는다 — fail-closed", () => {
    // 구버전 v2 응답·조회 실패로 필드가 없을 때 열어주면 정확히 막으려던 사고가 난다.
    expect(checkDepositEligibility(input({ hasPgPayment: undefined })).ok).toBe(false);
  });

  it("pending 이 아닌 주문은 막는다", () => {
    for (const status of ["completed", "cancelled", "refunded", "expired"]) {
      const r = checkDepositEligibility(input({ status }));
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.status).toBe(409);
    }
  });

  it("카드 등 다른 결제수단은 막는다", () => {
    for (const m of ["card", "toss", "kakaopay", "nicepay", null]) {
      const r = checkDepositEligibility(input({ paymentMethod: m }));
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.status).toBe(400);
    }
  });

  it("상태와 PG 둘 다 문제면 상태를 먼저 알린다", () => {
    const r = checkDepositEligibility(input({ status: "completed", hasPgPayment: true }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("상태");
  });
});

describe("showsDepositConfirmAction", () => {
  it("서버 판정과 같은 규칙을 쓴다 — 화면만 열리거나 서버만 열리는 어긋남이 없어야 한다", () => {
    const cases = [
      input(),
      input({ hasPgPayment: true }),
      input({ hasPgPayment: undefined }),
      input({ status: "completed" }),
      input({ paymentMethod: "card" }),
    ];
    for (const c of cases) {
      expect(showsDepositConfirmAction(c)).toBe(checkDepositEligibility(c).ok);
    }
  });

  it("PG 결제가 걸린 주문에는 버튼을 띄우지 않는다", () => {
    expect(showsDepositConfirmAction(input({ hasPgPayment: true }))).toBe(false);
  });
});
