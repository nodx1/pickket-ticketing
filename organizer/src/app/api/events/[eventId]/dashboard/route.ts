import { successResponse, errorResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { ERR } from "@/lib/errors";
import { getEventDashboard, V2CommerceError } from "@/lib/v2/commerce-client";
import { EventAccessError, resolveOwnedV2EventId } from "@/lib/v2/event-access";

type Params = { eventId: string };

// 빅뱅 read-flip §7 — go DB JOIN 집계 → v2 이벤트 대시보드 live read.
// 매출 헤드라인 = net_revenue(전액환불 자동 0). productSales.sold = refunded 제외(v2 sold 정의).
export const GET = withRole<Params>("organizer", async (_request, { params, session }) => {
  try {
    // 레벨2 컷오버 T2-EVT — go events 앵커 조회 폐기(go event id == v2 event id).
    // 테넌트 경계는 이제 v2 가 강제한다(organizer_ref 불일치 → not found).
    const v2EventId = await resolveOwnedV2EventId(params.eventId, session.accountId);
    if (!v2EventId) {
      // 없거나 내 계정 소유가 아님 → 상세류는 기존 404 동작 보존.
      return errorResponse(ERR.NOT_FOUND, 404);
    }

    const d = await getEventDashboard(v2EventId);
    return successResponse({
      totalOrders: d.summary.total_orders,
      totalAttendees: d.summary.total_attendees,
      // ★ 매출 헤드라인 = net_revenue
      totalRevenue: d.summary.net_revenue,
      checkedInCount: d.summary.checked_in_count,
      dailySales: d.daily_sales.map((row) => ({
        date: row.date,
        amount: row.amount,
        count: row.count,
      })),
      productSales: d.product_sales.map((row) => ({
        name: row.name,
        sold: row.sold,
        revenue: row.revenue,
      })),
    });
  } catch (err: unknown) {
    // v2 가 응답 불가(5xx/네트워크)인 것을 404 로 뭉개지 않는다 — 일시 오류는 503.
    // (아래 broad catch 의 500 으로 흘리면 "서버 오류"로 오인되므로 명시 분기를 둔다.)
    if (err instanceof EventAccessError) {
      return errorResponse("이벤트 정보를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    if (err instanceof V2CommerceError) {
      // EVENT_NOT_FOUND(404) 는 go 기존 동작(404) 보존, 그 외 v2 장애는 502.
      if (err.status === 404) {
        return errorResponse(ERR.NOT_FOUND, 404);
      }
      return errorResponse("매출 데이터를 불러오지 못했습니다", 502);
    }
    return errorResponse(err instanceof Error ? err.message : ERR.SERVER, 500);
  }
});
