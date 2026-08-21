import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * W2-PS 회귀 — RSVP/초대권 0원 상품 resolve-or-create 가 go `products` 없이 동작한다.
 *
 * 🔴 멱등성("동시 2회 실행하면?"): external_ref 가 `uuidv5("freeprod:{eventId}:{slug}")` 로
 *    **결정적**이라 advisory lock 없이도 두 요청이 같은 tier 로 수렴한다(v2 external_ref UNIQUE).
 * 🔴 트랜잭션 경계("외부호출 후 crash?"): 로컬 write 가 없다. 재시도는 같은 키로 같은 tier 를 얻는다.
 * 🔴 숨김 계약: visibility=hidden 이라 공개 상품목록에 절대 노출되지 않는다.
 */

const h = vi.hoisted(() => {
  class V2CommerceError extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
      this.name = "V2CommerceError";
    }
  }
  return {
    V2CommerceError,
    getEvent: vi.fn(),
    getEventBySlug: vi.fn(),
    listTierCatalog: vi.fn(),
    upsertTierCatalog: vi.fn(),
  };
});

vi.mock("@/lib/v2/commerce-client", () => ({
  V2CommerceError: h.V2CommerceError,
  getEvent: (...a: unknown[]) => h.getEvent(...a),
  getEventBySlug: (...a: unknown[]) => h.getEventBySlug(...a),
  listTierCatalog: (...a: unknown[]) => h.listTierCatalog(...a),
  upsertTierCatalog: (...a: unknown[]) => h.upsertTierCatalog(...a),
}));

import {
  COMP_PRODUCT_NAME,
  ensureCompProduct,
  ensureRsvpProduct,
  freeProductRef,
  RSVP_PRODUCT_NAME,
} from "@/lib/server/rsvp-product";

beforeEach(() => {
  h.getEvent.mockReset().mockResolvedValue({ event_id: "event-1" });
  h.listTierCatalog.mockReset().mockResolvedValue({ tiers: [], total: 0 });
  h.upsertTierCatalog.mockReset().mockResolvedValue({ tiers: [{ tier_id: "v2-tier-free" }] });
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("freeProductRef — 결정적 키", () => {
  it("같은 (eventId, 이름) 은 항상 같은 ref", () => {
    expect(freeProductRef("ev", RSVP_PRODUCT_NAME)).toBe(freeProductRef("ev", RSVP_PRODUCT_NAME));
    expect(freeProductRef("ev", COMP_PRODUCT_NAME)).toBe(freeProductRef("ev", COMP_PRODUCT_NAME));
  });

  it("RSVP 와 초대권은 서로 다른 상품", () => {
    expect(freeProductRef("ev", RSVP_PRODUCT_NAME)).not.toBe(freeProductRef("ev", COMP_PRODUCT_NAME));
  });

  it("이벤트가 다르면 ref 도 다르다(이벤트 간 공유 금지)", () => {
    expect(freeProductRef("ev1", COMP_PRODUCT_NAME)).not.toBe(freeProductRef("ev2", COMP_PRODUCT_NAME));
  });

  it("🔴 UUID v5 형태 — go 잔존 경로(order_items.product_id uuid)의 타입 계약을 깨지 않는다", () => {
    expect(freeProductRef("ev", RSVP_PRODUCT_NAME)).toMatch(UUID_RE);
  });

  it("🔴 값이 고정 — 네임스페이스/파생식이 바뀌면 과거 주문과 연결이 끊긴다(고정 스냅샷)", () => {
    // 이 기대값이 깨지면 기존 이벤트의 RSVP/초대권 상품 id 가 갈라진다는 뜻이다.
    // 파생식을 바꿔야 한다면 **기존 ref 를 새 ref 로 옮기는 마이그레이션**이 함께 필요하다.
    const EV = "11111111-1111-4111-8111-111111111111";
    expect(freeProductRef(EV, RSVP_PRODUCT_NAME)).toBe("a8a329e4-510c-548e-9c9b-e74e5708ab14");
    expect(freeProductRef(EV, COMP_PRODUCT_NAME)).toBe("7375b4ac-89d5-51ff-a23e-b4761931f9e9");
  });
});

describe("ensureRsvpProduct / ensureCompProduct", () => {
  it("정상 — hidden·0원 상품을 결정적 멱등키로 upsert", async () => {
    const ref = freeProductRef("event-1", RSVP_PRODUCT_NAME);
    const out = await ensureRsvpProduct(null, "event-1", "account-1");
    expect(out).toEqual({ productId: ref });

    const [v2EventId, tiers, opts] = h.upsertTierCatalog.mock.calls[0];
    expect(v2EventId).toBe("event-1");
    expect(tiers[0]).toMatchObject({
      external_ref: ref,
      visibility: "hidden",
      base_price: 0,
      stock_limit: null,
    });
    expect(opts.idempotencyKey).toBe(`free-product-tier:${ref}`);
  });

  it("🔴 동시/재시도 2회 — 같은 external_ref·같은 멱등키(이중생성 불가)", async () => {
    const [a, b] = await Promise.all([
      ensureCompProduct(null, "event-1", "account-1"),
      ensureCompProduct(null, "event-1", "account-1"),
    ]);
    expect(a).toEqual(b);
    const keys = h.upsertTierCatalog.mock.calls.map((c) => (c[2] as { idempotencyKey: string }).idempotencyKey);
    expect(new Set(keys).size).toBe(1);
  });

  it("comp 캡을 넘기면 tier capacity 상한으로 집행된다", async () => {
    await ensureCompProduct(null, "event-1", "account-1", 50);
    const [, tiers] = h.upsertTierCatalog.mock.calls[0];
    expect(tiers[0].stock_limit).toBe(50);
    expect(tiers[0].capacity).toBe(50);
  });

  it("이미 있으면 기존 capacity 를 덮지 않는다(최초 생성 시점 계약)", async () => {
    h.listTierCatalog.mockResolvedValue({
      tiers: [{
        tier_id: "v2-x", external_ref: freeProductRef("event-1", COMP_PRODUCT_NAME), name: COMP_PRODUCT_NAME,
        capacity: 30, base_price: 0, sale_mode: "fixed_fcfs",
        sale_window: { opens_at: null, closes_at: null }, sold_count: 0, fill_rate: 0,
        stock_limit: 30, visibility: "hidden", product_type: "ticket", description: null,
        tax_rate: 0, tax_included: false, image_url: null, sort_order: 0, min_per_order: 1,
        max_per_order: null, is_active: true, bundle_items: null, color_hex: null,
        seat_map_id: null, tier_metadata: { go_source: "product" },
      }],
      total: 1,
    });
    await ensureCompProduct(null, "event-1", "account-1", 999);
    const [, tiers] = h.upsertTierCatalog.mock.calls[0];
    expect(tiers[0].stock_limit).toBe(30);
  });

  it("미소유/미존재 이벤트 → null (호출부가 재시도 가능 오류로 처리)", async () => {
    h.getEvent.mockRejectedValue(new h.V2CommerceError("nf", 404));
    expect(await ensureRsvpProduct(null, "event-1", "account-1")).toBeNull();
    expect(h.upsertTierCatalog).not.toHaveBeenCalled();
  });

  it("v2 장애 → null (조용한 성공 금지)", async () => {
    h.upsertTierCatalog.mockRejectedValue(new h.V2CommerceError("boom", 502));
    expect(await ensureRsvpProduct(null, "event-1", "account-1")).toBeNull();
  });

  it("🔴 upsert 응답에 tier_id 가 없으면 null (저장 불명을 성공으로 흡수 금지)", async () => {
    h.upsertTierCatalog.mockResolvedValue({ tiers: [] });
    expect(await ensureRsvpProduct(null, "event-1", "account-1")).toBeNull();
  });
});
