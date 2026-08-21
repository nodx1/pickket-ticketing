import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { goToV2WriteEventStatus } from "@/lib/domain-model";
import {
  updateEvent,
  goAccountRef,
  V2CommerceError,
  type EventDetail,
} from "@/lib/v2/commerce-client";
import { EventAccessError, eventAccessStatus, requireOwnedEvent } from "@/lib/v2/event-access";

type Params = { eventId: string };

/**
 * 보관(archived) 이벤트를 초안(draft)으로 복원. 보관됨 탭의 "복원" 액션.
 * 보관 처리(DELETE=archive)의 역연산 — v2 status 전이(cancelled→draft).
 *
 * 🔴 fail-closed: 옛 코드는 go UPDATE 의 `AND status='archived'` 로 상태를 걸렀고, v2 write 는
 *    실패해도 200 을 냈다(go=draft / v2=cancelled 발산). 이제 v2 가 유일 정본이므로
 *    상태 판정도 v2 read 로 하고, v2 write 실패는 **503** 이다(복원되지 않았으므로).
 */
export const POST = withRole<Params>("organizer", async (_request, { session, params }) => {
  let event: EventDetail;
  try {
    event = await requireOwnedEvent(params.eventId, session.accountId);
  } catch (err: unknown) {
    if (err instanceof EventAccessError) {
      // not_found → 404("복원할 보관된 이벤트를 찾을 수 없습니다"와 동일 의미), unavailable → 503.
      return errorResponse(
        err.reason === "not_found" ? "복원할 보관된 이벤트를 찾을 수 없습니다" : err.message,
        eventAccessStatus(err),
      );
    }
    throw err;
  }

  if (event.status !== "archived") {
    return errorResponse("복원할 보관된 이벤트를 찾을 수 없습니다", 404);
  }

  try {
    await updateEvent(
      event.event_id,
      {
        organizer_ref: goAccountRef(session.accountId),
        status: goToV2WriteEventStatus("draft") ?? "draft",
      },
      { idempotencyKey: `event-restore:${params.eventId}` },
    );
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      return errorResponse(
        "이벤트 복원 중 커머스 동기화에 실패했습니다. 잠시 후 다시 시도해주세요.",
        503,
      );
    }
    throw err;
  }

  return successResponse({ restored: true });
});
