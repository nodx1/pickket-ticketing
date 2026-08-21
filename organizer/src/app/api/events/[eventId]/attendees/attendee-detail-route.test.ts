import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

// W4-ORD — 참석자 단건에서 go `attendees` 앵커 read 를 완전히 폐기했다:
//   ① 식별자 = v2 ticket_id. 소유 경계도 v2 응답(event_id + event.go_account_id)으로 강제.
//   ② 표시값(상태·좌석·연락처·상품명·설문응답·티켓번호·주문번호)은 전부 v2 단건 티켓.
//   ③ W5-ATTENDEE: 남아 있던 go-local 원장 2개(event_questions·check_in_logs)도 v2 정본으로
//      이관됐다 → 이 라우트의 **go DB 접근은 0**. 설문 문항은 보관분 포함 조회(응답 라벨 보존).
//   ④ 🔴 fail-closed: v2 장애를 404("참석자 없음")로 위장하지 않고 **503**. DELETE 도 마찬가지 —
//      "조회 실패 → 없음 → 이미 처리됨 → 성공"은 장애를 성공으로 위장한다.
//   ⑤ PATCH: status 차단(409) + 연락처 편집 차단(409, v2 SoT·write 경로 부재).

const TICKET_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const stubSession = { id: "u-1", accountId: "acct-1", role: "organizer" };
vi.mock("@/lib/auth/permissions", () => ({
  withRole:
    (
      _role: string,
      handler: (
        req: NextRequest,
        ctx: { session: typeof stubSession; params: { eventId: string; attendeeId: string } },
      ) => Promise<Response>,
    ) =>
    (req: NextRequest) =>
      handler(req, {
        session: stubSession,
        params: { eventId: "event-1", attendeeId: TICKET_ID },
      }),
}));

// 🔴 go DB 접근이 남아 있으면 즉시 실패 — W5-ATTENDEE 이관 회귀 가드.
const { getPool } = vi.hoisted(() => ({
  getPool: vi.fn(() => {
    throw new Error("go DB 접근이 남아 있다(W5-ATTENDEE 이관 위반)");
  }),
}));
vi.mock("@/lib/db/pool", () => ({ getPool }));

const { getTicket, getTicketByNumber, listEventQuestions, listCheckInLogs, V2CommerceError } = vi.hoisted(() => {
  class V2CommerceError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly body?: string,
    ) {
      super(message);
      this.name = "V2CommerceError";
    }
  }
  return {
    getTicket: vi.fn(), getTicketByNumber: vi.fn(),
    listEventQuestions: vi.fn(), listCheckInLogs: vi.fn(),
    V2CommerceError,
  };
});
vi.mock("@/lib/v2/commerce-client", () => ({
  getTicket, getTicketByNumber, listEventQuestions, listCheckInLogs, V2CommerceError,
}));

import { GET, PATCH, DELETE } from "@/app/api/events/[eventId]/attendees/[attendeeId]/route";

const ctx = {
  params: Promise.resolve({ eventId: "event-1", attendeeId: TICKET_ID }),
};

function req(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

/** 소유 티켓 기본형 — event_id 가 라우트 eventId, go_account_id 가 세션 accountId 와 일치. */
function ownedTicket(overrides: Record<string, unknown> = {}) {
  return {
    ticket_id: TICKET_ID,
    ticket_number: "TKT-0F8FAD5BD9CB",
    status: "active",
    checked_in_at: null,
    seat_id: "seat-9",
    tier_id: "tier-1",
    product_name: "일반권",
    product_external_ref: "prod-1",
    raffle_number: null,
    answers: { "q-1": "채식" },
    issued_at: "2026-07-01T00:00:00Z",
    event_id: "event-1",
    event: { starts_at: null, title: "행사", organizer_id: "org-1", external_ref: null, go_account_id: "acct-1", venue: null },
    order: {
      id: "v2-order-1",
      order_number: "GO-0001",
      external_ref: "go-order-1",
      buyer: { name: "홍길동", email: "hong@example.com", phone: "010-0000-0000" },
    },
    ...overrides,
  };
}

/** v2 부속 원장(설문 문항·체크인 로그) 응답 스텁. go pool 은 쓰지 않는다. */
function stubLedger(
  questions: Array<{ id: string; label: string }> = [],
  logs: Array<Record<string, unknown>> = [],
) {
  listEventQuestions.mockResolvedValue({
    questions: questions.map((q, i) => ({
      id: q.id, label: q.label, question_type: "short_text", is_required: false,
      options: [], sort_order: i, archived: false, created_at: null,
    })),
  });
  listCheckInLogs.mockResolvedValue({ logs });
}

beforeEach(() => {
  vi.clearAllMocks();
  getTicket.mockReset();
  getTicketByNumber.mockReset();
  stubLedger();
});

// ── GET 단건 — v2 live read + go-local 원장 2개 ──────────────────────────────
describe("attendees GET — v2 단건 티켓이 정본(go attendees 앵커 read 0)", () => {
  it("표시값 전부를 v2 티켓에서 읽고 go DB 를 전혀 쓰지 않는다", async () => {
    getTicket.mockResolvedValue(ownedTicket());
    stubLedger([{ id: "q-1", label: "식단" }], [{
      id: "log-1", ticket_id: TICKET_ID, attendee_name: null, ticket_number: null,
      method: "qr", note: null, attended_date: null, list_name: null, created_at: null,
    }]);

    const res = await GET({} as NextRequest, ctx);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).toMatchObject({
      id: TICKET_ID,
      ticketNumber: "TKT-0F8FAD5BD9CB",
      name: "홍길동",
      email: "hong@example.com",
      phone: "010-0000-0000",
      status: "confirmed", // v2 active → go 투영
      seatId: "seat-9",
      productName: "일반권",
      createdAt: "2026-07-01T00:00:00Z",
      orderId: "go-order-1", // external_ref 우선(주문 상세 링크가 go 라우트)
      orderNumber: "GO-0001",
    });
    // 설문응답도 v2 answers 에서(옛 go attendees.answers 폐기).
    expect(json.data.questionAnswers).toEqual([{ id: "q-1", questionLabel: "식단", answer: "채식" }]);

    expect(getPool).not.toHaveBeenCalled();
  });

  it("체크인 로그는 v2 를 ticket_id 스코프로 조회한다", async () => {
    getTicket.mockResolvedValue(ownedTicket());

    await GET({} as NextRequest, ctx);

    expect(listCheckInLogs).toHaveBeenCalledWith(
      "event-1", "acct-1", expect.objectContaining({ ticketId: TICKET_ID }),
    );
  });

  it("🔴 설문 문항은 보관분 포함으로 조회한다(지운 문항의 응답이 화면에서 사라지지 않게)", async () => {
    getTicket.mockResolvedValue(ownedTicket());

    await GET({} as NextRequest, ctx);

    expect(listEventQuestions).toHaveBeenCalledWith(
      "event-1", expect.objectContaining({ accountId: "acct-1", includeArchived: true }),
    );
  });

  it("🔴 부속 원장 조회 실패를 '응답/이력 없음'으로 강등하지 않고 503", async () => {
    getTicket.mockResolvedValue(ownedTicket());
    listCheckInLogs.mockRejectedValue(new V2CommerceError("v2 down", 503));

    const res = await GET({} as NextRequest, ctx);
    expect(res.status).toBe(503);
  });

  it("타 이벤트 티켓이면 404(이벤트 스코프 경계)", async () => {
    getTicket.mockResolvedValue(ownedTicket({ event_id: "event-other" }));
    const res = await GET({} as NextRequest, ctx);
    expect(res.status).toBe(404);
  });

  it("타 계정 소유 티켓이면 404(테넌트 경계)", async () => {
    getTicket.mockResolvedValue(
      ownedTicket({ event: { starts_at: null, title: null, organizer_id: null, external_ref: null, go_account_id: "acct-other", venue: null } }),
    );
    const res = await GET({} as NextRequest, ctx);
    expect(res.status).toBe(404);
  });

  it("go_account_id 를 못 받으면 소유 증명 불가 → 404(닫히는 방향)", async () => {
    getTicket.mockResolvedValue(
      ownedTicket({ event: { starts_at: null, title: null, organizer_id: null, external_ref: null, go_account_id: null, venue: null } }),
    );
    const res = await GET({} as NextRequest, ctx);
    expect(res.status).toBe(404);
  });

  it("v2 404 는 참석자 없음 → 404", async () => {
    getTicket.mockRejectedValue(new V2CommerceError("not found", 404));
    const res = await GET({} as NextRequest, ctx);
    expect(res.status).toBe(404);
  });

  it("🔴 v2 장애(5xx)는 404 가 아니라 503 — '참석자 없음' 위장 금지", async () => {
    getTicket.mockRejectedValue(new V2CommerceError("bad gateway", 502));
    const res = await GET({} as NextRequest, ctx);
    expect(res.status).toBe(503);
  });
});

// ── PATCH — go 직접편집 차단 ─────────────────────────────────────────────────
describe("attendees PATCH — 상태·연락처 go 직접편집 차단", () => {
  it("status 를 보내면 존재·소유 확인 후 409", async () => {
    getTicket.mockResolvedValue(ownedTicket());
    const res = await PATCH(req({ status: "checked_in" }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("체크인");
  });

  it("비소유/미존재면 안내 문구 없이 404 로 종결", async () => {
    getTicket.mockRejectedValue(new V2CommerceError("not found", 404));
    const res = await PATCH(req({ status: "checked_in" }), ctx);
    expect(res.status).toBe(404);
  });

  it("연락처(name/email/phone) 편집도 409 로 차단하고 go UPDATE 를 하지 않는다", async () => {
    getTicket.mockResolvedValue(ownedTicket());
    const res = await PATCH(req({ name: "새이름" }), ctx);
    expect(res.status).toBe(409);
    // go DB 를 아예 열지 않는다(=UPDATE attendees 가 있을 수 없다).
    expect(getPool).not.toHaveBeenCalled();
  });

  it("🔴 v2 장애면 409/404 가 아니라 503", async () => {
    getTicket.mockRejectedValue(new V2CommerceError("timeout", 503));
    const res = await PATCH(req({ status: "cancelled" }), ctx);
    expect(res.status).toBe(503);
  });
});

// ── DELETE — go-only 취소 차단 + 장애 위장 금지 ──────────────────────────────
describe("attendees DELETE — go-only 취소 차단", () => {
  it("존재하는 티켓이어도 409 로 차단하고 go status 를 변경하지 않는다", async () => {
    getTicket.mockResolvedValue(ownedTicket());
    const res = await DELETE({} as NextRequest, ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("주문 항목취소");
    expect(getPool).not.toHaveBeenCalled();
  });

  it("대상이 없으면 404", async () => {
    getTicket.mockRejectedValue(new V2CommerceError("not found", 404));
    const res = await DELETE({} as NextRequest, ctx);
    expect(res.status).toBe(404);
  });

  it("🔴 v2 장애를 '이미 처리됨(200/404)'으로 흡수하지 않고 503 으로 끊는다", async () => {
    getTicket.mockRejectedValue(new V2CommerceError("upstream down", 500));
    const res = await DELETE({} as NextRequest, ctx);
    expect(res.status).toBe(503);
  });
});
