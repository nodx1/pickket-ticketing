/**
 * `/api/events/[eventId]` GET·PATCH·DELETE — 레벨2 컷오버 W2-EVT 회귀.
 *
 * ## 🔴 복구된 커버리지 공백 (부채)
 * wave1 의 `event-anchor.ts` 삭제로 사라진 **`admission_mode` / `event_date_end` /
 * `raffle_enabled` 전파 단언**을 PATCH 경로에도 복구한다.
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
  class V2BizVerifError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  const poolQuery = vi.fn(async () => ({ rows: [], rowCount: 0 }));
  return {
    getEvent: vi.fn(),
    updateEvent: vi.fn(),
    listEventHostLinks: vi.fn(),
    putEventHostLinks: vi.fn(),
    listTiers: vi.fn(),
    // W5-SUPPORT: 심사 이력 기록이 go `INSERT INTO event_reviews` → v2 원장으로 이관.
    recordPublicationReview: vi.fn(),
    fetchBizVerification: vi.fn(),
    pushReviewRequestToV2: vi.fn(),
    poolQuery,
    V2CommerceError,
    V2BizVerifError,
  };
});

vi.mock("@/lib/auth/permissions", () => ({
  withRole: (_role: string, handler: (request: Request, ctx: unknown) => Promise<Response>) =>
    (request: Request) =>
      handler(request, {
        session: { accountId: "account-1", id: "user-1", role: "organizer" },
        params: { eventId: "event-1" },
      }),
}));
vi.mock("@/lib/db/pool", () => ({ getPool: () => ({ query: h.poolQuery }) }));
vi.mock("@/lib/v2/business-verification-client", () => ({
  fetchBizVerification: h.fetchBizVerification,
  V2BizVerifError: h.V2BizVerifError,
}));
vi.mock("@/lib/v2/review-request-sync", () => ({ pushReviewRequestToV2: h.pushReviewRequestToV2 }));
vi.mock("@/lib/v2/commerce-client", () => ({
  getEvent: h.getEvent,
  getEventBySlug: vi.fn(),
  updateEvent: h.updateEvent,
  listEventHostLinks: h.listEventHostLinks,
  putEventHostLinks: h.putEventHostLinks,
  listTiers: h.listTiers,
  recordPublicationReview: h.recordPublicationReview,
  goAccountRef: (accountId: string) => ({ go_account_id: accountId }),
  V2CommerceError: h.V2CommerceError,
}));

import { GET, PATCH, DELETE } from "@/app/api/events/[eventId]/route";

const HOST_ID = "11111111-1111-4111-8111-111111111111";

function eventDetail(overrides: Record<string, unknown> = {}) {
  return {
    event_id: "event-1",
    external_ref: "event-1",
    title: "이벤트",
    slug: "e1",
    description: null,
    venue: "홍대 롤링홀",
    category: "concert",
    status: "draft",
    status_v2: "draft",
    event_date: "2026-09-01T10:00:00.000Z",
    event_date_end: "2026-09-03T18:00:00.000Z",
    sale_window: { opens_at: null, closes_at: null },
    sale_channels: ["self"],
    organizer_id: "u1",
    total_seats: 100,
    image_url: null,
    event_type: "concert",
    admission_mode: "single",
    raffle_enabled: false,
    enabled_features: [],
    summary: {
      tier_count: 1,
      product_count: 1,
      seats_total: 0,
      seats_sold: 0,
      order_count: 2,
      attendee_count: 4,
      total_revenue: 10_000,
      refund_amount: 1_000,
    },
    content: {},
    ...overrides,
  };
}

function req(method: string, body?: unknown) {
  return new Request("http://localhost/api/events/event-1", {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }) as unknown as NextRequest;
}
const ctx = { params: Promise.resolve({ eventId: "event-1" }) };

/** updateEvent 로 전달된 patch(두 번째 인자). */
function patchPayload() {
  return h.updateEvent.mock.calls[0]?.[1] as Record<string, unknown>;
}

beforeEach(() => {
  h.getEvent.mockReset().mockResolvedValue(eventDetail());
  h.updateEvent.mockReset().mockResolvedValue({ event_id: "event-1" });
  h.listEventHostLinks.mockReset().mockResolvedValue({
    hosts: [
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
  });
  h.putEventHostLinks.mockReset().mockResolvedValue({ hosts: [] });
  h.listTiers.mockReset().mockResolvedValue({ tiers: [] });
  h.fetchBizVerification.mockReset().mockResolvedValue({ verificationStatus: "approved" });
  h.pushReviewRequestToV2.mockReset().mockResolvedValue(true);
  h.recordPublicationReview.mockReset().mockResolvedValue({ id: "rev-1" });
  h.poolQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
});

describe("GET /api/events/[eventId]", () => {
  it("v2 상세 + 호스트를 go shape 으로 반환한다", async () => {
    const res = await GET(req("GET"), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({
      id: "event-1",
      organizerId: HOST_ID,
      organizerName: "주최자A",
      endsAt: "2026-09-03T18:00:00.000Z",
      eventType: "concert",
      revenue: 9_000,
    });
    // 🔴 테넌트 경계
    expect(h.getEvent).toHaveBeenCalledWith("event-1", { organizerRef: "account-1" });
  });

  it("event_date_end 가 없는 옛 이벤트는 event_date 로 폴백한다", async () => {
    h.getEvent.mockResolvedValue(eventDetail({ event_date_end: null }));
    const body = await (await GET(req("GET"), ctx)).json();
    expect(body.data.endsAt).toBe("2026-09-01T10:00:00.000Z");
  });

  it("타 계정/미존재는 404", async () => {
    h.getEvent.mockRejectedValue(new h.V2CommerceError("nope", 404));
    expect((await GET(req("GET"), ctx)).status).toBe(404);
  });

  it("🔴 v2 장애는 503", async () => {
    h.getEvent.mockRejectedValue(new h.V2CommerceError("boom", 500));
    expect((await GET(req("GET"), ctx)).status).toBe(503);
  });
});

describe("PATCH /api/events/[eventId]", () => {
  // ── 🔴 복구된 회귀: admission_mode / event_date_end / raffle_enabled 전파 ──
  describe("v2 전파 회귀 — admission_mode · event_date_end · raffle_enabled", () => {
    it("admissionMode 를 v2 admission_mode 로 전파한다", async () => {
      await PATCH(req("PATCH", { admissionMode: "allpass" }), ctx);
      expect(patchPayload().admission_mode).toBe("allpass");
    });

    it("raffleEnabled 를 v2 raffle_enabled 로 전파한다(true/false 모두)", async () => {
      await PATCH(req("PATCH", { raffleEnabled: true }), ctx);
      expect(patchPayload().raffle_enabled).toBe(true);

      h.updateEvent.mockClear();
      await PATCH(req("PATCH", { raffleEnabled: false }), ctx);
      expect(patchPayload().raffle_enabled).toBe(false);
    });

    it("🔴 endsAt 은 admissionMode 와 무관하게 event_date_end 로 전파된다", async () => {
      await PATCH(
        req("PATCH", { admissionMode: "single", endsAt: "2026-09-05T18:00:00.000Z" }),
        ctx,
      );
      const p = patchPayload();
      expect(p.admission_mode).toBe("single");
      // 옛 버그: single 이면 null 로 지워 종료 일시가 비가역 소실됐다.
      expect(p.event_date_end).toBe("2026-09-05T18:00:00.000Z");
    });

    it("단일일 이벤트에 daypass/allpass 로 바꾸면 400 — v2 write 없음", async () => {
      h.getEvent.mockResolvedValue(
        eventDetail({
          event_date: "2026-09-01T10:00:00.000Z",
          event_date_end: "2026-09-01T18:00:00.000Z",
        }),
      );
      const res = await PATCH(req("PATCH", { admissionMode: "daypass" }), ctx);
      expect(res.status).toBe(400);
      expect(h.updateEvent).not.toHaveBeenCalled();
    });

    it("미포함 키는 patch 에 실리지 않는다(v2 값 보존)", async () => {
      await PATCH(req("PATCH", { title: "새 제목" }), ctx);
      const p = patchPayload();
      expect(p.title).toBe("새 제목");
      expect("admission_mode" in p).toBe(false);
      expect("event_date_end" in p).toBe(false);
      expect("raffle_enabled" in p).toBe(false);
      // 타임테이블/설문은 전용 라우트 소유 → 절대 실리면 안 된다.
      expect("event_schedules" in p).toBe(false);
      expect("questions" in p).toBe(false);
    });
  });

  it("eventType 변경 시 category 와 event_type 원본을 함께 보낸다", async () => {
    await PATCH(req("PATCH", { eventType: "conference" }), ctx);
    const p = patchPayload();
    expect(p.event_type).toBe("conference");
    expect(p.category).toBeTruthy();
  });

  it("paused 전이는 status 대신 sales_paused=true 를 보낸다", async () => {
    h.getEvent.mockResolvedValue(eventDetail({ status: "live" }));
    await PATCH(req("PATCH", { status: "paused" }), ctx);
    const p = patchPayload();
    expect(p.sales_paused).toBe(true);
    expect("status" in p).toBe(false);
  });

  it("paused→live 재개는 sales_paused=false", async () => {
    h.getEvent.mockResolvedValue(eventDetail({ status: "paused" }));
    await PATCH(req("PATCH", { status: "live" }), ctx);
    expect(patchPayload().sales_paused).toBe(false);
  });

  it("타 계정/미존재는 404 — v2 write 없음", async () => {
    h.getEvent.mockRejectedValue(new h.V2CommerceError("nope", 404));
    const res = await PATCH(req("PATCH", { title: "x1" }), ctx);
    expect(res.status).toBe(404);
    expect(h.updateEvent).not.toHaveBeenCalled();
  });

  it("🔴 v2 read 장애는 503(400 입력오류로 뭉개지 않는다)", async () => {
    h.getEvent.mockRejectedValue(new h.V2CommerceError("boom", 502));
    expect((await PATCH(req("PATCH", { title: "x1" }), ctx)).status).toBe(503);
  });

  it("🔴 v2 write 장애는 503", async () => {
    h.updateEvent.mockRejectedValue(new h.V2CommerceError("boom", 500));
    expect((await PATCH(req("PATCH", { title: "x1" }), ctx)).status).toBe(503);
  });

  it("slug 전역 충돌은 409 로 원인을 명시", async () => {
    h.updateEvent.mockRejectedValue(new h.V2CommerceError("dup", 409));
    const res = await PATCH(req("PATCH", { slug: "taken" }), ctx);
    expect(res.status).toBe(409);
  });

  it("판매중(live) 이벤트의 일시 변경은 403, 같은 값 재전송은 통과", async () => {
    h.getEvent.mockResolvedValue(eventDetail({ status: "live" }));
    expect((await PATCH(req("PATCH", { startsAt: "2027-01-01T00:00:00.000Z" }), ctx)).status).toBe(403);

    h.updateEvent.mockClear();
    const ok = await PATCH(
      req("PATCH", { startsAt: "2026-09-01T10:00:00.000Z", title: "제목만 변경" }),
      ctx,
    );
    expect(ok.status).toBe(200);
  });

  describe("유료판매 게이트(draft→pending_review)", () => {
    it("무료 이벤트는 인증 없이 통과", async () => {
      h.listTiers.mockResolvedValue({ tiers: [{ base_price: 0 }] });
      const res = await PATCH(req("PATCH", { status: "pending_review" }), ctx);
      expect(res.status).toBe(200);
      expect(h.fetchBizVerification).not.toHaveBeenCalled();
      // 심사 요청 webhook 은 소유 accountId 와 함께 발송한다(테넌트 경계).
      expect(h.pushReviewRequestToV2).toHaveBeenCalledWith("event-1", "account-1");
      // W5-SUPPORT: 심사 이력은 v2 원장에 기록(go DB 아님) + organizer_ref 로 경계 재확인.
      expect(h.recordPublicationReview).toHaveBeenCalledWith("event-1", {
        organizer_ref: "account-1",
        action: "submit",
        reviewer_ref: "user-1",
      });
    });

    it("유료 + 미승인은 403", async () => {
      h.listTiers.mockResolvedValue({ tiers: [{ base_price: 10_000 }] });
      h.fetchBizVerification.mockResolvedValue({ verificationStatus: "pending" });
      expect((await PATCH(req("PATCH", { status: "pending_review" }), ctx)).status).toBe(403);
    });

    it("🔴 fail-closed: 티어 조회 실패는 503 (무료로 간주해 통과시키지 않는다)", async () => {
      h.listTiers.mockRejectedValue(new h.V2CommerceError("boom", 500));
      const res = await PATCH(req("PATCH", { status: "pending_review" }), ctx);
      expect(res.status).toBe(503);
      expect(h.updateEvent).not.toHaveBeenCalled();
    });

    it("🔴 fail-closed: 인증상태 조회 실패는 503", async () => {
      h.listTiers.mockResolvedValue({ tiers: [{ base_price: 10_000 }] });
      h.fetchBizVerification.mockRejectedValue(new h.V2BizVerifError("boom", 500));
      expect((await PATCH(req("PATCH", { status: "pending_review" }), ctx)).status).toBe(503);
    });
  });

  it("organizers 교체는 v2 host 링크 PUT 으로 위임한다", async () => {
    await PATCH(
      req("PATCH", { organizers: [{ organizerId: HOST_ID, role: "host", displayOrder: 0 }] }),
      ctx,
    );
    expect(h.putEventHostLinks).toHaveBeenCalledWith("account-1", "event-1", [
      { host_id: HOST_ID, role: "host", display_order: 0 },
    ]);
  });

  it("타 계정 주최자 id(v2 400)는 400 으로 안내", async () => {
    h.putEventHostLinks.mockRejectedValue(new h.V2CommerceError("HOST_NOT_OWNED", 400));
    const res = await PATCH(
      req("PATCH", { organizers: [{ organizerId: HOST_ID, role: "host", displayOrder: 0 }] }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("변경 항목이 없으면 400", async () => {
    expect((await PATCH(req("PATCH", {}), ctx)).status).toBe(400);
  });
});

describe("DELETE /api/events/[eventId] (보관)", () => {
  it("v2 status=cancelled 로 전이한다", async () => {
    const res = await DELETE(req("DELETE"), ctx);
    expect(res.status).toBe(200);
    expect(patchPayload().status).toBeTruthy();
  });

  it("타 계정/미존재는 404", async () => {
    h.getEvent.mockRejectedValue(new h.V2CommerceError("nope", 404));
    expect((await DELETE(req("DELETE"), ctx)).status).toBe(404);
  });

  it("🔴 v2 write 장애는 503 — archived:true 로 거짓 응답하지 않는다", async () => {
    h.updateEvent.mockRejectedValue(new h.V2CommerceError("boom", 500));
    const res = await DELETE(req("DELETE"), ctx);
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ success: false });
  });
});
