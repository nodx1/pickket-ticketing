import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * toss confirm 라우트 — P0-3(레벨2 재감사): PG 승인 전 durable intent(payment_reference) 기록.
 *
 * 핵심 회귀: tossProvider.confirm(=PG 캡처) 이 호출되기 **전에** payment_reference 를 pending
 * 주문에 새겨야, 승인 후 go 트랜잭션이 실패해도 orphan 스캐너가 paymentKey 로 회수할 수 있다.
 */
const h = vi.hoisted(() => {
  const cookieStore = { get: vi.fn(() => ({ value: "order-1" })) };
  const calls: string[] = [];
  return {
    calls,
    cookieStore,
    poolQuery: vi.fn(),
    confirm: vi.fn(),
    transitionOrder: vi.fn(),
    transitionAttendees: vi.fn(),
    recordPaymentConfirmOutbox: vi.fn(),
    notifyNewOrder: vi.fn(),
    notifySoldOut: vi.fn(),
    resolveSoldOutProductsForOrder: vi.fn(async () => []),
    dispatchWebhook: vi.fn(),
    client: {
      query: vi.fn(async (text: string, _params?: unknown[]) => {
        h.calls.push(`client:${String(text).trim().slice(0, 20)}`);
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn(),
    },
  };
});

vi.mock("next/headers", () => ({ cookies: async () => h.cookieStore }));
vi.mock("@/lib/db/pool", () => ({
  getPool: () => ({
    query: h.poolQuery,
    connect: async () => h.client,
  }),
}));
vi.mock("@/lib/auth/withRateLimit", () => ({
  withRateLimit: () => (handler: (r: Request) => Promise<Response>) => handler,
}));
vi.mock("@/lib/payment/toss", () => ({ tossProvider: { confirm: (...a: unknown[]) => h.confirm(...a) } }));
vi.mock("@/lib/state-machine/order-state-machine", () => ({ transitionOrder: (...a: unknown[]) => h.transitionOrder(...a) }));
vi.mock("@/lib/state-machine/attendee-state-machine", () => ({ transitionAttendees: (...a: unknown[]) => h.transitionAttendees(...a) }));
vi.mock("@/lib/payment/confirm-v2", () => ({ recordPaymentConfirmOutbox: (...a: unknown[]) => h.recordPaymentConfirmOutbox(...a) }));
vi.mock("@/lib/notifications/create", () => ({ notifyNewOrder: (...a: unknown[]) => h.notifyNewOrder(...a), notifySoldOut: (...a: unknown[]) => h.notifySoldOut(...a) }));
vi.mock("@/lib/notification/sold-out", () => ({ resolveSoldOutProductsForOrder: () => h.resolveSoldOutProductsForOrder() }));
vi.mock("@/lib/webhook/dispatcher", () => ({ dispatchWebhook: (...a: unknown[]) => h.dispatchWebhook(...a) }));

import { POST } from "@/app/api/payment/toss/confirm/route";

function body() {
  return new Request("https://go.pickket.kr/api/payment/toss/confirm", {
    method: "POST",
    body: JSON.stringify({ paymentKey: "toss_pk_1", orderId: "11111111-1111-4111-8111-111111111111", amount: 15000 }),
  });
}

describe("toss confirm P0-3 durable intent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.calls.length = 0;
    h.cookieStore.get.mockReturnValue({ value: "11111111-1111-4111-8111-111111111111" });
    // 1) orderCheck SELECT  2) durable pre-write UPDATE  3) (post) order SELECT
    h.poolQuery.mockImplementation(async (text: string) => {
      h.calls.push(`pool:${String(text).trim().slice(0, 30)}`);
      if (/SELECT total_amount/.test(text)) return { rows: [{ total_amount: "15000", status: "pending" }] };
      if (/UPDATE orders/.test(text) && /payment_reference/.test(text)) return { rows: [], rowCount: 1 };
      if (/SELECT\s+account_id/.test(text)) return { rows: [{ accountId: "a", eventId: "e", orderNumber: "N1", totalAmount: 15000 }] };
      return { rows: [], rowCount: 1 };
    });
    h.confirm.mockImplementation(async () => {
      h.calls.push("confirm");
      return { success: true, paymentKey: "toss_pk_1", method: "toss", approvedAt: "now" };
    });
    h.transitionOrder.mockResolvedValue(true);
    h.transitionAttendees.mockResolvedValue(undefined);
    h.recordPaymentConfirmOutbox.mockResolvedValue({ pending: false, v2OrderId: null });
  });

  it("PG 승인(confirm) 전에 payment_reference durable UPDATE 를 먼저 수행한다", async () => {
    const res = await POST(body());
    expect(res.status).toBe(200);

    // durable pre-write CAS UPDATE 가 실제로 paymentKey 를 기록했는지(CAS 가드 포함).
    const preWrite = h.poolQuery.mock.calls.find(([sql]) =>
      /UPDATE orders/.test(sql) && /payment_reference = \$2/.test(sql) && /status = 'pending'/.test(sql),
    );
    expect(preWrite).toBeDefined();
    // CAS 조건: payment_reference IS NULL OR = 요청키.
    expect(preWrite?.[0]).toMatch(/payment_reference IS NULL OR payment_reference = \$2/);
    expect(preWrite?.[1]).toEqual(["11111111-1111-4111-8111-111111111111", "toss_pk_1"]);

    // 시도별 ledger(payment_attempts) INSERT 가 CAS 전에 수행됐는지.
    const ledgerInsert = h.poolQuery.mock.calls.find(([sql]) => /INSERT INTO payment_attempts/.test(sql));
    expect(ledgerInsert).toBeDefined();

    // 순서 불변식: pre-write UPDATE → confirm.
    const preWriteIdx = h.calls.findIndex((c) => c.startsWith("pool:UPDATE orders"));
    const confirmIdx = h.calls.indexOf("confirm");
    expect(preWriteIdx).toBeGreaterThanOrEqual(0);
    expect(confirmIdx).toBeGreaterThan(preWriteIdx);
  });

  it("payment_reference CAS 실패(다른 키 선점) 시 외부 PG confirm 을 실행하지 않고 409", async () => {
    // CAS UPDATE(payment_reference 포함) 만 rowCount 0 으로 만든다(다른 키가 이미 선점).
    h.poolQuery.mockImplementation(async (text: string) => {
      h.calls.push(`pool:${String(text).trim().slice(0, 30)}`);
      if (/SELECT total_amount/.test(text)) return { rows: [{ total_amount: "15000", status: "pending" }] };
      if (/INSERT INTO payment_attempts/.test(text)) return { rows: [], rowCount: 1 };
      if (/UPDATE orders/.test(text) && /payment_reference IS NULL OR/.test(text)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    });

    const res = await POST(body());
    expect(res.status).toBe(409);
    // 핵심 안전: CAS 실패 시 tossProvider.confirm(외부 캡처)이 절대 호출되지 않는다.
    expect(h.confirm).not.toHaveBeenCalled();
    // go 트랜잭션(client BEGIN)도 열리지 않는다.
    expect(h.calls).not.toContain("confirm");
  });

  it("정상 Toss 완료 시 해당 payment attempt를 같은 트랜잭션에서 settled로 종결", async () => {
    const res = await POST(body());
    expect(res.status).toBe(200);

    const settled = h.client.query.mock.calls.find(([sql]) =>
      /UPDATE payment_attempts/.test(String(sql)) && /status = 'settled'/.test(String(sql)),
    );
    expect(settled).toBeDefined();
    expect(settled?.[0]).toContain("status IN ('pending', 'won', 'captured')");
    expect(settled?.[1]).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "toss_pk_1",
    ]);

    const settledIndex = h.client.query.mock.calls.findIndex(([sql]) =>
      /UPDATE payment_attempts/.test(String(sql)) && /status = 'settled'/.test(String(sql)),
    );
    const commitIndex = h.client.query.mock.calls.findIndex(([sql]) => String(sql) === "COMMIT");
    expect(settledIndex).toBeGreaterThanOrEqual(0);
    expect(commitIndex).toBeGreaterThan(settledIndex);
  });
});
