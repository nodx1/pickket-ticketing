/**
 * 수신함 목록 — 원장은 v2 소유(레벨2 컷오버 W5-MSG). go DB SQL 0.
 *
 * 🔴 테넌트 경계 2겹
 *   ① go: `getOwnedEvent`(v2 소유 read)로 이 이벤트가 내 것인지 먼저 확인 — 순서를 바꾸면
 *      남의 수신함이 열린다.
 *   ② v2: event_id 일치 + (account_id 가 있으면 반드시 일치). go 원본 inbound_emails 에는
 *      account_id 가 없어 ①이 유일한 경계였는데, 이관하며 ②를 가산했다.
 */
import { withAuth } from "@/lib/auth/withAuth";
import { successResponse, errorResponse } from "@/lib/apiResponse";
import { EventAccessError, eventAccessStatus, getOwnedEvent } from "@/lib/v2/event-access";
import {
  ledgerErrorStatus,
  listInboundEmails,
  V2MessagingLedgerError,
} from "@/lib/v2/messaging-ledger-client";

export const GET = withAuth(async (request, { session, params }) => {
  const { eventId } = params as { eventId: string };
  const status = new URL(request.url).searchParams.get("status") ?? "all";

  // 🔴 소유 검증은 아래 광범위 catch **밖**에서 — 안에 두면 v2 장애가 500 으로 뭉개져
  //    "수신함 조회 실패"로 위장된다. 미소유 404 / v2 장애 503 을 명확히 구분한다.
  try {
    const owned = await getOwnedEvent(eventId, session.accountId);
    if (!owned) return errorResponse("이벤트를 찾을 수 없습니다", 404);
  } catch (err: unknown) {
    if (err instanceof EventAccessError) {
      return errorResponse(
        "이벤트 정보를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.",
        eventAccessStatus(err),
      );
    }
    throw err;
  }

  try {
    const rows = await listInboundEmails(session.accountId, eventId, status);
    return successResponse(
      rows.map((e) => ({
        id: e.id,
        fromEmail: e.from_email,
        fromName: e.from_name,
        subject: e.subject,
        status: e.status,
        excerpt: e.excerpt,
        hasAiDraft: e.has_ai_draft,
        createdAt: e.created_at,
      })),
    );
  } catch (err: unknown) {
    // 🔴 fail-closed: 빈 배열로 흘리면 미답변 문의가 없는 것처럼 보인다.
    if (err instanceof V2MessagingLedgerError) {
      return errorResponse(err.message, ledgerErrorStatus(err));
    }
    return errorResponse("수신함 조회에 실패했습니다", 500);
  }
});
