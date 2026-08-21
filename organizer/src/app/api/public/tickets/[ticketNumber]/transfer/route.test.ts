import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 초대권 양도 라우트 — 인가·오타 방어·발송 실패.
 *
 * 🔴 이 라우트는 **되돌릴 수 없다.** 성공하면 보낸 분의 링크가 즉시 죽고, 되찾으려면
 *    받은 분이 다시 넘겨줘야 한다. 그래서 다음 셋이 핵심이다:
 *
 *      ① 인가   유효한 딥링크 토큰 없이는 못 넘긴다 (링크 소지 = 소유 증명)
 *      ② 오타   번호 형식이 어긋나면 v2 를 부르기 **전에** 막는다
 *      ③ 발송   양도는 됐는데 알림톡 큐 적재가 실패하면 **삼키지 않고 알린다**
 *               (초대권이 허공에 뜬다 — 주최자 재발송 경로를 안내해야 한다)
 */

const h = vi.hoisted(() => {
  class MockV2CommerceError extends Error {
    constructor(message: string, readonly status: number) {
      super(message);
      this.name = "V2CommerceError";
    }
  }
  return {
    getInvitationByTicketNumber: vi.fn(),
    getTicketByNumber: vi.fn(),
    transferInvitationV2: vi.fn(),
    resendInvitationV2: vi.fn(),
    organizerIdRef: vi.fn((id: string) => ({ organizer_id: id })),
    poolQuery: vi.fn(),
    invitationTokenGrantsAccess: vi.fn(() => true),
    MockV2CommerceError,
  };
});

vi.mock("@/lib/v2/commerce-client", () => ({
  V2CommerceError: h.MockV2CommerceError,
  getInvitationByTicketNumber: h.getInvitationByTicketNumber,
  getTicketByNumber: h.getTicketByNumber,
  transferInvitationV2: h.transferInvitationV2,
  resendInvitationV2: h.resendInvitationV2,
  organizerIdRef: h.organizerIdRef,
}));
vi.mock("@/lib/invitation-token", () => ({
  invitationTokenGrantsAccess: h.invitationTokenGrantsAccess,
  INVITE_TOKEN_PARAM: "t",
}));
vi.mock("@/lib/db/pool", () => ({ getPool: () => ({ query: h.poolQuery }) }));
vi.mock("@/lib/auth/withRateLimit", () => ({
  withRateLimit: () => (fn: unknown) => fn,
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { POST } = await import("./route");

const TICKET = "TKT-INV-1";
const ctx = { params: Promise.resolve({ ticketNumber: TICKET }) };

function req(body: unknown) {
  return new Request("http://localhost/api/public/tickets/TKT-INV-1/transfer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const OK_BODY = { token: "deeplink-token-value", toName: "김철수", toPhone: "010-9999-8888" };

beforeEach(() => {
  vi.clearAllMocks();
  h.invitationTokenGrantsAccess.mockReturnValue(true);
  h.getInvitationByTicketNumber.mockResolvedValue({
    invitation: { id: "inv-1", recipient_name: "서낙원", token_version: 3, status: "issued" },
  });
  h.getTicketByNumber.mockResolvedValue({ event: { organizer_id: "org-1" } });
  h.transferInvitationV2.mockResolvedValue({
    transferred: true,
    invitation: { recipient_name: "김철수" },
    from: { recipient_name: "서낙원", phone_normalized: "01011112222" },
  });
  h.resendInvitationV2.mockResolvedValue({ requeued: true });
  h.poolQuery.mockResolvedValue({ rowCount: 1 });
});

describe("초대권 양도", () => {
  it("정상 양도 — v2 양도 + 알림톡 큐 적재", async () => {
    const res = await POST(req(OK_BODY), ctx);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.transferred).toBe(true);
    expect(json.data.queued).toBe(true);
    expect(h.transferInvitationV2).toHaveBeenCalledTimes(1);
    // 🔴 정규화된 번호(숫자만)로 넘겨야 v2 UNIQUE(event, phone, seq) 와 축이 맞는다.
    expect(h.transferInvitationV2.mock.calls[0][2]).toMatchObject({
      name: "김철수",
      phoneNormalized: "01099998888",
    });
    expect(h.resendInvitationV2).toHaveBeenCalledTimes(1);
  });

  it("🔴 딥링크 토큰이 유효하지 않으면 양도하지 않는다", async () => {
    h.invitationTokenGrantsAccess.mockReturnValue(false);
    const res = await POST(req(OK_BODY), ctx);
    expect(res.status).toBe(403);
    expect(h.transferInvitationV2).not.toHaveBeenCalled();
  });

  it("🔴 번호 형식이 어긋나면 v2 를 부르기 전에 막는다", async () => {
    for (const bad of ["010-1234", "02-123-4567", "0201234567", "abcdefghijk"]) {
      const res = await POST(req({ ...OK_BODY, toPhone: bad }), ctx);
      expect(res.status, `${bad} 가 통과했다`).toBe(400);
    }
    expect(h.transferInvitationV2).not.toHaveBeenCalled();
  });

  it("이름이 비면 400", async () => {
    const res = await POST(req({ ...OK_BODY, toName: "   " }), ctx);
    expect(res.status).toBe(400);
    expect(h.transferInvitationV2).not.toHaveBeenCalled();
  });

  it("초대권이 아닌 티켓(유료)은 404 — 존재를 알리지 않는다", async () => {
    h.getInvitationByTicketNumber.mockResolvedValue({ invitation: null });
    const res = await POST(req(OK_BODY), ctx);
    expect(res.status).toBe(404);
    expect(h.transferInvitationV2).not.toHaveBeenCalled();
  });

  it("v2 가 거절하면 사유를 그대로 전달한다 (5장 상한 등)", async () => {
    h.transferInvitationV2.mockRejectedValue(
      new h.MockV2CommerceError("받는 분이 이미 5장을 갖고 계십니다 (한 번호당 최대 5장)", 409),
    );
    const res = await POST(req(OK_BODY), ctx);
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(String(json.error?.message ?? json.error)).toContain("5장");
    expect(h.resendInvitationV2).not.toHaveBeenCalled();
  });

  it("🔴 양도는 됐는데 발송 큐 적재가 실패하면 — 삼키지 않고 알린다", async () => {
    h.resendInvitationV2.mockRejectedValue(new Error("queue down"));
    const res = await POST(req(OK_BODY), ctx);
    // 양도 자체는 성공했으므로 200 이되, queued=false 와 안내 문구가 있어야 한다.
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.transferred).toBe(true);
    expect(json.data.queued).toBe(false);
    expect(json.data.message).toContain("주최자");
  });

  it("🔴 requeued=false 도 발송 실패로 취급한다", async () => {
    // 예외가 아니라 **정상 응답으로 false** 가 올 수 있다. 이걸 성공으로 읽으면
    // 손님은 보냈다고 믿고 받는 분은 영영 못 받는다.
    h.resendInvitationV2.mockResolvedValue({ requeued: false, reason: "revoked" });
    const res = await POST(req(OK_BODY), ctx);
    const json = await res.json();
    expect(json.data.queued).toBe(false);
    expect(json.data.message).toContain("주최자");
  });


  it("🔴 go 참석자 명단을 새 소유자로 갱신한다", async () => {
    // 2026-08-03 첫 실사용에서 이게 **없었다** — v2 는 서낙원으로 바뀌었는데
    // go attendees 는 김상윤 그대로였고, 현장 체크인 명단이 옛 소유자를 가리켰다.
    // 계획서에 "부수효과로 전파" 라고 적어놓고 호출을 안 만들어서 로그도 없었다.
    const res = await POST(req(OK_BODY), ctx);
    expect(res.status).toBe(200);
    expect(h.poolQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = h.poolQuery.mock.calls[0];
    expect(String(sql)).toMatch(/UPDATE\s+attendees/i);
    expect(params).toEqual([TICKET, "김철수", "01099998888"]);
  });

  it("🔴 입장한 참석자는 건드리지 않는다", async () => {
    // 이미 입장한 사람의 이력을 지우면 재입장이 열린다.
    await POST(req(OK_BODY), ctx);
    expect(String(h.poolQuery.mock.calls[0][0])).toMatch(/status\s*<>\s*'checked_in'/);
  });

  it("명단 투영이 실패해도 양도는 되돌리지 않는다", async () => {
    // 양도는 v2 에서 이미 커밋됐다. 되돌리면 "티켓은 넘어갔는데 양도 실패" 로 보인다.
    h.poolQuery.mockRejectedValue(new Error("db down"));
    const res = await POST(req(OK_BODY), ctx);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.transferred).toBe(true);
    // 발송은 그대로 진행돼야 한다.
    expect(h.resendInvitationV2).toHaveBeenCalledTimes(1);
  });

  it("이벤트에 organizer_id 가 없으면 양도하지 않는다", async () => {
    h.getTicketByNumber.mockResolvedValue({ event: { organizer_id: null } });
    const res = await POST(req(OK_BODY), ctx);
    expect(res.status).toBe(503);
    expect(h.transferInvitationV2).not.toHaveBeenCalled();
  });
});
