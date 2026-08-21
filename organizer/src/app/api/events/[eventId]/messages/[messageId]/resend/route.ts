/**
 * 메시지 재발송 — v2 EventMessage 를 queued 로 되돌린다(발송은 v2 Celery 소유).
 *
 * 🔴 무조건 v2 위임(레벨2 컷오버 W5-MSG). 원장이 v2 로 이관돼 go DB 에는 되돌릴 행이 없다.
 *   flag 조건부로 두면 flag OFF 에서 없는 테이블을 UPDATE 한다.
 * 이미 발송된 수신자는 v2 원장 멱등(UNIQUE message_id/channel/contact)으로 스킵되고
 * 실패/미처리분만 재시도된다.
 */
import { withRole } from "@/lib/auth/permissions";
import { successResponse, errorResponse } from "@/lib/apiResponse";
import { requeueOrganizerMessage, V2CommerceError } from "@/lib/v2/commerce-client";

type Params = { eventId: string; messageId: string };

export const POST = withRole<Params>("organizer", async (_request, { session, params }) => {
  try {
    await requeueOrganizerMessage(params.messageId, {
      go_account_id: session.accountId,
      event_id: params.eventId,
    });
    return successResponse({ requeued: true });
  } catch (err: unknown) {
    if (err instanceof V2CommerceError && (err.status === 404 || err.status === 400)) {
      return errorResponse("재발송할 수 없는 메시지입니다", 400);
    }
    // 커머스 장애를 400 으로 뭉개면 주최자가 "메시지가 잘못됐다"고 오독한다 — 503(재시도 가능).
    return errorResponse("커머스 서버에 연결할 수 없어 재발송을 요청하지 못했습니다", 503);
  }
});
