import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getTiersByEvent, V2CommerceError } from "./commerce-client";

const OLD_ENV = { ...process.env };

function tierEnvelope(tiers: Array<Partial<Record<string, unknown>>>) {
  return new Response(
    JSON.stringify({ ok: true, data: { tiers, total: tiers.length } }),
    { status: 200 },
  );
}

beforeEach(() => {
  process.env.V2_INTERNAL_BASE_URL = "https://v2.test";
  process.env.GO_WEBHOOK_SECRET = "test-secret";
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...OLD_ENV };
});

describe("getTiersByEvent — 금액/재고 정본 read 맵", () => {
  it("external_ref(=go productId) 기준 맵을 만들고 base_price/capacity/sold_count 를 보존한다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      tierEnvelope([
        { tier_id: "t1", external_ref: "prod-1", name: "일반", capacity: 100, base_price: 50000, sold_count: 30, fill_rate: 0.3, sale_mode: "fixed_fcfs", sale_window: { opens_at: null, closes_at: null } },
        { tier_id: "t2", external_ref: "prod-2", name: "VIP", capacity: 10, base_price: 120000, sold_count: 10, fill_rate: 1, sale_mode: "fixed_fcfs", sale_window: { opens_at: null, closes_at: null } },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const map = await getTiersByEvent("v2-evt-1");

    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain("/api/v1/internal/events/v2-evt-1/tiers");
    expect(map.size).toBe(2);
    // 금액 정본: base_price 가 그대로 노출(go price 대체) → 전환으로 금액 변하지 않음의 근거.
    expect(map.get("prod-1")?.base_price).toBe(50000);
    expect(map.get("prod-2")?.base_price).toBe(120000);
    // 재고 정본: capacity/sold_count.
    expect(map.get("prod-1")?.capacity).toBe(100);
    expect(map.get("prod-1")?.sold_count).toBe(30);
    expect(map.get("prod-2")?.sold_count).toBe(10);
  });

  it("external_ref 가 NULL 인 티어(go 앵커 없음)는 맵에서 제외한다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      tierEnvelope([
        { tier_id: "t1", external_ref: "prod-1", name: "일반", capacity: 100, base_price: 50000, sold_count: 0, fill_rate: 0, sale_mode: null, sale_window: { opens_at: null, closes_at: null } },
        { tier_id: "t2", external_ref: null, name: "v2-전용", capacity: 20, base_price: 9999, sold_count: 0, fill_rate: 0, sale_mode: null, sale_window: { opens_at: null, closes_at: null } },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const map = await getTiersByEvent("v2-evt-1");
    expect(map.size).toBe(1);
    expect(map.has("prod-1")).toBe(true);
    expect([...map.values()].some((t) => t.base_price === 9999)).toBe(false);
  });

  it("v2 4xx 는 V2CommerceError 로 전파(조용한 0원 강등 금지)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "EVENT_NOT_FOUND", message: "no" } }), { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(getTiersByEvent("v2-missing")).rejects.toBeInstanceOf(V2CommerceError);
  });
});
