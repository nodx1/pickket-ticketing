import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * payment-reconcile cron — P1(레벨2 재감사): 미복구분이 남으면 succeeded 로 위장하지 않고
 * degraded(비200/207) 로 전파한다. orphan Toss pending 회수도 함께 배선됐는지 검증.
 */
const {
  getPool, startCronRun, finishCronRun,
  reconcilePayments, reconcileOrphanTossPendingPayments,
  processExpiredPaymentCompensations, reconcileUnknownCompensations, reconcileOrderState,
} = vi.hoisted(() => ({
  getPool: vi.fn(),
  startCronRun: vi.fn(),
  finishCronRun: vi.fn(),
  reconcilePayments: vi.fn(),
  reconcileOrphanTossPendingPayments: vi.fn(),
  processExpiredPaymentCompensations: vi.fn(),
  reconcileUnknownCompensations: vi.fn(),
  reconcileOrderState: vi.fn(),
}));
vi.mock("@/lib/db/pool", () => ({ getPool }));
vi.mock("@/lib/ops/cron-run", () => ({ startCronRun, finishCronRun }));
vi.mock("@/lib/payment/reconcile", () => ({ reconcilePayments, reconcileOrphanTossPendingPayments }));
vi.mock("@/lib/payment/compensation", () => ({ processExpiredPaymentCompensations, reconcileUnknownCompensations }));
vi.mock("@/lib/orders/reconcile-order-state", () => ({ reconcileOrderState }));

import { GET } from "@/app/api/cron/payment-reconcile/route";

const HEALTHY_SUMMARY = { scanned: 0, healthy: 0, mismatched: 0, repaired: 0, failed: 0, lookupFailed: 0, manualReview: 0, backfilled: 0, details: [] };
const HEALTHY_COMP = { claimed: 0, completed: 0, failed: 0, unknown: 0, manualReview: 0 };
const HEALTHY_RECON = { checked: 0, resolved: 0, manualReview: 0, remaining: 0 };
const HEALTHY_ORPHAN = { scanned: 0, refunding: 0, stillPending: 0, lookupFailed: 0 };
const HEALTHY_ORDER_STATE = {
  scanned: 0, repaired: 0, notified: 0, notifyFailed: 0,
  terminal: 0, undecidable: 0, capped: false,
};

function req() {
  return new Request("https://go.pickket.kr/api/cron/payment-reconcile", {
    headers: { authorization: "Bearer test-secret" },
  });
}

describe("payment-reconcile cron degraded propagation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "test-secret";
    getPool.mockReturnValue({ query: vi.fn() });
    startCronRun.mockResolvedValue({ id: "run-1", startedAt: Date.now() });
    finishCronRun.mockResolvedValue(undefined);
    reconcilePayments.mockResolvedValue(HEALTHY_SUMMARY);
    processExpiredPaymentCompensations.mockResolvedValue(HEALTHY_COMP);
    reconcileUnknownCompensations.mockResolvedValue(HEALTHY_RECON);
    reconcileOrphanTossPendingPayments.mockResolvedValue(HEALTHY_ORPHAN);
    reconcileOrderState.mockResolvedValue(HEALTHY_ORDER_STATE);
  });

  it("전부 정상이면 200 succeeded", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(reconcileOrphanTossPendingPayments).toHaveBeenCalledOnce();
    expect(finishCronRun).toHaveBeenCalledWith(expect.anything(), expect.anything(), "succeeded", expect.anything());
  });

  it("manual_review 가 남으면 207 degraded + finishCronRun('degraded')", async () => {
    reconcilePayments.mockResolvedValue({ ...HEALTHY_SUMMARY, manualReview: 1 });
    const res = await GET(req());
    expect(res.status).toBe(207);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.data.degraded).toBe(true);
    expect(finishCronRun).toHaveBeenCalledWith(expect.anything(), expect.anything(), "degraded", expect.anything());
  });

  it("orphan Toss 조회실패도 degraded 로 전파한다", async () => {
    reconcileOrphanTossPendingPayments.mockResolvedValue({ ...HEALTHY_ORPHAN, lookupFailed: 2 });
    const res = await GET(req());
    expect(res.status).toBe(207);
    expect(finishCronRun).toHaveBeenCalledWith(expect.anything(), expect.anything(), "degraded", expect.anything());
  });

  it("인증 실패는 401", async () => {
    const res = await GET(new Request("https://go.pickket.kr/api/cron/payment-reconcile", { headers: { authorization: "Bearer wrong" } }));
    expect(res.status).toBe(401);
    expect(reconcilePayments).not.toHaveBeenCalled();
  });
});

/**
 * 🔴 2026-07-31 — 역방향 대사가 **보상 드레인보다 먼저** 돌아야 한다.
 *
 * 보상 드레인은 큐를 실제 PG 환불로 집행한다. v2→go 전파가 유실돼 결제 주문이 go 에서
 * 만료돼 있었다면 그 큐에 **정당한 결제**가 들어 있을 수 있고, 대사가 먼저 돌아야
 * repair 하면서 그 큐를 취소한다. 순서가 뒤집히면 같은 tick 에서 **돈이 먼저 나간다.**
 */
describe("payment-reconcile — 역방향 대사 배선", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "test-secret";
    getPool.mockReturnValue({ query: vi.fn() });
    startCronRun.mockResolvedValue({ id: "run-1", startedAt: Date.now() });
    finishCronRun.mockResolvedValue(undefined);
    reconcilePayments.mockResolvedValue(HEALTHY_SUMMARY);
    processExpiredPaymentCompensations.mockResolvedValue(HEALTHY_COMP);
    reconcileUnknownCompensations.mockResolvedValue(HEALTHY_RECON);
    reconcileOrphanTossPendingPayments.mockResolvedValue(HEALTHY_ORPHAN);
    reconcileOrderState.mockResolvedValue(HEALTHY_ORDER_STATE);
  });

  it("🔴 대사가 보상 드레인보다 먼저 호출된다", async () => {
    const order: string[] = [];
    reconcileOrderState.mockImplementation(async () => {
      order.push("reconcile");
      return HEALTHY_ORDER_STATE;
    });
    processExpiredPaymentCompensations.mockImplementation(async () => {
      order.push("compensation");
      return HEALTHY_COMP;
    });

    await GET(req());

    expect(order).toEqual(["reconcile", "compensation"]);
  });

  it("대사 결과를 응답에 담는다 — 로그에만 있으면 크론 감시에서 안 보인다", async () => {
    reconcileOrderState.mockResolvedValue({
      ...HEALTHY_ORDER_STATE, scanned: 3, repaired: 1, notified: 1,
    });

    const res = await GET(req());
    const body = await res.json();

    expect(body.data.orderStateReconcile.repaired).toBe(1);
  });

  it("🔴 v2 에 못 물어본 건이 남으면 degraded(207) — 성공으로 위장하지 않는다", async () => {
    reconcileOrderState.mockResolvedValue({ ...HEALTHY_ORDER_STATE, undecidable: 2 });

    const res = await GET(req());

    expect(res.status).toBe(207);
  });

  it("🔴 알림톡 미발송이 남아도 degraded — 조용히 성공으로 넘기지 않는다", async () => {
    reconcileOrderState.mockResolvedValue({ ...HEALTHY_ORDER_STATE, repaired: 1, notifyFailed: 1 });

    const res = await GET(req());

    expect(res.status).toBe(207);
  });
});
