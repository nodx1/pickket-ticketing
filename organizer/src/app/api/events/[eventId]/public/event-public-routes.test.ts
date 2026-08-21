import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

/**
 * W2-PUB — 이벤트 스코프 공개 라우트(OG 이미지·컨텍스트 배너·RSVP) + 위젯 회귀.
 *
 * 공통 축: 정상 / 미존재 404 / v2 장애 503 / 상태 게이트.
 * 🔴 위젯(`/api/events/[id]/widget`)은 `AND account_id=$2` 가 유일한 소유 검증이었다 —
 *    크로스테넌트 누출 방지를 v2 organizer 경계로 이관했는지 고정한다.
 */
const h = vi.hoisted(() => {
  class MockV2CommerceError extends Error {
    constructor(message: string, readonly status: number) {
      super(message);
      this.name = "V2CommerceError";
    }
  }
  return {
    getEvent: vi.fn(),
    getEventBySlug: vi.fn(),
    getTiersByEvent: vi.fn(),
    requireOwnedEvent: vi.fn(),
    getPool: vi.fn(),
    redisGet: vi.fn(),
    redisSet: vi.fn(),
    MockV2CommerceError,
  };
});

vi.mock("@/lib/db/pool", () => ({ getPool: h.getPool }));
vi.mock("@/lib/v2/commerce-client", () => ({
  V2CommerceError: h.MockV2CommerceError,
  getEvent: h.getEvent,
  getEventBySlug: h.getEventBySlug,
  getTiersByEvent: h.getTiersByEvent,
}));
vi.mock("@/lib/v2/event-access", async () => {
  const actual = await vi.importActual<typeof import("@/lib/v2/event-access")>(
    "@/lib/v2/event-access",
  );
  return { ...actual, requireOwnedEvent: h.requireOwnedEvent };
});
vi.mock("@/lib/redis", () => ({
  getPrefixedRedis: () => ({ get: h.redisGet, set: h.redisSet }),
}));
vi.mock("@/lib/auth/permissions", () => ({
  withRole: (_role: string, handler: unknown) => handler,
}));

// 실 클래스를 쓴다 — 라우트가 `instanceof EventAccessError` 로 분기하므로 목 클래스를
// 던지면 분기가 타지 않고 테스트가 거짓 통과/실패한다.
import { EventAccessError } from "@/lib/v2/event-access";
import { GET as ogImageRoute } from "../og-image/route";
import { GET as widgetRoute } from "../widget/route";
import { GET as contextBannerRoute } from "./context-banner/route";

const EVENT_ID = "11111111-2222-4333-8444-555555555555";

function ctx() {
  return { params: Promise.resolve({ eventId: EVENT_ID }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getPool.mockReturnValue({ query: vi.fn().mockResolvedValue({ rows: [] }) });
  h.redisGet.mockResolvedValue(null);
  h.redisSet.mockResolvedValue("OK");
  h.getTiersByEvent.mockResolvedValue(new Map());
});

// ── OG 이미지 ────────────────────────────────────────────────────────────

describe("GET /api/events/[eventId]/og-image", () => {
  it("v2 상세로 SVG 를 만든다(주최자명 포함, go DB 미사용)", async () => {
    h.getEvent.mockResolvedValue({
      event_id: EVENT_ID, status: "live", title: "테스트 이벤트",
      event_type: "concert", event_date: "2026-09-01T00:00:00Z",
      venue: "올림픽홀", homepage_design: { accentColor: "#123456" },
      organizer_name: "주식회사 노드엑스",
    });

    const res = await ogImageRoute(new Request("http://localhost/og"), ctx());
    expect(res.status).toBe(200);
    const svg = await res.text();
    expect(svg).toContain("테스트 이벤트");
    expect(svg).toContain("올림픽홀");
    expect(svg).toContain("주식회사 노드엑스");
    expect(svg).toContain("#123456");
    expect(h.getPool).not.toHaveBeenCalled();
  });

  it("accentColor 가 HEX 가 아니면 기본색으로 대체(SVG 인젝션 차단)", async () => {
    h.getEvent.mockResolvedValue({
      event_id: EVENT_ID, status: "live", title: "T", event_type: "concert",
      event_date: null, venue: null,
      homepage_design: { accentColor: '"/><script>alert(1)</script>' },
      organizer_name: null,
    });
    const svg = await (await ogImageRoute(new Request("http://localhost/og"), ctx())).text();
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("#5FD3BC");
  });

  it("미존재 404 / 🔴 v2 장애 503 (크롤러가 404 를 캐시하면 카드가 영구 파손)", async () => {
    h.getEvent.mockRejectedValueOnce(new h.MockV2CommerceError("nope", 404));
    expect((await ogImageRoute(new Request("http://localhost/og"), ctx())).status).toBe(404);

    h.getEvent.mockRejectedValueOnce(new h.MockV2CommerceError("down", 500));
    expect((await ogImageRoute(new Request("http://localhost/og"), ctx())).status).toBe(503);
  });
});

// ── 위젯 임베드 코드(소유 검증) ──────────────────────────────────────────

describe("GET /api/events/[eventId]/widget", () => {
  const session = { accountId: "acc-1" };
  // withRole 을 통과 목으로 대체했으므로 핸들러는 **해석된** params 를 받는다
  // (실 래퍼 타입은 Promise 를 선언하므로 테스트에서만 캐스팅한다).
  const widgetCtx = { session, params: { eventId: EVENT_ID } } as unknown as Parameters<
    typeof widgetRoute
  >[1];

  it("🔴 소유 검증을 v2 organizer 경계로 넘긴다(accountId 전달)", async () => {
    h.requireOwnedEvent.mockResolvedValue({ event_id: EVENT_ID, slug: "my-event" });

    const res = await widgetRoute(new Request("http://localhost/w") as NextRequest, widgetCtx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.previewUrl).toBe("/embed/my-event");
    expect(h.requireOwnedEvent).toHaveBeenCalledWith(EVENT_ID, "acc-1");
    expect(h.getPool).not.toHaveBeenCalled();
  });

  it("타 계정 이벤트는 404, v2 장애는 503", async () => {
    h.requireOwnedEvent.mockRejectedValueOnce(
      new EventAccessError("없음", "not_found", 404),
    );
    expect(
      (await widgetRoute(new Request("http://localhost/w") as NextRequest, widgetCtx))
        .status,
    ).toBe(404);

    h.requireOwnedEvent.mockRejectedValueOnce(
      new EventAccessError("불가", "unavailable", 502),
    );
    expect(
      (await widgetRoute(new Request("http://localhost/w") as NextRequest, widgetCtx))
        .status,
    ).toBe(503);
  });
});

// ── 컨텍스트 배너 ────────────────────────────────────────────────────────

describe("GET /api/events/[eventId]/public/context-banner", () => {
  // 🔴 계약 변경(2026-07-30): 배너는 **주최자가 쓴 문구만** 표시한다.
  //
  //    종전에는 여기서 `D-N · 날짜 · 잔여석 · 최저가` 를 자동 계산했고(그것을 이 테스트가
  //    검증했다), 설정 화면의 「상단 안내 배너」 입력값은 읽지 않았다.
  //    그 결과 주최자가 쓴 공지는 사라지고, 통제할 수 없는 문구가 최상단에 떴다 —
  //    KLPGA 에서 최저가 계산에 0원 comp 등급이 섞여 **`₩0부터`** 가 표시됐다.
  //    유료 대회가 무료로 보이는 오정보였다(주최측 제보 → 대표 지시로 자동 생성 제거).
  it("주최자가 쓴 문구를 그대로 표시한다(go DB 미사용)", async () => {
    h.getEvent.mockResolvedValue({
      event_id: EVENT_ID, status: "live", title: "T", venue: "홀",
      event_date: new Date(Date.now() + 3 * 86400000).toISOString(),
      context_banner: "얼리버드 20% 할인 중",
    });

    const res = await contextBannerRoute({} as NextRequest, ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.banner).toBe("얼리버드 20% 할인 중");
    expect(h.getPool).not.toHaveBeenCalled();
  });

  it("🔴 문구를 비우면 배너가 사라진다 — 대표가 설정에서 끌 수 있어야 한다", async () => {
    h.getEvent.mockResolvedValue({
      event_id: EVENT_ID, status: "live", title: "T", venue: "홀",
      event_date: new Date(Date.now() + 3 * 86400000).toISOString(),
      context_banner: "   ",
    });

    const body = await (await contextBannerRoute({} as NextRequest, ctx())).json();
    expect(body.data.banner).toBeNull();
  });

  it("🔴 티어(최저가·잔여석)를 조회하지 않는다 — 자동 계산이 되살아나면 잡는다", async () => {
    h.getEvent.mockResolvedValue({
      event_id: EVENT_ID, status: "live", title: "T", venue: "홀",
      event_date: new Date(Date.now() + 3 * 86400000).toISOString(),
      context_banner: "공지",
    });
    h.getTiersByEvent.mockClear();

    await contextBannerRoute({} as NextRequest, ctx());
    expect(h.getTiersByEvent).not.toHaveBeenCalled();
  });

  it("이벤트 미존재/장애 시 배너 없이 200 (표시 전용 — 화면을 막지 않는다)", async () => {
    h.getEvent.mockRejectedValue(new h.MockV2CommerceError("down", 500));
    const res = await contextBannerRoute({} as NextRequest, ctx());
    expect(res.status).toBe(200);
    expect((await res.json()).data.banner).toBeNull();
  });
});
