import { describe, expect, it } from "vitest";
import { buildOrderTicketItems } from "./order-siblings";
import { ticketLinkGrantsAccess } from "@/lib/ticket-link-token";
import { TICKET_LINK_PARAM } from "@/lib/ticket-link-token";

const sib = (n: string, day: string | null = null) => ({
  ticket_number: n, status: "active", admission_day: day,
});

describe("🔴 같은 주문의 티켓 전환 (2026-08-19 · 유료 복수구매 54명·64장 미도달)", () => {
  it("🔴 형제 링크가 **실제로 열린다** — 각자의 토큰이 발급된다", () => {
    // 내 토큰을 재사용하면 티켓번호 대조에서 막혀 눌러도 /my-tickets 로 튕긴다.
    // 그게 이 기능이 조용히 죽는 유일한 방식이라 여기서 못 박는다.
    const items = buildOrderTicketItems({
      siblings: [sib("T-1"), sib("T-2"), sib("T-3")],
      currentTicketNumber: "T-1",
      isInvitation: false,
    });
    for (const item of items) {
      const token = new URL(item.href, "https://go.pickket.kr").searchParams.get(TICKET_LINK_PARAM);
      expect(token, `${item.ticketNumber} 링크에 토큰이 없다`).toBeTruthy();
      expect(
        ticketLinkGrantsAccess({ token, ticketNumber: item.ticketNumber, status: "active" }),
        `${item.ticketNumber} 링크를 눌러도 안 열린다`,
      ).toBe(true);
    }
  });

  it("🔴 남의 티켓 토큰으로는 안 열린다 — 토큰이 번호에 묶여 있다", () => {
    const [first] = buildOrderTicketItems({
      siblings: [sib("T-1"), sib("T-2")], currentTicketNumber: "T-1", isInvitation: false,
    });
    const token = new URL(first.href, "https://go.pickket.kr").searchParams.get(TICKET_LINK_PARAM);
    expect(
      ticketLinkGrantsAccess({ token, ticketNumber: "T-OTHER", status: "active" }),
    ).toBe(false);
  });

  it("🔴 초대권이면 빈 목록 — 장마다 주인이 다르다", () => {
    expect(
      buildOrderTicketItems({
        siblings: [sib("T-1"), sib("T-2")], currentTicketNumber: "T-1", isInvitation: true,
      }),
    ).toEqual([]);
  });

  it("1장이면 줄을 안 띄운다", () => {
    expect(
      buildOrderTicketItems({ siblings: [sib("T-1")], currentTicketNumber: "T-1", isInvitation: false }),
    ).toEqual([]);
  });

  it("🔴 구버전 v2(undefined)면 빈 목록 — 없는 티켓으로 넘기지 않는다", () => {
    expect(
      buildOrderTicketItems({ siblings: undefined, currentTicketNumber: "T-1", isInvitation: false }),
    ).toEqual([]);
  });

  it("현재 티켓이 정확히 하나만 isCurrent", () => {
    const items = buildOrderTicketItems({
      siblings: [sib("T-1"), sib("T-2"), sib("T-3")], currentTicketNumber: "T-2", isInvitation: false,
    });
    expect(items.filter((i) => i.isCurrent).map((i) => i.ticketNumber)).toEqual(["T-2"]);
  });

  it("daypass 지정일은 MM/DD 로 — 입구에서 날짜를 갈라야 한다", () => {
    const items = buildOrderTicketItems({
      siblings: [sib("T-1", "2026-08-20"), sib("T-2", null)],
      currentTicketNumber: "T-1", isInvitation: false,
    });
    expect(items.map((i) => i.dayLabel)).toEqual(["08/20", null]);
  });

  it("🔴 번호에 특수문자가 있어도 링크가 깨지지 않는다", () => {
    const [item] = buildOrderTicketItems({
      siblings: [sib("T/1 #x"), sib("T-2")], currentTicketNumber: "T-2", isInvitation: false,
    });
    expect(item.href).toContain(encodeURIComponent("T/1 #x"));
  });
});
