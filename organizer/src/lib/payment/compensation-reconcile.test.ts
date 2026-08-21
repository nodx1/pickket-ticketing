import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
  getOrder: vi.fn(),
}));
vi.mock("@/lib/db/pool", () => ({ getPool: () => ({ query: h.query, connect: h.connect }) }));
vi.mock("@/lib/v2/commerce-client", () => ({
  getOrder: h.getOrder,
  refundOrder: vi.fn(),
  V2CommerceError: class V2CommerceError extends Error { constructor(message: string, readonly status: number) { super(message); } },
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { reconcileUnknownCompensations } from "./compensation";

afterEach(() => {
  h.query.mockReset();
  h.connect.mockReset();
  h.getOrder.mockReset();
});

const row = { id: "a1", order_id: "o1", v2_order_id: "v2-1", requested_amount: "1000", unknown_since: new Date().toISOString() };

describe("unknown compensation reconciliation", () => {
  it("confirms a refund only when provider total_refunded covers the requested amount", async () => {
    h.query.mockResolvedValueOnce({ rows: [row] });
    h.getOrder.mockResolvedValue({ status: "refunded", status_v2: "refunded", total_refunded: 1000 });
    const client = { query: vi.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ order_id: "o1" }], rowCount: 1 })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({}), release: vi.fn() };
    h.connect.mockResolvedValue(client);

    await expect(reconcileUnknownCompensations()).resolves.toEqual({ checked: 1, resolved: 1, manualReview: 0, remaining: 0 });
    expect(h.getOrder).toHaveBeenCalledWith("v2-1", { idempotencyKey: "payment-compensation-reconcile:a1" });
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("status = 'completed'"))).toBe(true);
  });

  it("moves a partial refund to manual_review instead of treating it as full", async () => {
    h.query.mockResolvedValueOnce({ rows: [row] });
    h.getOrder.mockResolvedValue({ status: "partially_refunded", status_v2: "partially_refunded", total_refunded: 400 });
    h.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await expect(reconcileUnknownCompensations()).resolves.toEqual({ checked: 1, resolved: 0, manualReview: 1, remaining: 0 });
    expect(h.query.mock.calls[1]?.[1]).toContain("manual_review");
    expect(h.query.mock.calls[1]?.[1]).toContain("partial_refund");
  });

  it("does not auto-retry an old unknown when provider lookup fails", async () => {
    const old = { ...row, unknown_since: new Date(Date.now() - 121 * 60_000).toISOString() };
    h.query.mockResolvedValueOnce({ rows: [old] });
    h.getOrder.mockRejectedValue(new Error("provider unavailable"));
    h.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await expect(reconcileUnknownCompensations()).resolves.toEqual({ checked: 1, resolved: 0, manualReview: 1, remaining: 0 });
    expect(h.query.mock.calls[1]?.[1]).toContain("manual_review");
  });
});
