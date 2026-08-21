import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

// §13 현장 운영 척추 — 캡처방지(PKT-only 스캔·수기입력 별도경로)·undo/취소·당일 재입장 outcome.

// withRole 을 스텁 — 핸들러를 fake session/params 로 즉시 호출(권한체크 우회).
const stubSession = { id: "staff-1", accountId: "acct-1", role: "staff" };
vi.mock("@/lib/auth/permissions", () => ({
  withRole: (_role: string, handler: (req: NextRequest, ctx: { session: typeof stubSession; params: { eventId: string } }) => Promise<Response>) =>
    (req: NextRequest) => handler(req, { session: stubSession, params: { eventId: "event-1" } }),
}));

const {
  getPool, checkInTicket, revokeAdmission, getTicket, getTicketByNumber, verifyDynamicQRPayload,
  dynamicQRSignatureValid,
  dispatchWebhook, markInvitationCheckedIn, logAudit, V2CommerceError,
  getCheckInList, recordCheckInLog, deleteCheckInLogs,
} = vi.hoisted(() => {
  class V2CommerceError extends Error {
    status: number;
    constructor(message: string, status: number) { super(message); this.status = status; }
  }
  return {
    getPool: vi.fn(),
    checkInTicket: vi.fn(),
    revokeAdmission: vi.fn(),
    getTicket: vi.fn(),
    getTicketByNumber: vi.fn(),
    verifyDynamicQRPayload: vi.fn(),
    // 🔴 서명 전용 검증(2026-08-10) — 「위조」와 「만료」를 가른다.
    //    기본은 false: 이 목에서 서명이 맞다고 주장하지 않는다.
    dynamicQRSignatureValid: vi.fn(() => false),
    dispatchWebhook: vi.fn(),
    markInvitationCheckedIn: vi.fn(),
    logAudit: vi.fn(),
    // W5-ATTENDEE: 체크인 명단/로그가 v2 정본으로 이관됐다.
    getCheckInList: vi.fn(),
    recordCheckInLog: vi.fn(),
    deleteCheckInLogs: vi.fn(),
    V2CommerceError,
  };
});

vi.mock("@/lib/db/pool", () => ({ getPool }));
vi.mock("@/lib/v2/commerce-client", () => ({
  checkInTicket, revokeAdmission, getTicket, getTicketByNumber, V2CommerceError,
  getCheckInList, recordCheckInLog, deleteCheckInLogs,
}));
vi.mock("@/lib/ticket/dynamic-qr", () => ({
  verifyDynamicQRPayload,
  dynamicQRSignatureValid,
  clampToleranceWindows: (v: number | null | undefined) => (typeof v === "number" ? v : 1),
  MAX_TOLERANCE_WINDOWS: 20,
}));
vi.mock("@/lib/webhook/dispatcher", () => ({ dispatchWebhook }));
vi.mock("@/lib/server/invitations", () => ({ markInvitationCheckedIn }));
vi.mock("@/lib/audit", () => ({ logAudit }));

import { POST, DELETE } from "@/app/api/events/[eventId]/check-in/route";

// 실제 export 는 withAuth 시그니처(req, { params: Promise })를 갖지만, 이 테스트는 withRole 을
// 스텁해 params 를 무시한다. tsc 만족용 2번째 인자.
const ctx = { params: Promise.resolve({ eventId: "event-1" }) };

interface MockClient {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

// W4-ORD → W5-ATTENDEE: 티켓 조회는 v2 단건 티켓, 체크인 명단/로그도 v2 정본이다.
// **go pool 에 남은 SQL 은 발송 세그먼트 캐시(attendees) UPDATE 하나뿐**이다.
function makeQuery() {
  return vi.fn(async (sql: string, params?: unknown[]) => {
    void params;
    if (sql.includes("UPDATE attendees")) return { rows: [], rowCount: 1 };
    return { rows: [] };
  });
}

function makeClient(): MockClient {
  return { query: makeQuery(), release: vi.fn() };
}

/**
 * getPool() + v2 체크인 명단 응답 세팅.
 * `rows.list` 가 비면 v2 가 404(명단 없음)를 던지도록 한다(go 의 0행 SELECT 와 동치).
 */
function mockPool(rows: Record<string, unknown[]>) {
  const query = makeQuery();
  const client = makeClient();
  getPool.mockReturnValue({ query, connect: async () => client });
  const list = (rows.list ?? [])[0] as { id: string; status: string; productIds: string[] } | undefined;
  if (list) {
    getCheckInList.mockResolvedValue({
      list: { id: list.id, name: "게이트", status: list.status, product_ids: list.productIds, opens_at: null, closes_at: null, created_at: null },
    });
  } else {
    getCheckInList.mockRejectedValue(new V2CommerceError("list not found", 404));
  }
  return { query, client };
}

const TICKET_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

/** v2 소유 티켓(event_id=event-1, go_account_id=acct-1) — 라우트의 소유 경계를 통과한다. */
function v2Ticket(overrides: Record<string, unknown> = {}) {
  return {
    ticket_id: TICKET_ID,
    ticket_number: "TCKT-1",
    status: "active",
    checked_in_at: null,
    seat_id: null,
    tier_id: null,
    product_name: "일반권",
    product_external_ref: null,
    raffle_number: null,
    answers: null,
    issued_at: null,
    event_id: "event-1",
    event: { starts_at: null, title: null, organizer_id: null, external_ref: null, go_account_id: "acct-1", venue: null },
    order: { id: "v2-order-1", order_number: "GO-1", external_ref: "go-order-1", buyer: { name: "홍길동", email: null, phone: null } },
    ...overrides,
  };
}

function req(body: unknown): NextRequest {
  return new Request("http://localhost/api/events/event-1/check-in", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

const activeList = [{ id: "list-1", status: "active", productIds: [] }];

beforeEach(() => {
  vi.clearAllMocks();
  getTicket.mockResolvedValue(v2Ticket());
  getTicketByNumber.mockResolvedValue(v2Ticket());
  dispatchWebhook.mockResolvedValue(undefined);
  markInvitationCheckedIn.mockResolvedValue(undefined);
  logAudit.mockResolvedValue(undefined);
  recordCheckInLog.mockResolvedValue({ created: true, id: "log-1" });
  deleteCheckInLogs.mockResolvedValue({ deleted: 1 });
});

describe("① 캡처방지 — 스캔 경로는 PKT 만 수락", () => {
  it("비-PKT 스캔은 거부(회전 QR 재제시 안내), v2 호출 없음", async () => {
    mockPool({ list: activeList });
    const res = await POST(req({ mode: "scan", scanPayload: "TCKT-1", checkInListId: "11111111-1111-4111-8111-111111111111" }), ctx);
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error).toContain("회전 QR");
    expect(checkInTicket).not.toHaveBeenCalled();
    expect(verifyDynamicQRPayload).not.toHaveBeenCalled();
  });

  it("PKT 스캔은 검증 통과분만 티켓번호로 사용", async () => {
    verifyDynamicQRPayload.mockReturnValue({ valid: true, ticketId: "TCKT-1" });
    checkInTicket.mockResolvedValue({ checked_in_at: "2026-08-20T00:00:00Z", status: "used", already: false, outcome: "admitted", admission_mode: "single", attended_date: "2026-08-20" });
    mockPool({ list: activeList });
    const res = await POST(req({ mode: "scan", scanPayload: "PKT:TCKT-1:123:abc", checkInListId: "11111111-1111-4111-8111-111111111111" }), ctx);
    const json = await res.json();
    expect(res.status).toBe(200);
    // §13 킬스위치: 2번째 인자로 tolerance 창(기본 1)을 전달.
    expect(verifyDynamicQRPayload).toHaveBeenCalledWith("PKT:TCKT-1:123:abc", 1);
    expect(json.data.outcome).toBe("admitted");
  });

  it("만료 PKT 는 거부", async () => {
    verifyDynamicQRPayload.mockReturnValue({ valid: false, ticketId: null });
    mockPool({ list: activeList });
    const res = await POST(req({ mode: "scan", scanPayload: "PKT:x:1:bad", checkInListId: "11111111-1111-4111-8111-111111111111" }), ctx);
    expect(res.status).toBe(400);
    expect(checkInTicket).not.toHaveBeenCalled();
  });

  it("킬스위치: qrToleranceWindows 를 tolerance 로 전달", async () => {
    verifyDynamicQRPayload.mockReturnValue({ valid: true, ticketId: "TCKT-1" });
    checkInTicket.mockResolvedValue({ checked_in_at: "2026-08-20T00:00:00Z", status: "used", already: false, outcome: "admitted", admission_mode: "single", attended_date: "2026-08-20" });
    mockPool({ list: activeList });
    await POST(req({ mode: "scan", scanPayload: "PKT:TCKT-1:1:a", qrToleranceWindows: 10, checkInListId: "11111111-1111-4111-8111-111111111111" }), ctx);
    expect(verifyDynamicQRPayload).toHaveBeenCalledWith("PKT:TCKT-1:1:a", 10);
  });
});

describe("① 수기입력 — 별도 스태프 액션(사유 필수·감사)", () => {
  it("사유 없는 manual 은 검증 거부(400), PKT 검증 안 함", async () => {
    mockPool({ list: activeList });
    // 2026-07-28: 예전엔 zod refine 이 그대로 throw 해 **500** 이 나갔다(제목의 400 은 의도였을 뿐).
    // 게이트에서 500 은 "서버가 죽었다"로 읽힌다 — 이제 400 + 사유로 내려간다.
    const res = await POST(req({ mode: "manual", ticketNumber: "TCKT-1", checkInListId: "11111111-1111-4111-8111-111111111111" }), ctx);
    expect(res.status).toBe(400);
    expect(verifyDynamicQRPayload).not.toHaveBeenCalled();
  });

  it("사유 있는 manual 은 티켓번호로 체크인 + 감사로그", async () => {
    checkInTicket.mockResolvedValue({ checked_in_at: "2026-08-20T00:00:00Z", status: "used", already: false, outcome: "admitted", admission_mode: "single", attended_date: "2026-08-20" });
    mockPool({ list: activeList });
    const res = await POST(req({ mode: "manual", ticketNumber: "TCKT-1", manualReason: "QR 미인식", checkInListId: "11111111-1111-4111-8111-111111111111" }), ctx);
    expect(res.status).toBe(200);
    expect(verifyDynamicQRPayload).not.toHaveBeenCalled();
    expect(checkInTicket).toHaveBeenCalledWith(TICKET_ID, expect.anything());
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "check_in" }));
  });
});

describe("§13 오프라인 동기화 origin=offline_sync", () => {
  it("offline_sync 는 method='offline' 로그 + 감사 mode='offline'(QR 미검증 명시)", async () => {
    checkInTicket.mockResolvedValue({ checked_in_at: "2026-08-20T00:00:00Z", status: "used", already: false, outcome: "admitted", admission_mode: "single", attended_date: "2026-08-20" });
    mockPool({ list: activeList });
    const res = await POST(req({
      mode: "manual",
      origin: "offline_sync",
      ticketNumber: "TCKT-1",
      manualReason: "오프라인 육안 대조 (홍길동)",
      offlineCheckedInAt: "2026-08-20T00:00:00.000Z",
      checkInListId: "11111111-1111-4111-8111-111111111111",
    }), ctx);
    expect(res.status).toBe(200);
    // v2 체크인 로그에 method='offline' 로 기록됐는지.
    expect(recordCheckInLog).toHaveBeenCalledWith(
      "event-1", "acct-1", expect.objectContaining({ method: "offline" }),
    );
    // 감사 mode='offline'·qrVerified:false.
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      changes: expect.objectContaining({ mode: "offline", qrVerified: false }),
    }));
    expect(verifyDynamicQRPayload).not.toHaveBeenCalled();
  });

  /**
   * 🔴 2026-07-28 적대 감사 F9 회귀.
   * 종전엔 v2 에 항상 `new Date()`(=동기화 시각)를 보내고 `offlineCheckedInAt` 은
   * go 로그·감사에만 남겼다. v2 는 이 시각으로 **입장일(KST)** 과 daypass 확정일을 정한다.
   * ⟹ 목 23:50 오프라인 입장을 금 00:10 에 동기화하면 입장일이 **금요일**이 되어
   *    주중권(목·금 중 하루)이 금요일 하루를 새로 얻는다 — 다일 대회에서 재고가 샌다.
   */
  it("offline_sync 는 현장 실입장 시각을 v2 로 보낸다 (자정 넘김 방지)", async () => {
    checkInTicket.mockResolvedValue({ checked_in_at: "2026-08-20T14:50:00Z", status: "used", already: false, outcome: "admitted", admission_mode: "daypass", attended_date: "2026-08-20" });
    mockPool({ list: activeList });
    // 실입장 = 8/20(목) 23:50 KST. 동기화는 그 뒤(=현재 시각).
    const realAdmission = "2026-08-20T14:50:00.000Z";
    await POST(req({
      mode: "manual",
      origin: "offline_sync",
      ticketNumber: "TCKT-1",
      manualReason: "오프라인 육안 대조",
      offlineCheckedInAt: realAdmission,
      checkInListId: "11111111-1111-4111-8111-111111111111",
    }), ctx);
    expect(checkInTicket).toHaveBeenCalledWith(TICKET_ID, { at: realAdmission });
  });

  it("온라인 경로는 서버 시각을 쓴다 — 클라이언트 시각을 신뢰하지 않는다", async () => {
    checkInTicket.mockResolvedValue({ checked_in_at: "2026-08-20T00:00:00Z", status: "used", already: false, outcome: "admitted", admission_mode: "daypass", attended_date: "2026-08-20" });
    mockPool({ list: activeList });
    // origin 미지정(=live) 인데 offlineCheckedInAt 을 실어 보내도 채택하지 않는다.
    await POST(req({
      mode: "manual",
      ticketNumber: "TCKT-1",
      manualReason: "정상 수기",
      offlineCheckedInAt: "2020-01-01T00:00:00.000Z",
      checkInListId: "11111111-1111-4111-8111-111111111111",
    }), ctx);
    const at = checkInTicket.mock.calls[0]?.[1]?.at as string;
    expect(at).not.toBe("2020-01-01T00:00:00.000Z");
    expect(Number.isNaN(Date.parse(at))).toBe(false);
  });

  it("offline_sync 를 scan 모드로 보내면 검증 거부(오프라인은 manual 경로만)", async () => {
    mockPool({ list: activeList });
    const res = await POST(req({ mode: "scan", origin: "offline_sync", scanPayload: "PKT:x:1:a", checkInListId: "11111111-1111-4111-8111-111111111111" }), ctx);
    expect(res.status).toBe(400);
  });
});

describe("③ 당일 재입장 outcome (reentry_ok 초록 · 차단 빨강)", () => {
  it("allpass 당일 재스캔 → already + outcome=reentry_ok (차단 아님)", async () => {
    verifyDynamicQRPayload.mockReturnValue({ valid: true, ticketId: "TCKT-1" });
    checkInTicket.mockResolvedValue({ checked_in_at: "2026-08-20T00:00:00Z", status: "active", already: true, outcome: "reentry_ok", admission_mode: "allpass", attended_date: "2026-08-20" });
    mockPool({ list: activeList });
    const res = await POST(req({ mode: "scan", scanPayload: "PKT:TCKT-1:1:a", checkInListId: "11111111-1111-4111-8111-111111111111" }), ctx);
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.reentryOk).toBe(true);
    expect(json.data.outcome).toBe("reentry_ok");
  });

  it("소진/취소·타일(v2 422) → 차단(400)", async () => {
    verifyDynamicQRPayload.mockReturnValue({ valid: true, ticketId: "TCKT-1" });
    checkInTicket.mockRejectedValue(new V2CommerceError("입장일 아님", 422));
    mockPool({ list: activeList });
    const res = await POST(req({ mode: "scan", scanPayload: "PKT:TCKT-1:1:a", checkInListId: "11111111-1111-4111-8111-111111111111" }), ctx);
    expect(res.status).toBe(400);
  });

  // 🔴 2026-07-28 실측: 모든 422 를 "취소/만료" 로 덮어써서, 등급 입장창 밖 스캔에도
  //    "취소된 표"라고 안내됐다. 정상 티켓을 든 관객에게 하는 최악의 오안내다.
  it("등급 입장창 밖 → v2 사유를 그대로 보여준다(코드 접두어 제거)", async () => {
    verifyDynamicQRPayload.mockReturnValue({ valid: true, ticketId: "TCKT-1" });
    checkInTicket.mockRejectedValue(
      new V2CommerceError("STATE_TRANSITION_FORBIDDEN: 이 등급의 입장 가능일이 아닙니다", 422),
    );
    mockPool({ list: activeList });
    const res = await POST(req({ mode: "scan", scanPayload: "PKT:TCKT-1:1:a", checkInListId: "11111111-1111-4111-8111-111111111111" }), ctx);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("이 등급의 입장 가능일이 아닙니다");
    expect(body).not.toContain("STATE_TRANSITION_FORBIDDEN");
  });

  it("1회권 다른 날 재입장 → 언제 입장했는지까지 보여준다", async () => {
    verifyDynamicQRPayload.mockReturnValue({ valid: true, ticketId: "TCKT-1" });
    checkInTicket.mockRejectedValue(
      new V2CommerceError("STATE_TRANSITION_FORBIDDEN: 이미 2026-08-20 에 입장한 티켓입니다 (1회 입장권)", 422),
    );
    mockPool({ list: activeList });
    const res = await POST(req({ mode: "scan", scanPayload: "PKT:TCKT-1:1:a", checkInListId: "11111111-1111-4111-8111-111111111111" }), ctx);
    expect(await res.text()).toContain("2026-08-20");
  });

  it("v2 가 영문 내부 메시지를 주면 게이트에 노출하지 않는다", async () => {
    verifyDynamicQRPayload.mockReturnValue({ valid: true, ticketId: "TCKT-1" });
    checkInTicket.mockRejectedValue(new V2CommerceError("INTERNAL: cannot admit a cancelled ticket", 422));
    mockPool({ list: activeList });
    const res = await POST(req({ mode: "scan", scanPayload: "PKT:TCKT-1:1:a", checkInListId: "11111111-1111-4111-8111-111111111111" }), ctx);
    const text = await res.text();
    expect(text).not.toContain("cannot admit");
    expect(text).toContain("체크인할 수 없는 티켓입니다");
  });

  // 🔴 실측: 필수 필드가 빠지면 ZodError 가 그대로 올라가 **본문 없는 500** 이 나갔다.
  //    게이트에서 500 은 "서버가 죽었다"로 읽혀 스태프가 스캔을 멈춘다.
  it("필수 필드 누락 → 500 이 아니라 400 + 사유", async () => {
    mockPool({ list: activeList });
    const res = await POST(req({ mode: "manual", ticketNumber: "TKT-1" }), ctx);
    expect(res.status).toBe(400);
  });

  // 🔴 위 수정의 **잔여 절반**(적대 감사 F8). `request.json()` 자체가 던지는 경우는
  //    parseBody 에 도달하지 못하고 withAuth catch → 500 + "인증 처리 실패" 로그(원인 위장).
  it("본문이 JSON 이 아니면 → 500 이 아니라 400", async () => {
    mockPool({ list: activeList });
    const raw = new Request("http://localhost/api/events/event-1/check-in", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json{",
    }) as unknown as NextRequest;
    const res = await POST(raw, ctx);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("JSON");
  });

  it("본문이 비어 있어도 → 400", async () => {
    mockPool({ list: activeList });
    const raw = new Request("http://localhost/api/events/event-1/check-in", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }) as unknown as NextRequest;
    const res = await POST(raw, ctx);
    expect(res.status).toBe(400);
  });
});

describe("② 체크인 undo/취소 (오스캔 복구)", () => {
  function delReq(body: unknown): NextRequest {
    return new Request("http://localhost/api/events/event-1/check-in", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }) as unknown as NextRequest;
  }

  it("마지막 입장 취소 → attendees confirmed 원복 + v2 revoke + 감사로그", async () => {
    revokeAdmission.mockResolvedValue({ revoked: true, attended_date: "2026-08-20", was_last_admission: true, status_reverted: true, first_checked_in_reset: true, status: "active" });
    const { query } = mockPool({});
    const res = await DELETE(delReq({ attendeeId: TICKET_ID, attendedDate: "2026-08-20", reason: "잘못된 게이트" }), ctx);
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.revoked).toBe(true);
    expect(json.data.wasLastAdmission).toBe(true);
    expect(json.data.attendee.status).toBe("confirmed");
    expect(revokeAdmission).toHaveBeenCalledWith(TICKET_ID, expect.objectContaining({ reason: "잘못된 게이트" }));
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "check_in", changes: expect.objectContaining({ op: "revoke_admission" }) }));
    // attendees 를 confirmed 로 원복하는 UPDATE 가 실행됐는지.
    const updateCalled = query.mock.calls.some(([sql]) => typeof sql === "string" && sql.includes("SET status = 'confirmed'"));
    expect(updateCalled).toBe(true);
  });

  it("다일 잔여 입장이 있으면(was_last_admission=false) attendees 는 checked_in 유지", async () => {
    revokeAdmission.mockResolvedValue({ revoked: true, attended_date: "2026-08-20", was_last_admission: false, status_reverted: false, first_checked_in_reset: false, status: "active" });
    const { query } = mockPool({});
    const res = await DELETE(delReq({ attendeeId: TICKET_ID, reason: "테스트 스캔" }), ctx);
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.wasLastAdmission).toBe(false);
    const updateConfirmed = query.mock.calls.some(([sql]) => typeof sql === "string" && sql.includes("SET status = 'confirmed'"));
    expect(updateConfirmed).toBe(false);
  });

  it("사유 없는 취소는 검증 거부", async () => {
    mockPool({});
    const res = await DELETE(delReq({ attendeeId: TICKET_ID }), ctx);
    expect(res.status).toBe(400);
    expect(revokeAdmission).not.toHaveBeenCalled();
  });

  it("멱등: v2 revoked=false 여도 200 반환(중복 취소 안전)", async () => {
    revokeAdmission.mockResolvedValue({ revoked: false, attended_date: "2026-08-20", was_last_admission: false, status_reverted: false, first_checked_in_reset: false, status: "active" });
    mockPool({});
    const res = await DELETE(delReq({ attendeeId: TICKET_ID, reason: "중복 취소" }), ctx);
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.revoked).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// W4-ORD — 티켓 조회 go attendees → v2 이관 회귀
// ─────────────────────────────────────────────────────────────────────────────
describe("W4-ORD 티켓 해석 v2 이관", () => {
  const LIST_ID = "11111111-1111-4111-8111-111111111111";

  it("티켓번호 조회에 go attendees SELECT 를 쓰지 않고 v2 getTicketByNumber 를 쓴다", async () => {
    checkInTicket.mockResolvedValue({ checked_in_at: "2026-08-20T00:00:00Z", status: "used", already: false, outcome: "admitted", attended_date: "2026-08-20" });
    const { query, client } = mockPool({ list: activeList });

    const res = await POST(req({ mode: "manual", ticketNumber: "TCKT-1", manualReason: "QR 미인식", checkInListId: LIST_ID }), ctx);

    expect(res.status).toBe(200);
    // 소유 경계는 resolveOwnedTicketByNumber(실제 구현)가 v2 응답으로 판정한다.
    expect(getTicketByNumber).toHaveBeenCalledWith("TCKT-1");
    const allSql = [...query.mock.calls, ...client.query.mock.calls].map(([sql]) => String(sql));
    expect(allSql.some((sql) => /FROM\s+attendees/.test(sql))).toBe(false);
    // W5-ATTENDEE: 체크인 명단·로그도 go SQL 이 아니다.
    expect(allSql.some((sql) => /check_in_lists|check_in_logs/.test(sql))).toBe(false);
  });

  it("🔴 v2 조회 장애를 '등록되지 않은 티켓(404)' 으로 위장하지 않고 503 을 준다", async () => {
    getTicketByNumber.mockRejectedValue(new V2CommerceError("upstream down", 502));
    mockPool({ list: activeList });

    const res = await POST(req({ mode: "manual", ticketNumber: "TCKT-1", manualReason: "QR 미인식", checkInListId: LIST_ID }), ctx);

    expect(res.status).toBe(503);
    // 판정 불가 상태에서 입장을 태우지 않는다.
    expect(checkInTicket).not.toHaveBeenCalled();
  });

  it("타 이벤트/타 계정 티켓은 404 (테넌트 경계 = v2 응답으로 강제)", async () => {
    getTicketByNumber.mockResolvedValue(v2Ticket({ event_id: "event-other" }));
    mockPool({ list: activeList });
    const res1 = await POST(req({ mode: "manual", ticketNumber: "TCKT-1", manualReason: "x", checkInListId: LIST_ID }), ctx);
    expect(res1.status).toBe(404);

    getTicketByNumber.mockResolvedValue(
      v2Ticket({ event: { starts_at: null, title: null, organizer_id: null, external_ref: null, go_account_id: "acct-other", venue: null } }),
    );
    mockPool({ list: activeList });
    const res2 = await POST(req({ mode: "manual", ticketNumber: "TCKT-1", manualReason: "x", checkInListId: LIST_ID }), ctx);
    expect(res2.status).toBe(404);
    expect(checkInTicket).not.toHaveBeenCalled();
  });

  it("취소 티켓(v2 status=cancelled)은 v2 호출 전에 차단", async () => {
    getTicketByNumber.mockResolvedValue(v2Ticket({ status: "cancelled" }));
    mockPool({ list: activeList });
    const res = await POST(req({ mode: "manual", ticketNumber: "TCKT-1", manualReason: "x", checkInListId: LIST_ID }), ctx);
    expect(res.status).toBe(400);
    expect(checkInTicket).not.toHaveBeenCalled();
  });

  it("W5: 체크인 로그를 v2 에 ticket_id·입장일·표시값 스냅샷으로 기록한다", async () => {
    checkInTicket.mockResolvedValue({ checked_in_at: "2026-08-20T00:00:00Z", status: "used", already: false, outcome: "admitted", attended_date: "2026-08-20" });
    mockPool({ list: activeList });

    await POST(req({ mode: "manual", ticketNumber: "TCKT-1", manualReason: "QR 미인식", checkInListId: LIST_ID }), ctx);

    expect(recordCheckInLog).toHaveBeenCalledWith("event-1", "acct-1", expect.objectContaining({
      ticket_id: TICKET_ID,            // v2 티켓 키
      attended_date: "2026-08-20",     // 하루 1행 멱등키의 나머지 절반
      check_in_list_id: LIST_ID,
      attendee_name: "홍길동",          // 표시값 스냅샷
      ticket_number: "TCKT-1",
      method: "manual",
    }));
  });

  it("🔴 로그 기록 실패는 관람객을 막지 않되 성공으로 위장하지도 않는다(logRecorded:false)", async () => {
    checkInTicket.mockResolvedValue({ checked_in_at: "2026-08-20T00:00:00Z", status: "used", already: false, outcome: "admitted", attended_date: "2026-08-20" });
    mockPool({ list: activeList });
    recordCheckInLog.mockRejectedValue(new V2CommerceError("v2 down", 503));

    const res = await POST(req({ mode: "manual", ticketNumber: "TCKT-1", manualReason: "x", checkInListId: LIST_ID }), ctx);
    const json = await res.json();

    // 입장 정본(v2 event_admissions)은 이미 확정 — 게이트에서 거부하지 않는다.
    expect(res.status).toBe(200);
    expect(json.data.outcome).toBe("admitted");
    // 그러나 로그가 없다는 사실은 숨기지 않는다(UI 경고 + 재스캔이 멱등 복구).
    expect(json.data.logRecorded).toBe(false);
  });

  it("🔴 재스캔(already)도 로그를 멱등 기록해 누락분을 복구한다", async () => {
    checkInTicket.mockResolvedValue({ checked_in_at: "2026-08-20T00:00:00Z", status: "used", already: true, outcome: "reentry_ok", attended_date: "2026-08-20" });
    mockPool({ list: activeList });
    recordCheckInLog.mockResolvedValue({ created: false, id: "log-1" }); // 이미 있음 → 중복 행 없음

    const res = await POST(req({ mode: "manual", ticketNumber: "TCKT-1", manualReason: "x", checkInListId: LIST_ID }), ctx);
    const json = await res.json();

    expect(json.data.alreadyCheckedIn).toBe(true);
    expect(json.data.logRecorded).toBe(true);
    expect(recordCheckInLog).toHaveBeenCalledTimes(1);
  });

  it("🔴 체크인 명단 조회 장애를 '활성 명단 아님(400)' 으로 위장하지 않고 503", async () => {
    mockPool({ list: activeList });
    getCheckInList.mockRejectedValue(new V2CommerceError("v2 down", 503));

    const res = await POST(req({ mode: "manual", ticketNumber: "TCKT-1", manualReason: "x", checkInListId: LIST_ID }), ctx);

    expect(res.status).toBe(503);
    expect(checkInTicket).not.toHaveBeenCalled();
  });

  it("발송 세그먼트 캐시(attendees) UPDATE 는 v2_ticket_id 키로만 한다", async () => {
    checkInTicket.mockResolvedValue({ checked_in_at: "2026-08-20T00:00:00Z", status: "used", already: false, outcome: "admitted", attended_date: "2026-08-20" });
    const { query } = mockPool({ list: activeList });

    await POST(req({ mode: "manual", ticketNumber: "TCKT-1", manualReason: "x", checkInListId: LIST_ID }), ctx);

    const upd = query.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes("UPDATE attendees"));
    expect(String(upd?.[0])).toContain("v2_ticket_id");
    expect(upd?.[1]).toEqual(["acct-1", TICKET_ID, "2026-08-20T00:00:00Z"]);
  });

  it("DELETE(입장취소): 🔴 v2 장애를 '이미 취소됨' 으로 흡수하지 않고 503", async () => {
    getTicket.mockRejectedValue(new V2CommerceError("upstream down", 500));
    mockPool({});
    const res = await DELETE(
      new Request("http://localhost/api/events/event-1/check-in", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attendeeId: TICKET_ID, reason: "오스캔" }),
      }) as unknown as NextRequest,
      ctx,
    );
    expect(res.status).toBe(503);
    expect(revokeAdmission).not.toHaveBeenCalled();
  });

  it("DELETE(입장취소): 체크인 로그 원복도 v2 (ticket_id, 입장일) 키", async () => {
    revokeAdmission.mockResolvedValue({ revoked: true, attended_date: "2026-08-20", was_last_admission: true });
    mockPool({});
    await DELETE(
      new Request("http://localhost/api/events/event-1/check-in", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attendeeId: TICKET_ID, reason: "오스캔" }),
      }) as unknown as NextRequest,
      ctx,
    );
    expect(deleteCheckInLogs).toHaveBeenCalledWith("event-1", "acct-1", {
      ticketId: TICKET_ID,
      attendedDate: "2026-08-20",
    });
  });

  it("DELETE(입장취소): 🔴 로그 원복 실패를 성공으로 삼키지 않는다(502, 재시도 유도)", async () => {
    revokeAdmission.mockResolvedValue({ revoked: true, attended_date: "2026-08-20", was_last_admission: true });
    mockPool({});
    deleteCheckInLogs.mockRejectedValue(new V2CommerceError("v2 down", 503));

    const res = await DELETE(
      new Request("http://localhost/api/events/event-1/check-in", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attendeeId: TICKET_ID, reason: "오스캔" }),
      }) as unknown as NextRequest,
      ctx,
    );
    expect(res.status).toBe(502);
  });
});
