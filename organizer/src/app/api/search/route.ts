import type { NextRequest } from "next/server";
import { successResponse, errorResponse } from "@/lib/apiResponse";
import { withAuth } from "@/lib/auth/withAuth";
import { resolveOrganizerRef, searchOrganizer, V2CommerceError } from "@/lib/v2/commerce-client";
import { logger } from "@/lib/logger";

// 빅뱅 read-flip D — 통합 검색은 v2 가 SoT(events/orders/attendees 인덱스).
// go events/orders/attendees JOIN 제거 → §13 searchOrganizer live read.
// organizer_ref = go account_id 그대로. status 는 v2 가 go 투영(이벤트 4-상태/주문 6-상태)으로 반환.
// v2 read 보강 반영: events.slug · orders.event_id/order_number/ordered_at · attendees 검색결과 실필드 매핑.
export const GET = withAuth(async (request: NextRequest, { session }) => {
  const query = request.nextUrl.searchParams.get("q")?.trim() ?? "";

  if (!query || query.length < 2) {
    return successResponse({
      events: [],
      orders: [],
      attendees: [],
    });
  }

  try {
    const orgRef = resolveOrganizerRef(session.v2UserId) ?? session.accountId;
    const r = await searchOrganizer(orgRef, { q: query, limit: 5 });

    return successResponse({
      events: r.events.map((e) => ({
        id: e.event_id,
        title: e.title,
        slug: e.slug,
        status: e.status, // go 4-상태 투영
        startsAt: null, // v2 §13 미반환(이벤트 일시는 상세 read에서)
      })),
      orders: r.orders.map((o) => ({
        // 주문 상세·환불 라우트는 **go order id** 로 조회한다(orders/route.ts 주석 참조).
        // v2 id 를 내리면 검색에서 주문을 눌러도 404 가 된다.
        id: o.external_order_id ?? o.order_id,
        eventId: o.event_id,
        orderNumber: o.order_number, // = external_ref (없으면 order_id)
        buyerName: o.buyer_name,
        buyerEmail: o.buyer_email,
        status: o.status, // go 6-상태 투영
        orderedAt: o.ordered_at,
      })),
      attendees: r.attendees.map((a) => ({
        id: a.ticket_id,
        eventId: a.event_id,
        name: a.name,
        email: a.email,
      })),
    });
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      // 화면 비파괴: 빈 결과 폴백(검색 위젯이 죽지 않도록)
      logger.warn("통합 검색 v2 일시 오류 — 빈 결과 폴백", {
        source: "search-api",
        status: err.status,
      });
      return successResponse({ events: [], orders: [], attendees: [] });
    }
    logger.error("통합 검색 실패", {
      source: "search-api",
      error: err instanceof Error ? err.message : "알 수 없는 오류",
    });
    return errorResponse(err instanceof Error ? err.message : "알 수 없는 오류", 500);
  }
});
