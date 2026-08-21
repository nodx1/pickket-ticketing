import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 레벨2 read-flip 회귀: getPublicEventBySlug({ authoritativePricing: true }) 가 체크아웃 표시/선택/PG
// 금액을 v2 tier.base_price 정본으로 덮어쓰고, 불일치 시 CheckoutPricingError(409/502)로 중단하는지 검증.
//
// W4-EVT 추가: 이벤트 본문 자체가 go `events` SELECT 가 아니라 v2 by-slug read 에서 오는지,
// 상태 게이트(live)와 fail-closed(v2 장애 → null 이 아니라 EventAccessError)가 유지되는지 고정한다.
const h = vi.hoisted(() => {
  class FakeV2Error extends Error {
    status: number;
    constructor(message: string, status = 500) {
      super(message);
      this.status = status;
    }
  }
  return {
    pool: { query: vi.fn() },
    getTiersByEvent: vi.fn(),
    listTierCatalog: vi.fn(),
    getEvent: vi.fn(),
    getEventBySlug: vi.fn(),
    listSeats: vi.fn(),
    listEventHostLinks: vi.fn(),
    // 레벨2 컷오버 W5-CONTENT — 공개 공지는 go open_notices 가 아니라 v2 public-content read.
    listPublicNotices: vi.fn(),
    // W5-ATTENDEE: 예매 설문 문항 정본이 v2 로 이관됐다(go event_questions SELECT 폐기).
    listEventQuestions: vi.fn(),
    FakeV2Error,
  };
});

vi.mock("@/lib/db/pool", () => ({ getPool: () => h.pool }));
vi.mock("@/lib/v2/commerce-client", () => ({
  getTiersByEvent: (...a: unknown[]) => h.getTiersByEvent(...a),
  listTierCatalog: (...a: unknown[]) => h.listTierCatalog(...a),
  // 레벨2 컷오버 T1 — 배치도/좌석은 go 가 아니라 v2 에서 읽는다(getEvent + listSeats).
  getEvent: (...a: unknown[]) => h.getEvent(...a),
  // 레벨2 컷오버 W4-EVT — 공개 상세 본문은 v2 by-slug read 가 유일한 출처다.
  getEventBySlug: (...a: unknown[]) => h.getEventBySlug(...a),
  listSeats: (...a: unknown[]) => h.listSeats(...a),
  // 레벨2 컷오버 W2-EVT — 주최자 표기는 v2 event_host_links(go organizers/event_organizers 폐기).
  listEventHostLinks: (...a: unknown[]) => h.listEventHostLinks(...a),
  // 레벨2 컷오버 W5-CONTENT — go open_notices SELECT 폐기.
  listPublicNotices: (...a: unknown[]) => h.listPublicNotices(...a),
  // 레벨2 컷오버 W5-ATTENDEE — 예매 설문 문항은 v2 정본(go event_questions SELECT 폐기).
  listEventQuestions: (...a: unknown[]) => h.listEventQuestions(...a),
  V2CommerceError: h.FakeV2Error,
}));

import { getPublicEventBySlug, getPublicOrderCompletion } from "./events";

/** v2 `_event_detail_dict` 최소 형태(go 공개 상세가 소비하는 필드만). */
function v2Event(over: Record<string, unknown> = {}) {
  return {
    event_id: "evt-1",
    external_ref: "evt-1",
    title: "행사",
    slug: "e",
    description: null,
    venue: null,
    category: "concert",
    status: "live",
    status_v2: "published",
    event_date: "2026-09-01T10:00:00.000Z",
    sale_window: { opens_at: null, closes_at: null },
    sale_channels: ["self"],
    organizer_id: "org-1",
    total_seats: null,
    image_url: null,
    summary: {},
    content: { seat_map_data: null },
    // 소유 테넌트 — 옛 go `events.account_id`.
    go_account_id: "acc-1",
    ...over,
  };
}

/**
 * getPublicEventBySlug 의 pool.query 순차 호출을 순서대로 채워준다.
 * W5-ATTENDEE 이후 go 잔여 쿼리 순서: attendees(count) → products → notices.
 * (이벤트 본문·타임테이블·배치도·**예매 설문**은 pool.query 가 아니라 v2 응답에서 온다.)
 */
function mockSequence(opts: {
  event?: Record<string, unknown> | null;
  products?: Array<Record<string, unknown>>;
}) {
  h.pool.query.mockReset();
  h.pool.query
    .mockResolvedValueOnce({ rows: opts.products ?? [] }) // products
    .mockResolvedValueOnce({ rows: [] }); // notices
  // W5-ATTENDEE: 예매 설문은 v2 정본.
  h.listEventQuestions.mockResolvedValue({ questions: [] });
  const event = opts.event === undefined ? v2Event() : opts.event;
  if (event === null) {
    h.getEventBySlug.mockRejectedValue(new h.FakeV2Error("not found", 404));
  } else {
    h.getEventBySlug.mockResolvedValue(event);
  }
  h.listEventHostLinks.mockResolvedValue({ hosts: [] });
}

// (구 `tier()` 헬퍼 제거 — 재고 계약 변경으로 각 테스트가 capacity/sold_count 를 명시하게 되면서
//  호출자가 0 이 됐다. 죽은 픽스처는 다음 사람이 "이게 정본인가" 헷갈리게 만든다.)

// W5-CONTENT — 공개 공지는 v2 public-content read. 기본값 = 공지 없음.
beforeEach(() => {
  h.listPublicNotices.mockResolvedValue({ notices: [] });
  // 공개 상품 목록의 정본은 v2 카탈로그다 — 스텁을 안 주면 모든 케이스가 여기서 터진다.
  h.listTierCatalog.mockResolvedValue({ tiers: [], total: 0 });
});

afterEach(() => {
  h.pool.query.mockReset();
  h.getTiersByEvent.mockReset();
  h.listTierCatalog.mockReset();
  h.getEvent.mockReset();
  h.getEventBySlug.mockReset();
  h.listSeats.mockReset();
  h.listEventHostLinks.mockReset();
  h.listPublicNotices.mockReset();
});

/** v2 tier 카탈로그 스텁 — 공개 상품 목록의 **정본**. */
function stubCatalog(tiers: Array<Record<string, unknown>>) {
  h.listTierCatalog.mockResolvedValue({ tiers, total: tiers.length });
}

/**
 * 🔴 정가(face_price) 배선 — 2026-08-04.
 *
 * 온라인 10% 할인을 소구하려고 `~~₩15,000~~ ₩13,500` 을 그린다. 그 값이 화면까지
 * 오려면 **여기(매핑)** 를 통과해야 한다. 종전엔 `face_price` 를 아예 안 실었다.
 *
 * ⚠️ 화면 규칙(`face-price.ts`)은 별도 파일이 검증한다. 여기는 **값이 실려 오는지**만 본다.
 *    둘을 한 테스트로 묶으면 매핑을 지워도 규칙 테스트가 통과해 뮤테이션이 생존한다.
 */
describe("정가(facePrice) 가 공개 상품까지 실려 온다", () => {
  it("🔴 v2 face_price 를 products.facePrice 로 넘긴다", async () => {
    mockSequence({});
    stubCatalog([
      { tier_id: "t1", external_ref: "prod-A", name: "주중권", base_price: 13500, face_price: 15000,
        capacity: 1000, sold_count: 0, stock_limit: null, sale_window: { opens_at: null, closes_at: null } },
    ]);
    const out = await getPublicEventBySlug("e", { includeSeats: false });
    const p = (out?.products ?? [])[0] as unknown as { price: number; facePrice: number | null };
    expect(p.price, "판매가가 바뀌면 안 된다").toBe(13500);
    expect(p.facePrice, "정가가 화면까지 오지 않는다").toBe(15000);
  });

  it("정가가 없으면 null 로 온다 — 화면이 아무것도 안 그리게", async () => {
    mockSequence({});
    stubCatalog([
      { tier_id: "t1", external_ref: "prod-A", name: "주중권", base_price: 13500,
        capacity: 1000, sold_count: 0, stock_limit: null, sale_window: { opens_at: null, closes_at: null } },
    ]);
    const out = await getPublicEventBySlug("e", { includeSeats: false });
    const p = (out?.products ?? [])[0] as unknown as { facePrice: number | null };
    expect(p.facePrice).toBeNull();
  });

  it("정가가 0 이어도 그대로 넘긴다 — 판정은 화면 규칙이 한다", async () => {
    mockSequence({});
    stubCatalog([
      { tier_id: "t1", external_ref: "prod-A", name: "주중권", base_price: 13500, face_price: 0,
        capacity: 1000, sold_count: 0, stock_limit: null, sale_window: { opens_at: null, closes_at: null } },
    ]);
    const out = await getPublicEventBySlug("e", { includeSeats: false });
    const p = (out?.products ?? [])[0] as unknown as { facePrice: number | null };
    expect(p.facePrice, "0 을 null 로 뭉개면 화면 규칙이 판정할 값을 잃는다").toBe(0);
  });
});

/**
 * 🔴 등급 설명(description) 배선 — 2026-08-11.
 *
 * 등급명이 「주중권 (목 1R ~ 금 2R)」이라 **이틀로 읽힌다.** 실제로는 그 기간 중 **하루만**
 * 입장한다(daypass). 그 사실을 알리는 유일한 자리가 이 설명 필드다 — 이미 51장이 나갔고,
 * 손님이 이틀로 알고 현장에 오면 되돌릴 방법이 없다.
 *
 * ⚠️ 화면 규칙(있으면 그리고 없으면 안 그린다)은 별도 파일이 본다. 여기는 **값이 실려
 *    오는지**만 본다. 둘을 묶으면 매핑을 지워도 화면 테스트가 통과해 뮤테이션이 생존한다.
 *
 * 🔴 prod 실측(2026-08-11): 공개 API 가 `description` 키를 내려주고 값이 `null` 이다.
 *    즉 **배선은 살아 있고 데이터만 비어 있다.** 이 테스트가 그 배선을 지킨다.
 */
describe("등급 설명(description) 이 공개 상품까지 실려 온다", () => {
  const DAYPASS = "8월 20일 ~ 23일 기간 중 하루 입장하실 수 있습니다";

  it("🔴 v2 description 을 products.description 으로 넘긴다", async () => {
    mockSequence({});
    stubCatalog([
      { tier_id: "t1", external_ref: "prod-A", name: "주중권 (목 1R ~ 금 2R)", base_price: 13500,
        description: DAYPASS,
        capacity: 1000, sold_count: 0, stock_limit: null, sale_window: { opens_at: null, closes_at: null } },
    ]);
    const out = await getPublicEventBySlug("e", { includeSeats: false });
    const p = (out?.products ?? [])[0] as unknown as { description: string | null };
    expect(p.description, "설명이 화면까지 오지 않는다 — 손님이 이틀로 안다").toBe(DAYPASS);
  });

  it("설명이 없으면 null 로 온다 — 화면이 아무것도 안 그리게", async () => {
    mockSequence({});
    stubCatalog([
      { tier_id: "t1", external_ref: "prod-A", name: "주중권", base_price: 13500,
        capacity: 1000, sold_count: 0, stock_limit: null, sale_window: { opens_at: null, closes_at: null } },
    ]);
    const out = await getPublicEventBySlug("e", { includeSeats: false });
    const p = (out?.products ?? [])[0] as unknown as { description: string | null };
    expect(p.description ?? null).toBeNull();
  });

  it("🔴 등급마다 자기 설명이 실린다 — 첫 등급 것을 전부에 쓰면 안 된다", async () => {
    mockSequence({});
    stubCatalog([
      { tier_id: "t1", external_ref: "prod-A", name: "주중권", base_price: 13500, description: DAYPASS,
        capacity: 1000, sold_count: 0, stock_limit: null, sale_window: { opens_at: null, closes_at: null } },
      { tier_id: "t2", external_ref: "prod-B", name: "주말권", base_price: 22500,
        capacity: 1000, sold_count: 0, stock_limit: null, sale_window: { opens_at: null, closes_at: null } },
    ]);
    const out = await getPublicEventBySlug("e", { includeSeats: false });
    const ps = (out?.products ?? []) as unknown as Array<{ description: string | null }>;
    expect(ps.map((x) => x.description ?? null)).toEqual([DAYPASS, null]);
  });

  it("⚠️ 숨김 등급은 애초에 공개 목록에 없다 — 초대권 설명이 손님에게 새면 안 된다", async () => {
    // prod 에서 설명이 채워진 유일한 등급이 `초대권 · visibility=hidden` 이다(2026-08-11 실측).
    mockSequence({});
    stubCatalog([
      { tier_id: "t0", external_ref: "prod-INV", name: "초대권", base_price: 0, visibility: "hidden",
        description: "초대권/수동발권 (0원)",
        capacity: 100, sold_count: 0, stock_limit: null, sale_window: { opens_at: null, closes_at: null } },
      { tier_id: "t1", external_ref: "prod-A", name: "주중권", base_price: 13500, description: DAYPASS,
        capacity: 1000, sold_count: 0, stock_limit: null, sale_window: { opens_at: null, closes_at: null } },
    ]);
    const out = await getPublicEventBySlug("e", { includeSeats: false });
    const ps = (out?.products ?? []) as unknown as Array<{ name: string; description: string | null }>;
    expect(ps.map((x) => x.name)).toEqual(["주중권"]);
    expect(ps.map((x) => x.description)).not.toContain("초대권/수동발권 (0원)");
  });
});

describe("getPublicEventBySlug — 공개 상품 목록은 v2 카탈로그 정본", () => {
  /**
   * 🔴 2026-07-27 prod 실결함 회귀.
   * 여기가 go `products` 를 읽고 있었다. W2-PS 가 상품 생성을 v2 카탈로그 단독 write 로 옮겨
   * go 테이블에는 새 행이 생기지 않으므로, 초기화된 DB 에서 products 가 **항상 빈 배열**이 됐고
   *   totalStock = 0 → isSoldOut = true → 버튼이 **"매진되었습니다"**
   * 로 표시됐다. 티켓을 정상 등록해도 아무도 살 수 없고, 화면은 "매진"이라 원인을 알 수 없다.
   */
  it("v2 티어를 공개 상품으로 내려준다 — go products 조회 없음", async () => {
    mockSequence({});
    stubCatalog([
      { tier_id: "t1", external_ref: "prod-A", name: "주중권", base_price: 15000, capacity: 1000,
        sold_count: 0, stock_limit: null, sale_window: { opens_at: null, closes_at: null } },
      { tier_id: "t2", external_ref: "prod-B", name: "주말권", base_price: 25000, capacity: 100,
        sold_count: 40, stock_limit: 100, sale_window: { opens_at: null, closes_at: null } },
    ]);
    const out = await getPublicEventBySlug("e", { includeSeats: false });
    // stock = **잔여**(capacity − sold_count). 주말권은 100 중 40 팔려 60 남았다.
    expect(out?.products?.map((p) => [p.name, p.price, p.stock])).toEqual([
      ["주중권", 15000, 1000],
      ["주말권", 25000, 60],
    ]);
    expect(h.listTierCatalog).toHaveBeenCalledWith("evt-1");
  });

  it("무제한 sentinel(capacity 100만)은 null — '재고 100만장'으로 보이지 않는다", async () => {
    mockSequence({});
    stubCatalog([
      { tier_id: "t1", external_ref: "p", name: "무제한", base_price: 1000, capacity: 1_000_000,
        sold_count: 5, stock_limit: null, sale_window: { opens_at: null, closes_at: null } },
    ]);
    const out = await getPublicEventBySlug("e", { includeSeats: false });
    expect(out?.products?.[0]?.stock).toBeNull();
  });

  /**
   * 🔴 2026-07-28 실결함 회귀 (적대 감사 F3).
   * `stock` 이 `stock_limit`(입력 원본)이었다. 좌석등급 경로는 stock_limit 을 보내지 않아
   * KLPGA 티어는 `capacity=1000, stock_limit=NULL` 이었고, 화면이 `?? 999` 로 폴백해
   * **1,000장 완판돼도 매진이 뜨지 않고 구매 버튼이 살아 있었다**. 구매자는 결제 단계에서야
   * 409 SOLD_OUT 을 만난다. 판매를 막는 기준은 v2 의 `capacity − sold_count` 이므로
   * 표시도 같은 값을 써야 한다.
   */
  it("stock_limit 이 NULL 이어도 완판이면 잔여 0 — capacity−sold_count 로 판정", async () => {
    mockSequence({});
    stubCatalog([
      { tier_id: "t1", external_ref: "p", name: "주중권", base_price: 15000, capacity: 1000,
        sold_count: 1000, stock_limit: null, sale_window: { opens_at: null, closes_at: null } },
    ]);
    const out = await getPublicEventBySlug("e", { includeSeats: false });
    expect(out?.products?.[0]?.stock).toBe(0);
  });

  it("초과판매가 기록돼도 잔여는 음수로 내려가지 않는다", async () => {
    mockSequence({});
    stubCatalog([
      { tier_id: "t1", external_ref: "p", name: "주중권", base_price: 15000, capacity: 10,
        sold_count: 12, stock_limit: null, sale_window: { opens_at: null, closes_at: null } },
    ]);
    const out = await getPublicEventBySlug("e", { includeSeats: false });
    expect(out?.products?.[0]?.stock).toBe(0);
  });

  it("판매창 밖이면 isOnSale=false (매진과 구분되는 신호)", async () => {
    mockSequence({});
    stubCatalog([
      { tier_id: "t1", external_ref: "p", name: "예정", base_price: 1000, stock_limit: 10,
        sale_window: { opens_at: "2999-01-01T00:00:00Z", closes_at: null } },
    ]);
    const out = await getPublicEventBySlug("e", { includeSeats: false });
    expect(out?.products?.[0]?.isOnSale).toBe(false);
  });

  it("카탈로그 조회 실패를 '상품 0건'으로 흘리지 않는다 — 체크아웃 경로는 502 중단", async () => {
    mockSequence({});
    h.listTierCatalog.mockRejectedValue(new h.FakeV2Error("boom", 502));
    await expect(
      getPublicEventBySlug("e", { includeSeats: false, authoritativePricing: true }),
    ).rejects.toMatchObject({ name: "CheckoutPricingError", httpStatus: 502 });
  });

  it("상품이 없는 이벤트는 빈 목록으로 통과한다(무료/상품없음 회귀)", async () => {
    mockSequence({});
    stubCatalog([]);
    const out = await getPublicEventBySlug("e", { includeSeats: false, authoritativePricing: true });
    expect(out?.products).toEqual([]);
  });
});

/**
 * 레벨2 컷오버 W4-EVT — 공개 상세가 go `events` 테이블을 SQL 로 읽지 않고 v2 by-slug 에서
 * 가져오는지, 그리고 상태 게이트·fail-closed 가 유지되는지 고정한다.
 */
describe("getPublicEventBySlug — W4-EVT(이벤트 본문 v2 이관)", () => {
  it("go events SELECT 없이 v2 by-slug 로 본문을 읽고 go 컬럼명 shape 을 보존한다", async () => {
    mockSequence({
      event: v2Event({
        title: "KLPGA",
        venue: "메인홀",
        venue_address: "서울시",
        image_url: "https://cdn/x.png",
        age_rating: "all",
        event_type: "sports",
        is_online: false,
        rsvp_enabled: true,
        enabled_features: ["rehearsal"],
        event_date_end: "2026-09-02T10:00:00.000Z",
        content: {
          seat_map_data: null,
          summary: "요약문",
          transport_info: "지하철 2호선",
          parking_info: "주차 가능",
          runtime_minutes: 120,
          intermission_minutes: 15,
          seo_metadata: { seoTitle: "SEO" },
        },
      }),
      products: [],
    });

    const out = await getPublicEventBySlug("e", { includeSeats: false });

    expect(out).toMatchObject({
      id: "evt-1",
      v2EventId: "evt-1",
      accountId: "acc-1",
      title: "KLPGA",
      venueName: "메인홀",
      venueAddress: "서울시",
      heroImageUrl: "https://cdn/x.png",
      ageRating: "all",
      eventType: "sports",
      isOnline: false,
      rsvpEnabled: true,
      enabledFeatures: ["rehearsal"],
      startsAt: "2026-09-01T10:00:00.000Z",
      endsAt: "2026-09-02T10:00:00.000Z",
      summary: "요약문",
      transportInfo: "지하철 2호선",
      parkingInfo: "주차 가능",
      runtimeMinutes: 120,
      intermissionMinutes: 15,
      seoMetadata: { seoTitle: "SEO" },
    });

    const sqls = h.pool.query.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(sqls.some((s) => /\bFROM\s+events\b/i.test(s))).toBe(false);
    expect(sqls.some((s) => /\bJOIN\s+events\b/i.test(s))).toBe(false);
  });

  it("상태 게이트를 유지한다 — draft/paused/archived 이벤트는 null(공개 노출 금지)", async () => {
    for (const status of ["draft", "paused", "archived"]) {
      mockSequence({ event: v2Event({ status }), products: [] });
      expect(await getPublicEventBySlug("e", { includeSeats: false })).toBeNull();
    }
  });

  it("미존재 slug 는 null(404)", async () => {
    mockSequence({ event: null, products: [] });
    expect(await getPublicEventBySlug("e", { includeSeats: false })).toBeNull();
  });

  // 🔴 fail-closed: v2 장애를 "이벤트 없음"으로 위장하면 판매중인 행사가 조용히 사라진다.
  it("v2 장애는 null 로 뭉개지 않고 EventAccessError(unavailable)로 전파한다", async () => {
    h.pool.query.mockReset();
    h.getEventBySlug.mockRejectedValue(new h.FakeV2Error("boom", 503));
    await expect(getPublicEventBySlug("e", { includeSeats: false })).rejects.toMatchObject({
      name: "EventAccessError",
      reason: "unavailable",
    });
  });
});

/**
 * 레벨2 컷오버 W2-EVT — 공개 상세가 go `organizers`/`event_organizers`/`event_schedules` 를
 * 더 이상 SQL 로 읽지 않고 v2 에서 가져오는지 고정한다(마이그 240 DROP 의 안전망).
 */
describe("getPublicEventBySlug — W2-EVT(주최자 표기·타임테이블 v2 이관)", () => {
  it("주최자 표기를 v2 event_host_links 에서 가져오고, go organizers JOIN 을 하지 않는다", async () => {
    mockSequence({ products: [] });
    h.listEventHostLinks.mockResolvedValue({
      hosts: [
        { link_id: "l1", host_id: "h1", role: "host", display_order: 0, name: "주최자A", slug: "a", logo_url: null, contact_public: false, email: null, phone: null },
        { link_id: "l2", host_id: "h2", role: "sponsor", display_order: 1, name: "후원사B", slug: "b", logo_url: null, contact_public: false, email: null, phone: null },
      ],
    });

    const out = await getPublicEventBySlug("e", { includeSeats: false });
    expect(out?.organizerName).toBe("주최자A");
    expect(out?.organizers).toEqual([
      { organizerId: "h1", name: "주최자A", role: "host", displayOrder: 0 },
      { organizerId: "h2", name: "후원사B", role: "sponsor", displayOrder: 1 },
    ]);
    // 🔴 테넌트 경계: 공개 경로라 세션이 없어 v2 go_account_id 를 organizer_ref 로 넘긴다.
    expect(h.listEventHostLinks).toHaveBeenCalledWith("acc-1", "evt-1");

    const sqls = h.pool.query.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(sqls.some((s) => /FROM\s+organizers/.test(s))).toBe(false);
    expect(sqls.some((s) => /FROM\s+event_organizers/.test(s))).toBe(false);
    expect(sqls.some((s) => /FROM\s+event_schedules/.test(s))).toBe(false);
  });

  it("타임테이블을 by-slug 응답의 content.event_schedules 에서 복원한다(getEvent 재조회 없음)", async () => {
    mockSequence({
      event: v2Event({
        content: {
          seat_map_data: null,
          event_schedules: [
            { id: "s1", time: "2026-09-01T18:00:00.000Z", title: "1부", description: "오프닝", ends_at: null, venue_name: "메인홀", sort_order: 0 },
          ],
        },
      }),
      products: [],
    });

    const out = await getPublicEventBySlug("e", { includeSeats: false });
    expect(out?.schedules).toEqual([
      { id: "s1", title: "1부", description: "오프닝", startsAt: "2026-09-01T18:00:00.000Z", endsAt: null, venueName: "메인홀", sortOrder: 0, imageUrl: null },
    ]);
    // 본문을 이미 by-slug 로 읽었으므로 상세 재조회 왕복이 없어야 한다.
    expect(h.getEvent).not.toHaveBeenCalled();
  });

  it("주최자 표기 v2 조회 실패는 공개 상세 렌더를 막지 않고 표기만 비운다", async () => {
    mockSequence({ products: [] });
    h.listEventHostLinks.mockRejectedValue(new h.FakeV2Error("boom", 502));

    const out = await getPublicEventBySlug("e", { includeSeats: false });
    expect(out?.title).toBe("행사");
    expect(out?.organizers).toEqual([]);
  });
});

/**
 * W4-EVT — 결제완료 요약이 go `orders INNER JOIN events` 없이 slug 경계를 유지하는지.
 * 옛 JOIN 의 `events.slug = $2` 가 유일한 "주문↔이벤트 일치" 게이트였다 — 잃으면 주문 id 만
 * 알면 아무 slug URL 로나 남의 주문 요약이 열린다.
 */
describe("getPublicOrderCompletion — W4-EVT(slug 경계 v2 이관)", () => {
  it("slug 로 v2 이벤트를 해석하고 그 event_id 로 go 주문을 스코프한다", async () => {
    h.getEventBySlug.mockResolvedValue(v2Event({ title: "행사명" }));
    h.pool.query.mockReset();
    h.pool.query
      .mockResolvedValueOnce({ rows: [{ id: "ord-1", orderNumber: "ORD-1" }] })
      .mockResolvedValueOnce({ rows: [{ ticketNumber: "TKT-1" }] });

    const out = await getPublicOrderCompletion("ord-1", "e");
    expect(out).toMatchObject({ id: "ord-1", eventTitle: "행사명", ticketNumber: "TKT-1" });

    const [sql, params] = h.pool.query.mock.calls[0] as [string, unknown[]];
    expect(/\bJOIN\s+events\b/i.test(sql)).toBe(false);
    // 🔴 경계: 주문은 반드시 그 slug 의 이벤트로 스코프돼야 한다.
    expect(params).toEqual(["ord-1", "evt-1"]);
  });

  it("다른 이벤트의 주문 id 는 null (스코프 불일치)", async () => {
    h.getEventBySlug.mockResolvedValue(v2Event());
    h.pool.query.mockReset();
    h.pool.query.mockResolvedValueOnce({ rows: [] });
    expect(await getPublicOrderCompletion("ord-other", "e")).toBeNull();
  });

  it("미존재 slug 는 null — go 주문 조회조차 하지 않는다", async () => {
    h.getEventBySlug.mockRejectedValue(new h.FakeV2Error("not found", 404));
    h.pool.query.mockReset();
    expect(await getPublicOrderCompletion("ord-1", "nope")).toBeNull();
    expect(h.pool.query).not.toHaveBeenCalled();
  });

  // 🔴 v2 장애를 "주문 없음"으로 위장하면 결제한 구매자에게 주문이 사라졌다고 거짓말하게 된다.
  it("v2 장애는 null 이 아니라 EventAccessError 로 전파한다", async () => {
    h.getEventBySlug.mockRejectedValue(new h.FakeV2Error("boom", 500));
    h.pool.query.mockReset();
    await expect(getPublicOrderCompletion("ord-1", "e")).rejects.toMatchObject({
      name: "EventAccessError",
      reason: "unavailable",
    });
  });
});
