import { successResponse, errorResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { getEventReports, V2CommerceError, type EventReportType } from "@/lib/v2/commerce-client";
import { EventAccessError, resolveOwnedV2EventId } from "@/lib/v2/event-access";

type Params = { eventId: string };

export const GET = withRole<Params>("organizer", async (request, { params, session }) => {
  const rawType = new URL(request.url).searchParams.get("type") ?? "sales";
  const type: EventReportType = ["sales", "products", "promo", "attendees"].includes(rawType)
    ? (rawType as EventReportType)
    : "sales";

  try {
    // 레벨2 컷오버 T2-EVT — go events 앵커 조회 폐기(go event id == v2 event id).
    // 테넌트 경계는 이제 v2 가 강제한다(organizer_ref 불일치 → not found).
    const v2EventId = await resolveOwnedV2EventId(params.eventId, session.accountId);

    // 없거나 내 계정 소유가 아님 → 리포트 타입별 빈/0 폴백 유지(기존 동작 보존).
    if (!v2EventId) {
      if (type === "products") {
        return successResponse({
          type,
          items: [],
          summary: { totalSold: 0, totalRevenue: 0, totalStock: 0 },
        });
      }
      if (type === "promo") {
        return successResponse({ type, items: [] });
      }
      if (type === "attendees") {
        return successResponse({
          type,
          dailyRegistrations: [],
          summary: { totalAttendees: 0, checkedInCount: 0, checkInRate: 0 },
        });
      }
      return successResponse({
        type: "sales",
        dailySales: [],
        summary: { totalRevenue: 0, totalOrders: 0, avgOrderValue: 0, refundedAmount: 0 },
      });
    }

    if (type === "products") {
      const r = await getEventReports(v2EventId, "products");
      return successResponse({
        type,
        items: r.items.map((it) => ({
          name: it.name,
          sold: it.sold,
          revenue: it.revenue,
          stock: it.stock,
        })),
        summary: {
          totalSold: r.summary.total_sold,
          totalRevenue: r.summary.total_revenue,
          totalStock: r.summary.total_stock,
        },
      });
    }

    if (type === "promo") {
      const r = await getEventReports(v2EventId, "promo");
      return successResponse({
        type,
        items: r.items.map((it) => ({
          code: it.code,
          promoType: it.promo_type,
          usageCount: it.usage_count,
          // discountTotal: v2 실필드(고정할인=amount×used_count, 정률=null). 프론트 number 강제 폴백 0.
          discountTotal: it.discount_total ?? 0,
        })),
      });
    }

    if (type === "attendees") {
      const r = await getEventReports(v2EventId, "attendees");
      return successResponse({
        type,
        dailyRegistrations: r.daily_registrations.map((row) => ({
          date: row.date,
          count: row.count,
        })),
        summary: {
          totalAttendees: r.total_attendees,
          checkedInCount: r.checked_in_count,
          checkInRate: Math.round(r.check_in_rate),
        },
      });
    }

    const r = await getEventReports(v2EventId, "sales");
    return successResponse({
      type: "sales",
      dailySales: r.daily_sales.map((row) => ({
        date: row.date,
        amount: row.amount,
        count: row.count,
      })),
      summary: {
        // ★ 매출 헤드라인 = net_revenue (v2 total_revenue 가 이미 net)
        totalRevenue: r.total_revenue,
        totalOrders: r.total_orders,
        avgOrderValue: r.avg_order_value,
        refundedAmount: r.refunded_amount,
      },
    });
  } catch (err: unknown) {
    // v2 장애를 "빈 리포트(0원)"로 위장하지 않는다 — 소유 확인 자체가 불가한 상황은 503.
    if (err instanceof EventAccessError) {
      return errorResponse("리포트를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    if (err instanceof V2CommerceError) {
      if (err.status === 404) return errorResponse("이벤트를 찾을 수 없습니다", 404);
      return errorResponse("리포트 데이터를 불러오지 못했습니다 (v2 집계 일시 오류)", 502);
    }
    return errorResponse(err instanceof Error ? err.message : "알 수 없는 오류", 500);
  }
});
