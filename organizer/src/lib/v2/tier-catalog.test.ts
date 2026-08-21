import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * W2-PS 단위 회귀 — 상품·좌석등급 ↔ v2 티어 카탈로그 매핑.
 *
 * 여기서 지키는 계약 3가지:
 *   ① 재고: `stock_limit` 이 원본(null=무제한, 0=재고없음), `capacity` 는 파생 집행값.
 *      **0 을 무제한(1,000,000)으로 승격시키지 않는다** — 종전 go 의 초과판매 결함.
 *   ② 출처: `tier_metadata.go_source` 로 상품/좌석등급 화면을 분리(한 테이블 공유).
 *   ③ 실패: 조회/저장 실패를 빈 값·성공으로 흡수하지 않는다.
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
  return { V2CommerceError, listTierCatalog: vi.fn(), upsertTierCatalog: vi.fn() };
});

vi.mock("@/lib/v2/commerce-client", () => ({
  V2CommerceError: h.V2CommerceError,
  listTierCatalog: (...a: unknown[]) => h.listTierCatalog(...a),
  upsertTierCatalog: (...a: unknown[]) => h.upsertTierCatalog(...a),
}));

import {
  classifyTier,
  loadCatalog,
  parseStockInput,
  saveCatalogEntry,
  selectProducts,
  selectSeatTiers,
  toCapacity,
  toProductUpsert,
  toProductView,
  toSeatTierUpsert,
  toSeatTierView,
  upsertBundleItemRemoval,
  UNLIMITED_TIER_CAPACITY,
  validateBundleItems,
  type CatalogEntry,
} from "@/lib/v2/tier-catalog";

function row(over: Record<string, unknown> = {}) {
  return {
    tier_id: "v2-1",
    external_ref: "prod-1",
    name: "일반권",
    capacity: 100,
    base_price: 30000,
    sale_mode: "fixed_fcfs",
    sale_window: { opens_at: null, closes_at: null },
    sold_count: 0,
    fill_rate: 0,
    stock_limit: 100,
    description: null,
    product_type: "ticket",
    visibility: "public",
    tax_rate: 10,
    tax_included: true,
    image_url: null,
    sort_order: 0,
    min_per_order: 1,
    max_per_order: null,
    is_active: true,
    bundle_items: null,
    color_hex: null,
    seat_map_id: null,
    tier_metadata: null,
    face_price: 0,
    min_price: 0,
    max_price_cap: 0,
    section_name: null,
    seating_type: "assigned",
    view_description: null,
    distance_from_stage: null,
    view_rating: null,
    view_image_url: null,
    position_label: null,
    resale_allowed: true,
    resale_max_price: 0,
    allow_group_tickets: true,
    max_group_size: 4,
    ...over,
  };
}

beforeEach(() => {
  h.listTierCatalog.mockReset();
  h.upsertTierCatalog.mockReset().mockResolvedValue({ tiers: [{ tier_id: "v2-1" }] });
});

describe("재고(stock) ↔ capacity 계약", () => {
  it("무제한(null) → sentinel capacity", () => {
    expect(toCapacity(null)).toBe(UNLIMITED_TIER_CAPACITY);
  });

  it("🔴 재고 0 → capacity 0 (무제한으로 승격 금지)", () => {
    expect(toCapacity(0)).toBe(0);
  });

  it("양수 재고는 그대로", () => {
    expect(toCapacity(37)).toBe(37);
  });

  it("음수는 0 으로 클램프(재고 음수는 존재할 수 없다)", () => {
    expect(toCapacity(-5)).toBe(0);
  });

  it("parseStockInput — 무제한 체크는 null, 빈 입력은 0", () => {
    expect(parseStockInput(true, "999")).toBeNull();
    expect(parseStockInput(false, undefined)).toBe(0);
    expect(parseStockInput(false, "12")).toBe(12);
    expect(parseStockInput(false, "abc")).toBe(0);
  });

  it("🔴 view 는 capacity 가 아니라 stock_limit 을 재고로 노출", () => {
    const entry: CatalogEntry = { row: row({ capacity: 1_000_000, stock_limit: null }), ref: "prod-1", source: "product" };
    expect(toProductView(entry, [entry]).stock).toBeNull();
  });

  it("upsert 는 stock_limit 과 파생 capacity 를 함께 싣는다", () => {
    const out = toProductUpsert({
      ref: "p1", name: "n", type: "ticket", price: 1000, stock: 0,
      minPerOrder: 1, maxPerOrder: null, taxIncluded: true, taxRate: 10,
      saleStartsAt: null, saleEndsAt: null, imageUrl: null,
    });
    expect(out.stock_limit).toBe(0);
    expect(out.capacity).toBe(0);
  });
});

describe("출처 판정(go_source)", () => {
  it("메타에 표시된 값이 우선", () => {
    expect(classifyTier(row({ tier_metadata: { go_source: "seat_tier" } }))).toBe("seat_tier");
    expect(classifyTier(row({ tier_metadata: { go_source: "product" } }))).toBe("product");
  });

  it("빌더 흔적(seat_map_id/color_hex)이 있으면 좌석등급", () => {
    expect(classifyTier(row({ color_hex: "#fff000" }))).toBe("seat_tier");
    expect(classifyTier(row({ seat_map_id: "map-1" }))).toBe("seat_tier");
  });

  it("레거시(미표시·흔적없음)는 상품으로 간주", () => {
    expect(classifyTier(row())).toBe("product");
  });

  it("selectProducts/selectSeatTiers 가 서로의 행을 배제", () => {
    const entries: CatalogEntry[] = [
      { row: row(), ref: "prod-1", source: "product" },
      { row: row({ external_ref: "tier-1" }), ref: "tier-1", source: "seat_tier" },
    ];
    expect(selectProducts(entries).map((e) => e.ref)).toEqual(["prod-1"]);
    expect(selectSeatTiers(entries).map((e) => e.ref)).toEqual(["tier-1"]);
  });

  it("좌석등급 upsert 는 stock_limit 을 싣지 않는다(상품 재고 개념 아님)", () => {
    const out = toSeatTierUpsert({ ref: "t1", name: "VIP", capacity: 0, basePrice: 5000 });
    expect(out).not.toHaveProperty("stock_limit");
    expect(out.capacity).toBe(0);
    expect(out.tier_metadata).toMatchObject({ go_source: "seat_tier" });
  });
});

describe("뷰 매핑", () => {
  it("상품 id 는 external_ref (URL 보존)", () => {
    const entry: CatalogEntry = { row: row(), ref: "prod-1", source: "product" };
    expect(toProductView(entry, [entry]).id).toBe("prod-1");
  });

  it("번들 구성품 이름/가격을 형제 행에서 보강", () => {
    const bundle: CatalogEntry = {
      row: row({ external_ref: "b1", bundle_items: [{ productId: "prod-1", quantity: 2 }] }),
      ref: "b1",
      source: "product",
    };
    const child: CatalogEntry = { row: row(), ref: "prod-1", source: "product" };
    const view = toProductView(bundle, [bundle, child]);
    expect(view.bundleItems).toEqual([
      { productId: "prod-1", quantity: 2, productName: "일반권", price: 30000 },
    ]);
  });

  it("좌석등급 뷰는 sort_order → displayOrder, sold_count 를 보강", () => {
    const entry: CatalogEntry = {
      row: row({ external_ref: "t1", sort_order: 3, sold_count: 7, color_hex: "#112233" }),
      ref: "t1",
      source: "seat_tier",
    };
    const view = toSeatTierView(entry, "acct", "ev");
    expect(view).toMatchObject({ id: "t1", displayOrder: 3, soldCount: 7, colorHex: "#112233", accountId: "acct", eventId: "ev" });
  });
});

describe("번들 검증", () => {
  const siblings: CatalogEntry[] = [
    { row: row(), ref: "prod-1", source: "product" },
    { row: row({ external_ref: "prod-2" }), ref: "prod-2", source: "product" },
  ];

  it("빈 구성 / 중복 / 자기참조 / 외부상품을 각각 거부", () => {
    expect(validateBundleItems(siblings, "b", [])).toMatch(/최소 1개/);
    expect(validateBundleItems(siblings, "b", [
      { productId: "prod-1", quantity: 1 }, { productId: "prod-1", quantity: 1 },
    ])).toMatch(/중복/);
    expect(validateBundleItems(siblings, "prod-1", [{ productId: "prod-1", quantity: 1 }])).toMatch(/자기 자신/);
    expect(validateBundleItems(siblings, "b", [{ productId: "unknown", quantity: 1 }])).toMatch(/같은 이벤트/);
  });

  it("정상 구성은 null", () => {
    expect(validateBundleItems(siblings, "b", [{ productId: "prod-2", quantity: 1 }])).toBeNull();
  });
});

describe("실패 취급", () => {
  it("loadCatalog 실패는 빈 배열로 흡수하지 않고 전파", async () => {
    h.listTierCatalog.mockRejectedValue(new h.V2CommerceError("boom", 500));
    await expect(loadCatalog("ev")).rejects.toBeInstanceOf(h.V2CommerceError);
  });

  it("🔴 upsert 응답에 tier_id 가 없으면 성공으로 흡수하지 않는다", async () => {
    h.upsertTierCatalog.mockResolvedValue({ tiers: [] });
    await expect(
      saveCatalogEntry("ev", toSeatTierUpsert({ ref: "t", name: "n", capacity: 1, basePrice: 0 }), "k"),
    ).rejects.toBeInstanceOf(h.V2CommerceError);
  });

  it("upsertBundleItemRemoval 은 영향 받는 행만 부분 upsert", async () => {
    const entries: CatalogEntry[] = [
      { row: row({ external_ref: "b1", bundle_items: [{ productId: "gone", quantity: 1 }, { productId: "keep", quantity: 1 }] }), ref: "b1", source: "product" },
      { row: row({ external_ref: "b2", bundle_items: [{ productId: "keep", quantity: 1 }] }), ref: "b2", source: "product" },
    ];
    const n = await upsertBundleItemRemoval("ev", entries, "gone");
    expect(n).toBe(1);
    const [, payload] = h.upsertTierCatalog.mock.calls[0];
    expect(payload).toHaveLength(1);
    expect(payload[0].external_ref).toBe("b1");
    expect(payload[0].bundle_items).toEqual([{ productId: "keep", quantity: 1 }]);
  });

  it("영향 행이 없으면 호출하지 않는다", async () => {
    const entries: CatalogEntry[] = [{ row: row({ external_ref: "b2" }), ref: "b2", source: "product" }];
    expect(await upsertBundleItemRemoval("ev", entries, "gone")).toBe(0);
    expect(h.upsertTierCatalog).not.toHaveBeenCalled();
  });
});
