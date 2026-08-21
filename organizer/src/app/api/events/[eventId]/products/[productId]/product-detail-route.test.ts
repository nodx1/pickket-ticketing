import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

/**
 * W2-PS 회귀 — 상품 단건 GET/PATCH/DELETE 가 go `products` 없이 v2 카탈로그로 동작한다.
 *
 * 🔴 이 파일이 지키는 두 게이트(잃으면 돈이 샌다):
 *   1. 판매중 가격변경 차단 — 판매 단계 **조회 실패 시에도 차단**(열어주면 표시가·결제액이 갈라짐)
 *   2. 판매분 있는 상품 삭제 차단 + **조회 실패를 "이미 없음 → 삭제 성공"으로 흡수 금지**
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
    deleteTier: vi.fn(),
    hasActiveSalePhase: vi.fn(),
  };
});

vi.mock("@/lib/auth/permissions", () => ({
  withRole:
    (_role: string, handler: (request: Request, ctx: unknown) => Promise<Response>) =>
    (request: Request) =>
      handler(request, {
        session: { id: "user-1", accountId: "account-1", role: "organizer" },
        params: { eventId: "event-1", productId: "prod-1" },
      }),
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/v2/phase-client", () => ({ hasActiveSalePhase: h.hasActiveSalePhase }));
vi.mock("@/lib/v2/commerce-client", () => ({
  V2CommerceError: h.V2CommerceError,
  getEvent: (...a: unknown[]) => h.getEvent(...a),
  getEventBySlug: (...a: unknown[]) => h.getEventBySlug(...a),
  listTierCatalog: (...a: unknown[]) => h.listTierCatalog(...a),
  upsertTierCatalog: (...a: unknown[]) => h.upsertTierCatalog(...a),
  deleteTier: (...a: unknown[]) => h.deleteTier(...a),
}));

import { DELETE, GET, PATCH } from "@/app/api/events/[eventId]/products/[productId]/route";

const ctx = { params: Promise.resolve({ eventId: "event-1", productId: "prod-1" }) };

function tierRow(over: Record<string, unknown> = {}) {
  return {
    tier_id: "v2-tier-1",
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
    tier_metadata: { go_source: "product" },
    ...over,
  };
}

function getReq() {
  return new Request("http://localhost/x") as unknown as NextRequest;
}
function patchReq(body: Record<string, unknown> = {}) {
  return new Request("http://localhost/x", {
    method: "PATCH",
    body: JSON.stringify({
      name: "일반권",
      type: "ticket",
      isFree: false,
      price: "30000",
      unlimitedStock: false,
      stock: "100",
      minPerOrder: "1",
      taxIncluded: true,
      ...body,
    }),
  }) as unknown as NextRequest;
}
function deleteReq() {
  return new Request("http://localhost/x", { method: "DELETE" }) as unknown as NextRequest;
}

beforeEach(() => {
  h.getEvent.mockReset().mockResolvedValue({ event_id: "event-1", rsvp_enabled: false });
  h.listTierCatalog.mockReset().mockResolvedValue({ tiers: [tierRow()], total: 1 });
  h.upsertTierCatalog.mockReset().mockResolvedValue({ tiers: [{ tier_id: "v2-tier-1" }] });
  h.deleteTier.mockReset().mockResolvedValue({ deleted: true });
  h.hasActiveSalePhase.mockReset().mockResolvedValue(false);
});

describe("product GET", () => {
  it("정상 — 카탈로그 행 투영", async () => {
    const json = await (await GET(getReq(), ctx)).json();
    expect(json.data).toMatchObject({ id: "prod-1", stock: 100 });
  });

  it("카탈로그에 없으면 404", async () => {
    h.listTierCatalog.mockResolvedValue({ tiers: [], total: 0 });
    expect((await GET(getReq(), ctx)).status).toBe(404);
  });

  it("🔴 v2 장애 → 503", async () => {
    h.listTierCatalog.mockRejectedValue(new h.V2CommerceError("boom", 500));
    expect((await GET(getReq(), ctx)).status).toBe(503);
  });
});

describe("product PATCH — 가격 게이트", () => {
  it("가격 미변경이면 판매 단계 조회 없이 통과", async () => {
    const res = await PATCH(patchReq({ price: "30000" }), ctx);
    expect(res.status).toBe(200);
    expect(h.hasActiveSalePhase).not.toHaveBeenCalled();
  });

  it("판매중 단계가 있으면 가격 변경 409", async () => {
    h.hasActiveSalePhase.mockResolvedValue(true);
    const res = await PATCH(patchReq({ price: "50000" }), ctx);
    expect(res.status).toBe(409);
    expect(h.upsertTierCatalog).not.toHaveBeenCalled();
  });

  it("🔴 판매 단계 조회 실패 → 502 로 **차단**(모르면 열지 않는다)", async () => {
    h.hasActiveSalePhase.mockRejectedValue(new h.V2CommerceError("phase down", 503));
    const res = await PATCH(patchReq({ price: "50000" }), ctx);
    expect(res.status).toBe(502);
    expect(h.upsertTierCatalog).not.toHaveBeenCalled();
  });

  it("정상 가격 변경 — 안정 멱등키로 upsert", async () => {
    const res = await PATCH(patchReq({ price: "50000" }), ctx);
    expect(res.status).toBe(200);
    const [, tiers, opts] = h.upsertTierCatalog.mock.calls[0];
    expect(tiers[0].base_price).toBe(50000);
    expect(opts.idempotencyKey).toBe("product-tier:prod-1");
  });

  it("존재하지 않는 상품 → 404", async () => {
    h.listTierCatalog.mockResolvedValue({ tiers: [], total: 0 });
    expect((await PATCH(patchReq(), ctx)).status).toBe(404);
  });

  it("🔴 v2 장애 → 503", async () => {
    h.getEvent.mockRejectedValue(new h.V2CommerceError("boom", 500));
    expect((await PATCH(patchReq(), ctx)).status).toBe(503);
  });

  it("판매수보다 적은 재고로 축소하면 v2 409 → 409", async () => {
    h.upsertTierCatalog.mockRejectedValue(new h.V2CommerceError("conflict", 409));
    expect((await PATCH(patchReq({ stock: "1" }), ctx)).status).toBe(409);
  });
});

describe("product DELETE — 판매 이력 가드 + 멱등 흡수 금지", () => {
  it("정상 — v2 단건 삭제 호출 후 200", async () => {
    const res = await DELETE(deleteReq(), ctx);
    expect(res.status).toBe(200);
    expect(h.deleteTier).toHaveBeenCalledWith("event-1", "prod-1", expect.any(Object));
  });

  it("판매 이력이 있으면 409 · 삭제 미호출", async () => {
    h.listTierCatalog.mockResolvedValue({ tiers: [tierRow({ sold_count: 3 })], total: 1 });
    const res = await DELETE(deleteReq(), ctx);
    expect(res.status).toBe(409);
    expect(h.deleteTier).not.toHaveBeenCalled();
  });

  it("🔴 카탈로그 조회 실패를 '이미 없음 → 200 deleted' 로 흡수하지 않는다(503)", async () => {
    h.listTierCatalog.mockRejectedValue(new h.V2CommerceError("boom", 500));
    const res = await DELETE(deleteReq(), ctx);
    expect(res.status).toBe(503);
    expect(h.deleteTier).not.toHaveBeenCalled();
  });

  it("🔴 v2 삭제 호출이 5xx 면 200 이 아니라 503", async () => {
    h.deleteTier.mockRejectedValue(new h.V2CommerceError("boom", 502));
    expect((await DELETE(deleteReq(), ctx)).status).toBe(503);
  });

  it("존재하지 않는 상품 → 404", async () => {
    h.listTierCatalog.mockResolvedValue({ tiers: [], total: 0 });
    expect((await DELETE(deleteReq(), ctx)).status).toBe(404);
  });

  it("다른 상품의 번들 구성에서 삭제된 상품을 제거한다", async () => {
    h.listTierCatalog.mockResolvedValue({
      tiers: [
        tierRow(),
        tierRow({
          external_ref: "prod-bundle",
          tier_id: "v2-tier-2",
          product_type: "bundle",
          bundle_items: [
            { productId: "prod-1", quantity: 1 },
            { productId: "prod-keep", quantity: 2 },
          ],
        }),
      ],
      total: 2,
    });
    const res = await DELETE(deleteReq(), ctx);
    expect(res.status).toBe(200);
    const [, tiers] = h.upsertTierCatalog.mock.calls[0];
    expect(tiers[0].external_ref).toBe("prod-bundle");
    expect(tiers[0].bundle_items).toEqual([{ productId: "prod-keep", quantity: 2 }]);
  });

  it("번들 정리 실패는 삭제 결과를 뒤집지 않는다(200 유지)", async () => {
    h.listTierCatalog.mockResolvedValue({
      tiers: [
        tierRow(),
        tierRow({
          external_ref: "prod-bundle",
          bundle_items: [{ productId: "prod-1", quantity: 1 }],
        }),
      ],
      total: 2,
    });
    h.upsertTierCatalog.mockRejectedValue(new h.V2CommerceError("boom", 502));
    expect((await DELETE(deleteReq(), ctx)).status).toBe(200);
  });
});
