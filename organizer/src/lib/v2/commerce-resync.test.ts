import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  resolveOwned: vi.fn(),
  upsertTiers: vi.fn(),
  pool: { query: vi.fn() },
}));
vi.mock("@/lib/db/pool", () => ({ getPool: () => h.pool }));
// 레벨2 T2-EVT — go events 소유 SELECT + ensureV2EventAnchor 2단계가 v2 소유조회 1회로 대체됨.
vi.mock("@/lib/v2/event-access", () => ({
  resolveOwnedV2EventId: (...a: unknown[]) => h.resolveOwned(...a),
}));
vi.mock("@/lib/v2/commerce-client", () => ({
  upsertTiers: (...a: unknown[]) => h.upsertTiers(...a),
}));

import { resyncEventCommerce } from "@/lib/v2/commerce-resync";

afterEach(() => {
  h.resolveOwned.mockReset();
  h.upsertTiers.mockReset();
  h.pool.query.mockReset();
});

describe("resyncEventCommerce", () => {
  it("상품+티어를 v2 재-upsert 하고 tier_id 를 앵커에 반영", async () => {
    h.pool.query
      .mockResolvedValueOnce({ rows: [{ id: "p1", name: "갤러리", price: "50000", stock: 5000, sale_mode: null }] }) // products
      .mockResolvedValueOnce({ rows: [{ id: "st1", name: "VIP", capacity: 100, base_price: 80000, sale_mode: "fixed_fcfs" }] }) // seat_tiers
      .mockResolvedValue({ rows: [] }); // UPDATE 들
    h.resolveOwned.mockResolvedValue("v2-1");
    h.upsertTiers.mockResolvedValue({
      tiers: [
        { external_ref: "p1", tier_id: "t-p1" },
        { external_ref: "st1", tier_id: "t-st1" },
      ],
    });

    const r = await resyncEventCommerce("go-1", "acc-1");
    expect(r).toEqual({ v2EventId: "v2-1", tierCount: 2 });

    // 🔴 테넌트 경계: accountId 가 v2 소유조회로 반드시 전달돼야 한다(크로스테넌트 방지).
    expect(h.resolveOwned).toHaveBeenCalledWith("go-1", "acc-1");
    // go events SELECT 는 완전히 사라졌다.
    expect(
      h.pool.query.mock.calls.some((c: unknown[]) => String(c[0]).includes("FROM events")),
    ).toBe(false);

    // upsertTiers 입력: 상품 + 좌석티어 둘 다 external_ref 로 전달
    const [v2id, inputs] = h.upsertTiers.mock.calls[0];
    expect(v2id).toBe("v2-1");
    expect(inputs.map((i: { external_ref: string }) => i.external_ref).sort()).toEqual(["p1", "st1"]);
    expect(inputs.find((i: { external_ref: string }) => i.external_ref === "p1").capacity).toBe(5000);
  });

  it("미소유/미존재 이벤트는 차단(커머스 쿼리 미실행)", async () => {
    h.resolveOwned.mockResolvedValue(null); // v2 404 = 없거나 내 것 아님
    await expect(resyncEventCommerce("go-x", "acc-1")).rejects.toThrow(/찾을 수 없/);
    expect(h.pool.query).not.toHaveBeenCalled();
    expect(h.upsertTiers).not.toHaveBeenCalled();
  });

  it("커머스가 없으면 tierCount 0 (upsert 미호출)", async () => {
    h.pool.query
      .mockResolvedValueOnce({ rows: [] }) // products 없음
      .mockResolvedValueOnce({ rows: [] }); // seat_tiers 없음
    h.resolveOwned.mockResolvedValue("v2-1");
    const r = await resyncEventCommerce("go-1", "acc-1");
    expect(r).toEqual({ v2EventId: "v2-1", tierCount: 0 });
    expect(h.upsertTiers).not.toHaveBeenCalled();
  });
});
