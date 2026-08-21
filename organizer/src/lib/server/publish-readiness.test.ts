import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

// 레벨2 컷오버 T1 — 좌석수·발행 배치도수는 v2 가 정본(go seats/seat_maps 미read).
// 레벨2 컷오버 T2-EVT — 이벤트 소유/앵커도 go `events` 가 아니라 v2 상세(getEvent + organizer_ref)다.
// 레벨2 컷오버 W2-PS — 상품·좌석등급 정본도 **v2 tier 카탈로그**다(go products/seat_tiers 미read).
//   실장애 회귀: 여기가 go 를 세는 한 초기화된 DB 에서 tierCount 가 항상 0 이라 **게시가 영구 불가**였다.
// → go 풀은 이제 쓰이지 않는다. fakePool 은 "호출되면 안 된다"를 증명하는 용도로만 남긴다.
const h = vi.hoisted(() => {
  class V2CommerceErrorMock extends Error {
    constructor(
      message: string,
      readonly status: number = 500,
    ) {
      super(message);
      this.name = "V2CommerceError";
    }
  }
  return {
    listSeats: vi.fn(),
    listTierCatalog: vi.fn(),
    getEvent: vi.fn(),
    getEventBySlug: vi.fn(),
    updateEvent: vi.fn(),
    goAccountRef: vi.fn((accountId: string) => ({ go_account_id: accountId })),
    V2CommerceError: V2CommerceErrorMock,
  };
});

vi.mock("@/lib/v2/commerce-client", () => ({
  listSeats: h.listSeats,
  listTierCatalog: h.listTierCatalog,
  getEvent: h.getEvent,
  getEventBySlug: h.getEventBySlug,
  updateEvent: h.updateEvent,
  goAccountRef: h.goAccountRef,
  V2CommerceError: h.V2CommerceError,
}));

const { getTicketReadiness } = await import("./publish-readiness");
const { EventAccessError } = await import("@/lib/v2/event-access");

/** go 풀 스텁 — 이제 **한 번도 호출되면 안 된다**(정본이 v2 카탈로그로 옮겨졌다). */
function fakePool() {
  const query = vi.fn(async () => ({ rows: [] }));
  return { pool: { query } as unknown as Pool, query };
}

/**
 * v2 상세 스텁 — 소유 확인(getOwnedEvent)과 배치도 조회(fetchPublishedMaps)가 같은 getEvent 를 쓴다.
 * publishedMaps 개수만큼 published 맵 + draft 1개(발행수에 안 잡혀야 함 — 3.1 draft 계약).
 */
function stubOwnedEvent(publishedMaps: number) {
  h.getEvent.mockResolvedValue({
    event_id: "v2-ev",
    content: {
      seat_map_data: {
        maps: [
          ...Array.from({ length: publishedMaps }, (_, i) => ({
            id: `map-${i}`,
            status: "published",
          })),
          { id: "map-draft", status: "draft" },
        ],
      },
    },
  });
}

/** v2 tier 카탈로그 스텁 — go_source='product' 는 상품, 그 외는 좌석등급으로 집계된다. */
function stubCatalog(opts: { products: number; tiers: number }) {
  h.listTierCatalog.mockResolvedValue({
    tiers: [
      ...Array.from({ length: opts.products }, (_, i) => ({
        tier_id: `p-${i}`,
        tier_metadata: { go_source: "product" },
      })),
      ...Array.from({ length: opts.tiers }, (_, i) => ({
        tier_id: `t-${i}`,
        tier_metadata: { go_source: "seat_tier" },
      })),
    ],
    total: opts.products + opts.tiers,
  });
}

describe("getTicketReadiness (온보딩=게시 게이트 판정 SSOT — 감사 P0-12)", () => {
  beforeEach(() => {
    h.listSeats.mockReset();
    h.listTierCatalog.mockReset();
    h.getEvent.mockReset();
  });

  it("등급 + 배치도 발행 → pass", async () => {
    stubOwnedEvent(1);
    h.listSeats.mockResolvedValue({ total_seats: 50 });
    stubCatalog({ products: 0, tiers: 2 });
    const { pool, query } = fakePool();
    const r = await getTicketReadiness(pool, "ev", "acc");
    expect(r.ticketStatus).toBe("pass");
    expect(r.tierCount).toBe(2);
    expect(r.seatCount).toBe(50);
    expect(r.publishedMapCount).toBe(1); // draft 는 제외
    // 🔴 실장애 회귀: go 를 세면 초기화된 DB 에서 항상 0 → 게시 영구 불가.
    expect(query).not.toHaveBeenCalled();
  });

  it("등급만 있고 배치도 미발행 → warn", async () => {
    stubOwnedEvent(0);
    h.listSeats.mockResolvedValue({ total_seats: 0 });
    stubCatalog({ products: 3, tiers: 1 });
    const { pool } = fakePool();
    const r = await getTicketReadiness(pool, "ev", "acc");
    expect(r.ticketStatus).toBe("warn");
  });

  it("products 만 있고 등급 없음 → fail (가이드가 products 로 통과시키던 결함 재현 차단)", async () => {
    stubOwnedEvent(0);
    h.listSeats.mockResolvedValue({ total_seats: 0 });
    stubCatalog({ products: 5, tiers: 0 });
    const { pool } = fakePool();
    const r = await getTicketReadiness(pool, "ev", "acc");
    expect(r.ticketStatus).toBe("fail");
    expect(r.productCount).toBe(5);
  });

  it("이벤트 없음·타 계정 → 전부 0, fail. go 카운트 쿼리도 v2 조회도 하지 않는다", async () => {
    // v2 는 organizer_ref 불일치를 404 로 응답한다(존재 사실 비노출).
    h.getEvent.mockRejectedValue(new h.V2CommerceError("not found", 404));
    const { pool, query } = fakePool();
    const r = await getTicketReadiness(pool, "ev", "other-acc");
    expect(r).toEqual({
      productCount: 0,
      tierCount: 0,
      seatCount: 0,
      publishedMapCount: 0,
      ticketStatus: "fail",
    });
    // 🔴 카운트 쿼리에는 account_id 조건이 없다 → 소유 확인 실패 시 아예 실행되면 안 된다.
    expect(query).not.toHaveBeenCalled();
    expect(h.listSeats).not.toHaveBeenCalled();
  });

  it("소유 확인 불가(v2 응답불가)는 0 으로 뭉개지 않고 EventAccessError 를 던진다", async () => {
    // "확인 불가"를 "등급 0개"로 표시하면 주최자에게 데이터가 사라진 것처럼 보인다(조용한 폴백 금지).
    h.getEvent.mockRejectedValue(new h.V2CommerceError("bad gateway", 502));
    const { pool, query } = fakePool();
    await expect(getTicketReadiness(pool, "ev", "acc")).rejects.toBeInstanceOf(EventAccessError);
    expect(query).not.toHaveBeenCalled();
  });

  it("좌석/배치도 조회 일시오류는 게시 가이드를 막지 않고 0 으로 폴백한다(보수적 판정)", async () => {
    // 소유 확인은 성공(경계 통과) — 이후 좌석 read 만 실패하는 경우.
    stubOwnedEvent(1);
    h.listSeats.mockRejectedValue(new h.V2CommerceError("v2 down", 502));
    // 🔴 카탈로그는 성공해야 한다 — 좌석 조회 실패가 **등급 수까지 0 으로 만들면** 등급이 있는데도
    //    "등급을 추가하세요"가 떠서 주최자가 원인을 못 찾는다(분리 정책 회귀).
    stubCatalog({ products: 1, tiers: 2 });
    const { pool } = fakePool();
    const r = await getTicketReadiness(pool, "ev", "acc");
    expect(r.seatCount).toBe(0);
    expect(r.publishedMapCount).toBe(0);
    expect(r.tierCount).toBe(2); // 등급 수는 살아있어야 한다
    expect(r.ticketStatus).toBe("warn");
  });
});
