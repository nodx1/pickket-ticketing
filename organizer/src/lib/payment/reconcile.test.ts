import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * reconcilePayments — 구형 스캐너 백필(224 전 completed 대비) + outbox drain 위임.
 * pending-first 재배선에서 cron 은 (1)outbox 없는 완료·v2앵커 주문을 pending 으로 백필하고
 * (2)drain 이 그 pending 을 멱등키로 confirm 한다.
 */
const { getPool, processPaymentConfirmOutbox } = vi.hoisted(() => ({
  getPool: vi.fn(),
  processPaymentConfirmOutbox: vi.fn(),
}));
vi.mock("@/lib/db/pool", () => ({ getPool }));
vi.mock("@/lib/payment/confirm-outbox", () => ({ processPaymentConfirmOutbox }));

import { reconcilePayments } from "@/lib/payment/reconcile";

describe("reconcilePayments — 백필 + drain", () => {
  beforeEach(() => vi.clearAllMocks());

  it("백필 INSERT(구형 스캐너) 후 drain 을 호출하고 backfilled 를 집계한다", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 2 }); // 백필 2건
    getPool.mockReturnValue({ query });
    processPaymentConfirmOutbox.mockResolvedValue({ claimed: 3, confirmed: 3, failed: 0, manualReview: 0 });

    const summary = await reconcilePayments({ limit: 100 });

    // 백필 쿼리가 outbox 없는 completed·v2앵커 주문을 pending 으로 INSERT 하는지.
    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain("INSERT INTO payment_confirm_outbox");
    expect(sql).toContain("o.status = 'completed'");
    expect(sql).toContain("o.v2_order_id IS NOT NULL");
    expect(sql).toContain("x.order_id IS NULL"); // outbox 없는 것만
    expect(sql).toContain("ON CONFLICT (order_id) DO NOTHING"); // 멱등
    expect(query.mock.calls[0][1]).toEqual([100]);

    // 백필 후 drain 이 호출됐는지(순서: 백필→drain).
    expect(processPaymentConfirmOutbox).toHaveBeenCalledWith(100);
    expect(summary.backfilled).toBe(2);
    expect(summary.repaired).toBe(3);
    expect(summary.scanned).toBe(3);
  });

  it("dryRun 이면 백필·drain 을 하지 않고 no-op(backfilled=0)", async () => {
    const query = vi.fn();
    getPool.mockReturnValue({ query });

    const summary = await reconcilePayments({ dryRun: true });

    expect(query).not.toHaveBeenCalled();
    expect(processPaymentConfirmOutbox).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ scanned: 0, repaired: 0, backfilled: 0 });
  });

  it("백필 0건이어도 drain 은 항상 돈다(정상 운영 = 백필 0)", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 0 });
    getPool.mockReturnValue({ query });
    processPaymentConfirmOutbox.mockResolvedValue({ claimed: 0, confirmed: 0, failed: 0, manualReview: 0 });

    const summary = await reconcilePayments();

    expect(processPaymentConfirmOutbox).toHaveBeenCalledTimes(1);
    expect(summary.backfilled).toBe(0);
  });
});
