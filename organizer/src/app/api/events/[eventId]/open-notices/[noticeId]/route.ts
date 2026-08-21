/**
 * 주최자 공개 공지 단건 수정/삭제 — 레벨2 W5-CONTENT.
 *
 * go `open_notices` → v2 `organizer_open_notices` 이관. go DB read/write 0.
 * 정본 편집과 소비자 노출 투영(`event_announcements`, 발행분만) 재작성이 **v2 한 트랜잭션**에서
 * 끝난다 — 옛 "go 커밋 → v2 섹션 전체 재PUT" 이중 write 와 advisory lock 이 함께 사라졌다.
 *
 * 🔴 DELETE 는 v2 장애를 "이미 없음 → 200 deleted" 로 흡수하지 않는다(contentErrorResponse 가
 *    503 으로 끊는다). 지우지 않은 것을 지웠다고 응답하는 것이 가장 위험한 거짓말이다.
 */
import { withAuth } from "@/lib/auth/withAuth";
import { successResponse, errorResponse } from "@/lib/apiResponse";
import { logAudit } from "@/lib/audit";
import { deleteOrganizerNotice, patchOrganizerNotice } from "@/lib/v2/commerce-client";
import { contentErrorResponse } from "@/lib/v2/content-errors";
import { toClientNotice } from "@/lib/v2/organizer-content-view";
import { auditClientIp } from "@/lib/request-ip";

type Params = { eventId: string; noticeId: string };

const NOTICE_TYPES = ["cancellation", "refund", "schedule_change", "general"];
const NOT_FOUND = "공지를 찾을 수 없습니다";

export const PATCH = withAuth<Params>(async (request, { session, params }) => {
  const { eventId, noticeId } = await params;
  const body = (await request.json()) as {
    type?: string;
    title?: string;
    content?: string;
    isPublished?: boolean;
  };

  if (body.type !== undefined && !NOTICE_TYPES.includes(body.type)) {
    return errorResponse("유효하지 않은 공지 유형입니다", 400);
  }

  // 전달된 키만 patch — 미전달 필드는 v2 가 보존한다(부분 수정).
  const patch: {
    notice_type?: string; title?: string; content?: string; is_published?: boolean;
  } = {};
  if (body.type !== undefined) patch.notice_type = body.type;
  if (body.title !== undefined) patch.title = body.title;
  if (body.content !== undefined) patch.content = body.content;
  if (body.isPublished !== undefined) patch.is_published = body.isPublished;

  try {
    const updated = await patchOrganizerNotice(eventId, session.accountId, noticeId, patch);

    await logAudit({
      userId: session.id, accountId: session.accountId, action: "update",
      tableName: "organizer_open_notices", recordId: noticeId,
      changes: body,
      ipAddress: auditClientIp(request.headers),
    });

    return successResponse(toClientNotice(updated));
  } catch (err: unknown) {
    const mapped = contentErrorResponse(err, NOT_FOUND);
    if (mapped) return mapped;
    throw err;
  }
});

export const DELETE = withAuth<Params>(async (request, { session, params }) => {
  const { eventId, noticeId } = await params;

  try {
    await deleteOrganizerNotice(eventId, session.accountId, noticeId);

    await logAudit({
      userId: session.id, accountId: session.accountId, action: "delete",
      tableName: "organizer_open_notices", recordId: noticeId,
      changes: {},
      ipAddress: auditClientIp(request.headers),
    });

    return successResponse({ deleted: true });
  } catch (err: unknown) {
    const mapped = contentErrorResponse(err, NOT_FOUND);
    if (mapped) return mapped;
    throw err;
  }
});
