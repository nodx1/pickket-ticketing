/**
 * 레벨2 컷오버 W4-EVT — 주최자 스코프 라우트에서 go `events` SELECT 를 제거한 뒤의 회귀.
 *
 * 각 라우트마다 3가지를 고정한다:
 *   ① 정상          — v2 소유 확인 통과 → go 원장 조회 (go events SQL 0)
 *   ② 미소유/미존재  — v2 404 → **404**
 *   ③ v2 장애        — v2 5xx → **503** (🔴 404·200빈목록·400 으로 위장 금지)
 *
 * 왜 ③ 이 중요한가: `event_reviews` / `inbound_emails` 는 account_id 컬럼이 없어 옛
 * `JOIN events ... AND e.account_id=$2` 가 **유일한 테넌트 경계**였다. 그 게이트를 v2 로
 * 옮기면서 "확인 불가"를 "없음"으로 강등하면 주최자에게 데이터가 사라진 것처럼 보이고,
 * 게이트를 통과시켜 버리면 크로스테넌트 누출이 된다.
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
    getEvent: vi.fn(),
    // W5-SUPPORT: 심사 이력 원장이 go `event_reviews` → v2 `event_publication_reviews` 로 이관.
    listPublicationReviews: vi.fn(),
    poolQuery: vi.fn<(...args: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>>(),
    fetchLotteryStats: vi.fn(),
    fetchSalePlan: vi.fn(),
    sendEmail: vi.fn(async () => ({ simulated: true })),
    listInboundEmails: vi.fn(async () => [] as unknown[]),
    getInboundEmail: vi.fn(async () => ({ id: "mail-1", from_email: "a@b.test", subject: "문의" })),
    patchInboundEmail: vi.fn(async () => ({ id: "mail-1" })),
    recordInboundReply: vi.fn(async () => ({ id: "mail-1" })),
    V2MessagingLedgerError: class V2MessagingLedgerError extends Error {
      status?: number;
      constructor(message: string, status?: number) {
        super(message);
        this.name = "V2MessagingLedgerError";
        this.status = status;
      }
    },
    session: { accountId: "acc-1", id: "user-1", role: "organizer" } as Record<string, unknown>,
    params: { eventId: "evt-1", emailId: "mail-1" } as Record<string, string>,
    V2CommerceError,
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
vi.mock("@/lib/v2/commerce-client", () => ({
  getEvent: h.getEvent,
  getEventBySlug: vi.fn(),
  listTiers: vi.fn(),
  listPublicationReviews: h.listPublicationReviews,
  V2CommerceError: h.V2CommerceError,
}));
vi.mock("@/lib/v2/lottery-stats", () => ({ fetchLotteryStats: h.fetchLotteryStats }));
vi.mock("@/lib/v2/phase-client", () => ({ fetchSalePlan: h.fetchSalePlan }));
vi.mock("@/lib/notification/email", () => ({ sendEmail: h.sendEmail }));
// W5-MSG: inbound_emails 원장이 v2 로 이관됐다 — 수신함 read/write 는 go DB 가 아니라 이 클라이언트.
// 🔴 테넌트 경계는 여전히 위쪽 getOwnedEvent 게이트가 담당하므로 아래 ②③ 계약은 그대로 유효하다.
vi.mock("@/lib/v2/messaging-ledger-client", () => ({
  listInboundEmails: h.listInboundEmails,
  getInboundEmail: h.getInboundEmail,
  patchInboundEmail: h.patchInboundEmail,
  recordInboundReply: h.recordInboundReply,
  V2MessagingLedgerError: h.V2MessagingLedgerError,
  ledgerErrorStatus: (err: { status?: number }) => (err.status === 404 ? 404 : 503),
}));

import { GET as reviewsGET } from "@/app/api/events/[eventId]/reviews/route";
import { GET as inboxGET } from "@/app/api/events/[eventId]/inbox/route";
import {
  GET as inboxDetailGET,
  PATCH as inboxDetailPATCH,
  POST as inboxDetailPOST,
} from "@/app/api/events/[eventId]/inbox/[emailId]/route";
import { GET as rehearsalGET } from "@/app/api/events/[eventId]/rehearsal/route";
import { GET as lotteryStatsGET } from "@/app/api/events/[eventId]/lottery-stats/route";

function ownedEvent(over: Record<string, unknown> = {}) {
  return {
    event_id: "evt-1",
    title: "행사",
    slug: "e",
    status: "live",
    enabled_features: ["rehearsal"],
    go_account_id: "acc-1",
    content: {},
    ...over,
  };
}

/** v2 소유 확인 결과를 세팅한다. */
function v2Owned(over: Record<string, unknown> = {}) {
  h.getEvent.mockResolvedValue(ownedEvent(over));
}
/** 미소유/미존재 — v2 organizer_ref 불일치도 404 로 내려온다. */
function v2NotFound() {
  h.getEvent.mockRejectedValue(new h.V2CommerceError("not found", 404));
}
/** v2 일시 장애. */
function v2Down() {
  h.getEvent.mockRejectedValue(new h.V2CommerceError("boom", 503));
}

function req(url = "https://go.pickket.kr/api/x", init?: RequestInit) {
  return new Request(url, init);
}

/**
 * 라우트 핸들러 호출. 모의 withAuth/withRole 이 session·params 를 직접 주입하므로
 * 실제 Next context 인자는 필요 없다 — 시그니처만 좁혀서 부른다.
 */
function invoke(handler: unknown, request: Request): Promise<Response> {
  return (handler as (r: Request) => Promise<Response>)(request);
}

/** pool.query 호출 인자(SQL, params) 접근용. */
function queryCalls(): Array<[string, unknown[]]> {
  return h.poolQuery.mock.calls.map((c) => [String(c[0]), (c[1] ?? []) as unknown[]]);
}

/** go 원장 SQL 에 events 참조가 없어야 한다. */
function assertNoGoEventsSql() {
  for (const [sql] of queryCalls()) {
    expect(/\b(FROM|JOIN|INTO|UPDATE)\s+events\b/i.test(sql)).toBe(false);
  }
}

// 기본 go 쿼리 응답 — 각 테스트가 mockResolvedValueOnce 로 덮어쓴다.
beforeEach(() => {
  h.poolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

afterEach(() => {
  h.getEvent.mockReset();
  h.listPublicationReviews.mockReset();
  h.poolQuery.mockReset();
  h.poolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  h.fetchLotteryStats.mockReset();
  h.fetchSalePlan.mockReset();
  h.sendEmail.mockReset();
  h.session = { accountId: "acc-1", id: "user-1", role: "organizer" };
  h.params = { eventId: "evt-1", emailId: "mail-1" };
});

describe("GET /api/events/[eventId]/reviews — 게시 심사 이력(W5-SUPPORT: v2 원장 이관)", () => {
  it("정상: v2 소유 확인 후 v2 게시 심사 원장을 읽는다(go DB 미접근)", async () => {
    v2Owned();
    h.listPublicationReviews.mockResolvedValue({
      reviews: [
        {
          id: "r1",
          action: "approve",
          reason: null,
          checklist: {},
          reviewer_ref: "admin-1",
          reviewer_name: "심사자",
          created_at: "2026-07-27T00:00:00Z",
        },
      ],
      total: 1,
    });

    const res = await invoke(reviewsGET, req());
    expect(res.status).toBe(200);
    // 🔴 경계: v2 에 organizer_ref 를 넘겨야 크로스테넌트가 막힌다(이중 게이트).
    expect(h.getEvent).toHaveBeenCalledWith("evt-1", { organizerRef: "acc-1" });
    expect(h.listPublicationReviews).toHaveBeenCalledWith("evt-1", "acc-1", { limit: 20 });
    // go 원장은 더 이상 쓰지 않는다.
    expect(h.poolQuery).not.toHaveBeenCalled();
    assertNoGoEventsSql();
  });

  it("미소유 이벤트는 404 이고 심사 원장을 아예 조회하지 않는다(누출 차단)", async () => {
    v2NotFound();
    const res = await invoke(reviewsGET, req());
    expect(res.status).toBe(404);
    expect(h.listPublicationReviews).not.toHaveBeenCalled();
    expect(h.poolQuery).not.toHaveBeenCalled();
  });

  it("v2 장애는 503 — 빈 목록(=심사 이력 없음)으로 위장하지 않는다", async () => {
    v2Down();
    const res = await invoke(reviewsGET, req());
    expect(res.status).toBe(503);
    expect(h.listPublicationReviews).not.toHaveBeenCalled();
    expect(h.poolQuery).not.toHaveBeenCalled();
  });

  it("🔴 소유 확인은 됐는데 심사 원장 조회가 실패하면 503 — 승인/반려 어느 쪽으로도 흘리지 않는다", async () => {
    v2Owned();
    h.listPublicationReviews.mockRejectedValue(new h.V2CommerceError("ledger down", 500));
    const res = await invoke(reviewsGET, req());
    expect(res.status).toBe(503);
    const body = await res.json();
    // 빈 배열(=이력 없음)로 위장하면 "미심사"로 오독돼 공개 판단이 깨진다.
    expect(body.data).toBeUndefined();
  });
});

describe("GET /api/events/[eventId]/inbox — 수신함 목록", () => {
  it("정상: 소유 확인 후 v2 수신함 원장 조회(go DB SQL 0)", async () => {
    v2Owned();
    h.listInboundEmails.mockResolvedValue([{ id: "m1" }] as never);
    const res = await invoke(inboxGET, req("https://go.pickket.kr/api/x?status=new"));
    expect(res.status).toBe(200);
    assertNoGoEventsSql();
    // W5-MSG: 목록 조회에 go DB 를 전혀 쓰지 않는다.
    expect(h.poolQuery).not.toHaveBeenCalled();
    expect(h.listInboundEmails).toHaveBeenCalledWith("acc-1", "evt-1", "new");
  });

  // 🔴 fail-closed: 원장 장애를 빈 배열(=문의 없음)로 흘리면 미답변 문의가 사라진다.
  it("v2 원장 장애는 503 — 빈 목록으로 위장하지 않는다", async () => {
    v2Owned();
    h.listInboundEmails.mockRejectedValue(new h.V2MessagingLedgerError("ledger down"));
    const res = await invoke(inboxGET, req());
    expect(res.status).toBe(503);
  });

  it("미소유는 404", async () => {
    v2NotFound();
    expect((await invoke(inboxGET, req())).status).toBe(404);
  });

  // 🔴 옛 구조에서는 소유 조회가 광범위 catch 안이라 v2 장애가 500 으로 뭉개졌다.
  it("v2 장애는 503 (500 '수신함 조회 실패' 로 뭉개지 않는다)", async () => {
    v2Down();
    const res = await invoke(inboxGET, req());
    expect(res.status).toBe(503);
    expect(h.poolQuery).not.toHaveBeenCalled();
  });
});

describe("/api/events/[eventId]/inbox/[emailId] — 수신 메일 단건", () => {
  it("GET 정상 / 미소유 404 / v2 장애 503", async () => {
    v2Owned();
    h.getInboundEmail.mockResolvedValue({ id: "mail-1", from_email: "a@b.test" } as never);
    expect((await invoke(inboxDetailGET, req())).status).toBe(200);
    assertNoGoEventsSql();

    h.poolQuery.mockClear();
    v2NotFound();
    expect((await invoke(inboxDetailGET, req())).status).toBe(404);
    expect(h.poolQuery).not.toHaveBeenCalled();

    v2Down();
    expect((await invoke(inboxDetailGET, req())).status).toBe(503);
  });

  it("PATCH: v2 장애는 503 — 상태를 못 바꿨는데 400/500 입력오류로 위장하지 않는다", async () => {
    v2Down();
    const res = await invoke(inboxDetailPATCH, req("https://go.pickket.kr/api/x", {
        method: "PATCH",
        body: JSON.stringify({ status: "archived" }),
      }));
    expect(res.status).toBe(503);
    expect(h.poolQuery).not.toHaveBeenCalled();
  });

  // 🔴 실발송 라우트 — 확인 불가 상태에서 메일이 나가면 안 되고, 실패 사유도 정확해야 한다.
  it("POST(답장 실발송): v2 장애면 503 이고 메일을 보내지 않는다", async () => {
    v2Down();
    const res = await invoke(inboxDetailPOST, req("https://go.pickket.kr/api/x", {
        method: "POST",
        body: JSON.stringify({ reply: "안녕하세요, 답변드립니다." }),
      }));
    expect(res.status).toBe(503);
    expect(h.sendEmail).not.toHaveBeenCalled();
    expect(h.poolQuery).not.toHaveBeenCalled();
  });

  it("POST: 미소유 이벤트면 404 이고 메일을 보내지 않는다", async () => {
    v2NotFound();
    const res = await invoke(inboxDetailPOST, req("https://go.pickket.kr/api/x", {
        method: "POST",
        body: JSON.stringify({ reply: "안녕하세요, 답변드립니다." }),
      }));
    expect(res.status).toBe(404);
    expect(h.sendEmail).not.toHaveBeenCalled();
  });
});

describe("GET /api/events/[eventId]/rehearsal — 준비 현황", () => {
  it("정상: status 는 v2 정본, 카운트만 go 집계(events SQL 0)", async () => {
    v2Owned({ status: "draft" });
    h.poolQuery.mockResolvedValue({
      rows: [{ productCount: 2, orderCount: 0, attendeeCount: 0 }],
      rowCount: 1,
    });
    const res = await invoke(rehearsalGET, req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({ status: "draft", productCount: 2 });
    assertNoGoEventsSql();
  });

  // 옛 동작: 미소유면 rows 가 비어 200 + 빈 객체. 이제 게이트에서 끊긴다.
  it("미소유는 404 (옛 '200 빈 객체' 회귀 방지)", async () => {
    v2NotFound();
    const res = await invoke(rehearsalGET, req());
    expect(res.status).toBe(404);
    expect(h.poolQuery).not.toHaveBeenCalled();
  });

  it("v2 장애는 503", async () => {
    v2Down();
    expect((await invoke(rehearsalGET, req())).status).toBe(503);
  });
});

describe("GET /api/events/[eventId]/lottery-stats — 응모 현황", () => {
  it("정상: v2 소유 확인 통과 후 집계를 내려준다", async () => {
    v2Owned();
    h.poolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    h.fetchLotteryStats.mockResolvedValue(null);
    h.fetchSalePlan.mockResolvedValue(null);
    const res = await invoke(lotteryStatsGET, req());
    expect(res.status).toBe(200);
    expect(h.getEvent).toHaveBeenCalledWith("evt-1", { organizerRef: "acc-1" });
    assertNoGoEventsSql();
  });

  it("미소유는 404 이고 v2 집계 조회를 하지 않는다", async () => {
    v2NotFound();
    const res = await invoke(lotteryStatsGET, req());
    expect(res.status).toBe(404);
    expect(h.fetchLotteryStats).not.toHaveBeenCalled();
  });

  it("v2 장애는 503 — '응모 0건' 으로 위장하지 않는다", async () => {
    v2Down();
    const res = await invoke(lotteryStatsGET, req());
    expect(res.status).toBe(503);
    expect(h.fetchLotteryStats).not.toHaveBeenCalled();
  });
});
