import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  class FakeV2CommerceError extends Error {
    constructor(message: string, readonly status = 500) {
      super(message);
    }
  }
  return { getTicketByNumber: vi.fn(), query: vi.fn(), FakeV2CommerceError };
});
vi.mock("@/lib/v2/commerce-client", () => ({
  getTicketByNumber: h.getTicketByNumber,
  V2CommerceError: h.FakeV2CommerceError,
}));
vi.mock("@/lib/db/pool", () => ({ getPool: () => ({ query: h.query }) }));

import {
  resolveTicketArtifactContext,
  TicketArtifactNotFoundError,
  TicketArtifactUpstreamError,
} from "@/lib/ticket/artifact-context";

function v2Ticket(overrides: Record<string, unknown> = {}) {
  return {
    ticket_id: "tk-uuid",
    ticket_number: "TKT-ABCDEF123456",
    status: "active",
    checked_in_at: null,
    seat_id: null,
    tier_id: "tier-1",
    product_name: "VIP석",
    product_external_ref: "p-vip",
    raffle_number: null,
    answers: null,
    event_id: "evt-v2",
    event: {
      starts_at: "2026-08-01T10:00:00Z",
      title: "페스티벌",
      organizer_id: "org-1",
      external_ref: "evt-go",
      // W2-ORD: 접근제어 account id·표시용 공연장명을 v2 가 함께 내려준다(go events read 폐기).
      go_account_id: "acct-1",
      venue: "올림픽홀",
    },
    order: {
      id: "ord-1",
      order_number: "PKT-260801-001",
      buyer: { name: "홍길동", email: "a@b.com", phone: "010-1234-5678" },
    },
    ...overrides,
  };
}

beforeEach(() => {
  h.getTicketByNumber.mockReset();
  h.query.mockReset();
  h.query.mockResolvedValue({ rows: [] });
});

describe("resolveTicketArtifactContext — 티켓 산출물 컨텍스트", () => {
  it("v2 티켓 단일 응답으로 컨텍스트를 구성한다(W2-ORD: go DB read 0)", async () => {
    h.getTicketByNumber.mockResolvedValue(v2Ticket());

    const ctx = await resolveTicketArtifactContext("TKT-ABCDEF123456");

    expect(ctx).toMatchObject({
      ticketNumber: "TKT-ABCDEF123456",
      v2TicketId: "tk-uuid",
      attendeeName: "홍길동",
      buyerEmail: "a@b.com",
      buyerPhone: "010-1234-5678",
      eventTitle: "페스티벌",
      venueName: "올림픽홀",
      eventAccountId: "acct-1",
      productName: "VIP석",
    });
    // 🔴 회귀 핵심: QR/PDF/지갑 경로가 go DB 를 단 한 번도 조회하지 않는다.
    expect(h.query).not.toHaveBeenCalled();
  });

  it("v2 가 go_account_id 를 안 주면 eventAccountId=null — 접근제어는 닫히는 방향", async () => {
    // v2 네이티브 주최자(go 계정 미연결)나 필드 미제공 시. null 이면 주최자 세션 경로가
    // 열리는 게 아니라 **거부**된다(구매자 이메일/전화 일치만 통과) = fail-closed.
    const t = v2Ticket();
    const ctx = await (async () => {
      h.getTicketByNumber.mockResolvedValue({
        ...t,
        event: { ...t.event, go_account_id: null, venue: null },
      });
      return resolveTicketArtifactContext("TKT-ABCDEF123456");
    })();
    expect(ctx.eventAccountId).toBeNull();
    expect(ctx.venueName).toBeNull();
  });

  it("취소 티켓은 404 — 구 go `attendees.status != 'cancelled'` 가드와 동등", async () => {
    h.getTicketByNumber.mockResolvedValue(v2Ticket({ status: "cancelled" }));

    await expect(resolveTicketArtifactContext("TKT-X")).rejects.toBeInstanceOf(
      TicketArtifactNotFoundError,
    );
  });

  it("includeRevoked 면 취소 티켓도 반환한다(PDF 재출력)", async () => {
    h.getTicketByNumber.mockResolvedValue(v2Ticket({ status: "cancelled" }));

    await expect(
      resolveTicketArtifactContext("TKT-X", { includeRevoked: true }),
    ).resolves.toMatchObject({ status: "cancelled" });
  });

  it("v2 404 는 티켓 없음, 그 외 v2 오류는 업스트림 오류(502)로 구분한다", async () => {
    h.getTicketByNumber.mockRejectedValueOnce(new h.FakeV2CommerceError("nope", 404));
    await expect(resolveTicketArtifactContext("TKT-X")).rejects.toBeInstanceOf(
      TicketArtifactNotFoundError,
    );

    h.getTicketByNumber.mockRejectedValueOnce(new h.FakeV2CommerceError("down", 503));
    await expect(resolveTicketArtifactContext("TKT-X")).rejects.toBeInstanceOf(
      TicketArtifactUpstreamError,
    );
  });
});
