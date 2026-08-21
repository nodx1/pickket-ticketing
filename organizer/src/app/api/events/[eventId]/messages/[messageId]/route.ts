/**
 * 단체메시지 단건 조회 — 원장은 v2 소유(레벨2 컷오버 W5-MSG). go DB SQL 0.
 * 소유 경계(account_id + event_id)는 v2 가 WHERE 로 강제한다.
 */
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { ERR } from "@/lib/errors";
import {
  getEventMessage,
  ledgerErrorStatus,
  V2MessagingLedgerError,
} from "@/lib/v2/messaging-ledger-client";

type Params = { eventId: string; messageId: string };

export const GET = withRole<Params>("organizer", async (_request, { session, params }) => {
  try {
    const msg = await getEventMessage(session.accountId, params.eventId, params.messageId);
    if (!msg) return errorResponse(ERR.NOT_FOUND, 404);
    return successResponse({
      id: msg.id,
      title: msg.title,
      channel: msg.channel,
      status: msg.status,
      body: msg.body,
      recipientFilter: msg.recipient_filter,
      sentCount: msg.sent_count,
      failedCount: msg.failed_count,
      resultMeta: msg.result_meta,
      sentAt: msg.sent_at,
      createdAt: msg.created_at,
    });
  } catch (err: unknown) {
    // 🔴 조회 실패를 404 로 뭉개지 않는다 — "없다"와 "확인 불가"는 다른 사실이다.
    if (err instanceof V2MessagingLedgerError) {
      return errorResponse(err.message, ledgerErrorStatus(err));
    }
    return errorResponse(ERR.SERVER, 500);
  }
});
