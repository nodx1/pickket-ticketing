import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withAuth } from "@/lib/auth/withAuth";
// ── 레벨2 컷오버 W5-SUPPORT: go `notifications` → v2 `organizer_notifications`. ──
// 🔴 조회 실패를 `count: 0` 으로 흘리지 않는다. 0 은 "읽을 알림 없음"이라는 **확정 사실**로
//    읽히므로 뱃지가 조용히 사라지고 주최자는 장애를 인지하지 못한다. 503 으로 끊는다.
import { getOrganizerUnreadCount, V2CommerceError } from "@/lib/v2/commerce-client";

export const GET = withAuth(async (_request, { session }) => {
  try {
    const result = await getOrganizerUnreadCount(session.accountId);
    return successResponse({ count: result.count });
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      return errorResponse("알림 수를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    throw err;
  }
});
