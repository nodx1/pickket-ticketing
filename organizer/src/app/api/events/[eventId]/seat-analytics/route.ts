/**
 * 트랙 7.8 + 7.9 — 주최자 대시보드 좌석 통계 + funnel 분석
 *
 * GET /api/events/{eventId}/seat-analytics
 * 응답:
 *  - statusCounts: { available, held, reserved, sold, blocked }
 *  - tierStats: [{ tierId, name, sold, capacity, basePrice, fillRate }]
 *  - sectionTopRevenue: [{ section, revenue, sold }]  ← 매출 히트맵용
 *  - funnel: { view, hover, select, hold, checkout, complete }
 *  - funnelDropoffRate: { viewToSelect, selectToHold, holdToCheckout, checkoutToComplete }
 *
 * 빅뱅 read-flip D: 좌석 상태/티어/섹션매출 집계는 v2 §10(getSeatAnalytics).
 *
 * 레벨2 컷오버 T2-REST: funnel 도 v2 로 이관했다(옛 "go-local boundary" 해소).
 * go seat_funnel_events 직접 쿼리 → v2 `GET /internal/events/{id}/seat-funnel`.
 * 퍼널은 부가지표라 실패해도 0 으로 두고 좌석 집계는 그대로 응답한다(기존 fail-soft 유지).
 */
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { getSeatAnalytics, getSeatFunnel, V2CommerceError } from "@/lib/v2/commerce-client";
import { EventAccessError, resolveOwnedV2EventId } from "@/lib/v2/event-access";

type Params = { eventId: string };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET = withRole<Params>(
  "staff",
  async (_request, { params, session }) => {
    if (!UUID_RE.test(params.eventId)) {
      return errorResponse("잘못된 이벤트 ID", 400);
    }

    // ── 소유 검증 + v2 event id 해석 ──
    // 레벨2 컷오버 T2-EVT — go events 앵커 조회 폐기(go event id == v2 event id).
    // 테넌트 경계는 이제 v2 가 강제한다(organizer_ref 불일치 → not found).
    let v2EventId: string | null;
    try {
      v2EventId = await resolveOwnedV2EventId(params.eventId, session.accountId);
    } catch (err: unknown) {
      // 아래 집계 try/catch 밖이라 여기서 명시 처리 — v2 장애를 404 로 뭉개지 않는다.
      if (err instanceof EventAccessError) {
        return errorResponse("좌석 분석 데이터를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
      }
      throw err;
    }
    if (!v2EventId) {
      // 없거나 내 계정 소유가 아님 → 상세 스냅샷이므로 404
      return errorResponse("이벤트를 찾을 수 없습니다", 404);
    }

    // ── funnel: v2 정본 집계(T2-REST 이관). 실패는 0 으로 흡수(부가지표) ──
    const funnel: Record<string, number> = {
      view: 0,
      hover: 0,
      select: 0,
      hold: 0,
      checkout: 0,
      complete: 0,
      abandon: 0,
    };
    let funnelDropoffRate = {
      viewToSelect: 0,
      selectToHold: 0,
      holdToCheckout: 0,
      checkoutToComplete: 0,
    };
    try {
      const f = await getSeatFunnel(v2EventId, session.accountId, 7);
      for (const [step, count] of Object.entries(f.funnel)) {
        funnel[step] = Number(count);
      }
      funnelDropoffRate = {
        viewToSelect: f.dropoff_rate.view_to_select,
        selectToHold: f.dropoff_rate.select_to_hold,
        holdToCheckout: f.dropoff_rate.hold_to_checkout,
        checkoutToComplete: f.dropoff_rate.checkout_to_complete,
      };
    } catch {
      // funnel 누락은 비치명적 — 0 으로 유지(좌석 집계 응답은 그대로 내보낸다)
    }

    // ── 좌석 상태/티어/섹션매출 집계는 v2 §10 (SoT) ──
    try {
      const a = await getSeatAnalytics(v2EventId);

      // go 기존 응답 shape: statusCounts 5종 기본값 보장 후 v2 카운트 병합
      const statusCounts: Record<string, number> = {
        available: 0,
        held: 0,
        reserved: 0,
        sold: 0,
        blocked: 0,
      };
      for (const [status, count] of Object.entries(a.status_counts)) {
        statusCounts[status] = Number(count);
      }

      const tierStats = a.tier_stats.map((t) => ({
        tierId: t.tier_id,
        name: t.name,
        capacity: t.capacity,
        sold: t.sold,
        basePrice: t.base_price,
        fillRate: Math.round(t.fill_rate),
      }));

      const sectionTopRevenue = a.section_top_revenue.slice(0, 5).map((s) => ({
        section: s.section,
        sold: s.sold,
        revenue: s.revenue,
      }));

      return successResponse({
        statusCounts,
        tierStats,
        sectionTopRevenue,
        funnel,
        funnelDropoffRate,
        generatedAt: new Date().toISOString(),
      });
    } catch (err: unknown) {
      if (err instanceof V2CommerceError) {
        if (err.status === 404) return errorResponse("이벤트를 찾을 수 없습니다", 404);
        return errorResponse("좌석 분석 데이터를 불러오지 못했습니다 (v2 집계 일시 오류)", 502);
      }
      return errorResponse(err instanceof Error ? err.message : "알 수 없는 오류", 500);
    }
  },
);
