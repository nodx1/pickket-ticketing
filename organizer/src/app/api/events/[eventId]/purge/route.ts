import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { deleteEvent, V2CommerceError, type EventDetail } from "@/lib/v2/commerce-client";
import { EventAccessError, eventAccessStatus, requireOwnedEvent } from "@/lib/v2/event-access";

type Params = { eventId: string };

/**
 * 테스트 이벤트 **영구삭제**(하드삭제) — 보관됨 탭의 "영구삭제" 액션.
 *
 * 안전장치:
 *  1) 소유 경계 + 보관(archived) 상태 — v2 read 로 판정(옛 go `AND account_id=$2` 대체).
 *  2) v2 하드삭제(SoT) — v2 가 주문·티켓 0 + 소유권을 서버 재검증한 뒤 cascade 삭제.
 *     주문이 있으면 409, 미해결 자식은 409, 소유자 불일치 403.
 *
 * ## 🔴 레벨2 W2-EVT — "이미 지워짐" 흡수 규칙이 바뀌었다
 * 옛 코드는 v2 404 를 "이미 삭제됨"으로 흡수하고 go 앵커만 지운 뒤 `deleted:true` 를 냈다.
 * go 앵커가 사라진 지금 그 경로는 **아무것도 지우지 않고 지웠다고 응답**하는 거짓말이 된다.
 * → 존재 판정은 (1)의 v2 read 가 이미 했고, 그 뒤의 404 는 동시 삭제(경합)뿐이므로
 *   멱등하게 `deleted:true` 로 흡수해도 사실과 어긋나지 않는다.
 *   반면 **v2 장애(5xx/네트워크)는 절대 삭제 성공으로 흡수하지 않는다 → 503**.
 *
 * ⚠️ 옛 go-local 0건 가드(`orders`/`attendees` COUNT)는 제거했다. 동일 판정을 v2 가 SoT 로
 *    수행하며(409 EVENT_HAS_ORDERS/EVENT_HAS_DEPENDENTS), go 사본으로 재판정하면 오히려
 *    stale 투영으로 잘못 막거나 잘못 통과시킨다.
 */
export const DELETE = withRole<Params>("organizer", async (_request, { session, params }) => {
  let event: EventDetail;
  try {
    event = await requireOwnedEvent(params.eventId, session.accountId);
  } catch (err: unknown) {
    if (err instanceof EventAccessError) {
      return errorResponse(err.message, eventAccessStatus(err));
    }
    throw err;
  }

  if (event.status !== "archived") {
    return errorResponse("보관된 이벤트만 영구삭제할 수 있습니다. 먼저 보관 처리하세요.", 400);
  }

  try {
    await deleteEvent(event.event_id, session.accountId);
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      if (err.status === 409) {
        return errorResponse(
          "주문·참석자 또는 관련 데이터가 있어 영구삭제할 수 없습니다. 보관만 가능합니다.",
          409,
        );
      }
      if (err.status === 403) {
        return errorResponse("이 이벤트를 삭제할 권한이 없습니다.", 403);
      }
      if (err.status === 404) {
        // 위 read 이후 삭제된 경합 케이스 — 목표 상태(존재하지 않음)에 도달했으므로 멱등 성공.
        return successResponse({ deleted: true });
      }
      return errorResponse(
        "커머스 삭제 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.",
        503,
      );
    }
    throw err;
  }

  return successResponse({ deleted: true });
});
