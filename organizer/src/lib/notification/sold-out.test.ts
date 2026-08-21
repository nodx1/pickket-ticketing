import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  class FakeV2Error extends Error {
    status: number;
    constructor(message: string, status = 500) {
      super(message);
      this.status = status;
    }
  }
  return {
    pool: { query: vi.fn() },
    getOrder: vi.fn(),
    getTiersByEvent: vi.fn(),
    FakeV2Error,
  };
});

vi.mock("@/lib/db/pool", () => ({ getPool: () => h.pool }));
vi.mock("@/lib/v2/commerce-client", () => ({
  getOrder: (...a: unknown[]) => h.getOrder(...a),
  getTiersByEvent: (...a: unknown[]) => h.getTiersByEvent(...a),
  V2CommerceError: h.FakeV2Error,
}));

import { resolveSoldOutProductsForOrder } from "./sold-out";

function anchorRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    rows: [{
      accountId: "acc-1",
      eventId: "evt-go-1",
      v2OrderId: "v2-ord-1",
      ...over,
    }],
  };
}

function tier(over: Partial<Record<string, unknown>>) {
  return {
    tier_id: "t", external_ref: "p", name: "티어", capacity: 10, base_price: 1000,
    sold_count: 0, fill_rate: 0, sale_mode: null, sale_window: { opens_at: null, closes_at: null },
    ...over,
  };
}

afterEach(() => {
  h.pool.query.mockReset();
  h.getOrder.mockReset();
  h.getTiersByEvent.mockReset();
});

describe("resolveSoldOutProductsForOrder — 매진 알림 대상(v2 정본)", () => {
  it("sold_count ≥ capacity 인 주문 상품만 매진으로 반환한다", async () => {
    h.pool.query.mockResolvedValue(anchorRow());
    h.getOrder.mockResolvedValue({
      items: [
        { external_ref: "prod-A", product_name: "A석" },
        { external_ref: "prod-B", product_name: "B석" },
      ],
    });
    h.getTiersByEvent.mockResolvedValue(new Map([
      ["prod-A", tier({ external_ref: "prod-A", capacity: 5, sold_count: 5, name: "A석" })], // 매진
      ["prod-B", tier({ external_ref: "prod-B", capacity: 5, sold_count: 3, name: "B석" })], // 잔여
    ]));

    const out = await resolveSoldOutProductsForOrder("go-ord-1");
    expect(out).toEqual([{ accountId: "acc-1", eventId: "evt-go-1", productName: "A석" }]);
  });

  it("capacity 0(무제한) 티어는 매진 판정에서 제외한다", async () => {
    h.pool.query.mockResolvedValue(anchorRow());
    h.getOrder.mockResolvedValue({ items: [{ external_ref: "prod-U", product_name: "무제한" }] });
    h.getTiersByEvent.mockResolvedValue(new Map([
      ["prod-U", tier({ external_ref: "prod-U", capacity: 0, sold_count: 999 })],
    ]));
    expect(await resolveSoldOutProductsForOrder("go-ord-1")).toEqual([]);
  });

  it("중복 external_ref 는 1건으로 dedupe 한다", async () => {
    h.pool.query.mockResolvedValue(anchorRow());
    h.getOrder.mockResolvedValue({
      items: [
        { external_ref: "prod-A", product_name: "A석" },
        { external_ref: "prod-A", product_name: "A석" },
      ],
    });
    h.getTiersByEvent.mockResolvedValue(new Map([
      ["prod-A", tier({ external_ref: "prod-A", capacity: 2, sold_count: 2, name: "A석" })],
    ]));
    const out = await resolveSoldOutProductsForOrder("go-ord-1");
    expect(out).toHaveLength(1);
  });

  it("미앵커 주문(v2_order_id NULL)은 빈 목록 — v2 조회 없음", async () => {
    h.pool.query.mockResolvedValue(anchorRow({ v2OrderId: null }));
    const out = await resolveSoldOutProductsForOrder("go-ord-1");
    expect(out).toEqual([]);
    expect(h.getOrder).not.toHaveBeenCalled();
  });

  // ── W4-EVT 회귀 ──
  it("go events JOIN 없이 orders 단독으로 앵커를 읽고, 티어는 go event id(항등)로 조회한다", async () => {
    h.pool.query.mockResolvedValue(anchorRow());
    h.getOrder.mockResolvedValue({ items: [] });
    h.getTiersByEvent.mockResolvedValue(new Map());

    await resolveSoldOutProductsForOrder("go-ord-1");

    const sqls = h.pool.query.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(sqls.some((s) => /\bJOIN\s+events\b/i.test(s))).toBe(false);
    expect(sqls.some((s) => /\bFROM\s+events\b/i.test(s))).toBe(false);
    expect(h.getTiersByEvent).toHaveBeenCalledWith("evt-go-1");
  });

  it("v2 조회 실패 시 빈 목록으로 폴백(결제완료 흐름 비차단)", async () => {
    h.pool.query.mockResolvedValue(anchorRow());
    h.getOrder.mockRejectedValue(new h.FakeV2Error("boom", 502));
    h.getTiersByEvent.mockResolvedValue(new Map());
    await expect(resolveSoldOutProductsForOrder("go-ord-1")).resolves.toEqual([]);
  });

  // ── W4-ORD 결함 회귀: 죽은 앵커 컬럼(events.v2_event_id, writer 0)이 매진 알림을 통째로
  //    죽이고 있었다. 이제 go events 를 JOIN 하지 않고 orders.event_id 를 v2 event id 로 쓴다.
  it("go events 를 JOIN 하지 않고 orders.event_id 를 v2 티어 조회 키로 쓴다", async () => {
    h.pool.query.mockResolvedValue(anchorRow());
    h.getOrder.mockResolvedValue({ items: [{ external_ref: "prod-A", product_name: "A석" }] });
    h.getTiersByEvent.mockResolvedValue(new Map([
      ["prod-A", tier({ external_ref: "prod-A", capacity: 1, sold_count: 1, name: "A석" })],
    ]));

    const out = await resolveSoldOutProductsForOrder("go-ord-1");

    // 항등: go orders.event_id 가 곧 v2 event id.
    expect(h.getTiersByEvent).toHaveBeenCalledWith("evt-go-1");
    expect(out).toEqual([{ accountId: "acc-1", eventId: "evt-go-1", productName: "A석" }]);
    // 옛 결함 재발 방지 — events JOIN 이 다시 들어오면 실패한다.
    const sql = String(h.pool.query.mock.calls[0]?.[0] ?? "");
    expect(sql).not.toMatch(/JOIN\s+events/);
    expect(sql).not.toContain("v2_event_id");
  });
});
