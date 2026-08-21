import { createTicketLinkToken, TICKET_LINK_PARAM } from "@/lib/ticket-link-token";

/**
 * 🔴 같은 주문의 티켓 전환 목록 (2026-08-19, 대회 D-1).
 *
 * 「4장 샀는데 QR 이 하나만 보인다」를 푼다. prod 실측: 유료 복수구매 54명 · 120장 중
 * **64장이 링크로 닿지 않았다** — 알림톡 딥링크가 첫 장 하나뿐이고 티켓 화면에도
 * 나머지로 가는 길이 없었다.
 *
 * ## 🔴 형제 링크는 **각자의 토큰**을 새로 발급한다
 *
 * 내 토큰을 그대로 붙이면 `ticketLinkGrantsAccess` 의 티켓번호 대조에서 막힌다 —
 * 토큰은 티켓번호에 묶여 있다. 눌러도 `/my-tickets` 로 튕기는 줄만 늘어난다.
 *
 * ## 🔴 초대권이면 빈 목록
 *
 * 초대권은 **장마다 주인이 다르다**(1인 다장 상한 50, 양도 기능 있음). 주문이 같다는
 * 이유로 형제를 보여주면 남의 초대권이 열린다. v2 도 목록에서 빼지만 여기서도 막는다 —
 * 한쪽이 무너져도 유출이 안 되게(이중 방어).
 */
export interface OrderSiblingTicket {
  ticket_number: string;
  status: string;
  admission_day: string | null;
}

export interface OrderTicketItem {
  ticketNumber: string;
  href: string;
  isCurrent: boolean;
  /** F1 daypass 지정일 — 입구에서 날짜를 갈라야 한다. 없으면 null. */
  dayLabel: string | null;
}

export function buildOrderTicketItems(input: {
  /** v2 `order.tickets`. **`undefined` = 구버전이라 모른다** — 빈 목록으로 다룬다. */
  siblings: OrderSiblingTicket[] | undefined;
  currentTicketNumber: string;
  /** 초대권 화면인가. true 면 항상 빈 목록. */
  isInvitation: boolean;
}): OrderTicketItem[] {
  if (input.isInvitation) return [];
  const siblings = input.siblings ?? [];
  // 1장뿐이면 전환할 곳이 없다 — 줄을 띄우지 않는다(있으나 마나 한 UI 는 방해다).
  if (siblings.length < 2) return [];

  return siblings.map((sib) => ({
    ticketNumber: sib.ticket_number,
    isCurrent: sib.ticket_number === input.currentTicketNumber,
    dayLabel: sib.admission_day ? sib.admission_day.slice(5).replace("-", "/") : null,
    href: `/tickets/${encodeURIComponent(sib.ticket_number)}?${TICKET_LINK_PARAM}=${
      createTicketLinkToken({ ticketNumber: sib.ticket_number })
    }`,
  }));
}
