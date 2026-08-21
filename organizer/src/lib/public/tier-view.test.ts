/**
 * 공개 재고 규칙 회귀 — 적대 감사 F-5·F-6.
 *
 * 이 규칙(필터·잔여·총좌석·판매창)이 라우트마다 복붙돼 있었기 때문에 한쪽만 고쳐지고
 * 위젯 embed 는 go `products` 를 계속 읽어 **상품 0개**로 렌더됐다. 규칙을 순수 함수로 모으고
 * 여기서 고정한다 — 값을 뒤집으면 아래 단언이 죽어야 한다.
 */
import { describe, expect, it } from "vitest";
import type { TierCatalogRow } from "@/lib/v2/commerce-client";
import { UNLIMITED_TIER_CAPACITY } from "@/lib/v2/tier-catalog";
import {
  isPubliclyVisibleTier,
  selectPublicTiers,
  tierIsOnSale,
  tierRemainingStock,
  tierTotalCapacity,
} from "./tier-view";

function tier(over: Partial<TierCatalogRow> = {}): TierCatalogRow {
  return {
    tier_id: "t1",
    external_ref: "p1",
    name: "일반",
    capacity: 100,
    base_price: 30000,
    sale_mode: "fixed_fcfs",
    sale_window: { opens_at: null, closes_at: null },
    sold_count: 0,
    fill_rate: 0,
    stock_limit: null,
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
    face_price: null,
    min_price: null,
    max_price_cap: null,
    section_name: null,
    seating_type: null,
    view_description: null,
    distance_from_stage: null,
    view_rating: null,
    view_image_url: null,
    position_label: null,
    resale_allowed: null,
    resale_max_price: null,
    allow_group_tickets: null,
    max_group_size: null,
    ...over,
  };
}

describe("tierRemainingStock — 잔여(= capacity − sold_count)", () => {
  // 🔴 판매량이 빠지지 않으면 완판돼도 매진이 안 뜬다(F-3 의 원인).
  it("판매수를 뺀 값이다", () => {
    expect(tierRemainingStock(tier({ capacity: 100, sold_count: 40 }))).toBe(60);
  });

  it("완판이면 0", () => {
    expect(tierRemainingStock(tier({ capacity: 1000, sold_count: 1000 }))).toBe(0);
  });

  // 🔴 stock_limit(주최자 입력 원본)을 쓰면 안 된다 — 좌석등급 경로는 NULL 로 온다(KLPGA).
  it("stock_limit 이 NULL 이어도 capacity 로 잔여를 낸다", () => {
    expect(tierRemainingStock(tier({ stock_limit: null, capacity: 1000, sold_count: 1000 }))).toBe(0);
  });

  it("초과판매(음수)는 0 으로 클램프", () => {
    expect(tierRemainingStock(tier({ capacity: 10, sold_count: 13 }))).toBe(0);
  });

  // 🔴 무제한 sentinel 을 그대로 흘리면 "재고 100만장"이 된다.
  it("무제한 sentinel 은 null", () => {
    expect(tierRemainingStock(tier({ capacity: UNLIMITED_TIER_CAPACITY, sold_count: 7 }))).toBeNull();
  });

  it("재고 0(판매불가)은 무제한이 아니라 0", () => {
    expect(tierRemainingStock(tier({ capacity: 0, sold_count: 0 }))).toBe(0);
  });
});

describe("tierTotalCapacity — 총좌석(F-6: 잔여와 다른 값이다)", () => {
  // 🔴 이 단언이 F-6 의 본체다. 총좌석은 팔려도 줄지 않는다.
  it("판매수를 빼지 않는다 — 팔려도 총좌석은 그대로", () => {
    expect(tierTotalCapacity(tier({ capacity: 100, sold_count: 40 }))).toBe(100);
  });

  it("같은 티어에서 총좌석 ≠ 잔여", () => {
    const t = tier({ capacity: 1000, sold_count: 999 });
    expect(tierTotalCapacity(t)).toBe(1000);
    expect(tierRemainingStock(t)).toBe(1);
  });

  it("무제한 sentinel 은 null", () => {
    expect(tierTotalCapacity(tier({ capacity: UNLIMITED_TIER_CAPACITY }))).toBeNull();
  });
});

describe("isPubliclyVisibleTier — 공개 노출 필터", () => {
  it("비활성 티어는 제외", () => {
    expect(isPubliclyVisibleTier(tier({ is_active: false }))).toBe(false);
  });

  it("private/hidden 은 제외", () => {
    expect(isPubliclyVisibleTier(tier({ visibility: "private" }))).toBe(false);
    expect(isPubliclyVisibleTier(tier({ visibility: "hidden" }))).toBe(false);
  });

  it("public 활성 티어는 노출", () => {
    expect(isPubliclyVisibleTier(tier())).toBe(true);
  });

  // 숨김은 명시적일 때만 — 레거시(메타 미기록) 행을 숨기면 "상품 0개"가 재발한다.
  it("is_active/visibility 미기록 행은 노출한다", () => {
    expect(isPubliclyVisibleTier({ capacity: 10, sold_count: 0 })).toBe(true);
  });
});

describe("tierIsOnSale — 판매창", () => {
  const now = Date.parse("2026-07-28T00:00:00.000Z");

  it("판매창이 없으면 판매중(이벤트 판매창을 따른다)", () => {
    expect(tierIsOnSale(tier(), now)).toBe(true);
  });

  it("판매 시작 전은 false", () => {
    expect(
      tierIsOnSale(tier({ sale_window: { opens_at: "2026-08-01T00:00:00.000Z", closes_at: null } }), now),
    ).toBe(false);
  });

  it("판매 종료 후는 false", () => {
    expect(
      tierIsOnSale(tier({ sale_window: { opens_at: null, closes_at: "2026-07-01T00:00:00.000Z" } }), now),
    ).toBe(false);
  });

  it("창 안이면 true", () => {
    expect(
      tierIsOnSale(
        tier({ sale_window: { opens_at: "2026-07-01T00:00:00.000Z", closes_at: "2026-08-01T00:00:00.000Z" } }),
        now,
      ),
    ).toBe(true);
  });
});

describe("selectPublicTiers", () => {
  it("숨김 티어를 걸러내고 sort_order 순으로 정렬한다", () => {
    const rows = [
      tier({ tier_id: "b", external_ref: "b", name: "B", sort_order: 2 }),
      tier({ tier_id: "hidden", external_ref: "h", name: "H", visibility: "hidden" }),
      tier({ tier_id: "a", external_ref: "a", name: "A", sort_order: 1 }),
    ];
    expect(selectPublicTiers(rows).map((t) => t.external_ref)).toEqual(["a", "b"]);
  });

  // 동순위(주최자가 순서를 안 정한 흔한 경우)는 입력 순서 보존 — 이름순으로 뒤집지 않는다.
  it("sort_order 가 같으면 입력 순서를 유지한다", () => {
    const rows = [
      tier({ tier_id: "1", external_ref: "주중권", name: "주중권", sort_order: 0 }),
      tier({ tier_id: "2", external_ref: "주말권", name: "주말권", sort_order: 0 }),
    ];
    expect(selectPublicTiers(rows).map((t) => t.external_ref)).toEqual(["주중권", "주말권"]);
  });

  // 🔴 빈 입력이 빈 출력인 것은 정상이지만, **조회 실패**를 빈 배열로 바꾸는 책임은
  //    이 함수에 없다(호출부가 5xx 로 끊는다). 라우트 테스트가 그쪽을 고정한다.
  it("빈 목록은 빈 목록", () => {
    expect(selectPublicTiers([])).toEqual([]);
  });
});
