import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

/**
 * W2-PS 회귀 — 상품 목록/생성이 go `products` 없이 **v2 티어 카탈로그**만으로 동작한다.
 *
 * 검증 축(라우트마다 동일):
 *   ① 정상        — v2 카탈로그를 그대로 투영(재고는 stock_limit, capacity 아님)
 *   ② 미소유/미존재 — 404 (v2 organizer_ref 경계)
 *   ③ v2 장애     — **503**. 빈 목록·404·400 으로 위장하지 않는다
 *   ④ 게이트      — RSVP 이벤트 유료티켓 차단이 조회 실패 시 열리지 않는다(보수적 폴백)
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
  };
});

vi.mock("@/lib/auth/permissions", () => ({
  withRole:
    (_role: string, handler: (request: Request, ctx: unknown) => Promise<Response>) =>
    (request: Request) =>
      handler(request, {
        session: { id: "user-1", accountId: "account-1", role: "organizer" },
        params: { eventId: "event-1" },
      }),
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
// ★ event-access·tier-catalog 은 실물 — 테넌트 경계·에러분류·재고 매핑이 검증 대상. v2 HTTP 만 격리.
vi.mock("@/lib/v2/commerce-client", () => ({
  V2CommerceError: h.V2CommerceError,
  getEvent: (...a: unknown[]) => h.getEvent(...a),
  getEventBySlug: (...a: unknown[]) => h.getEventBySlug(...a),
  listTierCatalog: (...a: unknown[]) => h.listTierCatalog(...a),
  upsertTierCatalog: (...a: unknown[]) => h.upsertTierCatalog(...a),
  deleteTier: (...a: unknown[]) => h.deleteTier(...a),
}));

import { GET, POST } from "@/app/api/events/[eventId]/products/route";

const ctx = { params: Promise.resolve({ eventId: "event-1" }) };

export function tierRow(over: Record<string, unknown> = {}) {
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
  return new Request("http://localhost/api/events/event-1/products") as unknown as NextRequest;
}
function postReq(body: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/events/event-1/products", {
    method: "POST",
    body: JSON.stringify({
      name: "일반권",
      type: "ticket",
      isFree: true,
      unlimitedStock: false,
      stock: "100",
      minPerOrder: "1",
      taxIncluded: true,
      ...body,
    }),
  }) as unknown as NextRequest;
}

beforeEach(() => {
  h.getEvent.mockReset().mockResolvedValue({ event_id: "event-1", rsvp_enabled: false });
  h.listTierCatalog.mockReset().mockResolvedValue({ tiers: [tierRow()], total: 1 });
  h.upsertTierCatalog.mockReset().mockResolvedValue({ tiers: [{ tier_id: "v2-tier-new" }] });
});

describe("products GET — v2 카탈로그 투영", () => {
  it("정상 — external_ref 를 상품 id 로, stock_limit 을 재고로 투영", async () => {
    const res = await GET(getReq(), ctx);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toHaveLength(1);
    expect(json.data[0]).toMatchObject({ id: "prod-1", stock: 100, price: 30000, soldCount: 0 });
    expect(h.getEvent).toHaveBeenCalledWith("event-1", { organizerRef: "account-1" });
  });

  it("🔴 무제한 재고는 stock=null — capacity sentinel(1,000,000)이 새어나오지 않는다", async () => {
    h.listTierCatalog.mockResolvedValue({
      tiers: [tierRow({ capacity: 1_000_000, stock_limit: null })],
      total: 1,
    });
    const json = await (await GET(getReq(), ctx)).json();
    expect(json.data[0].stock).toBeNull();
  });

  it("좌석등급(go_source=seat_tier) 행은 상품 목록에 섞이지 않는다", async () => {
    h.listTierCatalog.mockResolvedValue({
      tiers: [tierRow(), tierRow({ external_ref: "tier-9", tier_metadata: { go_source: "seat_tier" } })],
      total: 2,
    });
    const json = await (await GET(getReq(), ctx)).json();
    expect(json.data.map((p: { id: string }) => p.id)).toEqual(["prod-1"]);
  });

  it("미소유/미존재 → 404", async () => {
    h.getEvent.mockRejectedValue(new h.V2CommerceError("not found", 404));
    expect((await GET(getReq(), ctx)).status).toBe(404);
  });

  it("🔴 v2 장애 → 503 (빈 목록으로 위장 금지)", async () => {
    h.getEvent.mockRejectedValue(new h.V2CommerceError("boom", 502));
    expect((await GET(getReq(), ctx)).status).toBe(503);
  });

  it("🔴 카탈로그 조회 실패 → 503 (이벤트는 살아있어도 빈 목록 금지)", async () => {
    h.listTierCatalog.mockRejectedValue(new h.V2CommerceError("boom", 500));
    expect((await GET(getReq(), ctx)).status).toBe(503);
  });
});

describe("products POST — v2 카탈로그 write-through", () => {
  it("정상 — 앱 발급 id 를 external_ref 로 upsert 후 201", async () => {
    const res = await POST(postReq(), ctx);
    expect(res.status).toBe(201);
    const [v2EventId, tiers, opts] = h.upsertTierCatalog.mock.calls[0];
    expect(v2EventId).toBe("event-1");
    expect(tiers[0].stock_limit).toBe(100);
    expect(tiers[0].capacity).toBe(100);
    expect(tiers[0].tier_metadata).toEqual({ go_source: "product" });
    const json = await res.json();
    expect(opts.idempotencyKey).toBe(`product-tier:${json.data.id}`);
    expect(tiers[0].external_ref).toBe(json.data.id);
  });

  it("🔴 무제한 재고 → stock_limit=null + capacity sentinel", async () => {
    await POST(postReq({ unlimitedStock: true, stock: "" }), ctx);
    const [, tiers] = h.upsertTierCatalog.mock.calls[0];
    expect(tiers[0].stock_limit).toBeNull();
    expect(tiers[0].capacity).toBe(1_000_000);
  });

  it("🔴 재고 0 은 0 으로 집행 — 무제한(1,000,000)으로 승격되지 않는다(초과판매 차단)", async () => {
    await POST(postReq({ unlimitedStock: false, stock: "0" }), ctx);
    const [, tiers] = h.upsertTierCatalog.mock.calls[0];
    expect(tiers[0].stock_limit).toBe(0);
    expect(tiers[0].capacity).toBe(0);
  });

  it("미소유/미존재 → 404, write 미수행", async () => {
    h.getEvent.mockRejectedValue(new h.V2CommerceError("not found", 404));
    expect((await POST(postReq(), ctx)).status).toBe(404);
    expect(h.upsertTierCatalog).not.toHaveBeenCalled();
  });

  it("🔴 v2 장애 → 503, write 미수행 (404·400 으로 뭉개지 않는다)", async () => {
    h.getEvent.mockRejectedValue(new h.V2CommerceError("boom", 503));
    expect((await POST(postReq(), ctx)).status).toBe(503);
    expect(h.upsertTierCatalog).not.toHaveBeenCalled();
  });

  it("게이트 — RSVP 이벤트에 유료 티켓 추가는 409", async () => {
    h.getEvent.mockResolvedValue({ event_id: "event-1", rsvp_enabled: true });
    const res = await POST(postReq({ isFree: false, price: "10000" }), ctx);
    expect(res.status).toBe(409);
    expect(h.upsertTierCatalog).not.toHaveBeenCalled();
  });

  it("🔴 게이트 보수적 폴백 — RSVP 여부를 못 읽으면 통과가 아니라 503", async () => {
    h.getEvent.mockRejectedValue(new h.V2CommerceError("boom", 500));
    const res = await POST(postReq({ isFree: false, price: "10000" }), ctx);
    expect(res.status).toBe(503);
    expect(h.upsertTierCatalog).not.toHaveBeenCalled();
  });

  it("번들 구성품이 같은 이벤트 상품이 아니면 400", async () => {
    const res = await POST(
      postReq({
        type: "bundle",
        bundleItems: [{ productId: "22222222-2222-4222-8222-222222222222", quantity: 1 }],
      }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(h.upsertTierCatalog).not.toHaveBeenCalled();
  });
});
