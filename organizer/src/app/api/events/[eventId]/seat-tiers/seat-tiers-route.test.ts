import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

/**
 * W2-PS 회귀 — 좌석 등급 CRUD 가 go `seat_tiers` 없이 v2 카탈로그로 동작한다.
 *
 * 🔴 이 파일이 지키는 것:
 *   - 목록/단건 조회 실패를 **빈 목록·go 미러값·soldCount 0** 으로 흡수하지 않는다(503).
 *   - **capacity 0 이 정상 입력**이다(좌석 배치도가 정원을 나중에 채운다). 종전 v2 계약(`gt=0`)이
 *     이 생성을 422→502 로 막고 있었고, PATCH 는 `capacity>0?capacity:1` 로 정원을 부풀렸다.
 *   - DELETE 는 조회 실패를 "이미 없음 → 200" 으로 흡수하지 않는다.
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
        params: { eventId: "event-1", tierId: "tier-1" },
      }),
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/v2/commerce-client", () => ({
  V2CommerceError: h.V2CommerceError,
  getEvent: (...a: unknown[]) => h.getEvent(...a),
  getEventBySlug: (...a: unknown[]) => h.getEventBySlug(...a),
  listTierCatalog: (...a: unknown[]) => h.listTierCatalog(...a),
  upsertTierCatalog: (...a: unknown[]) => h.upsertTierCatalog(...a),
  deleteTier: (...a: unknown[]) => h.deleteTier(...a),
}));

import { GET, POST } from "@/app/api/events/[eventId]/seat-tiers/route";
import {
  DELETE as TIER_DELETE,
  PATCH as TIER_PATCH,
} from "@/app/api/events/[eventId]/seat-tiers/[tierId]/route";

const listCtx = { params: Promise.resolve({ eventId: "event-1" }) };
const oneCtx = { params: Promise.resolve({ eventId: "event-1", tierId: "tier-1" }) };

function seatTierRow(over: Record<string, unknown> = {}) {
  return {
    tier_id: "v2-tier-1",
    external_ref: "tier-1",
    name: "VIP",
    capacity: 0,
    base_price: 50000,
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
    color_hex: "#6c5ce7",
    seat_map_id: null,
    tier_metadata: { go_source: "seat_tier" },
    face_price: 50000,
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

function listReq() {
  return new Request("http://localhost/x") as unknown as NextRequest;
}
function postReq(body: Record<string, unknown> = {}) {
  return new Request("http://localhost/x", {
    method: "POST",
    body: JSON.stringify({ name: "VIP", capacity: 0, basePrice: 50000, colorHex: "#6c5ce7", ...body }),
  }) as unknown as NextRequest;
}
function patchReq(body: Record<string, unknown>) {
  return new Request("http://localhost/x", {
    method: "PATCH",
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}
function deleteReq() {
  return new Request("http://localhost/x", { method: "DELETE" }) as unknown as NextRequest;
}

beforeEach(() => {
  h.getEvent.mockReset().mockResolvedValue({ event_id: "event-1" });
  h.listTierCatalog.mockReset().mockResolvedValue({ tiers: [seatTierRow()], total: 1 });
  h.upsertTierCatalog.mockReset().mockResolvedValue({ tiers: [{ tier_id: "v2-tier-1" }] });
  h.deleteTier.mockReset().mockResolvedValue({ deleted: true });
});

describe("seat-tiers GET", () => {
  it("정상 — 좌석등급 행만 투영(색상·정원·판매수 포함)", async () => {
    const json = await (await GET(listReq(), listCtx)).json();
    expect(json.data).toHaveLength(1);
    expect(json.data[0]).toMatchObject({ id: "tier-1", colorHex: "#6c5ce7", capacity: 0, soldCount: 0 });
    expect(h.getEvent).toHaveBeenCalledWith("event-1", { organizerRef: "account-1" });
  });

  it("상품(go_source=product) 행은 좌석등급 목록에 섞이지 않는다", async () => {
    h.listTierCatalog.mockResolvedValue({
      tiers: [seatTierRow(), seatTierRow({ external_ref: "prod-1", color_hex: null, tier_metadata: { go_source: "product" } })],
      total: 2,
    });
    const json = await (await GET(listReq(), listCtx)).json();
    expect(json.data.map((t: { id: string }) => t.id)).toEqual(["tier-1"]);
  });

  it("미소유/미존재 → 404", async () => {
    h.getEvent.mockRejectedValue(new h.V2CommerceError("nf", 404));
    expect((await GET(listReq(), listCtx)).status).toBe(404);
  });

  it("🔴 v2 장애 → 503 (빈 목록·soldCount 0 폴백 금지)", async () => {
    h.listTierCatalog.mockRejectedValue(new h.V2CommerceError("boom", 500));
    expect((await GET(listReq(), listCtx)).status).toBe(503);
  });
});

describe("seat-tiers POST", () => {
  it("🔴 capacity=0 생성이 허용된다(정원은 좌석 배치도가 채운다)", async () => {
    const res = await POST(postReq(), listCtx);
    expect(res.status).toBe(201);
    const [v2EventId, tiers, opts] = h.upsertTierCatalog.mock.calls[0];
    expect(v2EventId).toBe("event-1");
    expect(tiers[0].capacity).toBe(0);
    expect(tiers[0].color_hex).toBe("#6c5ce7");
    expect(tiers[0].tier_metadata).toMatchObject({ go_source: "seat_tier" });
    expect(opts.idempotencyKey).toMatch(/^tier-create:/);
  });

  it("좌석등급은 상품 재고(stock_limit)를 보내지 않는다 — capacity 만 집행", async () => {
    await POST(postReq(), listCtx);
    const [, tiers] = h.upsertTierCatalog.mock.calls[0];
    expect(tiers[0]).not.toHaveProperty("stock_limit");
  });

  it("미소유/미존재 → 404, write 미수행", async () => {
    h.getEvent.mockRejectedValue(new h.V2CommerceError("nf", 404));
    expect((await POST(postReq(), listCtx)).status).toBe(404);
    expect(h.upsertTierCatalog).not.toHaveBeenCalled();
  });

  it("🔴 v2 장애 → 503, write 미수행", async () => {
    h.getEvent.mockRejectedValue(new h.V2CommerceError("boom", 503));
    expect((await POST(postReq(), listCtx)).status).toBe(503);
    expect(h.upsertTierCatalog).not.toHaveBeenCalled();
  });
});

describe("seat-tiers PATCH", () => {
  it("🔴 정원 0 을 1 로 부풀리지 않는다(옛 워크어라운드 제거)", async () => {
    await TIER_PATCH(patchReq({ basePrice: 70000 }), oneCtx);
    const [, tiers] = h.upsertTierCatalog.mock.calls[0];
    expect(tiers[0].capacity).toBe(0);
    expect(tiers[0].base_price).toBe(70000);
  });

  it("미지정 필드는 기존 값을 유지한다", async () => {
    await TIER_PATCH(patchReq({ name: "VIP2" }), oneCtx);
    const [, tiers] = h.upsertTierCatalog.mock.calls[0];
    expect(tiers[0].name).toBe("VIP2");
    expect(tiers[0].base_price).toBe(50000);
    expect(tiers[0].color_hex).toBe("#6c5ce7");
  });

  it("존재하지 않는 등급 → 404", async () => {
    h.listTierCatalog.mockResolvedValue({ tiers: [], total: 0 });
    expect((await TIER_PATCH(patchReq({ name: "x" }), oneCtx)).status).toBe(404);
  });

  it("🔴 v2 장애 → 503 (400 입력오류로 위장 금지)", async () => {
    h.listTierCatalog.mockRejectedValue(new h.V2CommerceError("boom", 500));
    expect((await TIER_PATCH(patchReq({ name: "x" }), oneCtx)).status).toBe(503);
  });

  it("내부 IP viewImageUrl 은 400(SSRF 가드 보존)", async () => {
    const res = await TIER_PATCH(patchReq({ viewImageUrl: "https://127.0.0.1/a.png" }), oneCtx);
    expect(res.status).toBe(400);
  });
});

describe("seat-tiers DELETE", () => {
  it("정상 — v2 단건 삭제", async () => {
    expect((await TIER_DELETE(deleteReq(), oneCtx)).status).toBe(200);
    expect(h.deleteTier).toHaveBeenCalledWith("event-1", "tier-1", expect.any(Object));
  });

  it("판매분 있으면 409 · 삭제 미호출", async () => {
    h.listTierCatalog.mockResolvedValue({ tiers: [seatTierRow({ sold_count: 2 })], total: 1 });
    expect((await TIER_DELETE(deleteReq(), oneCtx)).status).toBe(409);
    expect(h.deleteTier).not.toHaveBeenCalled();
  });

  it("🔴 조회 실패를 '이미 없음 → 200' 으로 흡수하지 않는다(503)", async () => {
    h.listTierCatalog.mockRejectedValue(new h.V2CommerceError("boom", 500));
    expect((await TIER_DELETE(deleteReq(), oneCtx)).status).toBe(503);
    expect(h.deleteTier).not.toHaveBeenCalled();
  });

  it("v2 가 좌석 배정 등을 이유로 409 를 주면 409 전달", async () => {
    h.deleteTier.mockRejectedValue(new h.V2CommerceError("has seats", 409));
    expect((await TIER_DELETE(deleteReq(), oneCtx)).status).toBe(409);
  });
});
