/**
 * `/api/events` 목록·생성 — 레벨2 컷오버 W2-EVT 회귀.
 *
 * ## 🔴 복구된 커버리지 공백 (부채)
 * wave1 에서 `event-anchor.ts` 를 삭제하며 **`admission_mode` / `event_date_end` /
 * `raffle_enabled` 가 v2 로 전파되는지 검증하는 단언이 0** 이 됐다. 이 세 필드는 전부 v2 가
 * 유일 정본이라(입장 규칙·다일 관람창·경품번호 부여) 전파가 끊기면 조용히 기능이 죽는다.
 * 아래 "3필드 전파" 블록이 그 방어선이다 — 지우지 말 것.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
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
    listOrganizerEvents: vi.fn(),
    batchEventHostLinks: vi.fn(),
    createEvent: vi.fn(),
    putEventHostLinks: vi.fn(),
    upsertEventFeePlan: vi.fn(),
    getAccountFeePlan: vi.fn(),
    V2CommerceError,
  };
});

vi.mock("@/lib/auth/permissions", () => ({
  withRole: (_role: string, handler: (request: Request, ctx: unknown) => Promise<Response>) =>
    (request: Request) =>
      handler(request, { session: { accountId: "account-1", role: "organizer" }, params: {} }),
}));
vi.mock("@/lib/fee/calculator", () => ({ getAccountFeePlan: h.getAccountFeePlan }));
vi.mock("@/lib/v2/commerce-client", () => ({
  listOrganizerEvents: h.listOrganizerEvents,
  batchEventHostLinks: h.batchEventHostLinks,
  createEvent: h.createEvent,
  putEventHostLinks: h.putEventHostLinks,
  upsertEventFeePlan: h.upsertEventFeePlan,
  goAccountRef: (accountId: string) => ({ go_account_id: accountId }),
  V2CommerceError: h.V2CommerceError,
}));

import { GET, POST } from "@/app/api/events/route";

function get(query = "") {
  return GET(new Request(`http://localhost/api/events${query}`) as unknown as NextRequest, {
    params: Promise.resolve({}),
  });
}

const HOST_ID = "11111111-1111-4111-8111-111111111111";

function postBody(overrides: Record<string, unknown> = {}) {
  return {
    organizers: [{ organizerId: HOST_ID, role: "host", displayOrder: 0 }],
    title: "테스트 이벤트",
    slug: "test-event",
    startsAt: "2026-09-01T10:00:00.000Z",
    endsAt: "2026-09-03T18:00:00.000Z",
    eventType: "concert",
    ageRating: "all",
    isOnline: false,
    ...overrides,
  };
}

function post(body: Record<string, unknown>) {
  return POST(
    new Request("http://localhost/api/events", {
      method: "POST",
      body: JSON.stringify(body),
    }) as unknown as NextRequest,
    { params: Promise.resolve({}) },
  );
}

/** createEvent 로 전달된 payload(첫 인자). */
function createPayload() {
  return h.createEvent.mock.calls[0]?.[0] as Record<string, unknown>;
}

beforeEach(() => {
  h.listOrganizerEvents.mockReset().mockResolvedValue({
    events: [
      {
        event_id: "event-1",
        external_ref: "event-1",
        title: "이벤트",
        slug: "e1",
        status: "live",
        category: "concert",
        event_date: "2026-09-01T10:00:00.000Z",
        event_date_end: "2026-09-03T18:00:00.000Z",
        sale_window: { opens_at: null, closes_at: null },
        total_seats: 100,
        order_count: 3,
        attendee_count: 5,
        revenue: 10_000,
        refund_amount: 2_000,
      },
    ],
    total: 1,
    limit: 12,
    offset: 0,
  });
  h.batchEventHostLinks.mockReset().mockResolvedValue({
    hosts_by_event: {
      "event-1": [
        {
          link_id: "l1",
          host_id: HOST_ID,
          role: "host",
          display_order: 0,
          name: "주최자A",
          slug: "host-a",
          logo_url: null,
          contact_public: false,
          email: null,
          phone: null,
        },
      ],
    },
  });
  h.createEvent.mockReset().mockResolvedValue({ event_id: "new-event", created: true });
  h.putEventHostLinks.mockReset().mockResolvedValue({ hosts: [] });
  h.upsertEventFeePlan.mockReset().mockResolvedValue({});
  h.getAccountFeePlan.mockReset().mockResolvedValue(null);
});

describe("GET /api/events (목록)", () => {
  it("v2 목록 + 호스트를 병합하고 net 매출을 계산한다", async () => {
    const res = await get("?page=1&limit=12&search=테스트&sort=title&status=live");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0]).toMatchObject({
      id: "event-1",
      organizerId: HOST_ID,
      organizerName: "주최자A",
      revenue: 8_000, // 10000 - 2000
      orderCount: 3,
      attendeeCount: 5,
    });
    // 🔴 테넌트 경계: 목록/호스트 조회 모두 accountId 스코프.
    expect(h.listOrganizerEvents).toHaveBeenCalledWith(
      "account-1",
      expect.objectContaining({ status: "live", search: "테스트", sort: "title", limit: 12, offset: 0 }),
    );
    expect(h.batchEventHostLinks).toHaveBeenCalledWith("account-1", ["event-1"]);
  });

  it("알 수 없는 status/sort 는 v2 로 전달하지 않고 기본값을 쓴다", async () => {
    await get("?status=;DROP&sort=hax");
    expect(h.listOrganizerEvents).toHaveBeenCalledWith(
      "account-1",
      expect.objectContaining({ status: undefined, sort: "latest" }),
    );
  });

  it("🔴 v2 장애는 503 — 빈 목록으로 위장하지 않는다", async () => {
    h.listOrganizerEvents.mockRejectedValue(new h.V2CommerceError("boom", 502));
    const res = await get();
    expect(res.status).toBe(503);
  });

  it("🔴 호스트 배치 조회 장애도 503 (주최자 미지정으로 렌더 금지)", async () => {
    h.batchEventHostLinks.mockRejectedValue(new h.V2CommerceError("boom", 500));
    expect((await get()).status).toBe(503);
  });
});

describe("POST /api/events (생성)", () => {
  it("go DB INSERT 없이 v2 createEvent 로 생성하고 호스트를 연결한다", async () => {
    const res = await post(postBody());
    expect(res.status).toBe(201);
    expect(h.createEvent).toHaveBeenCalledOnce();
    const [, opts] = h.createEvent.mock.calls[0];
    // 멱등키 = go 채번 id → 재시도 시 이벤트 중복 생성 없음.
    expect((opts as { idempotencyKey: string }).idempotencyKey).toMatch(/^event-create:/);
    expect(createPayload().organizer_ref).toEqual({ go_account_id: "account-1" });
    expect(h.putEventHostLinks).toHaveBeenCalledWith(
      "account-1",
      "new-event",
      [{ host_id: HOST_ID, role: "host", display_order: 0 }],
    );
  });

  // ── 🔴 복구된 회귀: admission_mode / event_date_end / raffle_enabled 전파 ──
  describe("v2 전파 회귀 — admission_mode · event_date_end · raffle_enabled", () => {
    it("single + raffle off 기본값을 그대로 전파한다", async () => {
      await post(postBody());
      const p = createPayload();
      expect(p.admission_mode).toBe("single");
      expect(p.raffle_enabled).toBe(false);
      // 🔴 종료 일시는 입장방식과 무관하게 항상 전파(go events.ends_at 소실 방지).
      expect(p.event_date_end).toBe("2026-09-03T18:00:00.000Z");
    });

    it("allpass + raffle on 을 전파하고 다일 관람창(event_date_end)을 함께 보낸다", async () => {
      await post(postBody({ admissionMode: "allpass", raffleEnabled: true }));
      const p = createPayload();
      expect(p.admission_mode).toBe("allpass");
      expect(p.raffle_enabled).toBe(true);
      expect(p.event_date_end).toBe("2026-09-03T18:00:00.000Z");
    });

    it("daypass 를 전파한다", async () => {
      await post(postBody({ admissionMode: "daypass" }));
      expect(createPayload().admission_mode).toBe("daypass");
    });

    it("단일일(같은 날) 이벤트에 daypass/allpass 는 400 — v2 호출 없음", async () => {
      const res = await post(
        postBody({
          admissionMode: "allpass",
          startsAt: "2026-09-01T10:00:00.000Z",
          endsAt: "2026-09-01T18:00:00.000Z",
        }),
      );
      expect(res.status).toBe(400);
      expect(h.createEvent).not.toHaveBeenCalled();
    });

    it("단일일 이벤트도 event_date_end 를 전파한다(종료 일시 비가역 소실 방지)", async () => {
      await post(
        postBody({ startsAt: "2026-09-01T10:00:00.000Z", endsAt: "2026-09-01T18:00:00.000Z" }),
      );
      expect(createPayload().event_date_end).toBe("2026-09-01T18:00:00.000Z");
    });
  });

  it("event_type 원본과 category 를 함께 보낸다(손실 매핑 대비)", async () => {
    await post(postBody({ eventType: "conference" }));
    const p = createPayload();
    expect(p.event_type).toBe("conference");
    expect(p.category).toBeTruthy();
  });

  it("기본 취소정책(옛 go DB DEFAULT)을 전파한다", async () => {
    await post(postBody());
    expect(createPayload().cancellation_fee_tiers).toEqual([
      { days_before: 30, fee_pct: 0 },
      { days_before: 7, fee_pct: 30 },
      { days_before: 3, fee_pct: 50 },
      { days_before: 1, fee_pct: 80 },
      { days_before: 0, fee_pct: 100 },
    ]);
  });

  it("host 역할이 없으면 400 — v2 호출 없음", async () => {
    const res = await post(
      postBody({ organizers: [{ organizerId: HOST_ID, role: "sponsor", displayOrder: 0 }] }),
    );
    expect(res.status).toBe(400);
    expect(h.createEvent).not.toHaveBeenCalled();
  });

  it("slug 전역 충돌(409)은 원인을 명시한 409", async () => {
    h.createEvent.mockRejectedValue(new h.V2CommerceError("slug taken", 409));
    const res = await post(postBody());
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining("슬러그") });
  });

  it("🔴 v2 장애는 503 — 400(입력오류)으로 뭉개지 않는다", async () => {
    h.createEvent.mockRejectedValue(new h.V2CommerceError("boom", 502));
    expect((await post(postBody())).status).toBe(503);
  });

  it("타 계정 주최자 id(400)는 400 으로 안내한다", async () => {
    h.putEventHostLinks.mockRejectedValue(new h.V2CommerceError("HOST_NOT_OWNED", 400));
    const res = await post(postBody());
    expect(res.status).toBe(400);
  });

  it("호스트 연결이 v2 장애로 실패하면 503(이벤트는 생성됨을 안내)", async () => {
    h.putEventHostLinks.mockRejectedValue(new h.V2CommerceError("boom", 500));
    expect((await post(postBody())).status).toBe(503);
  });

  it("fee plan 실패는 생성을 막지 않는다", async () => {
    h.upsertEventFeePlan.mockRejectedValue(new h.V2CommerceError("boom", 500));
    expect((await post(postBody())).status).toBe(201);
  });
});
