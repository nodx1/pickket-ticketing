import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  reconcilePayments,
  reconcileOrphanTossPendingPayments,
  processExpiredPaymentCompensations,
  reconcileUnknownCompensations,
} = vi.hoisted(() => ({
  reconcilePayments: vi.fn(),
  reconcileOrphanTossPendingPayments: vi.fn(),
  processExpiredPaymentCompensations: vi.fn(),
  reconcileUnknownCompensations: vi.fn(),
}));
vi.mock("@/lib/payment/reconcile", () => ({ reconcilePayments, reconcileOrphanTossPendingPayments }));
vi.mock("@/lib/payment/compensation", () => ({ processExpiredPaymentCompensations, reconcileUnknownCompensations }));

import { hasRecoveryFailure, runOnce } from "../../scripts/payment-reconcile";

const summary = {
  scanned: 0,
  healthy: 0,
  mismatched: 0,
  repaired: 0,
  failed: 0,
  lookupFailed: 0,
  manualReview: 0,
  backfilled: 0,
  details: [],
};
const compensation = { claimed: 0, completed: 0, failed: 0, unknown: 0, manualReview: 0 };
const compensationReconciliation = { checked: 0, resolved: 0, manualReview: 0, remaining: 0 };
const orphanToss = { scanned: 0, refunding: 0, stillPending: 0, lookupFailed: 0 };

describe("payment-reconcile K8s script", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reconcilePayments.mockResolvedValue(summary);
    reconcileOrphanTossPendingPayments.mockResolvedValue(orphanToss);
    processExpiredPaymentCompensations.mockResolvedValue(compensation);
    reconcileUnknownCompensations.mockResolvedValue(compensationReconciliation);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it("실행 모드에서 Toss orphan scanner를 호출하고 요약에 포함한다", async () => {
    const result = await runOnce(false, 48);
    expect(reconcileOrphanTossPendingPayments).toHaveBeenCalledOnce();
    expect(result.orphanToss).toEqual(orphanToss);
  });

  it("dry-run은 외부 orphan 조회를 하지 않는다", async () => {
    const result = await runOnce(true, 48);
    expect(reconcileOrphanTossPendingPayments).not.toHaveBeenCalled();
    expect(result.orphanToss).toEqual({ scanned: 0, refunding: 0, stillPending: 0, lookupFailed: 0 });
  });

  it("orphan 조회실패와 보상 미복구를 비정상 종료 대상으로 판정한다", () => {
    expect(hasRecoveryFailure({
      ...summary,
      compensation,
      compensationReconciliation,
      orphanToss: { ...orphanToss, lookupFailed: 1 },
    })).toBe(true);
    expect(hasRecoveryFailure({
      ...summary,
      lookupFailed: 1,
      compensation,
      compensationReconciliation,
      orphanToss,
    })).toBe(true);
    expect(hasRecoveryFailure({
      ...summary,
      compensation: { ...compensation, unknown: 1 },
      compensationReconciliation,
      orphanToss,
    })).toBe(true);
  });
});
