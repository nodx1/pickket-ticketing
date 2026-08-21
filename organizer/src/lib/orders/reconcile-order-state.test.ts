/**
 * 역방향 대사 회귀 — 2026-07-31 실사고.
 *
 * v2→go 결제확정 전파가 한 번도 도달하지 않아 결제 주문이 go 에서 pending/expired 로
 * 남았다. 이 대사가 없으면 전파를 고치기 전까지 아무것도 수렴하지 않는다.
 *
 * 여기서 증명할 것:
 *  ① v2 가 결제 유효로 보는 건만 되돌린다 (terminal 은 **손대지 않는다**)
 *  ② 되돌린 건에만 알림톡 — 🔴 발송 원장이 없어 **5분마다 재발송되면 스팸**이 된다
 *  ③ v2 에 못 물어보면 아무것도 하지 않는다
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getPool, askV2AboutOrder, repairPaidOrder, sendPurchaseConfirm } = vi.hoisted(() => ({
  getPool: vi.fn(),
  askV2AboutOrder: vi.fn(),
  repairPaidOrder: vi.fn(),
  sendPurchaseConfirm: vi.fn(),
}));
vi.mock("@/lib/db/pool", () => ({ getPool }));
vi.mock("@/lib/orders/v2-authority", () => ({ askV2AboutOrder }));
vi.mock("@/lib/orders/repair-paid-order", () => ({ repairPaidOrder }));
vi.mock("@/lib/notification/purchase-confirm-sender", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/notification/purchase-confirm-sender")
  >("@/lib/notification/purchase-confirm-sender");
  return { ...actual, sendPurchaseConfirm };
});

import { reconcileOrderState } from "@/lib/orders/reconcile-order-state";

/** 후보 SELECT → BEGIN → repair → 발송행 SELECT → COMMIT 을 흉내낸다. */
function mockPool(candidateIds: string[]) {
  const clientQuery = vi.fn(async (sql: string) => {
    if (/SELECT o\.account_id/.test(sql)) {
      return {
        rows: [{
          accountId: "acc-1", eventId: "evt-1", orderNumber: "ORD-1",
          v2OrderId: "v2-1", email: "a@b.c", phone: "01000000000",
          name: "구매자", ticketCount: 1,
        }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  });
  const release = vi.fn();
  const pool = {
    query: vi.fn(async (_sql: string, _params?: unknown[]) => ({
      rows: candidateIds.map((id) => ({ id })),
      rowCount: candidateIds.length,
    })),
    connect: vi.fn(async () => ({ query: clientQuery, release })),
  };
  getPool.mockReturnValue(pool);
  return { pool, clientQuery, release };
}

beforeEach(() => {
  vi.clearAllMocks();
  repairPaidOrder.mockResolvedValue({
    repaired: true, from: "expired", attendeesRestored: 1,
    compensationsCancelled: 0, shouldNotify: true,
  });
  sendPurchaseConfirm.mockResolvedValue({ sent: true, ticketNumber: "TKT-1", attempted: 2, failed: 0 });
});

describe("역방향 대사", () => {
  it("🔴 v2 가 결제 유효로 보면 되돌리고 알림톡을 보낸다", async () => {
    mockPool(["go-1"]);
    askV2AboutOrder.mockResolvedValue({ kind: "paid", v2OrderId: "v2-1", v2Status: "confirmed", facts: { amount: 15000, method: "card" } });

    const s = await reconcileOrderState();

    expect(repairPaidOrder).toHaveBeenCalledOnce();
    expect(sendPurchaseConfirm).toHaveBeenCalledOnce();
    expect(s.repaired).toBe(1);
    expect(s.notified).toBe(1);
  });

  it("🔴 v2 도 끝났다고 보면 **아무것도 하지 않는다** — 오발송·오복구 금지", async () => {
    mockPool(["go-dead"]);
    askV2AboutOrder.mockResolvedValue({ kind: "terminal", v2OrderId: "v2-x", v2Status: "expired" });

    const s = await reconcileOrderState();

    expect(repairPaidOrder).not.toHaveBeenCalled();
    expect(sendPurchaseConfirm).not.toHaveBeenCalled();
    expect(s.terminal).toBe(1);
    expect(s.repaired).toBe(0);
  });

  it("🔴 v2 에 못 물어보면 손대지 않는다(fail-closed)", async () => {
    mockPool(["go-unknown"]);
    askV2AboutOrder.mockResolvedValue({ kind: "unknown", reason: "timeout" });

    const s = await reconcileOrderState();

    expect(repairPaidOrder).not.toHaveBeenCalled();
    expect(sendPurchaseConfirm).not.toHaveBeenCalled();
    expect(s.undecidable).toBe(1);
  });

  it("🔴 이미 고쳐진 건은 알림톡을 다시 보내지 않는다 — 5분 크론 재발송 방지", async () => {
    mockPool(["go-already"]);
    askV2AboutOrder.mockResolvedValue({ kind: "paid", v2OrderId: "v2-1", v2Status: "confirmed", facts: { amount: 15000, method: "card" } });
    // repair 가 noop = 다른 tick 이 이미 고쳤다. 발송 원장이 없으므로 이 전이가 유일한 잠금이다.
    repairPaidOrder.mockResolvedValue({
      repaired: false, attendeesRestored: 0, compensationsCancelled: 0, shouldNotify: false,
    });

    const s = await reconcileOrderState();

    expect(sendPurchaseConfirm).not.toHaveBeenCalled();
    expect(s.repaired).toBe(0);
    expect(s.notified).toBe(0);
  });

  it("발송 실패는 삼키지 않고 집계에 남긴다", async () => {
    mockPool(["go-1"]);
    askV2AboutOrder.mockResolvedValue({ kind: "paid", v2OrderId: "v2-1", v2Status: "confirmed", facts: { amount: 15000, method: "card" } });
    sendPurchaseConfirm.mockResolvedValue({ sent: false, reason: "열람 가능한 티켓이 없다" });

    const s = await reconcileOrderState();

    expect(s.repaired).toBe(1);
    expect(s.notifyFailed).toBe(1);
    expect(s.notified).toBe(0);
  });

  it("repair 가 터지면 롤백하고 다음 건을 계속 본다", async () => {
    mockPool(["go-boom", "go-ok"]);
    askV2AboutOrder.mockResolvedValue({ kind: "paid", v2OrderId: "v2-1", v2Status: "confirmed", facts: { amount: 15000, method: "card" } });
    repairPaidOrder
      .mockRejectedValueOnce(new Error("deadlock"))
      .mockResolvedValueOnce({
        repaired: true, from: "pending", attendeesRestored: 0,
        compensationsCancelled: 0, shouldNotify: true,
      });

    const s = await reconcileOrderState();

    expect(s.scanned).toBe(2);
    expect(s.repaired).toBe(1);
  });
});

/**
 * 🔴 스캔 계약 — 감사 뮤테이션 M5 생존분 + 기아(DESC) 지적분.
 */
describe("역방향 대사 — 스캔 조건", () => {
  it("🔴 무통장 대기(v2_order_id NULL)는 스캔하지 않는다 — 전파 대상이 아니라 정상 대기다", async () => {
    const { pool } = mockPool([]);
    await reconcileOrderState();
    const sql = String(pool.query.mock.calls[0]?.[0] ?? "");
    expect(sql).toMatch(/v2_order_id IS NOT NULL/);
  });

  it("🔴 오래된 것부터 본다(ASC) — DESC + 상한이면 오래된 사고 건이 영원히 안 잡힌다", async () => {
    const { pool } = mockPool([]);
    await reconcileOrderState();
    const sql = String(pool.query.mock.calls[0]?.[0] ?? "");
    expect(sql).toMatch(/ORDER BY updated_at ASC/);
    // 그 기아는 보상 드레인에 직접 공급된다 — 대사가 못 본 정당결제를 드레인이 먼저 환불한다.
  });

  it("🔴 expired 도 스캔한다 — 만료 크론이 이미 훑고 갔을 수 있다(실사고 건이 그랬다)", async () => {
    const { pool } = mockPool([]);
    await reconcileOrderState();
    const sql = String(pool.query.mock.calls[0]?.[0] ?? "");
    expect(sql).toMatch(/status = 'expired'/);
  });

  it("🔴 결제창 안에 있는 정상 주문은 후보에서 뺀다 — 기아의 원인이자 경보 소음의 원인", async () => {
    const { pool } = mockPool([]);
    await reconcileOrderState();
    const sql = String(pool.query.mock.calls[0]?.[0] ?? "");
    // pending 은 **만료 시각이 지난 것만** 본다. 아직 창 안이면 v2 에 물어볼 필요도 없다.
    expect(sql).toMatch(/status = 'pending' AND expires_at IS NOT NULL AND expires_at < NOW\(\)/);
  });

  it("결제 진행 중(in_flight)은 경보가 아니다 — 정상 주문으로 경보를 울리면 진짜 신호가 묻힌다", async () => {
    mockPool(["go-inflight"]);
    askV2AboutOrder.mockResolvedValue({
      kind: "in_flight", v2OrderId: "v2-1", v2Status: "payment_required",
    });

    const s = await reconcileOrderState();

    expect(s.inFlight).toBe(1);
    expect(s.undecidable).toBe(0);
  });
});
