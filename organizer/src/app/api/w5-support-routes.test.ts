/**
 * 레벨2 컷오버 W5-SUPPORT — 문의·심사·알림·용량·파이널콜·제휴 라우트 회귀.
 *
 * 각 라우트마다 고정하는 것:
 *   ① 정상          — v2 원장 호출이 **테넌트 경계 인자**(account_id / organizer_ref)와 함께 나간다
 *   ② 미소유/미존재  — v2 404 → **404** (존재 노출 금지)
 *   ③ v2 장애        — v2 5xx → **503** (🔴 빈목록·0건·400·200 으로 위장 금지)
 *
 * 왜 ③ 이 핵심인가:
 *   · 심사 이력은 **이벤트 공개 여부**를 좌우한다. 실패를 빈 목록으로 흘리면 "미심사"로
 *     오독되고, 승인으로 흘리면 미심사 이벤트가 공개된다 → 모름은 503.
 *   · 알림 뱃지 `count:0` 은 "읽을 것 없음"이라는 확정 사실로 읽힌다 → 장애를 0 으로 못 쓴다.
 *   · DELETE 를 "이미 없음 → 200" 으로 흡수하면 지우지 않은 것을 지웠다고 응답하게 된다.
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
  class EventAccessError extends Error {
    constructor(
      message: string,
      readonly reason: "not_found" | "unavailable",
      readonly status: number,
    ) {
      super(message);
      this.name = "EventAccessError";
    }
  }
  return {
    // notifications
    listOrganizerNotifications: vi.fn(),
    getOrganizerUnreadCount: vi.fn(),
    markAllOrganizerNotificationsRead: vi.fn(),
    markOrganizerNotificationRead: vi.fn(),
    deleteOrganizerNotification: vi.fn(),
    // inquiries
    listEventInquiries: vi.fn(),
    patchEventInquiry: vi.fn(),
    // capacity
    listCapacityAssignments: vi.fn(),
    upsertCapacityAssignment: vi.fn(),
    listTiers: vi.fn(),
    // final call
    getFinalCallRule: vi.fn(),
    putFinalCallRule: vi.fn(),
    // affiliates
    createAffiliate: vi.fn(),
    listAffiliates: vi.fn(),
    patchAffiliate: vi.fn(),
    deleteAffiliate: vi.fn(),
    getAffiliateDetail: vi.fn(),
    // access
    resolveOwnedV2EventId: vi.fn(),
    requireFeature: vi.fn(),
    poolQuery: vi.fn<(...args: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>>(),
    session: { accountId: "acc-1", id: "user-1", role: "organizer" } as Record<string, unknown>,
    params: { eventId: "evt-1", notificationId: "notif-1", affiliateId: "aff-1" } as Record<
      string,
      string
    >,
    V2CommerceError,
    EventAccessError,
  };
});

vi.mock("@/lib/auth/withAuth", () => ({
  withAuth:
    (handler: (request: Request, ctx: unknown) => Promise<Response>) => (request: Request) =>
      handler(request, { session: h.session, params: h.params }),
}));
vi.mock("@/lib/auth/permissions", () => ({
  withRole:
    (_role: string, handler: (request: Request, ctx: unknown) => Promise<Response>) =>
      (request: Request) =>
        handler(request, { session: h.session, params: h.params }),
}));
vi.mock("@/lib/db/pool", () => ({ getPool: () => ({ query: h.poolQuery }) }));
vi.mock("@/lib/server/require-feature", () => ({ requireFeature: h.requireFeature }));
vi.mock("@/lib/notification/email", () => ({ sendEmail: vi.fn(async () => ({ simulated: true })) }));
vi.mock("@/lib/v2/event-access", () => ({
  resolveOwnedV2EventId: h.resolveOwnedV2EventId,
  EventAccessError: h.EventAccessError,
}));
vi.mock("@/lib/v2/commerce-client", () => ({
  V2CommerceError: h.V2CommerceError,
  listOrganizerNotifications: h.listOrganizerNotifications,
  getOrganizerUnreadCount: h.getOrganizerUnreadCount,
  markAllOrganizerNotificationsRead: h.markAllOrganizerNotificationsRead,
  markOrganizerNotificationRead: h.markOrganizerNotificationRead,
  deleteOrganizerNotification: h.deleteOrganizerNotification,
  listEventInquiries: h.listEventInquiries,
  patchEventInquiry: h.patchEventInquiry,
  listCapacityAssignments: h.listCapacityAssignments,
  upsertCapacityAssignment: h.upsertCapacityAssignment,
  listTiers: h.listTiers,
  getFinalCallRule: h.getFinalCallRule,
  putFinalCallRule: h.putFinalCallRule,
  createAffiliate: h.createAffiliate,
  listAffiliates: h.listAffiliates,
  patchAffiliate: h.patchAffiliate,
  deleteAffiliate: h.deleteAffiliate,
  getAffiliateDetail: h.getAffiliateDetail,
}));

import { GET as notifGET, PATCH as notifPATCH } from "@/app/api/notifications/route";
import { GET as unreadGET } from "@/app/api/notifications/unread-count/route";
import {
  DELETE as notifDELETE,
  PATCH as notifReadPATCH,
} from "@/app/api/notifications/[notificationId]/route";
import {
  GET as inquiriesGET,
  PATCH as inquiriesPATCH,
} from "@/app/api/events/[eventId]/inquiries/route";
import { GET as capacityGET, POST as capacityPOST } from "@/app/api/events/[eventId]/capacity/route";
import { GET as finalCallGET, PUT as finalCallPUT } from "@/app/api/events/[eventId]/final-call/route";
import { POST as affiliatePOST } from "@/app/api/events/[eventId]/affiliates/route";
import { DELETE as affiliateDELETE } from "@/app/api/events/[eventId]/affiliates/[affiliateId]/route";

type Handler = (request: Request) => Promise<Response>;

function req(method = "GET", body?: unknown, url = "http://localhost/x") {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

// Next 라우트 params 는 Promise 로도 접근되므로 양쪽을 만족시킨다(final-call 은 await params).
function withPromiseParams<T extends object>(p: T): T {
  return Object.assign(Promise.resolve(p), p) as unknown as T;
}

const down = () => new h.V2CommerceError("v2 down", 503);
const missing = () => new h.V2CommerceError("not found", 404);

beforeEach(() => {
  h.session = { accountId: "acc-1", id: "user-1", role: "organizer" };
  h.params = withPromiseParams({
    eventId: "evt-1",
    notificationId: "notif-1",
    affiliateId: "aff-1",
  });
  h.requireFeature.mockResolvedValue(null);
  h.resolveOwnedV2EventId.mockResolvedValue("evt-1");
  h.poolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── 알림 ──────────────────────────────────────────────────────────────────

describe("W5-SUPPORT 알림 — go notifications → v2 organizer_notifications", () => {
  it("정상: 목록은 account_id 경계와 함께 v2 를 호출한다", async () => {
    h.listOrganizerNotifications.mockResolvedValue({
      items: [
        {
          id: "n1",
          account_id: "acc-1",
          event_id: "evt-1",
          type: "new_order",
          title: "새 주문",
          message: "주문 1건",
          is_read: false,
          metadata: {},
          created_at: "2026-07-27T00:00:00Z",
        },
      ],
      total: 1,
      page: 1,
      limit: 20,
    });
    const res = await (notifGET as unknown as Handler)(req("GET"));
    expect(res.status).toBe(200);
    // 🔴 테넌트 경계 — session.accountId 가 반드시 전달돼야 한다.
    expect(h.listOrganizerNotifications).toHaveBeenCalledWith("acc-1", {
      page: 1,
      limit: 20,
      unreadOnly: false,
    });
    const body = await res.json();
    expect(body.data[0]).toMatchObject({ id: "n1", isRead: false, accountId: "acc-1" });
  });

  it("🔴 v2 장애는 503 — 빈 목록으로 위장하지 않는다", async () => {
    h.listOrganizerNotifications.mockRejectedValue(down());
    const res = await (notifGET as unknown as Handler)(req("GET"));
    expect(res.status).toBe(503);
  });

  it("🔴 미읽음 수 조회 실패는 503 — count:0 으로 흘리면 뱃지가 조용히 사라진다", async () => {
    h.getOrganizerUnreadCount.mockRejectedValue(down());
    const res = await (unreadGET as unknown as Handler)(req("GET"));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.data?.count).toBeUndefined();
  });

  it("정상: 미읽음 수는 v2 값을 그대로 돌려준다", async () => {
    h.getOrganizerUnreadCount.mockResolvedValue({ count: 7 });
    const res = await (unreadGET as unknown as Handler)(req("GET"));
    expect(res.status).toBe(200);
    expect((await res.json()).data.count).toBe(7);
    expect(h.getOrganizerUnreadCount).toHaveBeenCalledWith("acc-1");
  });

  it("🔴 전체 읽음 실패는 200 이 아니라 503 (원장은 그대로인데 UI 만 비우면 안 된다)", async () => {
    h.markAllOrganizerNotificationsRead.mockRejectedValue(down());
    const res = await (notifPATCH as unknown as Handler)(req("PATCH"));
    expect(res.status).toBe(503);
  });

  it("단건 읽음: 미존재/타 계정은 404", async () => {
    h.markOrganizerNotificationRead.mockRejectedValue(missing());
    const res = await (notifReadPATCH as unknown as Handler)(req("PATCH"));
    expect(res.status).toBe(404);
    expect(h.markOrganizerNotificationRead).toHaveBeenCalledWith("notif-1", "acc-1");
  });

  it("🔴 DELETE 멱등 흡수 금지: v2 장애는 200 deleted 가 아니라 503", async () => {
    h.deleteOrganizerNotification.mockRejectedValue(down());
    const res = await (notifDELETE as unknown as Handler)(req("DELETE"));
    expect(res.status).toBe(503);
  });

  it("DELETE: 미존재/타 계정만 404", async () => {
    h.deleteOrganizerNotification.mockRejectedValue(missing());
    const res = await (notifDELETE as unknown as Handler)(req("DELETE"));
    expect(res.status).toBe(404);
  });
});

// ── 문의함 ────────────────────────────────────────────────────────────────

describe("W5-SUPPORT 문의함 — go event_inquiries → v2 event_inquiries", () => {
  it("정상: organizer_ref 경계와 함께 조회하고 연락처를 마스킹한다", async () => {
    h.listEventInquiries.mockResolvedValue({
      inquiries: [
        {
          id: "i1",
          contact: "person@example.test",
          question: "언제 시작하나요",
          answer: null,
          status: "open",
          source: "web",
          category: null,
          urgency: null,
          created_at: "2026-07-27T00:00:00Z",
          updated_at: null,
        },
      ],
      total: 1,
    });
    const res = await (inquiriesGET as unknown as Handler)(req("GET"));
    expect(res.status).toBe(200);
    expect(h.listEventInquiries).toHaveBeenCalledWith("evt-1", "acc-1", { status: undefined });
    const body = await res.json();
    // PII 는 목록에서 마스킹된 채로 나간다.
    expect(body.data[0].contact).not.toBe("person@example.test");
  });

  it("미소유 이벤트는 404", async () => {
    h.listEventInquiries.mockRejectedValue(missing());
    const res = await (inquiriesGET as unknown as Handler)(req("GET"));
    expect(res.status).toBe(404);
  });

  it("🔴 v2 장애는 503 — 빈 배열('문의 없음')로 위장하지 않는다", async () => {
    h.listEventInquiries.mockRejectedValue(down());
    const res = await (inquiriesGET as unknown as Handler)(req("GET"));
    expect(res.status).toBe(503);
  });

  it("🔴 회신 저장 실패는 500/400 이 아니라 503 (재시도 가능 신호)", async () => {
    h.patchEventInquiry.mockRejectedValue(down());
    const res = await (inquiriesPATCH as unknown as Handler)(
      req("PATCH", { id: "11111111-1111-4111-8111-111111111111", answer: "곧 시작합니다" }),
    );
    expect(res.status).toBe(503);
  });

  it("회신 대상 문의가 없으면 404", async () => {
    h.patchEventInquiry.mockRejectedValue(missing());
    const res = await (inquiriesPATCH as unknown as Handler)(
      req("PATCH", { id: "11111111-1111-4111-8111-111111111111", status: "archived" }),
    );
    expect(res.status).toBe(404);
  });
});

// ── 용량 배정 ─────────────────────────────────────────────────────────────

describe("W5-SUPPORT 용량 배정 — go capacity_assignments → v2", () => {
  it("정상: organizer_ref 경계와 함께 조회하고 camelCase 계약을 유지한다", async () => {
    h.listCapacityAssignments.mockResolvedValue({
      assignments: [
        {
          id: "c1",
          product_ref: "prod-1",
          product_name: "일반석",
          capacity: 100,
          used_capacity: 10,
          status: "active",
        },
      ],
      total: 1,
    });
    const res = await (capacityGET as unknown as Handler)(req("GET"));
    expect(res.status).toBe(200);
    expect(h.listCapacityAssignments).toHaveBeenCalledWith("evt-1", "acc-1");
    expect((await res.json()).data[0]).toMatchObject({
      productId: "prod-1",
      usedCapacity: 10,
      productName: "일반석",
    });
  });

  it("🔴 v2 장애는 503 — 빈 배열이면 주최자가 용량을 다시 배정해 덮어쓴다", async () => {
    h.listCapacityAssignments.mockRejectedValue(down());
    const res = await (capacityGET as unknown as Handler)(req("GET"));
    expect(res.status).toBe(503);
  });

  it("정상 저장: sold_count 를 used_capacity 시드로 넣어 upsert 한다", async () => {
    h.listTiers.mockResolvedValue({
      tiers: [{ external_ref: "11111111-1111-4111-8111-111111111111", sold_count: 12 }],
    });
    h.upsertCapacityAssignment.mockResolvedValue({ id: "c1" });
    const res = await (capacityPOST as unknown as Handler)(
      req("POST", { productId: "11111111-1111-4111-8111-111111111111", capacity: 50 }),
    );
    expect(res.status).toBe(200);
    expect(h.upsertCapacityAssignment).toHaveBeenCalledWith("evt-1", {
      organizer_ref: "acc-1",
      product_ref: "11111111-1111-4111-8111-111111111111",
      capacity: 50,
      used_capacity: 12,
    });
  });

  it("🔴 저장 실패는 500 이 아니라 503 (저장되지 않았음을 재시도 가능 신호로)", async () => {
    h.listTiers.mockResolvedValue({ tiers: [] });
    h.upsertCapacityAssignment.mockRejectedValue(down());
    const res = await (capacityPOST as unknown as Handler)(
      req("POST", { productId: "11111111-1111-4111-8111-111111111111", capacity: 50 }),
    );
    expect(res.status).toBe(503);
  });
});

// ── 파이널콜 ──────────────────────────────────────────────────────────────

describe("W5-SUPPORT 파이널콜 규칙 — go final_call_rules → v2 final_call_rules(신설)", () => {
  it("정상: 미설정 이벤트는 기본값을 돌려준다(설정 없음은 확정 사실)", async () => {
    h.getFinalCallRule.mockResolvedValue({
      rule: {
        is_active: false,
        trigger_hours_before: 24,
        discount_percent: 30,
        min_remaining_percent: 20,
        max_discount_tickets: null,
        notify_buyers: true,
      },
      configured: false,
    });
    const res = await (finalCallGET as unknown as Handler)(req("GET"));
    expect(res.status).toBe(200);
    expect(h.getFinalCallRule).toHaveBeenCalledWith("evt-1", "acc-1");
    expect((await res.json()).data).toMatchObject({ isActive: false, discountPercent: 30 });
  });

  it("🔴 조회 실패는 기본값 200 이 아니라 503 (장애를 '설정 없음'으로 위장 금지)", async () => {
    h.getFinalCallRule.mockRejectedValue(down());
    const res = await (finalCallGET as unknown as Handler)(req("GET"));
    expect(res.status).toBe(503);
  });

  it("🔴 저장 실패는 200 이 아니라 503 (규칙이 켜진 줄 알면 안 된다)", async () => {
    h.putFinalCallRule.mockRejectedValue(down());
    const res = await (finalCallPUT as unknown as Handler)(
      req("PUT", { isActive: true, discountPercent: 40 }),
    );
    expect(res.status).toBe(503);
  });

  it("정상 저장: organizer_ref 와 전체 설정을 upsert 한다", async () => {
    h.putFinalCallRule.mockResolvedValue({
      rule: {
        is_active: true,
        trigger_hours_before: 24,
        discount_percent: 40,
        min_remaining_percent: 20,
        max_discount_tickets: null,
        notify_buyers: true,
      },
      configured: true,
    });
    const res = await (finalCallPUT as unknown as Handler)(
      req("PUT", { isActive: true, discountPercent: 40 }),
    );
    expect(res.status).toBe(200);
    expect(h.putFinalCallRule).toHaveBeenCalledWith("evt-1", {
      organizer_ref: "acc-1",
      is_active: true,
      trigger_hours_before: 24,
      discount_percent: 40,
      min_remaining_percent: 20,
      max_discount_tickets: null,
      notify_buyers: true,
    });
  });
});

// ── 제휴 ──────────────────────────────────────────────────────────────────

describe("W5-SUPPORT 제휴 — go affiliates 앵커 write 제거", () => {
  it("정상 생성: go 미러 없이 v2 원자 생성 1회만 호출한다", async () => {
    h.createAffiliate.mockResolvedValue({ affiliate_id: "v2-aff-1", external_ref: "x" });
    const res = await (affiliatePOST as unknown as Handler)(
      req("POST", { name: "파트너A", code: "PARTNER_A", commissionRate: 10 }),
    );
    expect(res.status).toBe(201);
    expect(h.createAffiliate).toHaveBeenCalledTimes(1);
    expect(h.poolQuery).not.toHaveBeenCalled();
    const [, payload] = h.createAffiliate.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload).toMatchObject({
      organizer_ref: "acc-1",
      name: "파트너A",
      code: "PARTNER_A",
      commission_rate: 10,
    });
  });

  it("🔴 중복 코드는 409 — v2 유니크 제약이 경합을 원자적으로 끊는다(사전검사 TOCTOU 제거)", async () => {
    h.createAffiliate.mockRejectedValue(new h.V2CommerceError("conflict", 409));
    const res = await (affiliatePOST as unknown as Handler)(
      req("POST", { name: "파트너A", code: "PARTNER_A", commissionRate: 10 }),
    );
    expect(res.status).toBe(409);
  });

  it("🔴 생성 실패는 400(입력오류)이 아니라 502 — 주최자가 무한 재입력하면 안 된다", async () => {
    h.createAffiliate.mockRejectedValue(down());
    const res = await (affiliatePOST as unknown as Handler)(
      req("POST", { name: "파트너A", code: "PARTNER_A", commissionRate: 10 }),
    );
    expect(res.status).toBe(502);
  });

  it("🔴 DELETE 장애는 200 deleted 가 아니라 502 (지우지 않은 걸 지웠다고 하면 안 된다)", async () => {
    h.deleteAffiliate.mockRejectedValue(down());
    const res = await (affiliateDELETE as unknown as Handler)(req("DELETE"));
    expect(res.status).toBe(502);
    expect(h.poolQuery).not.toHaveBeenCalled();
  });

  it("DELETE: 미존재/미소유는 404", async () => {
    h.deleteAffiliate.mockRejectedValue(missing());
    const res = await (affiliateDELETE as unknown as Handler)(req("DELETE"));
    expect(res.status).toBe(404);
  });

  it("DELETE 정상: v2 soft-delete 만 수행하고 go 미러는 건드리지 않는다", async () => {
    h.deleteAffiliate.mockResolvedValue({ deleted: true });
    const res = await (affiliateDELETE as unknown as Handler)(req("DELETE"));
    expect(res.status).toBe(200);
    expect(h.deleteAffiliate).toHaveBeenCalledWith("evt-1", "aff-1");
    expect(h.poolQuery).not.toHaveBeenCalled();
  });
});
