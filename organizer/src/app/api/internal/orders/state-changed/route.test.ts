import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  getPool: vi.fn(),
  getRedis: vi.fn(),
  enqueueCompensation: vi.fn(),
  askV2AboutOrder: vi.fn(),
  repairPaidOrder: vi.fn(),
  sendPurchaseConfirm: vi.fn(),
  transitionOrderDetailed: vi.fn(),
}));

vi.mock("@/lib/db/pool", () => ({ getPool: h.getPool }));
vi.mock("@/lib/redis", () => ({ getRedis: h.getRedis }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/notification/transactional", () => ({
  notifyPurchaseConfirm: vi.fn(),
  notifyRefundConfirm: vi.fn(),
}));
vi.mock("@/lib/payment/compensation", () => ({ enqueueExpiredPaymentCompensation: h.enqueueCompensation }));
vi.mock("@/lib/orders/v2-authority", () => ({ askV2AboutOrder: h.askV2AboutOrder }));
vi.mock("@/lib/state-machine/order-state-machine", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/state-machine/order-state-machine")
  >("@/lib/state-machine/order-state-machine");
  return { ...actual, transitionOrderDetailed: h.transitionOrderDetailed };
});
vi.mock("@/lib/orders/repair-paid-order", () => ({ repairPaidOrder: h.repairPaidOrder }));
vi.mock("@/lib/notification/purchase-confirm-sender", () => ({
  PURCHASE_CONFIRM_ORDER_SELECT: "SELECT o.account_id",
  sendPurchaseConfirm: h.sendPurchaseConfirm,
}));

import { POST } from "@/app/api/internal/orders/state-changed/route";

const secret = "audit-secret";
const deliveryId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function request() {
  const body = JSON.stringify({
    event: "order.payment.confirmed",
    delivery_id: deliveryId,
    timestamp: new Date().toISOString(),
    order_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    data: { amount: 1000 },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return new NextRequest("http://localhost/api/internal/orders/state-changed", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-pickket-signature": `sha256=${signature}`,
      "x-pickket-timestamp": timestamp,
      "x-pickket-event": "order.payment.confirmed",
      "x-pickket-delivery-id": deliveryId,
    },
  });
}

describe("state-changed replay durability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GO_WEBHOOK_SECRET", secret);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("does not turn a Redis marker left by a failed audit insert into duplicate 200", async () => {
    const redis = {
      set: vi.fn().mockResolvedValueOnce("OK").mockResolvedValueOnce(null),
      del: vi.fn().mockResolvedValue(1),
    };
    h.getRedis.mockResolvedValue(redis);

    let auditAttempts = 0;
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("SELECT status FROM inter_service_webhook_deliveries")) return { rows: [] };
        if (sql.includes("INSERT INTO inter_service_webhook_deliveries")) {
          auditAttempts += 1;
          if (auditAttempts === 1) throw new Error("database unavailable");
          return { rows: [{ id: "audit-row-1", status: "received", is_new: true }] };
        }
        if (sql.includes("SELECT retry_count AS")) {
          return { rows: [{ retryCount: 0, createdAt: new Date() }] };
        }
        return { rows: [] };
      }),
      connect: vi.fn().mockResolvedValue({
        query: vi.fn(async (sql: string) => {
          if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
          if (sql.includes("FROM orders WHERE v2_order_id")) return { rows: [] };
          return { rows: [] };
        }),
        release: vi.fn(),
      }),
    };
    h.getPool.mockReturnValue(pool);

    const first = await POST(request());
    const second = await POST(request());

    expect(first.status).toBe(503);
    expect(second.status).toBe(202);
    expect((await second.json()).data.status).toBe("pending_order");
    expect(redis.del).toHaveBeenCalledWith(`go:webhook:inbound:${deliveryId}`);
    expect(auditAttempts).toBe(2);
  });
});

/**
 * 🔴 만료 주문에 결제확정이 도착했을 때 — 감사 반려분 P0-1 · 뮤테이션 M1.
 *
 * 이 분기가 **자동 전액환불의 방아쇠**다. 전파가 유실돼 결제 주문이 go 에서 만료돼 있던
 * 동안 파이프를 복구하면, 적체된 결제확정이 여기 도착해 정당한 결제를 환불한다
 * (`compensation.ts` → `refundOrder({full:true})` = 실 PG 취소).
 *
 * 그런데 이 분기 전체가 **무테스트**여서 fail-closed 를 통째로 지워도 그린이었다.
 */
describe("state-changed — 만료 주문 결제확정 (자동환불 방아쇠)", () => {
  const orderRow = {
    id: "go-order-1", status: "expired", expiresAt: new Date(Date.now() - 60_000),
    totalAmount: 15000, v2OrderId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  };

  function poolWithExpiredOrder() {
    const clientQuery = vi.fn(async (sql: string) => {
      if (sql.includes("FROM orders WHERE v2_order_id")) return { rows: [orderRow] };
      if (sql.includes("SELECT o.account_id")) {
        return { rows: [{ accountId: "a", eventId: "e", orderNumber: "ORD-1",
                          v2OrderId: "v2-1", email: null, phone: "010", name: "n", ticketCount: 1 }] };
      }
      return { rows: [] };
    });
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("SELECT status FROM inter_service_webhook_deliveries")) return { rows: [] };
        if (sql.includes("INSERT INTO inter_service_webhook_deliveries")) {
          return { rows: [{ id: "audit-1", status: "received", is_new: true }] };
        }
        return { rows: [] };
      }),
      connect: vi.fn().mockResolvedValue({ query: clientQuery, release: vi.fn() }),
    };
    h.getPool.mockReturnValue(pool);
    return { clientQuery };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GO_WEBHOOK_SECRET", secret);
    h.getRedis.mockResolvedValue({ set: vi.fn().mockResolvedValue("OK"), del: vi.fn() });
    h.repairPaidOrder.mockResolvedValue({
      repaired: true, from: "expired", attendeesRestored: 1,
      compensationsCancelled: 1, shouldNotify: true,
    });
    h.sendPurchaseConfirm.mockResolvedValue({ sent: true, ticketNumber: "TKT-1", attempted: 1, failed: 0 });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("🔴 v2 가 결제 유효로 보면 환불이 아니라 repair 한다", async () => {
    poolWithExpiredOrder();
    h.askV2AboutOrder.mockResolvedValue({ kind: "paid", v2OrderId: "v2-1", v2Status: "confirmed", facts: { amount: 15000, method: "card" } });

    const res = await POST(request());
    const body = await res.json();

    expect(body.data.status).toBe("repaired");
    expect(h.repairPaidOrder).toHaveBeenCalledOnce();
    // 이것이 핵심 — 보상환불 큐에 **들어가지 않아야** 한다.
    expect(h.enqueueCompensation).not.toHaveBeenCalled();
  });

  it("🔴 v2 에 못 물어보면 보상환불을 보류한다(fail-closed) — 넣으면 5분 뒤 돈이 나간다", async () => {
    poolWithExpiredOrder();
    h.askV2AboutOrder.mockResolvedValue({ kind: "unknown", reason: "v2 timeout" });

    const res = await POST(request());
    const body = await res.json();

    expect(body.data.status).toBe("compensation_deferred");
    expect(h.enqueueCompensation).not.toHaveBeenCalled();
    expect(h.repairPaidOrder).not.toHaveBeenCalled();
  });

  it("🔴 결제 전(in_flight)도 보류한다 — terminal 로 확인된 것만 환불 대상이다", async () => {
    poolWithExpiredOrder();
    h.askV2AboutOrder.mockResolvedValue({
      kind: "in_flight", v2OrderId: "v2-1", v2Status: "payment_required",
    });

    const res = await POST(request());

    expect((await res.json()).data.status).toBe("compensation_deferred");
    expect(h.enqueueCompensation).not.toHaveBeenCalled();
  });

  it("v2 도 끝났다고 하면 종전대로 보상환불 큐에 넣는다(무회귀)", async () => {
    poolWithExpiredOrder();
    h.askV2AboutOrder.mockResolvedValue({ kind: "terminal", v2OrderId: "v2-1", v2Status: "expired" });

    const res = await POST(request());
    const body = await res.json();

    expect(body.data.status).toBe("expired_compensation_pending");
    expect(h.enqueueCompensation).toHaveBeenCalledOnce();
  });

  it("repair 가 noop 이면 알림톡을 보내지 않는다 — 재전달 중복 발송 방지", async () => {
    poolWithExpiredOrder();
    h.askV2AboutOrder.mockResolvedValue({ kind: "paid", v2OrderId: "v2-1", v2Status: "confirmed", facts: { amount: 15000, method: "card" } });
    h.repairPaidOrder.mockResolvedValue({
      repaired: false, attendeesRestored: 0, compensationsCancelled: 0, shouldNotify: false,
    });

    await POST(request());

    expect(h.sendPurchaseConfirm).not.toHaveBeenCalled();
  });
});

/**
 * 🔴 두 번째 진입점 — 감사 뮤테이션 M1c 생존분.
 *
 * `isExpiredOrder` 는 **ms 비교**이고 상태 전이 SQL 가드는 **NOW()** 기준이다. 그 사이에
 * 만료 시각이 넘어가면, 첫 분기를 통과한 요청이 전이 실패(`condition_failed/expired`)로
 * 떨어진다. 종전엔 이 자리가 **v2 대조 없이** 곧장 보상환불 큐로 갔다 —
 * 방금 v2 가 confirmed 라고 보낸 결제가 검증 없이 환불 대상이 되는 사각이었다.
 */
describe("state-changed — 전이 실패(expired)로 떨어진 두 번째 진입점", () => {
  /** 아직 안 만료된 pending 주문 = 첫 분기를 통과한다. */
  const liveOrder = {
    id: "go-order-2", status: "pending", expiresAt: new Date(Date.now() + 600_000),
    totalAmount: 15000, v2OrderId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GO_WEBHOOK_SECRET", secret);
    h.getRedis.mockResolvedValue({ set: vi.fn().mockResolvedValue("OK"), del: vi.fn() });
    // 전이 SQL 이 "이미 만료" 로 거절 → via === "expired"
    h.transitionOrderDetailed.mockResolvedValue({ status: "condition_failed", reason: "expired" });
    h.repairPaidOrder.mockResolvedValue({
      repaired: true, from: "pending", attendeesRestored: 0,
      compensationsCancelled: 0, shouldNotify: false,
    });
    const clientQuery = vi.fn(async (sql: string) => {
      if (sql.includes("FROM orders WHERE v2_order_id")) return { rows: [liveOrder] };
      return { rows: [] };
    });
    h.getPool.mockReturnValue({
      query: vi.fn(async (sql: string) => {
        if (sql.includes("SELECT status FROM inter_service_webhook_deliveries")) return { rows: [] };
        if (sql.includes("INSERT INTO inter_service_webhook_deliveries")) {
          return { rows: [{ id: "audit-2", status: "received", is_new: true }] };
        }
        return { rows: [] };
      }),
      connect: vi.fn().mockResolvedValue({ query: clientQuery, release: vi.fn() }),
    });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("🔴 이 경로도 v2 에 물어본다 — paid 면 환불이 아니라 repair", async () => {
    h.askV2AboutOrder.mockResolvedValue({ kind: "paid", v2OrderId: "v2-1", v2Status: "confirmed", facts: { amount: 15000, method: "card" } });

    const res = await POST(request());

    expect((await res.json()).data.status).toBe("repaired");
    expect(h.enqueueCompensation).not.toHaveBeenCalled();
  });

  it("🔴 이 경로도 fail-closed — 못 물어보면 환불 큐에 넣지 않는다", async () => {
    h.askV2AboutOrder.mockResolvedValue({ kind: "unknown", reason: "timeout" });

    const res = await POST(request());

    expect((await res.json()).data.status).toBe("compensation_deferred");
    expect(h.enqueueCompensation).not.toHaveBeenCalled();
  });
});
