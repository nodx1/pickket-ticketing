import { errorResponse, listResponse, successResponse } from "@/lib/apiResponse";
import { withAuth } from "@/lib/auth/withAuth";
// ── 레벨2 컷오버 W5-SUPPORT: go `notifications` → v2 `organizer_notifications`. ──
// go DB read/write 제거. 테넌트 경계(옛 `WHERE account_id = $1`)는 v2 가 account_id 를
// 필수 파라미터로 받아 목록·총계 **양쪽 쿼리**에 강제한다.
// 🔴 v2 장애를 "빈 목록"으로 위장하지 않는다 — 알림이 사라진 것처럼 보이면 주최자가
//    새 주문·환불 요청을 놓친다. 503(재시도 가능)으로 명확히 끊는다.
import {
  listOrganizerNotifications,
  markAllOrganizerNotificationsRead,
  V2CommerceError,
} from "@/lib/v2/commerce-client";

export const GET = withAuth(async (request, { session }) => {
  const { searchParams } = new URL(request.url);
  const page = Math.max(Number(searchParams.get("page") ?? "1") || 1, 1);
  const limit = Math.min(Math.max(Number(searchParams.get("limit") ?? "20") || 20, 1), 100);
  const unreadOnly = searchParams.get("unreadOnly") === "true";

  try {
    const result = await listOrganizerNotifications(session.accountId, {
      page,
      limit,
      unreadOnly,
    });
    // 응답 계약(camelCase)은 기존 프론트와 동일하게 유지.
    const items = result.items.map((n) => ({
      id: n.id,
      accountId: n.account_id,
      eventId: n.event_id,
      type: n.type,
      title: n.title,
      message: n.message,
      isRead: n.is_read,
      metadata: n.metadata,
      createdAt: n.created_at,
    }));
    return listResponse(items, result.total, page, limit);
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      return errorResponse("알림을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    throw err;
  }
});

export const PATCH = withAuth(async (_request, { session }) => {
  try {
    await markAllOrganizerNotificationsRead(session.accountId);
    return successResponse({ updated: true });
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      // 🔴 실패를 200 으로 흘리면 UI 는 읽음 처리된 것처럼 비우는데 원장은 그대로다.
      return errorResponse("읽음 처리에 실패했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    throw err;
  }
});
