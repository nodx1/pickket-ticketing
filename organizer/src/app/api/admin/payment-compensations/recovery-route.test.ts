import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ query: vi.fn(), poolQuery: vi.fn(), role: vi.fn(), refundOrder: vi.fn() }));
vi.mock("@/lib/auth/permissions", () => ({
  withRole: (role: string, handler: unknown) => {
    h.role(role);
    return async (request: Request, context: { params: Promise<unknown>; session: unknown }) =>
      (handler as (req: Request, ctx: unknown) => Promise<Response>)(request, { session: context.session, params: await context.params });
  },
}));
// pool.query(트랜잭션 밖 선반영/보상 write) 와 connect().query(트랜잭션) 를 모두 제공한다.
vi.mock("@/lib/db/pool", () => ({
  getPool: () => ({ query: h.poolQuery, connect: async () => ({ query: h.query, release: vi.fn() }) }),
}));
vi.mock("@/lib/v2/commerce-client", () => ({ refundOrder: h.refundOrder }));

import { NextRequest } from "next/server";
import { POST } from "./[actionId]/route";

const session = { id: "owner-1", accountId: "account-1", role: "owner" };

/** 트랜잭션 밖 pool.query — 선반영 SELECT(대상 행) / manual_review 보상 write. */
function mockPoolQuery(preRow: { v2_order_id: string | null; status: string } | null) {
  h.poolQuery.mockReset();
  h.poolQuery.mockImplementation(async (sql: string) => {
    // T8: 테넌트 스코프가 orders 경유로 바뀌었다(payment_compensation_actions 에는
    //     account_id 컬럼이 없다 — 실 PG 통합테스트에서 드러난 결함).
    if (String(sql).includes("SELECT a.v2_order_id, a.status")) {
      return { rows: preRow ? [preRow] : [], rowCount: preRow ? 1 : 0 };
    }
    return { rows: [], rowCount: 1 };
  });
}

function mockTxnQuery() {
  h.query.mockReset();
  h.query.mockImplementation(async (sql: string) => {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: 0 };
    if (sql.includes("FROM payment_compensation_actions a") && sql.includes("FOR UPDATE")) {
      return { rows: [{ id: "a1", order_id: "o1", account_id: "account-1", v2_order_id: "v2-1", status: "unknown", requested_amount: "1000", max_attempts: 5, attempt_count: 1, event_id: "e1" }] };
    }
    if (sql.includes("INSERT INTO payment_compensation_operator_actions")) return { rows: [{ id: "op1" }] };
    return { rows: [], rowCount: 1 };
  });
}

function confirmRequest() {
  return new NextRequest("https://go.pickket.kr/api/admin/payment-compensations/a1", {
    method: "POST",
    headers: { authorization: "Bearer token", "idempotency-key": "op-1", "content-type": "application/json" },
    body: JSON.stringify({ action: "confirm_completed", reason: "external refund verified", providerRefundId: "refund-1" }),
  });
}

const invoke = (req: Request) =>
  (POST as unknown as (r: Request, c: unknown) => Promise<Response>)(req, { params: Promise.resolve({ actionId: "a1" }), session });

describe("owner compensation recovery route", () => {
  it("requires evidence for completion and writes an audit in the same transaction", async () => {
    mockPoolQuery({ v2_order_id: "v2-1", status: "unknown" });
    mockTxnQuery();
    h.refundOrder.mockReset().mockResolvedValue({ status: "refunded", order_id: "v2-1" });

    const response = await invoke(confirmRequest());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data.status).toBe("completed");
    expect(h.role).toHaveBeenCalledWith("owner");
    // P1 트랜잭션 아웃박스: 감사는 동일 txn 으로 audit_outbox 에 적재(직접 audit_logs 쓰기 폐지).
    expect(h.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO audit_outbox"))).toBe(true);
    expect(h.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO audit_logs"))).toBe(false);
    expect(h.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });

  it("T2: confirm_completed 는 go 확정 전에 v2 refundOrder 를 워커와 동일한 멱등키로 호출한다", async () => {
    mockPoolQuery({ v2_order_id: "v2-1", status: "unknown" });
    mockTxnQuery();
    h.refundOrder.mockReset().mockResolvedValue({ status: "refunded", order_id: "v2-1" });

    const response = await invoke(confirmRequest());
    expect(response.status).toBe(200);
    expect(h.refundOrder).toHaveBeenCalledTimes(1);
    expect(h.refundOrder).toHaveBeenCalledWith(
      "v2-1",
      expect.objectContaining({ full: true }),
      // 워커(processExpiredPaymentCompensations)와 동일 키 → 2회 환불 불가.
      { idempotencyKey: "payment-compensation:a1" },
    );
  });

  it("🔴 T2: v2 반영 실패 시 completed 로 만들지 않고 manual_review 로 남긴 뒤 502 를 반환한다", async () => {
    mockPoolQuery({ v2_order_id: "v2-1", status: "unknown" });
    mockTxnQuery();
    h.refundOrder.mockReset().mockRejectedValue(new Error("v2 unavailable"));

    const response = await invoke(confirmRequest());
    expect(response.status).toBe(502);

    // go 주문을 refunded 로 쓰지 않았다(부분 성공 위장 금지).
    expect(h.query.mock.calls.some(([sql]) => String(sql).includes("UPDATE orders SET payment_status = 'refunded'"))).toBe(false);
    // 트랜잭션 자체가 열리지 않았다(= completed 전이 없음).
    expect(h.query).not.toHaveBeenCalled();
    // manual_review 로 durable 기록.
    const mr = h.poolQuery.mock.calls.find(([sql]) => String(sql).includes("status = 'manual_review'"));
    expect(mr).toBeTruthy();
    expect(String(mr?.[0])).toContain("v2_propagation_failed");
  });

  it("T2: v2 앵커가 없으면 확정하지 않고 409 로 막는다", async () => {
    mockPoolQuery({ v2_order_id: null, status: "unknown" });
    mockTxnQuery();
    h.refundOrder.mockReset();

    const response = await invoke(confirmRequest());
    expect(response.status).toBe(409);
    expect(h.refundOrder).not.toHaveBeenCalled();
    expect(h.query).not.toHaveBeenCalled();
  });
});
