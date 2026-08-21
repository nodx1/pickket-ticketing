/**
 * T2-ORD: 발송 세그먼트 "특정 상품 구매자" → v2 티켓 해석.
 *
 * 기존엔 go `order_items`(oi.order_id = attendees.order_id AND oi.product_id = ANY(...))
 * EXISTS 로 판정했다. 그런데 `order_items` 는 **프로덕션 write 0 의 死테이블**이라
 * v2-흐름 참석자에게는 이 EXISTS 가 항상 false → **조용한 0명 발송**이 된다.
 * (그렇다고 조건을 그냥 지우면 반대로 **전체 발송**이 되어 더 위험하다.)
 *
 * 정본은 v2 티켓의 tier(external_ref = go productId)다. 여기서 v2 참석자 목록을
 * 페이지네이션하며 해당 상품의 ticket_id 를 모아, go `attendees.v2_ticket_id` 와 매칭한다.
 * 조회 실패는 **throw**(fail-closed) — 빈 목록 위장은 다시 조용한 무발송이다.
 */
import { listAttendees, V2CommerceError } from "@/lib/v2/commerce-client";

const PAGE_SIZE = 500; // v2 listAttendees 상한
/** 폭주 방지 상한(= 25만 티켓). 초과 이벤트는 세그먼트 대신 전체발송/개별선택을 쓴다. */
const MAX_PAGES = 500;

export class V2SegmentTicketsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "V2SegmentTicketsError";
  }
}

/**
 * 주어진 go productId 집합을 구매한 v2 ticket_id 목록.
 * v2EventId = events.v2_event_id(canonical). 0건이면 정상적으로 빈 배열.
 */
export async function fetchTicketIdsByProductRefs(
  v2EventId: string,
  productIds: string[],
): Promise<string[]> {
  if (productIds.length === 0) return [];
  const wanted = new Set(productIds.map((p) => String(p)));
  const ticketIds: string[] = [];

  for (let page = 0; page < MAX_PAGES; page += 1) {
    let result: Awaited<ReturnType<typeof listAttendees>>;
    try {
      result = await listAttendees(v2EventId, { limit: PAGE_SIZE, offset: page * PAGE_SIZE });
    } catch (err: unknown) {
      throw new V2SegmentTicketsError(
        err instanceof V2CommerceError
          ? `상품 세그먼트 조회에 실패했습니다: ${err.message}`
          : "상품 세그먼트 조회 중 커머스 연결에 실패했습니다",
      );
    }
    for (const row of result.attendees) {
      if (row.product_external_ref && wanted.has(row.product_external_ref)) {
        ticketIds.push(row.ticket_id);
      }
    }
    if (result.attendees.length < PAGE_SIZE) break;
  }

  return ticketIds;
}
