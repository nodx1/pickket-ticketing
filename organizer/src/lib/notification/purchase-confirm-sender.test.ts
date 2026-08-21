/**
 * 구매확정 발송기 회귀 — 2026-07-31 감사 반려분.
 *
 * 🔴 이 파일이 없던 동안 "살아있는 티켓" 게이트를 없애도 그린이었다(감사 뮤테이션 M3).
 *    그 게이트가 빠지면 **취소·만료된 티켓에 '구매 완료' 알림**이 나가고, 발송은 회수 불가다.
 *
 * 🔴 그리고 게이트를 너무 좁게(active|used) 잡았다가 **무통장 알림톡을 통째로 끊을 뻔했다** —
 *    입금확정 경로는 v2 confirm 을 비동기 outbox 로 돌려서, 발송 시점의 티켓이 `pending` 이다.
 *    판정 기준은 "지금 열리는가" 가 아니라 **"앞으로도 안 열리는가"** 여야 한다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getEvent, getOrder, notifyPurchaseConfirm } = vi.hoisted(() => ({
  getEvent: vi.fn(),
  getOrder: vi.fn(),
  notifyPurchaseConfirm: vi.fn(),
}));
vi.mock("@/lib/v2/commerce-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/v2/commerce-client")>(
    "@/lib/v2/commerce-client",
  );
  return { ...actual, getEvent, getOrder };
});
vi.mock("@/lib/notification/transactional", () => ({ notifyPurchaseConfirm }));

import { sendPurchaseConfirm } from "@/lib/notification/purchase-confirm-sender";

const ROW = {
  accountId: "acc-1", eventId: "evt-1", orderNumber: "ORD-1", v2OrderId: "v2-1",
  email: "a@b.c", phone: "01000000000", name: "구매자", ticketCount: 1,
};
const EVENT_DATE = "2026-08-20T07:00:00.000Z";

beforeEach(() => {
  vi.clearAllMocks();
  getEvent.mockResolvedValue({ title: "KLPGA", event_date: EVENT_DATE, venue: "포천힐스" });
  getOrder.mockResolvedValue({ tickets: [{ ticket_id: "11111111-2222-3333-4444-555555555555", status: "active" }] });
  notifyPurchaseConfirm.mockResolvedValue({ attempted: 2, failed: 0 });
});

describe("sendPurchaseConfirm — 버튼 인자", () => {
  it("🔴 ticketNumber·venueName·linkExpiresAt 을 반드시 넘긴다", async () => {
    // 승인 템플릿에 '모바일 티켓' 버튼이 있어 안 실으면 접수 A000 · 카카오 3027 거부다
    // (2026-07-28 실측). 즉 구매자는 못 받는데 로그엔 성공으로 남는다.
    const out = await sendPurchaseConfirm(ROW);

    expect(out.sent).toBe(true);
    const arg = notifyPurchaseConfirm.mock.calls[0]![0];
    expect(arg.ticketNumber).toBe("TKT-111111112222");
    expect(arg.venueName).toBe("포천힐스");
    // linkExpiresAt 이 없으면 토큰이 now+30일이라 **호출마다 값이 달라진다**.
    expect(arg.linkExpiresAt).toBe(new Date(EVENT_DATE).getTime() + 24 * 60 * 60 * 1000);
  });
});

describe("sendPurchaseConfirm — 티켓 상태 게이트", () => {
  it("🔴 전부 취소·만료면 보내지 않는다 — 죽은 링크로 '구매 완료' 를 보내면 회수 불가", async () => {
    getOrder.mockResolvedValue({
      tickets: [{ ticket_id: "t-1", status: "expired" }, { ticket_id: "t-2", status: "cancelled" }],
    });

    const out = await sendPurchaseConfirm(ROW);

    expect(out.sent).toBe(false);
    expect(notifyPurchaseConfirm).not.toHaveBeenCalled();
  });

  it("🔴 pending 티켓은 보낸다 — 무통장은 v2 confirm 이 비동기라 발송 시점에 pending 이다", async () => {
    getOrder.mockResolvedValue({
      tickets: [{ ticket_id: "11111111-2222-3333-4444-555555555555", status: "pending" }],
    });

    const out = await sendPurchaseConfirm(ROW);

    // 이걸 막으면 무통장 구매확정 알림톡이 통째로 끊긴다(한 번 그렇게 만들었다).
    expect(out.sent).toBe(true);
    expect(notifyPurchaseConfirm.mock.calls[0]![0].ticketNumber).toBe("TKT-111111112222");
  });

  it("살아있는 티켓이 섞여 있으면 active 를 고른다", async () => {
    getOrder.mockResolvedValue({
      tickets: [
        { ticket_id: "aaaaaaaa-0000-0000-0000-000000000000", status: "cancelled" },
        { ticket_id: "bbbbbbbb-0000-0000-0000-000000000000", status: "pending" },
        { ticket_id: "cccccccc-0000-0000-0000-000000000000", status: "active" },
      ],
    });

    await sendPurchaseConfirm(ROW);

    expect(notifyPurchaseConfirm.mock.calls[0]![0].ticketNumber).toBe("TKT-CCCCCCCC0000");
  });
});

describe("sendPurchaseConfirm — v2 조회 실패", () => {
  it("🔴 이벤트 조회 실패 시 폴백 발송하지 않는다 — '행사'/'-' 로 나가면 되돌릴 수 없다", async () => {
    getEvent.mockRejectedValue(new Error("v2 down"));

    const out = await sendPurchaseConfirm(ROW);

    expect(out.sent).toBe(false);
    expect(notifyPurchaseConfirm).not.toHaveBeenCalled();
  });

  it("🔴 주문 조회 실패 시에도 보내지 않는다 — 버튼 없는 발송은 3027 거부다", async () => {
    getOrder.mockRejectedValue(new Error("v2 down"));

    const out = await sendPurchaseConfirm(ROW);

    expect(out.sent).toBe(false);
    expect(notifyPurchaseConfirm).not.toHaveBeenCalled();
  });
});

describe("sendPurchaseConfirm — 결과 보고", () => {
  it("일부 채널 실패를 삼키지 않는다", async () => {
    notifyPurchaseConfirm.mockResolvedValue({ attempted: 2, failed: 1 });

    const out = await sendPurchaseConfirm(ROW);

    expect(out).toMatchObject({ sent: true, attempted: 2, failed: 1 });
  });
});
