import { withAuth } from "@/lib/auth/withAuth";
import { createSSEStream } from "@/lib/sse/stream";
import { getEventLive, V2CommerceError } from "@/lib/v2/commerce-client";
import { EventAccessError, resolveOwnedV2EventId } from "@/lib/v2/event-access";
import { logger } from "@/lib/logger";

// 빅뱅 read-flip D — 실시간 대시보드 스냅샷은 v2 가 SoT(net_revenue/order_count/checked_in_count/stock_remaining).
// go orders/attendees/products JOIN 제거 → 정정6 getEventLive 폴링(no-store).
// SSE 전송 형식(stats 이벤트)은 보존 — 프론트 비파괴. 5초 폴링 루프 유지.
// ★ 매출 헤드라인 = net_revenue(전액환불 자동 0). soldCount/잔여재고는 v2 sold/stock_remaining 기준.
// v2 read 보강 완료: total_attendees(체크인율 분모)/total_stock(잔여재고 바 분모) 실필드 재매핑.
export const GET = withAuth(async (request, { session, params }) => {
  const { eventId } = params as { eventId: string };
  const abortController = new AbortController();

  request.signal.addEventListener("abort", () => abortController.abort());

  const { stream, send, close } = createSSEStream(abortController.signal);

  // 레벨2 컷오버 T2-EVT — go events 앵커 조회 폐기(go event id == v2 event id).
  // 테넌트 경계는 이제 v2 가 강제한다(organizer_ref 불일치 → null → 스냅샷 미전송).
  // SSE 는 에러 응답 대신 "빈 스냅샷 + 경고" 가 기존 동작 → v2 일시 장애도 null 로 두고
  // 다음 폴링에서 소유 해석을 재시도한다(장애를 "이벤트 없음"으로 굳히지 않는다).
  const resolveAnchor = async (): Promise<string | null> => {
    try {
      return await resolveOwnedV2EventId(eventId, session.accountId);
    } catch (err: unknown) {
      if (err instanceof EventAccessError) {
        logger.warn("실시간 스냅샷 이벤트 소유 확인 실패(v2 일시 오류) — 다음 폴링 재시도", {
          source: "event-live-sse",
          eventId,
          reason: err.reason,
        });
        return null;
      }
      throw err;
    }
  };
  let v2EventId = await resolveAnchor();

  (async () => {
    try {
      while (!abortController.signal.aborted) {
        try {
          // 이벤트 미해석(없음/타 계정/ v2 일시 오류) → 빈 스냅샷 유지하며 SSE 연결 보존.
          if (!v2EventId) {
            logger.warn("실시간 스냅샷 이벤트 미해석 — 빈 스냅샷 유지", {
              source: "event-live-sse",
              eventId,
            });
            await new Promise((resolve) => setTimeout(resolve, 5000));
            v2EventId = await resolveAnchor();
            continue;
          }
          const live = await getEventLive(v2EventId);
          send("stats", {
            orders: live.order_count,
            // ★ net_revenue — 전액환불 자동 0
            revenue: live.net_revenue,
            // 체크인율 분모 = 전체 참석자(ticket) 수
            totalAttendees: live.total_attendees,
            checkedIn: live.checked_in_count,
            // 잔여재고 바 분모 = 총 재고
            totalStock: live.total_stock,
            remaining: live.stock_remaining,
            timestamp: live.ts,
          });
        } catch (err: unknown) {
          if (err instanceof V2CommerceError) {
            // 화면 비파괴: 스냅샷 일시 오류는 SSE 연결 유지하며 다음 폴링 재시도
            logger.warn("실시간 스냅샷 v2 일시 오류 — 다음 폴링 재시도", {
              source: "event-live-sse",
              eventId,
              status: err.status,
            });
          } else {
            throw err;
          }
        }

        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    } catch {
      // Connection closed
    } finally {
      close();
    }
  })();

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});
