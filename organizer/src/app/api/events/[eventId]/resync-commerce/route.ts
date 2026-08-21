import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { V2CommerceError } from "@/lib/v2/commerce-client";
import { resyncEventCommerce } from "@/lib/v2/commerce-resync";
import { EventAccessError } from "@/lib/v2/event-access";

type Params = { eventId: string };

/**
 * POST /api/events/{eventId}/resync-commerce (P1)
 * 커머스(상품·좌석티어)가 v2 에 누락/불일치된 이벤트를 수동 재동기화한다.
 */
export const POST = withRole<Params>("organizer", async (_request, { session, params }) => {
  try {
    const result = await resyncEventCommerce(params.eventId, session.accountId);
    return successResponse(result);
  } catch (err: unknown) {
    // 🔴 레벨2 T2-EVT — 소유 검증이 v2 조회로 바뀌면서 v2 응답불가는 EventAccessError 로 온다.
    //    EventAccessError 는 Error 라서 아래 폴백이 **400 + 내부 문구**로 흘려보낸다 → 재동기화가
    //    "요청이 잘못됐다"로 보이고 재시도를 포기하게 만든다. 재시도 가능한 503 으로 분리한다.
    if (err instanceof EventAccessError) {
      return errorResponse("이벤트 정보를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    if (err instanceof V2CommerceError) {
      return errorResponse("v2 커머스 동기화에 실패했습니다. 잠시 후 다시 시도해주세요.", 502);
    }
    return errorResponse(err instanceof Error ? err.message : "재동기화에 실패했습니다", 400);
  }
});
