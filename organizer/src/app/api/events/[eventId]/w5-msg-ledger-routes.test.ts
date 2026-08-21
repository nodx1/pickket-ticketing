/**
 * 레벨2 컷오버 W5-MSG — 주최자 발송/캠페인 라우트가 v2 원장으로 재배선된 뒤의 회귀.
 *
 * 각 라우트마다 고정하는 것:
 *   ① 정상 — v2 원장 응답을 그대로 화면 계약으로 변환하고 **go DB 를 잡지 않는다**.
 *   ② 원장 장애 — **503**. 🔴 빈 목록(200)·404·500 으로 위장 금지.
 *      "0건"과 "확인 불가"는 다른 사실이다. 빈 목록으로 흘리면 발송 이력이 사라진 것처럼 보이고,
 *      운영자는 이미 나간 발송을 다시 보내려 한다.
 *   ③ 캠페인 발송 — 안정 멱등키 + draft CAS(중복 큐잉 차단).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  class V2MessagingLedgerError extends Error {
    status?: number;
    constructor(message: string, status?: number) {
      super(message);
      this.name = "V2MessagingLedgerError";
      this.status = status;
    }
  }
  return {
    poolQuery: vi.fn(),
    session: { accountId: "acc-1", id: "user-1", role: "organizer" } as Record<string, unknown>,
    params: { eventId: "evt-1", messageId: "msg-1", campaignId: "cmp-1" } as Record<string, string>,
    listEventMessages: vi.fn(),
    getEventMessage: vi.fn(),
    listMessageDeliveries: vi.fn(),
    listCampaigns: vi.fn(),
    getCampaign: vi.fn(),
    markCampaignSent: vi.fn(),
    countSegment: vi.fn(async () => 3),
    createOrganizerMessage: vi.fn(async () => ({
      message_id: "v2-msg-1",
      status: "queued",
      scheduled: false,
    })),
    V2MessagingLedgerError,
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
vi.mock("@/lib/v2/messaging-ledger-client", () => ({
  listEventMessages: h.listEventMessages,
  getEventMessage: h.getEventMessage,
  listMessageDeliveries: h.listMessageDeliveries,
  listCampaigns: h.listCampaigns,
  getCampaign: h.getCampaign,
  markCampaignSent: h.markCampaignSent,
  V2MessagingLedgerError: h.V2MessagingLedgerError,
  ledgerErrorStatus: (err: { status?: number }) => (err.status === 404 ? 404 : 503),
}));
vi.mock("@/lib/notification/recipients", () => ({
  countSegment: h.countSegment,
  countRecipients: vi.fn(async () => 3),
  resolveSegment: vi.fn(async () => []),
}));
vi.mock("@/lib/v2/commerce-client", () => ({
  createOrganizerMessage: h.createOrganizerMessage,
  V2CommerceError: class extends Error {},
}));

import { GET as messagesGET } from "@/app/api/events/[eventId]/messages/route";
import { GET as messageGET } from "@/app/api/events/[eventId]/messages/[messageId]/route";
import { GET as deliveriesGET } from "@/app/api/events/[eventId]/messages/[messageId]/deliveries/route";
import { GET as campaignsGET } from "@/app/api/events/[eventId]/campaigns/route";
import { GET as campaignStatsGET } from "@/app/api/events/[eventId]/campaigns/[campaignId]/stats/route";
import { POST as campaignSendPOST } from "@/app/api/events/[eventId]/campaigns/[campaignId]/send/route";

type Handler = (request: Request) => Promise<Response>;
const invoke = (handler: unknown, request: Request) => (handler as Handler)(request);
const req = (url = "https://go.pickket.kr/api/x", init?: RequestInit) => new Request(url, init);

const down = () => new h.V2MessagingLedgerError("ledger unreachable", 503);

beforeEach(() => {
  vi.clearAllMocks();
  h.poolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  h.countSegment.mockResolvedValue(3);
  h.createOrganizerMessage.mockResolvedValue({
    message_id: "v2-msg-1",
    status: "queued",
    scheduled: false,
  });
});

describe("GET /messages — 단체메시지 목록", () => {
  it("① 정상: v2 원장 → 화면 계약 변환, go DB SQL 0", async () => {
    h.listEventMessages.mockResolvedValue([
      {
        id: "m1",
        title: "공지",
        channel: "email",
        status: "sent",
        body: "b",
        message_type: "informational",
        recipient_filter: "all",
        sent_count: 10,
        failed_count: 1,
        delivered_count: 9,
        opened_count: 4,
        clicked_count: 2,
        scheduled_at: null,
        sent_at: null,
        created_at: null,
      },
    ]);
    const res = await invoke(messagesGET, req("https://go.pickket.kr/api/x?status=sent"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data[0]).toMatchObject({ id: "m1", sentCount: 10, deliveredCount: 9 });
    expect(h.poolQuery).not.toHaveBeenCalled();
    expect(h.listEventMessages).toHaveBeenCalledWith("acc-1", "evt-1", "sent");
  });

  it("② 원장 장애는 503 — 빈 목록(=발송 이력 없음)으로 위장하지 않는다", async () => {
    h.listEventMessages.mockRejectedValue(down());
    expect((await invoke(messagesGET, req())).status).toBe(503);
  });
});

describe("GET /messages/[id] — 단건", () => {
  it("① 정상", async () => {
    h.getEventMessage.mockResolvedValue({
      id: "m1",
      title: "t",
      channel: "sms",
      status: "sent",
      body: "b",
      recipient_filter: "all",
      sent_count: 1,
      failed_count: 0,
      result_meta: null,
      sent_at: null,
      created_at: null,
    });
    expect((await invoke(messageGET, req())).status).toBe(200);
    expect(h.poolQuery).not.toHaveBeenCalled();
  });

  it("미존재는 404", async () => {
    h.getEventMessage.mockResolvedValue(null);
    expect((await invoke(messageGET, req())).status).toBe(404);
  });

  it("② 원장 장애는 503 — 404('없음')로 강등하지 않는다", async () => {
    h.getEventMessage.mockRejectedValue(down());
    expect((await invoke(messageGET, req())).status).toBe(503);
  });
});

describe("GET /messages/[id]/deliveries — 수신자별 상세", () => {
  const page = {
    items: [
      {
        contact_masked: "a***@b.test",
        status: "delivered",
        reason: null,
        channel: "email",
        delivered_at: null,
        opened_at: null,
        clicked_at: null,
        updated_at: null,
      },
    ],
    total: 1,
    summary: { total: 1, sent: 1, delivered: 1, failed: 0, skipped: 0, opened: 0, clicked: 0 },
  };

  it("① 정상: 마스킹된 연락처만 노출(원문 유출 없음)", async () => {
    h.listMessageDeliveries.mockResolvedValue(page);
    const res = await invoke(deliveriesGET, req());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.items[0].contact).toBe("a***@b.test");
    expect(body.data.summary.delivered).toBe(1);
    expect(h.poolQuery).not.toHaveBeenCalled();
  });

  it("CSV 내보내기도 마스킹된 값만 담는다", async () => {
    h.listMessageDeliveries.mockResolvedValue(page);
    const res = await invoke(deliveriesGET, req("https://go.pickket.kr/api/x?format=csv"));
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(await res.text()).toContain("a***@b.test");
  });

  it("② 원장 장애는 503 — 빈 목록(=0명 발송)으로 위장하지 않는다", async () => {
    h.listMessageDeliveries.mockRejectedValue(down());
    expect((await invoke(deliveriesGET, req())).status).toBe(503);
  });
});

describe("GET /campaigns — 캠페인 목록/통계", () => {
  it("① 정상 목록", async () => {
    h.listCampaigns.mockResolvedValue([
      { id: "c1", subject: "s", status: "sent", stats: null, scheduled_at: null, sent_at: null, created_at: null },
    ]);
    const res = await invoke(campaignsGET, req());
    expect(res.status).toBe(200);
    expect((await res.json()).data[0].id).toBe("c1");
    expect(h.poolQuery).not.toHaveBeenCalled();
  });

  it("② 목록 원장 장애는 503", async () => {
    h.listCampaigns.mockRejectedValue(down());
    expect((await invoke(campaignsGET, req())).status).toBe(503);
  });

  it("① 통계는 v2 실측 COUNT 를 그대로 전달", async () => {
    h.getCampaign.mockResolvedValue({
      campaign: {
        id: "c1",
        subject: "s",
        body_html: "<p>x</p>",
        status: "sent",
        message_type: "advertising",
        segment: null,
        stats: null,
        scheduled_at: null,
        sent_at: null,
      },
      total_recipients: 10,
      sent: 9,
      opened: 4,
      clicked: 1,
    });
    const body = await (await invoke(campaignStatsGET, req())).json();
    expect(body.data).toMatchObject({ totalRecipients: 10, sent: 9, opened: 4, clicked: 1 });
  });

  it("② 통계 원장 장애는 503", async () => {
    h.getCampaign.mockRejectedValue(down());
    expect((await invoke(campaignStatsGET, req())).status).toBe(503);
  });
});

describe("POST /campaigns/[id]/send — 발송(v2 큐잉 + draft CAS)", () => {
  const draft = {
    campaign: {
      id: "cmp-1",
      subject: "s",
      body_html: "<p>x</p>",
      status: "draft",
      message_type: "advertising",
      segment: null,
      stats: null,
      scheduled_at: null,
      sent_at: null,
    },
    total_recipients: 0,
    sent: 0,
    opened: 0,
    clicked: 0,
  };

  it("③ 안정 멱등키(campaign-send:{id})로 큐잉하고 draft CAS 로 확정한다", async () => {
    h.getCampaign.mockResolvedValue(draft);
    h.markCampaignSent.mockResolvedValue({ campaign_id: "cmp-1", status: "sent" });
    const res = await invoke(campaignSendPOST, req("https://go.pickket.kr/api/x", { method: "POST" }));
    expect(res.status).toBe(200);
    expect(h.createOrganizerMessage).toHaveBeenCalledWith(
      expect.objectContaining({ message_type: "advertising", channel: "email" }),
      { idempotencyKey: "campaign-send:cmp-1" },
    );
    expect(h.markCampaignSent).toHaveBeenCalledWith("acc-1", "evt-1", "cmp-1");
    expect(h.poolQuery).not.toHaveBeenCalled();
  });

  it("③ 이미 발송된 캠페인(CAS 실패=409)은 409 로 차단 — 두 번 큐잉하지 않는다", async () => {
    h.getCampaign.mockResolvedValue(draft);
    h.markCampaignSent.mockRejectedValue(new h.V2MessagingLedgerError("not draft", 409));
    const res = await invoke(campaignSendPOST, req("https://go.pickket.kr/api/x", { method: "POST" }));
    expect(res.status).toBe(409);
  });

  it("draft 가 아니면 v2 큐잉 자체를 하지 않는다", async () => {
    h.getCampaign.mockResolvedValue({ ...draft, campaign: { ...draft.campaign, status: "sent" } });
    const res = await invoke(campaignSendPOST, req("https://go.pickket.kr/api/x", { method: "POST" }));
    expect(res.status).toBe(400);
    expect(h.createOrganizerMessage).not.toHaveBeenCalled();
  });

  it("dryRun 은 수신자 수만 세고 발송하지 않는다", async () => {
    h.getCampaign.mockResolvedValue(draft);
    const res = await invoke(
      campaignSendPOST,
      req("https://go.pickket.kr/api/x?dryRun=true", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data.recipientCount).toBe(3);
    expect(h.createOrganizerMessage).not.toHaveBeenCalled();
    expect(h.markCampaignSent).not.toHaveBeenCalled();
  });

  it("② 캠페인 조회 원장 장애는 503 — 발송 시도조차 하지 않는다", async () => {
    h.getCampaign.mockRejectedValue(down());
    const res = await invoke(campaignSendPOST, req("https://go.pickket.kr/api/x", { method: "POST" }));
    expect(res.status).toBe(503);
    expect(h.createOrganizerMessage).not.toHaveBeenCalled();
  });

  it("미존재 캠페인은 404", async () => {
    h.getCampaign.mockResolvedValue(null);
    const res = await invoke(campaignSendPOST, req("https://go.pickket.kr/api/x", { method: "POST" }));
    expect(res.status).toBe(404);
  });
});
