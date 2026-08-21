import { beforeEach, describe, expect, it, vi } from "vitest";

// W4-ORD — go `attendees` 앵커의 세 역할(경계·식별자·표시값) 중 **경계** 를 v2 로 옮긴 헬퍼.
// 여기서 가장 중요한 계약은 "없음(null)"과 "판정 불가(throw)"를 절대 뭉개지 않는 것이다.

const { getTicket, getTicketByNumber, V2CommerceError } = vi.hoisted(() => {
  class V2CommerceError extends Error {
    constructor(message: string, readonly status: number) {
      super(message);
      this.name = "V2CommerceError";
    }
  }
  return { getTicket: vi.fn(), getTicketByNumber: vi.fn(), V2CommerceError };
});
vi.mock("@/lib/v2/commerce-client", () => ({ getTicket, getTicketByNumber, V2CommerceError }));

import { resolveOwnedTicket, resolveOwnedTicketByNumber, TicketAccessError } from "@/lib/v2/ticket-access";

function ticket(overrides: Record<string, unknown> = {}) {
  return {
    ticket_id: "t-1",
    event_id: "event-1",
    event: { go_account_id: "acct-1" },
    ...overrides,
  };
}

beforeEach(() => {
  getTicket.mockReset();
  getTicketByNumber.mockReset();
});

describe("resolveOwnedTicket — 소유 경계", () => {
  it("이벤트·계정이 모두 일치하면 티켓을 반환", async () => {
    getTicket.mockResolvedValue(ticket());
    await expect(resolveOwnedTicket("t-1", "event-1", "acct-1")).resolves.toMatchObject({ ticket_id: "t-1" });
  });

  it("다른 이벤트의 티켓이면 null(→404)", async () => {
    getTicket.mockResolvedValue(ticket({ event_id: "event-2" }));
    await expect(resolveOwnedTicket("t-1", "event-1", "acct-1")).resolves.toBeNull();
  });

  it("다른 계정 소유면 null(→404)", async () => {
    getTicket.mockResolvedValue(ticket({ event: { go_account_id: "acct-2" } }));
    await expect(resolveOwnedTicket("t-1", "event-1", "acct-1")).resolves.toBeNull();
  });

  it("go_account_id 가 없으면 소유 증명 불가 → null (닫히는 방향)", async () => {
    getTicket.mockResolvedValue(ticket({ event: { go_account_id: null } }));
    await expect(resolveOwnedTicket("t-1", "event-1", "acct-1")).resolves.toBeNull();
  });

  it("v2 404 는 '없음' → null", async () => {
    getTicket.mockRejectedValue(new V2CommerceError("not found", 404));
    await expect(resolveOwnedTicket("t-1", "event-1", "acct-1")).resolves.toBeNull();
  });

  it("🔴 v2 5xx 는 null 이 아니라 TicketAccessError — 장애를 '없음'으로 위장 금지", async () => {
    getTicket.mockRejectedValue(new V2CommerceError("bad gateway", 502));
    await expect(resolveOwnedTicket("t-1", "event-1", "acct-1")).rejects.toBeInstanceOf(TicketAccessError);
  });

  it("🔴 네트워크 예외(비-V2CommerceError)는 그대로 전파한다(삼키지 않음)", async () => {
    getTicket.mockRejectedValue(new TypeError("fetch failed"));
    await expect(resolveOwnedTicket("t-1", "event-1", "acct-1")).rejects.toBeInstanceOf(TypeError);
  });
});

describe("resolveOwnedTicketByNumber — 티켓번호 진입점", () => {
  it("소유 티켓이면 반환", async () => {
    getTicketByNumber.mockResolvedValue(ticket());
    await expect(resolveOwnedTicketByNumber("TKT-1", "event-1", "acct-1")).resolves.toMatchObject({ ticket_id: "t-1" });
  });

  it("타 계정 티켓번호를 알아도 null(번호 추측 공격 차단)", async () => {
    getTicketByNumber.mockResolvedValue(ticket({ event: { go_account_id: "acct-2" } }));
    await expect(resolveOwnedTicketByNumber("TKT-1", "event-1", "acct-1")).resolves.toBeNull();
  });

  it("🔴 v2 장애는 TicketAccessError", async () => {
    getTicketByNumber.mockRejectedValue(new V2CommerceError("timeout", 504));
    await expect(resolveOwnedTicketByNumber("TKT-1", "event-1", "acct-1")).rejects.toBeInstanceOf(TicketAccessError);
  });
});
