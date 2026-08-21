import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

/**
 * W2-PUB — slug 기반 공개 라우트 회귀(레벨2 컷오버 wave2).
 *
 * 라우트마다 **정상 / 미존재(404) / v2 장애(503) / 상태 게이트(비 live 차단)** 4축을 고정한다.
 * 이 4축이 wave1 에서 실제로 무너졌던 지점이다:
 *   · v2 장애를 404·빈목록으로 위장 → 판매중 이벤트가 조용히 사라짐
 *   · 상태 게이트 유실 → draft 이벤트가 공개 노출
 */
const h = vi.hoisted(() => {
  class MockV2CommerceError extends Error {
    constructor(message: string, readonly status: number) {
      super(message);
      this.name = "V2CommerceError";
    }
  }
  return {
    getEventBySlug: vi.fn(),
    getEvent: vi.fn(),
    getPool: vi.fn(),
    fetchPublishedMapIds: vi.fn(),
    fetchPublishedMaps: vi.fn(),
    getByEvent: vi.fn(),
    MockV2CommerceError,
  };
});

vi.mock("@/lib/db/pool", () => ({ getPool: h.getPool }));
vi.mock("@/lib/v2/commerce-client", () => ({
  V2CommerceError: h.MockV2CommerceError,
  getEventBySlug: h.getEventBySlug,
  getEvent: h.getEvent,
}));
vi.mock("@/lib/v2/seat-map-payload", () => ({
  fetchPublishedMapIds: h.fetchPublishedMapIds,
  fetchPublishedMaps: h.fetchPublishedMaps,
}));
vi.mock("@/lib/seats", () => ({
  seatRepo: { getByEvent: h.getByEvent, getBestAvailable: vi.fn(async () => []) },
}));
vi.mock("@/lib/seats/metrics", () => ({
  seatMetrics: {
    incrementBestAvailable: vi.fn(),
    sseConnected: vi.fn(),
    sseDisconnected: vi.fn(),
  },
}));
vi.mock("@/lib/seats/event-bus", () => ({
  replaySeatUpdates: vi.fn(async () => []),
  subscribeSeatUpdates: vi.fn(() => () => {}),
}));
// 레이트리밋 HOF 는 통과시킨다(이 테스트의 관심사가 아님).
vi.mock("@/lib/auth/withRateLimit", () => ({
  withRateLimit: () => (handler: unknown) => handler,
  SEAT_RATE_LIMITS: {
    read: {}, hold: {}, watch: {}, companion: {}, bestAvailable: {},
  },
}));

import { GET as calendarRoute } from "./calendar/route";
import { GET as seatsRoute } from "./seats/route";
import { GET as streamRoute } from "./seats/stream/route";
import { GET as seatMapsRoute } from "./seat-maps/route";

const SLUG = "my-event";
const EVENT_ID = "11111111-2222-4333-8444-555555555555";

function ctx() {
  return { params: Promise.resolve({ slug: SLUG }) };
}

function liveEvent(overrides: Record<string, unknown> = {}) {
  return {
    event_id: EVENT_ID,
    slug: SLUG,
    title: "테스트 이벤트",
    status: "live",
    event_date: "2026-09-01T10:00:00+00:00",
    event_date_end: "2026-09-01T13:00:00+00:00",
    venue: "올림픽홀",
    venue_address: "서울시 송파구",
    description: "설명",
    content: { summary: "한 줄 요약" },
    ...overrides,
  };
}

beforeEach(() => {
  h.getEventBySlug.mockReset();
  h.getEvent.mockReset();
  h.getPool.mockReset();
  h.fetchPublishedMapIds.mockReset().mockResolvedValue([]);
  h.fetchPublishedMaps.mockReset().mockResolvedValue([]);
  h.getByEvent.mockReset().mockResolvedValue([]);
  h.getPool.mockReturnValue({ query: vi.fn().mockResolvedValue({ rows: [] }) });
});

describe("GET /api/public/events/[slug]/calendar", () => {
  it("live 이벤트의 .ics 를 v2 상세로 만든다(go DB 미사용)", async () => {
    h.getEventBySlug.mockResolvedValue(liveEvent());

    const res = await calendarRoute({} as NextRequest, ctx());

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/calendar");
    const body = await res.text();
    expect(body).toContain("테스트 이벤트");
    expect(h.getPool).not.toHaveBeenCalled();
  });

  it("미존재 slug 는 404", async () => {
    h.getEventBySlug.mockRejectedValue(new h.MockV2CommerceError("nope", 404));
    const res = await calendarRoute({} as NextRequest, ctx());
    expect(res.status).toBe(404);
  });

  it("🔴 v2 장애는 503 (404 로 뭉개지 않는다)", async () => {
    h.getEventBySlug.mockRejectedValue(new h.MockV2CommerceError("down", 502));
    const res = await calendarRoute({} as NextRequest, ctx());
    expect(res.status).toBe(503);
  });

  it("🔴 상태 게이트 — draft 이벤트 일정은 공개되지 않는다", async () => {
    h.getEventBySlug.mockResolvedValue(liveEvent({ status: "draft" }));
    const res = await calendarRoute({} as NextRequest, ctx());
    expect(res.status).toBe(404);
  });
});

describe("GET /api/public/events/[slug]/seats", () => {
  function req() {
    return new Request(`http://localhost/api/public/events/${SLUG}/seats`) as NextRequest;
  }

  it("published 배치도 좌석을 v2 canonical event id 로 조회한다", async () => {
    h.getEventBySlug.mockResolvedValue(liveEvent());
    h.fetchPublishedMapIds.mockResolvedValue(["map-1"]);
    h.getByEvent.mockResolvedValue([
      { id: "s1", status: "available", section: "A" },
      { id: "s2", status: "sold", section: "A" },
    ]);

    const res = await seatsRoute(req(), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.summary).toMatchObject({ total: 2, available: 1, sold: 1 });
    expect(h.fetchPublishedMapIds).toHaveBeenCalledWith(EVENT_ID);
    expect(h.getPool).not.toHaveBeenCalled();
  });

  it("미존재 404 / v2 장애 503 / draft 404", async () => {
    h.getEventBySlug.mockRejectedValueOnce(new h.MockV2CommerceError("nope", 404));
    expect((await seatsRoute(req(), ctx())).status).toBe(404);

    h.getEventBySlug.mockRejectedValueOnce(new h.MockV2CommerceError("down", 503));
    expect((await seatsRoute(req(), ctx())).status).toBe(503);

    h.getEventBySlug.mockResolvedValueOnce(liveEvent({ status: "draft" }));
    expect((await seatsRoute(req(), ctx())).status).toBe(404);
  });

  it("soldout 이벤트는 좌석을 계속 노출한다(옛 게이트 동일)", async () => {
    h.getEventBySlug.mockResolvedValue(liveEvent({ status: "soldout" }));
    h.fetchPublishedMapIds.mockResolvedValue([]);
    const res = await seatsRoute(req(), ctx());
    expect(res.status).toBe(200);
  });
});

describe("GET /api/public/events/[slug]/seats/stream (SSE)", () => {
  function req() {
    return new Request(
      `http://localhost/api/public/events/${SLUG}/seats/stream?mapId=map-1`,
    ) as NextRequest;
  }

  it("🔴 v2 장애는 503 — 404 면 클라이언트가 재연결을 포기한다", async () => {
    h.getEventBySlug.mockRejectedValue(new h.MockV2CommerceError("down", 500));
    const res = await streamRoute(req(), ctx());
    expect(res.status).toBe(503);
  });

  it("draft 이벤트는 구독을 열지 않는다", async () => {
    h.getEventBySlug.mockResolvedValue(liveEvent({ status: "draft" }));
    const res = await streamRoute(req(), ctx());
    expect(res.status).toBe(404);
  });
});

describe("GET /api/public/events/[slug]/seat-maps", () => {
  function req() {
    return new Request(`http://localhost/api/public/events/${SLUG}/seat-maps`) as NextRequest;
  }

  it("published 배치도만 노출하고 tier 는 go 저장소에서 읽는다(미전환 잔여)", async () => {
    h.getEventBySlug.mockResolvedValue(liveEvent());
    h.fetchPublishedMaps.mockResolvedValue([
      { id: "map-1", name: "1층", status: "published", map_data: { a: 1 } },
    ]);
    const query = vi.fn().mockResolvedValue({ rows: [{ id: "tier-1", name: "VIP" }] });
    h.getPool.mockReturnValue({ query });

    const res = await seatMapsRoute(req(), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.maps).toHaveLength(1);
    expect(body.data.tiers).toHaveLength(1);
    expect(h.fetchPublishedMaps).toHaveBeenCalledWith(EVENT_ID);
    // 잔여 go 의존은 seat_tiers 하나뿐임을 고정(events 조회가 다시 들어오면 실패한다).
    expect(String(query.mock.calls[0]?.[0])).toContain("seat_tiers");
    expect(String(query.mock.calls[0]?.[0])).not.toContain("FROM events");
  });

  it("미존재 404 / v2 장애 503 / draft 404 — go 조회 없이 판정", async () => {
    const query = vi.fn();
    h.getPool.mockReturnValue({ query });

    h.getEventBySlug.mockRejectedValueOnce(new h.MockV2CommerceError("nope", 404));
    expect((await seatMapsRoute(req(), ctx())).status).toBe(404);

    h.getEventBySlug.mockRejectedValueOnce(new h.MockV2CommerceError("down", 500));
    expect((await seatMapsRoute(req(), ctx())).status).toBe(503);

    h.getEventBySlug.mockResolvedValueOnce(liveEvent({ status: "paused" }));
    expect((await seatMapsRoute(req(), ctx())).status).toBe(404);

    expect(query).not.toHaveBeenCalled();
  });
});
