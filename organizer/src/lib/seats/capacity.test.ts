import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * W2-PS 회귀 — 정원 반영이 go(`UPDATE events` / `UPDATE seat_tiers`)가 아니라 **v2 티어 카탈로그**로 간다.
 *
 * 🔴 지키는 것:
 *   - 카탈로그 조회 실패 시 **아무것도 쓰지 않는다**(추측값으로 정원을 덮어쓰면 재고가 갈라진다).
 *   - 레이아웃에 없는 등급은 건드리지 않는다(다른 배치도 등급을 0 으로 지우지 않기).
 *   - 산출값 0 도 그대로 반영한다(좌석 전부 차단 = 판매불가가 정답, 무제한 승격 아님).
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
    listTierCatalog: vi.fn(),
    upsertTierCatalog: vi.fn(),
    listSeats: vi.fn(),
  };
});

vi.mock("@/lib/v2/commerce-client", () => ({
  V2CommerceError: h.V2CommerceError,
  listTierCatalog: (...a: unknown[]) => h.listTierCatalog(...a),
  upsertTierCatalog: (...a: unknown[]) => h.upsertTierCatalog(...a),
  listSeats: (...a: unknown[]) => h.listSeats(...a),
}));

import { computeCapacity, persistCapacity, syncCapacityFromLayout } from "@/lib/seats/capacity";
import type { GeneratedLayout } from "@/lib/seats/seat-generator";

function catalogRow(ref: string, over: Record<string, unknown> = {}) {
  return {
    tier_id: `v2-${ref}`, external_ref: ref, name: `등급 ${ref}`, capacity: 0, base_price: 10000,
    sale_mode: "fixed_fcfs", sale_window: { opens_at: null, closes_at: null },
    sold_count: 0, fill_rate: 0, stock_limit: null, description: null, product_type: "ticket",
    visibility: "public", tax_rate: 10, tax_included: true, image_url: null, sort_order: 0,
    min_per_order: 1, max_per_order: null, is_active: true, bundle_items: null,
    color_hex: "#111111", seat_map_id: null, tier_metadata: { go_source: "seat_tier" },
    face_price: 0, ...over,
  };
}

/** 좌석 2개(tier-A) + 차단 1개 + 스탠딩(tier-B 5명) 레이아웃. */
function layout(): GeneratedLayout {
  return {
    seats: [
      { externalRef: "s1", tierId: "tier-A", section: "A", rowNumber: 1, seatNumber: 1, x: 0, y: 0, label: "A1", blocked: false },
      { externalRef: "s2", tierId: "tier-A", section: "A", rowNumber: 1, seatNumber: 2, x: 1, y: 0, label: "A2", blocked: false },
      { externalRef: "s3", tierId: "tier-A", section: "A", rowNumber: 1, seatNumber: 3, x: 2, y: 0, label: "A3", blocked: true },
    ],
    standingByTier: new Map([["tier-B", 5]]),
    standingTotal: 5,
  } as unknown as GeneratedLayout;
}

beforeEach(() => {
  h.listTierCatalog.mockReset().mockResolvedValue({
    tiers: [catalogRow("tier-A"), catalogRow("tier-B")],
    total: 2,
  });
  h.upsertTierCatalog.mockReset().mockResolvedValue({ tiers: [] });
  h.listSeats.mockReset().mockResolvedValue({
    seats: [], status_counts: {}, total_seats: 0, page_count: 0,
  });
});

describe("computeCapacity", () => {
  it("차단석 제외 + 스탠딩 합산", async () => {
    const c = await computeCapacity(null, "event-1", layout());
    expect(c.capacityByTier.get("tier-A")).toBe(2);
    expect(c.capacityByTier.get("tier-B")).toBe(5);
    expect(c.maxAttendees).toBe(7);
  });

  it("v2 가 reserved 로 잠근 좌석도 제외(판매중지 보정)", async () => {
    h.listSeats.mockResolvedValue({
      seats: [{ seat_id: "x", external_ref: "s1", status: "reserved" }],
      status_counts: { reserved: 1 },
      total_seats: 1,
      page_count: 1,
    });
    const c = await computeCapacity(null, "event-1", layout());
    expect(c.capacityByTier.get("tier-A")).toBe(1);
  });
});

describe("persistCapacity — v2 write-through", () => {
  it("정상 — 레이아웃 등급의 capacity 만 교체해 upsert", async () => {
    const computed = await computeCapacity(null, "event-1", layout());
    await persistCapacity(null, "event-1", "account-1", computed);

    const [v2EventId, payload] = h.upsertTierCatalog.mock.calls[0];
    expect(v2EventId).toBe("event-1");
    const byRef = Object.fromEntries(
      (payload as Array<{ external_ref: string; capacity: number; name: string }>).map((t) => [t.external_ref, t]),
    );
    expect(byRef["tier-A"].capacity).toBe(2);
    expect(byRef["tier-B"].capacity).toBe(5);
    // 이름 등 나머지 필드는 카탈로그 현재값을 유지(전량 upsert 계약 대응)
    expect(byRef["tier-A"].name).toBe("등급 tier-A");
  });

  it("🔴 카탈로그 조회 실패 시 아무것도 쓰지 않고 전파", async () => {
    h.listTierCatalog.mockRejectedValue(new h.V2CommerceError("boom", 500));
    await expect(
      persistCapacity(null, "event-1", "account-1", {
        maxAttendees: 7,
        capacityByTier: new Map([["tier-A", 2]]),
      }),
    ).rejects.toBeInstanceOf(h.V2CommerceError);
    expect(h.upsertTierCatalog).not.toHaveBeenCalled();
  });

  it("v2 에 없는 등급은 payload 에서 제외(유령 등급 생성 금지)", async () => {
    h.listTierCatalog.mockResolvedValue({ tiers: [catalogRow("tier-A")], total: 1 });
    await persistCapacity(null, "event-1", "account-1", {
      maxAttendees: 7,
      capacityByTier: new Map([["tier-A", 2], ["tier-GHOST", 9]]),
    });
    const [, payload] = h.upsertTierCatalog.mock.calls[0];
    expect((payload as Array<{ external_ref: string }>).map((t) => t.external_ref)).toEqual(["tier-A"]);
  });

  it("반영 대상이 없으면 호출하지 않는다", async () => {
    await persistCapacity(null, "event-1", "account-1", { maxAttendees: null, capacityByTier: new Map() });
    expect(h.upsertTierCatalog).not.toHaveBeenCalled();
  });

  it("🔴 출처(go_source)·상품유형을 덮어쓰지 않는다 — 정원 반영이 상품을 목록에서 지우면 안 된다", async () => {
    h.listTierCatalog.mockResolvedValue({
      tiers: [catalogRow("tier-A", {
        tier_metadata: { go_source: "product" }, product_type: "addon",
      })],
      total: 1,
    });
    await persistCapacity(null, "event-1", "account-1", {
      maxAttendees: 2,
      capacityByTier: new Map([["tier-A", 2]]),
    });
    const [, payload] = h.upsertTierCatalog.mock.calls[0];
    const row = (payload as Array<{ tier_metadata: unknown; product_type: string; capacity: number }>)[0];
    expect(row.tier_metadata).toEqual({ go_source: "product" });
    expect(row.product_type).toBe("addon");
    expect(row.capacity).toBe(2);
  });

  it("🔴 산출 정원 0 도 0 으로 반영(무제한 승격 금지)", async () => {
    await persistCapacity(null, "event-1", "account-1", {
      maxAttendees: null,
      capacityByTier: new Map([["tier-A", 0]]),
    });
    const [, payload] = h.upsertTierCatalog.mock.calls[0];
    expect((payload as Array<{ capacity: number }>)[0].capacity).toBe(0);
  });
});

describe("syncCapacityFromLayout", () => {
  it("산출 후 반영까지 수행하고 산출값을 돌려준다", async () => {
    const c = await syncCapacityFromLayout(null, "event-1", "account-1", layout());
    expect(c.maxAttendees).toBe(7);
    expect(h.upsertTierCatalog).toHaveBeenCalledTimes(1);
  });
});
