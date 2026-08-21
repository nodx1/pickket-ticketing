import type { NextRequest } from "next/server";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withAuth } from "@/lib/auth/withAuth";
import { logger } from "@/lib/logger";
import {
  getOrganizerDashboard,
  listOrganizerEvents,
  resolveOrganizerRef,
  searchOrganizer,
  V2CommerceError,
} from "@/lib/v2/commerce-client";

// 빅뱅 read-flip §8 — go DB JOIN 집계 → v2 조직 대시보드 live read.
// organizer_ref = go account_id 그대로 전달(v2 _parse_org_ref 가 go_account_id 로 해석).
// 매출 헤드라인(todayRevenue/revenueTotal) = net_revenue(v2 _org_window_revenue 가 net).
//
// 합성 출처:
//  - live / thisWeek / actions(low_stock) : §8 getOrganizerDashboard
//  - recentActivity                        : §13 searchOrganizer(q="") 최근 주문
//  - upcomingEvents                        : organizers/{ref}/events live 목록(order_count/net revenue)
// ⚠️ v2 미제공 갭(빈/null 폴백):
//  - live.lastOrderMinutesAgo : §8 미제공 → null
//  - actions.recent_refunds / expiring_orders : §8 미제공 → low_stock 만 노출
export const GET = withAuth(async (_request: NextRequest, { session }) => {
  const accountId = session.accountId;
  // organizer_ref = 세션 v2UserId(= v2 User.id). v2 _resolve_organizer 가 organizer_id 로 1:1 해석.
  // go DB 미조회(레벨2 앵커전환). null(레거시 토큰) 시 account_id 폴백 → v2 go_account_id 재해석.
  const orgRef = resolveOrganizerRef(session.v2UserId) ?? accountId;

  try {
    const [org, search, events] = await Promise.all([
      getOrganizerDashboard(orgRef),
      // recentActivity: 최근 주문 5건(q 빈문자열=전체). v2 search 는 시간/주문번호 미제공.
      searchOrganizer(orgRef, { q: "", limit: 5 }),
      // upcomingEvents: live/draft 이벤트 목록(net revenue/order_count 포함).
      listOrganizerEvents(orgRef, { limit: 5 }),
    ]);

    const thisWeekRevenue = org.this_week_revenue;
    const lastWeekRevenue = org.last_week_revenue;
    const revenueVsLastWeek =
      lastWeekRevenue > 0
        ? `${thisWeekRevenue >= lastWeekRevenue ? "+" : ""}${(((thisWeekRevenue - lastWeekRevenue) / lastWeekRevenue) * 100).toFixed(1)}%`
        : thisWeekRevenue > 0
          ? "+100%"
          : "0%";

    // actions: v2 §8 은 low_stock_count 만 제공(recent_refunds/expiring_orders 미집계).
    const actions: Array<{ type: string; count: number; label: string }> = [];
    if (org.low_stock_count > 0) {
      actions.push({ type: "low_stock", count: org.low_stock_count, label: "매진 임박 상품" });
    }

    const orderStatusLabel = (status: string): string => {
      switch (status) {
        case "completed":
          return "결제 완료";
        case "pending":
          return "결제 대기";
        case "refunded":
          return "환불 완료";
        case "partially_refunded":
          return "부분 환불";
        default:
          return status;
      }
    };

    return successResponse({
      live: {
        // ★ net_revenue
        todayRevenue: org.today_revenue,
        todayOrders: org.today_orders,
        activeCheckIns: org.active_check_ins,
        // v2 §8 미제공 — go 기존 "마지막 주문 N분 전" 위젯은 null 폴백.
        lastOrderMinutesAgo: null,
      },
      thisWeek: {
        revenueTotal: thisWeekRevenue,
        orderTotal: org.this_week_orders,
        revenueVsLastWeek,
      },
      actions,
      recentActivity: search.orders.map((o) => ({
        type: "order",
        message: `주문 ${o.buyer_name ?? o.buyer_email ?? ""} ${orderStatusLabel(o.status)}`.trim(),
        // v2 search 는 ordered_at 미제공 — 시간 라벨 공란.
        time: "",
        // v2 search 주문행은 event_id 미제공 — 빈 문자열 폴백.
        eventId: "",
      })),
      upcomingEvents: events.events.map((e) => ({
        id: e.event_id,
        title: e.title,
        status: e.status,
        startsAt: e.event_date ?? "",
        orderCount: e.order_count,
        // ★ net = revenue − refund_amount
        revenue: e.revenue - e.refund_amount,
      })),
    });
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      logger.error("메인 대시보드 v2 집계 오류", {
        source: "dashboard-api",
        status: err.status,
        error: err.message,
      });
      return errorResponse("대시보드 데이터를 불러오지 못했습니다", 502);
    }
    logger.error("메인 대시보드 조회 실패", {
      source: "dashboard-api",
      error: err instanceof Error ? err.message : "알 수 없는 오류",
    });
    return errorResponse(err instanceof Error ? err.message : "알 수 없는 오류", 500);
  }
});
