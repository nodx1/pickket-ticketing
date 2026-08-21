import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

// 레벨2 컷오버 wave2(W2-PS): 대기열 정본은 v2, **상품 소유권·제안 컨텍스트도 v2 카탈로그**에서 온다.
// go pool 은 더 이상 쓰지 않는다 — 상품 조회 실패는 "소유권 없음(404)"이 아니라 503 이어야 한다.
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
    createWaitlistEntry: vi.fn(),
    listWaitlistEntries: vi.fn(),
    transitionWaitlistEntry: vi.fn(),
    deleteWaitlistEntry: vi.fn(),
    sendWaitlistOffer: vi.fn(),
  };
});

vi.mock("@/lib/auth/permissions", () => ({
  withRole: (_role: string, handler: (request: Request, ctx: unknown) => Promise<Response>) =>
    (request: Request) =>
      handler(request, {
        session: { accountId: "account-1", role: "organizer" },
        params: { eventId: "event-1", entryId: "entry-1" },
      }),
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/waitlist/offer", () => ({ sendWaitlistOffer: h.sendWaitlistOffer }));
vi.mock("@/lib/v2/commerce-client", () => ({
  V2CommerceError: h.V2CommerceError,
  getEvent: (...a: unknown[]) => h.getEvent(...a),
  getEventBySlug: (...a: unknown[]) => h.getEventBySlug(...a),
  listTierCatalog: (...a: unknown[]) => h.listTierCatalog(...a),
  upsertTierCatalog: (...a: unknown[]) => h.upsertTierCatalog(...a),
  deleteTier: (...a: unknown[]) => h.deleteTier(...a),
}));
vi.mock("@/lib/v2/waitlist-client", () => ({
  createWaitlistEntry: h.createWaitlistEntry,
  listWaitlistEntries: h.listWaitlistEntries,
  transitionWaitlistEntry: h.transitionWaitlistEntry,
  deleteWaitlistEntry: h.deleteWaitlistEntry,
}));

import { POST } from "@/app/api/events/[eventId]/waitlist/route";
import { PATCH, DELETE } from "@/app/api/events/[eventId]/waitlist/[entryId]/route";

const postContext = { params: Promise.resolve({ eventId: "event-1" }) };
const patchContext = { params: Promise.resolve({ eventId: "event-1", entryId: "entry-1" }) };

const PRODUCT_ID = "11111111-1111-4111-8111-111111111111";

function postRequest(body: unknown): Request {
  return new Request("http://localhost/api/events/event-1/waitlist", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function patchRequest(body: unknown): NextRequest {
  return new Request("http://localhost/api/events/event-1/waitlist/entry-1", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  }) as unknown as NextRequest;
}

/** v2 카탈로그 한 행(대기열은 이름·가격만 쓴다). */
function tierRow(ref: string) {
  return {
    tier_id: `v2-${ref}`, external_ref: ref, name: "일반석", capacity: 100, base_price: 10000,
    sale_mode: "fixed_fcfs", sale_window: { opens_at: null, closes_at: null },
    sold_count: 0, fill_rate: 0, stock_limit: 100, description: null, product_type: "ticket",
    visibility: "public", tax_rate: 10, tax_included: true, image_url: null, sort_order: 0,
    min_per_order: 1, max_per_order: null, is_active: true, bundle_items: null,
    color_hex: null, seat_map_id: null, tier_metadata: { go_source: "product" },
  };
}

beforeEach(() => {
  h.getEvent.mockReset().mockResolvedValue({
    event_id: "event-1", go_account_id: "account-1", title: "행사", slug: "ev",
  });
  h.listTierCatalog.mockReset().mockResolvedValue({ tiers: [tierRow(PRODUCT_ID)], total: 1 });
  h.createWaitlistEntry.mockReset();
  h.listWaitlistEntries.mockReset();
  h.transitionWaitlistEntry.mockReset();
  h.deleteWaitlistEntry.mockReset();
  h.sendWaitlistOffer.mockReset();
  h.sendWaitlistOffer.mockResolvedValue({ emailSent: true, simulated: true });
});

describe("waitlist POST product ownership (v2 catalog guard, v2 write)", () => {
  it("rejects a product not owned by the event and does not write to v2", async () => {
    h.listTierCatalog.mockResolvedValue({ tiers: [], total: 0 }); // 이 이벤트 상품 아님

    const response = await POST(
      postRequest({ name: "홍길동", email: "hong@example.com", productId: PRODUCT_ID }),
      postContext,
    );

    expect(response.status).toBe(404);
    expect(h.createWaitlistEntry).not.toHaveBeenCalled();
  });

  it("validates ownership then delegates entry storage to v2", async () => {
    h.createWaitlistEntry.mockResolvedValue({ id: "entry-1" });

    const response = await POST(
      postRequest({ name: "홍길동", email: "hong@example.com", productId: PRODUCT_ID }),
      postContext,
    );

    expect(response.status).toBe(201);
    expect(h.createWaitlistEntry).toHaveBeenCalledWith(
      expect.objectContaining({ account_id: "account-1", event_id: "event-1", product_id: PRODUCT_ID }),
    );
  });

  it("maps v2 409 (duplicate) to 409 with Korean message", async () => {
    h.createWaitlistEntry.mockRejectedValue(new h.V2CommerceError("dup", 409));

    const response = await POST(
      postRequest({ name: "홍길동", email: "hong@example.com", productId: PRODUCT_ID }),
      postContext,
    );

    expect(response.status).toBe(409);
  });

  it("🔴 상품 카탈로그 조회 실패는 '소유권 없음(404)' 이 아니라 503 — 통과시키지 않는다", async () => {
    h.listTierCatalog.mockRejectedValue(new h.V2CommerceError("boom", 500));

    const response = await POST(
      postRequest({ name: "홍길동", email: "hong@example.com", productId: PRODUCT_ID }),
      postContext,
    );

    expect(response.status).toBe(503);
    expect(h.createWaitlistEntry).not.toHaveBeenCalled();
  });

  it("이벤트에 go_account_id 가 없으면 테넌트 미상 — 저장하지 않는다(404)", async () => {
    h.getEvent.mockResolvedValue({ event_id: "event-1", go_account_id: null });

    const response = await POST(
      postRequest({ name: "홍길동", email: "hong@example.com", productId: PRODUCT_ID }),
      postContext,
    );

    expect(response.status).toBe(404);
    expect(h.createWaitlistEntry).not.toHaveBeenCalled();
  });
});

describe("waitlist PATCH transition (v2 CAS proxy)", () => {
  it("returns 409 when v2 CAS reports status already changed", async () => {
    h.transitionWaitlistEntry.mockRejectedValue(new h.V2CommerceError("conflict", 409));

    const response = await PATCH(patchRequest({ status: "cancelled" }), patchContext);

    expect(response.status).toBe(409);
    expect(h.sendWaitlistOffer).not.toHaveBeenCalled();
  });

  it("returns 404 when v2 reports entry not found", async () => {
    h.transitionWaitlistEntry.mockRejectedValue(new h.V2CommerceError("not found", 404));

    const response = await PATCH(patchRequest({ status: "cancelled" }), patchContext);

    expect(response.status).toBe(404);
  });

  it("on offered transition, sends offer using go-local context after v2 commit", async () => {
    h.transitionWaitlistEntry.mockResolvedValue({
      id: "entry-1",
      event_id: "event-1",
      product_id: PRODUCT_ID,
      name: "홍길동",
      email: "hong@example.com",
      offer_token_version: 3,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    const response = await PATCH(patchRequest({ status: "offered" }), patchContext);

    expect(response.status).toBe(200);
    expect(h.transitionWaitlistEntry).toHaveBeenCalledWith("entry-1", {
      account_id: "account-1",
      event_id: "event-1",
      status: "offered",
    });
    expect(h.sendWaitlistOffer).toHaveBeenCalledWith(
      expect.objectContaining({ tokenVersion: 3, productName: "일반석", unitPrice: 10000 }),
    );
    const json = await response.json();
    expect(json.data.offerSent).toBe(true);
  });

  it("keeps offered state when offer send throws (best-effort)", async () => {
    h.transitionWaitlistEntry.mockResolvedValue({
      id: "entry-1",
      event_id: "event-1",
      product_id: PRODUCT_ID,
      name: "홍길동",
      email: "hong@example.com",
      offer_token_version: 1,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    h.sendWaitlistOffer.mockRejectedValue(new Error("mailer down"));

    const response = await PATCH(patchRequest({ status: "offered" }), patchContext);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data.offerSent).toBe(false);
  });

  it("passes event_id to v2 transition contract (event boundary P1)", async () => {
    h.transitionWaitlistEntry.mockResolvedValue({ id: "entry-1", event_id: "event-1", status: "cancelled" });

    await PATCH(patchRequest({ status: "cancelled" }), patchContext);

    expect(h.transitionWaitlistEntry).toHaveBeenCalledWith("entry-1", {
      account_id: "account-1",
      event_id: "event-1",
      status: "cancelled",
    });
  });

  it("returns 404 when v2 returns an entry from a different event (cross-event guard)", async () => {
    // 심층방어: v2 WHERE 가 이미 차단하나, 계약 회귀로 다른 이벤트 entry 가 반환되면 404 로 끊는다.
    h.transitionWaitlistEntry.mockResolvedValue({ id: "entry-1", event_id: "event-OTHER", status: "cancelled" });

    const response = await PATCH(patchRequest({ status: "cancelled" }), patchContext);

    expect(response.status).toBe(404);
    expect(h.sendWaitlistOffer).not.toHaveBeenCalled();
  });
});

describe("waitlist PATCH — 제안 컨텍스트 실패 취급", () => {
  it("🔴 컨텍스트 조회 실패해도 상태 전이는 되돌리지 않고 offerSent:false 로 알린다", async () => {
    h.transitionWaitlistEntry.mockResolvedValue({
      id: "entry-1",
      event_id: "event-1",
      product_id: PRODUCT_ID,
      name: "홍길동",
      email: "hong@example.com",
      offer_token_version: 1,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    h.listTierCatalog.mockRejectedValue(new h.V2CommerceError("boom", 500));

    const response = await PATCH(patchRequest({ status: "offered" }), patchContext);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data.offerSent).toBe(false);
    expect(h.sendWaitlistOffer).not.toHaveBeenCalled();
  });
});

describe("waitlist DELETE (v2 event+account boundary)", () => {
  const deleteContext = { params: Promise.resolve({ eventId: "event-1", entryId: "entry-1" }) };
  const deleteRequest = () =>
    new Request("http://localhost/api/events/event-1/waitlist/entry-1", { method: "DELETE" }) as unknown as NextRequest;

  it("passes both account_id and event_id to v2 delete contract", async () => {
    h.deleteWaitlistEntry.mockResolvedValue({ deleted: true });

    const response = await DELETE(deleteRequest(), deleteContext);

    expect(response.status).toBe(200);
    expect(h.deleteWaitlistEntry).toHaveBeenCalledWith("entry-1", "account-1", "event-1");
  });

  it("maps v2 404 (out of boundary) to 404", async () => {
    h.deleteWaitlistEntry.mockRejectedValue(new h.V2CommerceError("not found", 404));

    const response = await DELETE(deleteRequest(), deleteContext);

    expect(response.status).toBe(404);
  });
});
