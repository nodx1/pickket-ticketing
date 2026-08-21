/**
 * `/api/public/events/[slug]/widget-config` — 레벨2 컷오버 W4-EVT 회귀.
 *
 * 옛 `SELECT ... FROM events WHERE slug=$1 AND status='live'` 를 v2 by-slug read 로 바꾼 뒤:
 *   ① 상태 게이트(live)를 잃지 않았는가 — draft 이벤트가 외부 사이트 위젯에 노출되면 안 된다
 *   ② v2 장애를 404 로 위장하지 않는가 — 위젯이 "행사 없음"을 렌더하면 주최자는 이벤트가
 *      내려간 줄 안다(재시도 가능 신호 503 이어야 한다)
 *   ③ allowed_domains 서버 강제(기존 보안 동작)가 그대로인가
 *
 * ── 적대 감사 F-5 (2026-07-28) ──
 * 이 라우트만 go `products` 를 직접 SELECT 하고 있었다. W2-PS 이후 go 에는 상품 행이 생기지
 * 않아(prod 실측 0행) 위젯이 **상품 0개**로 렌더됐다. v2 카탈로그 정본 전환 + 조회 실패를
 * 빈 목록으로 흘리지 않는다는 것을 아래에서 고정한다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    // 레벨2 컷오버 W5-CONTENT — 위젯 설정은 go widget_configs 가 아니라 v2 public-content read.
    getPublicWidgetConfig: vi.fn(),
    // F-5 — 상품 목록도 v2 tier 카탈로그 정본(go products SELECT 폐기).
    listTierCatalog: vi.fn(),
    poolQuery: vi.fn<(...args: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }>>(),
    V2CommerceError,
  };
});

vi.mock("@/lib/db/pool", () => ({ getPool: () => ({ query: h.poolQuery }) }));
vi.mock("@/lib/v2/commerce-client", () => ({
  getEvent: vi.fn(),
  getEventBySlug: h.getEventBySlug,
  getPublicWidgetConfig: h.getPublicWidgetConfig,
  listTierCatalog: h.listTierCatalog,
  V2CommerceError: h.V2CommerceError,
}));

import { GET } from "@/app/api/public/events/[slug]/widget-config/route";

function v2Event(over: Record<string, unknown> = {}) {
  return {
    event_id: "evt-1",
    title: "KLPGA 대회",
    slug: "klpga",
    status: "live",
    event_date: "2026-09-01T10:00:00.000Z",
    event_date_end: "2026-09-02T10:00:00.000Z",
    venue: "메인홀",
    image_url: "https://cdn/x.png",
    content: {},
    ...over,
  };
}

function v2Tier(over: Record<string, unknown> = {}) {
  return {
    tier_id: "t-1",
    external_ref: "p-1",
    name: "일반",
    capacity: 1000,
    sold_count: 0,
    base_price: 30000,
    sale_window: { opens_at: null, closes_at: null },
    is_active: true,
    visibility: "public",
    sort_order: 0,
    ...over,
  };
}

function call(headers: Record<string, string> = {}) {
  return GET(
    new Request("https://go.pickket.kr/api/public/events/klpga/widget-config", { headers }) as never,
    { params: Promise.resolve({ slug: "klpga" }) },
  );
}

// 기본 go 쿼리 응답 — 각 테스트가 mockResolvedValueOnce 로 덮어쓴다.
// 기본: 위젯 설정 미등록(configured=false) = go 기존 동작(도메인 제한 없음).
beforeEach(() => {
  h.poolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  h.getPublicWidgetConfig.mockResolvedValue({
    configured: false, mode: "button", theme: {}, allowed_domains: [], is_active: true,
  });
  h.listTierCatalog.mockResolvedValue({ tiers: [v2Tier()], total: 1 });
});

afterEach(() => {
  h.getEventBySlug.mockReset();
  h.getPublicWidgetConfig.mockReset();
  h.listTierCatalog.mockReset();
  h.poolQuery.mockReset();
  h.poolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe("widget-config — W4-EVT(공개 이벤트 본문 v2 이관)", () => {
  it("live 이벤트: v2 필드를 go 위젯 계약(startsAt/endsAt/venueName/heroImageUrl)으로 매핑한다", async () => {
    h.getEventBySlug.mockResolvedValue(v2Event());
    const res = await call();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { event: Record<string, unknown> } };
    expect(body.data.event).toEqual({
      title: "KLPGA 대회",
      startsAt: "2026-09-01T10:00:00.000Z",
      endsAt: "2026-09-02T10:00:00.000Z",
      venueName: "메인홀",
      heroImageUrl: "https://cdn/x.png",
    });

    // 🔴 F-5 — go DB 조회가 **0** 이다(products 까지 v2 로 넘어가면서 마지막 go 쿼리가 사라졌다).
    expect(h.poolQuery).not.toHaveBeenCalled();
    // 이벤트 스코프는 v2 canonical id(항등)로 넘어간다.
    expect(h.listTierCatalog).toHaveBeenCalledWith("evt-1");
  });

  it("단일일 이벤트(event_date_end 없음)는 시작=종료로 폴백한다", async () => {
    h.getEventBySlug.mockResolvedValue(v2Event({ event_date_end: null }));
    const body = (await (await call()).json()) as { data: { event: { endsAt: string } } };
    expect(body.data.event.endsAt).toBe("2026-09-01T10:00:00.000Z");
  });

  it("상태 게이트 유지 — draft/paused 는 404(외부 위젯 노출 금지)", async () => {
    for (const status of ["draft", "paused", "archived"]) {
      h.getEventBySlug.mockResolvedValue(v2Event({ status }));
      const res = await call();
      expect(res.status).toBe(404);
      expect(h.poolQuery).not.toHaveBeenCalled();
    }
  });

  it("미존재 slug 는 404", async () => {
    h.getEventBySlug.mockRejectedValue(new h.V2CommerceError("not found", 404));
    expect((await call()).status).toBe(404);
  });

  // 🔴 위젯이 v2 장애를 "행사 없음"으로 렌더하면 안 된다.
  it("v2 장애는 503 이며 CORS 헤더를 유지한다", async () => {
    h.getEventBySlug.mockRejectedValue(new h.V2CommerceError("boom", 502));
    const res = await call();
    expect(res.status).toBe(503);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(h.poolQuery).not.toHaveBeenCalled();
  });

  it("allowed_domains 서버 강제는 그대로 — 미허용 Origin 은 403", async () => {
    h.getEventBySlug.mockResolvedValue(v2Event());
    h.getPublicWidgetConfig.mockResolvedValue({
      configured: true, mode: "button", theme: {},
      allowed_domains: ["ok.example.com"], is_active: true,
    });
    const res = await call({ origin: "https://evil.example.org" });
    expect(res.status).toBe(403);
  });

  it("허용 Origin(서브도메인 포함)은 200", async () => {
    h.getEventBySlug.mockResolvedValue(v2Event());
    h.getPublicWidgetConfig.mockResolvedValue({
      configured: true, mode: "button", theme: {},
      allowed_domains: ["ok.example.com"], is_active: true,
    });
    expect((await call({ origin: "https://shop.ok.example.com" })).status).toBe(200);
  });

  // 🔴🔴 W5-CONTENT 핵심 회귀: 위젯 설정 조회 실패를 "설정 없음(=제한 없음)"으로 폴백하면
  //   임의 사이트가 위젯을 embed 할 수 있게 된다. 반드시 503 으로 끊어야 한다.
  it("위젯 설정 v2 장애는 503 — 화이트리스트를 '전체 허용'으로 흘리지 않는다", async () => {
    h.getEventBySlug.mockResolvedValue(v2Event());
    h.getPublicWidgetConfig.mockRejectedValue(new h.V2CommerceError("boom", 502));
    const res = await call({ origin: "https://evil.example.org" });
    expect(res.status).toBe(503);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(false);
  });

  it("위젯 설정 미등록(configured=false)은 기존 동작 유지 — 도메인 제한 없이 200", async () => {
    h.getEventBySlug.mockResolvedValue(v2Event());
    expect((await call({ origin: "https://any.example.org" })).status).toBe(200);
  });
});

// ── 적대 감사 F-5 — 상품 정본을 v2 카탈로그로 ───────────────────────────────
describe("widget-config — 상품 목록(F-5)", () => {
  type WidgetProduct = {
    id: string;
    name: string;
    price: number;
    stock: number | null;
    isOnSale: boolean;
  };
  async function products(headers: Record<string, string> = {}): Promise<WidgetProduct[]> {
    const res = await call(headers);
    const body = (await res.json()) as { data: { products: WidgetProduct[] } };
    return body.data.products;
  }

  beforeEach(() => {
    h.getEventBySlug.mockResolvedValue(v2Event());
  });

  // 🔴 결함 본체: go products 를 읽으면 컷오버 이후 항상 0행 → 상품 0개(= 화면상 매진).
  it("v2 카탈로그의 상품을 내려준다 (go products 0행이어도)", async () => {
    h.listTierCatalog.mockResolvedValue({
      tiers: [v2Tier({ external_ref: "p-1", name: "1일권", base_price: 30000 })],
      total: 1,
    });
    expect(await products()).toEqual([
      { id: "p-1", name: "1일권", price: 30000, stock: 1000, isOnSale: true },
    ]);
  });

  // 🔴 stock = **잔여**(공개 상세와 동일 규칙). 원본 재고를 내려보내면 완판이 안 보인다.
  it("stock 은 잔여(capacity − sold_count)다", async () => {
    h.listTierCatalog.mockResolvedValue({
      tiers: [v2Tier({ capacity: 1000, sold_count: 999 })],
      total: 1,
    });
    expect((await products())[0]?.stock).toBe(1);
  });

  it("완판 등급은 stock 0 (stock_limit 이 NULL 이어도)", async () => {
    h.listTierCatalog.mockResolvedValue({
      tiers: [v2Tier({ capacity: 1000, sold_count: 1000, stock_limit: null })],
      total: 1,
    });
    expect((await products())[0]?.stock).toBe(0);
  });

  it("무제한 등급의 stock 은 null — '재고 100만장'을 내보내지 않는다", async () => {
    h.listTierCatalog.mockResolvedValue({
      tiers: [v2Tier({ capacity: 1_000_000, sold_count: 12 })],
      total: 1,
    });
    expect((await products())[0]?.stock).toBeNull();
  });

  it("비활성·비공개 등급은 제외한다", async () => {
    h.listTierCatalog.mockResolvedValue({
      tiers: [
        v2Tier({ external_ref: "keep" }),
        v2Tier({ external_ref: "off", is_active: false }),
        v2Tier({ external_ref: "priv", visibility: "private" }),
        v2Tier({ external_ref: "hid", visibility: "hidden" }),
      ],
      total: 4,
    });
    expect((await products()).map((p) => p.id)).toEqual(["keep"]);
  });

  // isOnSale 은 판매창 기준 — 종전 go 경로는 `is_active` 라 **항상 true** 였다.
  it("판매 시작 전 등급은 isOnSale=false", async () => {
    h.listTierCatalog.mockResolvedValue({
      tiers: [v2Tier({ sale_window: { opens_at: "2999-01-01T00:00:00.000Z", closes_at: null } })],
      total: 1,
    });
    expect((await products())[0]?.isOnSale).toBe(false);
  });

  // 🔴🔴 핵심 회귀: 조회 실패를 빈 목록으로 흘리면 위젯이 "상품 없음(=매진)"으로 렌더된다.
  it("카탈로그 조회 실패는 503 — 빈 상품 목록(200)으로 흘리지 않는다", async () => {
    h.listTierCatalog.mockRejectedValue(new h.V2CommerceError("boom", 502));
    const res = await call();
    expect(res.status).toBe(503);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const body = (await res.json()) as { success: boolean; data?: unknown };
    expect(body.success).toBe(false);
    expect(body.data).toBeUndefined();
  });

  // v2 가 404(이벤트 없음)를 줘도 마찬가지다 — 위 resolve 에서 live 로 확인된 직후이므로
  // 일시 불일치이며, "행사 없음"으로 위장하지 않고 재시도 가능 신호로 끊는다.
  it("카탈로그 404 도 503 으로 끊는다", async () => {
    h.listTierCatalog.mockRejectedValue(new h.V2CommerceError("not found", 404));
    expect((await call()).status).toBe(503);
  });

  it("미허용 Origin(403)은 카탈로그를 조회하지 않는다", async () => {
    h.getPublicWidgetConfig.mockResolvedValue({
      configured: true, mode: "button", theme: {},
      allowed_domains: ["ok.example.com"], is_active: true,
    });
    expect((await call({ origin: "https://evil.example.org" })).status).toBe(403);
    expect(h.listTierCatalog).not.toHaveBeenCalled();
  });
});
