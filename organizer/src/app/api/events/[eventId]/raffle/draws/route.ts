import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { logger } from "@/lib/logger";
import { listRaffleDraws, V2CommerceError } from "@/lib/v2/commerce-client";
import { EventAccessError } from "@/lib/v2/event-access";

import { loadOwnedRaffleEvent, toGoDraw } from "../_shared";

type Params = { eventId: string };

/**
 * GET /api/events/[eventId]/raffle/draws — 추첨 실행 이력·결과 조회(최신순).
 * 이벤트 소유검증(account_id 경계) 후 v2 서비스토큰으로 이력 read. 각 행: 당첨 raffle_number·seed·시각.
 * 앵커 미준비(추첨 이력 없음) → 빈 목록.
 */
export const GET = withRole<Params>("organizer", async (_request, { params, session }) => {
  // 🔴 레벨2 T2-EVT — v2 응답불가(EventAccessError)를 잡지 않으면 정체불명 500 이 된다.
  //    "이력 없음(빈 목록)"으로도 "이벤트 없음(404)"으로도 뭉개지 않는다 — 둘 다 장애를 숨겨
  //    주최자가 추첨 결과가 사라진 줄 알게 만든다. 재시도 가능한 503 으로 명시한다.
  let event: Awaited<ReturnType<typeof loadOwnedRaffleEvent>>;
  try {
    event = await loadOwnedRaffleEvent(params.eventId, session.accountId);
  } catch (err: unknown) {
    if (err instanceof EventAccessError) {
      return errorResponse("이벤트 정보를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    throw err;
  }
  if (!event) return errorResponse("이벤트를 찾을 수 없습니다", 404);
  if (!event.v2EventId) {
    // 앵커 미준비 = 아직 추첨 이력 없음. 빈 목록으로 폴백(프론트 목록 렌더 안전).
    return successResponse({ draws: [] });
  }

  try {
    const result = await listRaffleDraws(event.v2EventId);
    return successResponse({ draws: result.draws.map(toGoDraw) });
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      if (err.status === 404) return successResponse({ draws: [] });
      logger.error("v2 추첨 이력 조회 실패", {
        eventId: params.eventId,
        status: err.status,
        message: err.message,
      });
      return errorResponse("추첨 이력을 불러오지 못했습니다", 502);
    }
    return errorResponse(err instanceof Error ? err.message : "알 수 없는 오류", 500);
  }
});
