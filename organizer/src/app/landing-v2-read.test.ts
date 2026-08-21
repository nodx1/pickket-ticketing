import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * W2-PUB — 랜딩/사이트맵의 go DB 제거 회귀.
 *
 * 이 3개는 화면을 막을 수 없는 경로라 throw 대신 축소 렌더로 간다. 그래서 **"축소 상태가
 * 정상처럼 보이지 않는지"** 가 핵심 검증이다:
 *  · sitemap  → 정적 엔트리만(색인 파손 방지) + 로그
 *  · 그리드   → 빈 배열 + `degraded=true`(안내 문구 분기)
 *  · 소셜프루프 → 0 을 표시하지 않고 섹션 자체를 생략
 */
const h = vi.hoisted(() => ({
  listPublicEventsV2: vi.fn(),
  getPublicStatsV2: vi.fn(),
  getPool: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/lib/db/pool", () => ({ getPool: h.getPool }));
vi.mock("@/lib/v2/commerce-client", () => ({
  listPublicEventsV2: h.listPublicEventsV2,
  getPublicStatsV2: h.getPublicStatsV2,
}));
vi.mock("@/lib/logger", () => ({
  logger: { warn: h.warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
// 서버 컴포넌트는 JSX 를 반환한다 — 자식 클라이언트 컴포넌트를 props 캡처용으로 대체.
vi.mock("@/app/_components/event-discovery-grid-client", () => ({
  EventDiscoveryGridClient: (props: unknown) => ({ __client: "grid", props }),
}));
vi.mock("@/app/_components/social-proof-bar-client", () => ({
  SocialProofBarClient: (props: unknown) => ({ __client: "social", props }),
}));

import sitemap from "@/app/sitemap";
import { EventDiscoveryGrid } from "@/app/_components/event-discovery-grid";
import { SocialProofBar } from "@/app/_components/social-proof-bar";

function eventRow(i: number) {
  return {
    event_id: `evt-${i}`, external_ref: null, slug: `e-${i}`, title: `이벤트 ${i}`,
    summary: null, description: null, venue: "홀", venue_address: null,
    event_type: "concert", category: "concert", age_rating: null, is_online: false,
    event_date: "2026-09-01T00:00:00Z", event_date_end: null, image_url: null,
    image_variants: null, status: "live", sale_channels: ["self"], total_seats: 10,
    attendee_count: 4, tier_count: 1, updated_at: "2026-08-01T00:00:00Z",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getPool.mockReturnValue({ query: vi.fn() });
  process.env.NEXT_PUBLIC_APP_URL = "https://go.example";
});

describe("sitemap", () => {
  it("v2 공개 목록(updated 정렬)으로 이벤트 URL 을 만든다 — go DB 미사용", async () => {
    h.listPublicEventsV2.mockResolvedValue({
      events: [eventRow(1), eventRow(2)], total: 2, limit: 200, offset: 0,
    });

    const entries = await sitemap();
    expect(entries.map((e) => e.url)).toEqual([
      "https://go.example/",
      "https://go.example/my-tickets",
      "https://go.example/e/e-1",
      "https://go.example/e/e-2",
    ]);
    expect(h.listPublicEventsV2).toHaveBeenCalledWith(
      expect.objectContaining({ sort: "updated" }),
    );
    expect(h.getPool).not.toHaveBeenCalled();
  });

  it("v2 장애 시 정적 엔트리만 반환하고 **로그를 남긴다**(조용한 축소 금지)", async () => {
    h.listPublicEventsV2.mockRejectedValue(new Error("down"));

    const entries = await sitemap();
    expect(entries).toHaveLength(2);
    expect(h.warn).toHaveBeenCalledTimes(1);
  });

  it("페이지 크기만큼 오면 다음 페이지를 이어 읽는다", async () => {
    const full = Array.from({ length: 200 }, (_, i) => eventRow(i));
    h.listPublicEventsV2
      .mockResolvedValueOnce({ events: full, total: 201, limit: 200, offset: 0 })
      .mockResolvedValueOnce({ events: [eventRow(999)], total: 201, limit: 200, offset: 200 });

    const entries = await sitemap();
    expect(entries).toHaveLength(2 + 201);
    expect(h.listPublicEventsV2).toHaveBeenCalledTimes(2);
  });
});

describe("EventDiscoveryGrid", () => {
  it("v2 목록을 카드 데이터로 매핑한다", async () => {
    h.listPublicEventsV2.mockResolvedValue({
      events: [eventRow(1)], total: 1, limit: 24, offset: 0,
    });

    const node = (await EventDiscoveryGrid()) as unknown as {
      props: { events: unknown[]; degraded: boolean };
    };
    const props = (node.props as { events: Array<Record<string, unknown>>; degraded: boolean });
    expect(props.degraded).toBe(false);
    expect(props.events[0]).toMatchObject({
      id: "evt-1", slug: "e-1", venueName: "홀", attendeeCount: 4,
    });
    expect(h.getPool).not.toHaveBeenCalled();
  });

  it("🔴 v2 장애를 '이벤트 0건'으로 위장하지 않는다 — degraded 플래그", async () => {
    h.listPublicEventsV2.mockRejectedValue(new Error("down"));

    const node = (await EventDiscoveryGrid()) as unknown as {
      props: { events: unknown[]; degraded: boolean };
    };
    expect(node.props.degraded).toBe(true);
    expect(node.props.events).toEqual([]);
    expect(h.warn).toHaveBeenCalledTimes(1);
  });
});

describe("SocialProofBar", () => {
  it("v2 집계를 그대로 표시한다", async () => {
    h.getPublicStatsV2.mockResolvedValue({
      event_count: 31, live_event_count: 29, ticket_count: 120,
    });

    const node = (await SocialProofBar()) as unknown as {
      props: { eventCount: number; ticketCount: number; liveCount: number };
    };
    expect(node.props).toMatchObject({ eventCount: 31, ticketCount: 120, liveCount: 29 });
    expect(h.getPool).not.toHaveBeenCalled();
  });

  it("🔴 v2 장애 시 0 을 표시하지 않고 섹션을 생략한다", async () => {
    h.getPublicStatsV2.mockRejectedValue(new Error("down"));
    expect(await SocialProofBar()).toBeNull();
    expect(h.warn).toHaveBeenCalledTimes(1);
  });
});
