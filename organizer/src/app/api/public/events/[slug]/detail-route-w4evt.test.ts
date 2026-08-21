/**
 * `GET /api/public/events/[slug]` — 레벨2 컷오버 W4-EVT 회귀.
 *
 * 이벤트 본문 정본이 go `events` → v2 by-slug 로 넘어가면서 `getPublicEventBySlug` 는
 * v2 장애 시 **null 이 아니라 EventAccessError** 를 던진다. 이 JSON 라우트가 그것을
 * 🔴 404("공개된 이벤트를 찾을 수 없습니다")로 뭉개면 판매중인 행사가 사라진 것처럼 보인다.
 * 미존재 404 / v2 장애 503 을 구분해서 내려주는지 고정한다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const h = vi.hoisted(() => {
  class V2CommerceError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return {
    getEventBySlug: vi.fn(),
    getEvent: vi.fn(),
    getTiersByEvent: vi.fn(),
    listEventHostLinks: vi.fn(),
    listPublicNotices: vi.fn(),
  listTierCatalog: vi.fn(),
    // W5-ATTENDEE: 예매 설문 문항 = v2 정본.
    listEventQuestions: vi.fn(),
    poolQuery: vi.fn<(...args: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }>>(),
    V2CommerceError,
  };
});

vi.mock("@/lib/db/pool", () => ({ getPool: () => ({ query: h.poolQuery }) }));
vi.mock("@/lib/v2/commerce-client", () => ({
  getEventBySlug: h.getEventBySlug,
  getEvent: h.getEvent,
  getTiersByEvent: h.getTiersByEvent,
  listEventHostLinks: h.listEventHostLinks,
  // 레벨2 컷오버 W5-CONTENT — 공개 공지는 v2 public-content read(go open_notices 폐기).
  listPublicNotices: h.listPublicNotices,
  listEventQuestions: h.listEventQuestions,
  // W2-PS — 공개 상품 목록 정본(go products 폐기).
  listTierCatalog: h.listTierCatalog,
  listSeats: vi.fn(),
  V2CommerceError: h.V2CommerceError,
}));

import { GET } from "@/app/api/public/events/[slug]/route";

function call(format?: string) {
  const qs = format ? `?format=${format}` : "";
  return GET(new Request(`https://go.pickket.kr/api/public/events/klpga${qs}`) as NextRequest, {
    params: Promise.resolve({ slug: "klpga" }),
  });
}

function v2Event(over: Record<string, unknown> = {}) {
  return {
    event_id: "evt-1",
    title: "KLPGA 대회",
    slug: "klpga",
    status: "live",
    event_date: "2026-09-01T10:00:00.000Z",
    venue: "메인홀",
    image_url: null,
    go_account_id: "acc-1",
    content: { seat_map_data: null },
    ...over,
  };
}

// 기본 go 쿼리 응답 — 각 테스트가 mockResolvedValueOnce 로 덮어쓴다.
beforeEach(() => {
  h.poolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  h.listPublicNotices.mockResolvedValue({ notices: [] });
  // W5-ATTENDEE: 예매 설문 문항은 v2 정본(go SELECT 폐기).
  h.listEventQuestions.mockResolvedValue({ questions: [] });
  h.listTierCatalog.mockResolvedValue({ tiers: [], total: 0 });
});

afterEach(() => {
  h.getEventBySlug.mockReset();
  h.getEvent.mockReset();
  h.getTiersByEvent.mockReset();
  h.listEventHostLinks.mockReset();
  h.listPublicNotices.mockReset();
  h.listEventQuestions.mockReset();
  h.listTierCatalog.mockReset();
  h.listEventQuestions.mockResolvedValue({ questions: [] });
  h.listTierCatalog.mockResolvedValue({ tiers: [], total: 0 });
  h.poolQuery.mockReset();
  h.poolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe("GET /api/public/events/[slug] — W4-EVT", () => {
  it("정상: v2 본문 + go 상품/문의/공지를 합쳐 내려준다(go events SQL 0)", async () => {
    h.getEventBySlug.mockResolvedValue(v2Event());
    h.listEventHostLinks.mockResolvedValue({ hosts: [] });
    h.poolQuery
      .mockResolvedValueOnce({ rows: [{ id: "p1", name: "일반", price: 30000, isOnSale: true }] })
      .mockResolvedValueOnce({ rows: [] }); // 문의(inquiries)
      // 공지 = v2 public-content(W5-CONTENT), 설문문항 = v2 정본(W5-ATTENDEE) → go 쿼리 아님.

    const res = await call();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    // 2026-07-28: attendeeCount 제거 — go attendees 를 상태필터 없이 세던 자리(취소·환불 포함).
    expect(body.data).toMatchObject({ id: "evt-1", title: "KLPGA 대회" });
    expect(body.data).not.toHaveProperty("attendeeCount");

    const sqls = h.poolQuery.mock.calls.map((c) => String(c[0]));
    for (const sql of sqls) {
      expect(/\b(FROM|JOIN)\s+events\b/i.test(sql)).toBe(false);
    }
  });

  it("미존재 slug 는 404", async () => {
    h.getEventBySlug.mockRejectedValue(new h.V2CommerceError("not found", 404));
    expect((await call()).status).toBe(404);
  });

  it("비 live 상태는 404 (공개 노출 게이트 유지)", async () => {
    h.getEventBySlug.mockResolvedValue(v2Event({ status: "draft" }));
    expect((await call()).status).toBe(404);
  });

  // 🔴 핵심: v2 장애 → 404 위장 금지.
  it("v2 장애는 503 — '공개된 이벤트를 찾을 수 없습니다'(404)로 위장하지 않는다", async () => {
    h.getEventBySlug.mockRejectedValue(new h.V2CommerceError("boom", 500));
    const res = await call();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: string };
    expect(body.error).not.toContain("찾을 수 없습니다");
  });
});

// ── 적대 감사 F-6 — `capacity` 가 조용히 "잔여"가 되어 있었다 ────────────────
//
// 종전 `capacity: p.capacity ?? p.stock ?? null` 은 상품 타입에 `capacity` 가 **없어서** 항상
// `stock` 폴백을 탔고, 오늘 stock 의미가 원본→잔여로 바뀌면서 외부 소비자가 "총좌석"으로 읽는
// 값이 팔릴수록 줄어들게 됐다. 이름과 값을 일치시킨 결과를 고정한다.
describe("GET /api/public/events/[slug]?format=v2 — 재고 필드 의미(F-6)", () => {
  function tier(over: Record<string, unknown> = {}) {
    return {
      tier_id: "t-1",
      external_ref: "p-1",
      name: "1일권",
      capacity: 1000,
      sold_count: 400,
      base_price: 30000,
      sale_window: { opens_at: null, closes_at: null },
      is_active: true,
      visibility: "public",
      sort_order: 0,
      ...over,
    };
  }

  type SeatTier = {
    id: string;
    capacity: number | null;
    remaining_stock: number | null;
    sold_count: number;
  };
  /** 가격 필드까지 보는 변형 — `SeatTier` 타입에 없는 필드를 읽어야 해서 따로 둔다. */
  async function seatTiersFull(
    over: Record<string, unknown> = {},
  ): Promise<Array<{ base_price: number; face_price: number | null }>> {
    h.getEventBySlug.mockResolvedValue(v2Event());
    h.listEventHostLinks.mockResolvedValue({ hosts: [] });
    h.listTierCatalog.mockResolvedValue({ tiers: [tier(over)], total: 1 });
    const res = await call("v2");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { seat_tiers: Array<{ base_price: number; face_price: number | null }> };
    };
    return body.data.seat_tiers;
  }

  async function seatTiers(over: Record<string, unknown> = {}): Promise<SeatTier[]> {
    h.getEventBySlug.mockResolvedValue(v2Event());
    h.listEventHostLinks.mockResolvedValue({ hosts: [] });
    h.listTierCatalog.mockResolvedValue({ tiers: [tier(over)], total: 1 });
    const res = await call("v2");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { seat_tiers: SeatTier[] } };
    return body.data.seat_tiers;
  }

  // 🔴 F-6 본체: capacity = **총좌석**. 400장 팔려도 1000 이다.
  it("capacity 는 총좌석 — 판매수를 빼지 않는다", async () => {
    expect((await seatTiers())[0]?.capacity).toBe(1000);
  });

  // 잔여는 별도 이름으로 가산했다(기존 필드 유지 = 가산적 변경).
  it("remaining_stock 은 잔여(= capacity − sold_count)", async () => {
    const t = (await seatTiers())[0];
    expect(t?.remaining_stock).toBe(600);
    expect(t?.sold_count).toBe(400);
    // 🔴 두 값이 같아지면 (= capacity 가 다시 잔여가 되면) 이 단언이 죽는다.
    expect(t?.capacity).not.toBe(t?.remaining_stock);
  });

  it("완판이어도 capacity 는 총좌석, remaining_stock 만 0", async () => {
    const t = (await seatTiers({ capacity: 1000, sold_count: 1000 }))[0];
    expect(t?.capacity).toBe(1000);
    expect(t?.remaining_stock).toBe(0);
  });

  /**
   * 🔴 `face_price` 계약 — 2026-08-04 실값 전환.
   *
   * 종전엔 `face_price: p.price` **상수**라 할인 중에도 정가가 판매가로 보였다.
   * 이제 v2 원장의 정가를 그대로 내린다.
   *
   * ⚠️ **화면 테스트로는 이 자리를 못 잡는다.** 화면은 `facePrice == price` 면 아무것도
   *    안 그리므로(3-3 규칙), 폴백이 사라져 null 이 돼도 화면은 그대로다.
   *    그래서 **API 계약 테스트**가 따로 있어야 한다.
   */
  it("🔴 face_price 는 v2 정가를 그대로 내린다 — 판매가 상수가 아니다", async () => {
    const [t] = (await seatTiersFull({ base_price: 13500, face_price: 15000 }));
    expect(t?.base_price, "판매가가 바뀌면 안 된다").toBe(13500);
    expect(t?.face_price, "정가 자리에 판매가가 들어가 있다").toBe(15000);
  });

  it("🔴 정가가 없으면 판매가로 폴백한다 — null 을 내보내지 않는다", async () => {
    const [t] = (await seatTiersFull({ base_price: 13500 }));
    expect(t?.face_price, "face_price 가 null 이 됐다 — 계약 파괴다").toBe(13500);
    expect(t?.face_price).not.toBeNull();
  });

  it("정가와 판매가가 같으면 그대로 같은 값", async () => {
    const [t] = (await seatTiersFull({ base_price: 15000, face_price: 15000 }));
    expect(t?.face_price).toBe(15000);
  });

  it("무제한 등급은 capacity·remaining_stock 둘 다 null (sentinel 노출 금지)", async () => {
    const t = (await seatTiers({ capacity: 1_000_000, sold_count: 3 }))[0];
    expect(t?.capacity).toBeNull();
    expect(t?.remaining_stock).toBeNull();
  });

  it("products 의 stock 은 잔여, capacity 는 총좌석으로 함께 내려간다", async () => {
    h.getEventBySlug.mockResolvedValue(v2Event());
    h.listEventHostLinks.mockResolvedValue({ hosts: [] });
    h.listTierCatalog.mockResolvedValue({ tiers: [tier()], total: 1 });
    const res = await call();
    const body = (await res.json()) as {
      data: { products: Array<{ stock: number | null; capacity: number | null; soldCount: number }> };
    };
    expect(body.data.products[0]).toMatchObject({ stock: 600, capacity: 1000, soldCount: 400 });
  });
});
