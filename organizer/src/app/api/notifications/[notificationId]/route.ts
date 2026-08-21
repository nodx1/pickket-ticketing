import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withAuth } from "@/lib/auth/withAuth";
// ── 레벨2 컷오버 W5-SUPPORT: go `notifications` → v2 `organizer_notifications`. ──
// 테넌트 경계(옛 `AND account_id = $2`)는 v2 가 account_id 를 WHERE 에 강제해 유지한다.
// 🔴 DELETE 멱등 흡수 금지: "조회 실패 → 이미 없음 → 200 deleted" 로 뭉개면 남아 있는
//    알림을 지웠다고 거짓말하게 된다. v2 404(진짜 미존재/타 계정)만 404, 장애는 503.
import {
  deleteOrganizerNotification,
  markOrganizerNotificationRead,
  V2CommerceError,
} from "@/lib/v2/commerce-client";
import { ERR } from "@/lib/errors";

type Params = { notificationId: string };

export const PATCH = withAuth<Params>(async (_request, { session, params }) => {
  try {
    await markOrganizerNotificationRead(params.notificationId, session.accountId);
    return successResponse({ updated: true });
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      if (err.status === 404) return errorResponse(ERR.NOT_FOUND, 404);
      return errorResponse("읽음 처리에 실패했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    throw err;
  }
});

export const DELETE = withAuth<Params>(async (_request, { session, params }) => {
  try {
    await deleteOrganizerNotification(params.notificationId, session.accountId);
    return successResponse({ deleted: true });
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      // 404 = 없거나 내 계정 알림이 아님(존재 노출 금지). 그 외는 삭제되지 않았다 → 503.
      if (err.status === 404) return errorResponse(ERR.NOT_FOUND, 404);
      return errorResponse("알림을 삭제하지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    throw err;
  }
});
