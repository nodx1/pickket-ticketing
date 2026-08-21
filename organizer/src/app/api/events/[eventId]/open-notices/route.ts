/**
 * 주최자 공개 공지 목록/생성 — 레벨2 W5-CONTENT.
 *
 * go `open_notices` → v2 `organizer_open_notices` 이관. go DB read/write 0.
 *
 * ## 옛 구조와 무엇이 달라졌나
 * 예전엔 go 가 원본을 갖고, 매 편집마다 **발행분 전체를 다시 읽어 v2 content 섹션을 통째로
 * PUT**(write-through)했다. 그 구조에는 두 결함이 있었다.
 *   · go 커밋과 v2 PUT 사이가 원자적이지 않다 → 한쪽만 반영되는 창이 존재(502 후 stale).
 *   · 동시 편집 시 오래된 스냅샷이 최신을 덮어쓴다(go 가 advisory lock 으로 막아야 했다).
 * 이제 정본도 소비자 투영(`event_announcements`)도 **v2 안에 있고 같은 트랜잭션에서** 갱신된다
 * (`internal_organizer_content._reproject_notices`). 이중 write 자체가 사라졌다.
 *
 * 소비자 노출은 여전히 **발행(is_published=true) 공지만**이다 — 투영 시 v2 가 필터한다.
 * 테넌트 경계는 v2 가 `organizer_ref` 로 강제한다(불일치 → 404).
 */
import { randomUUID } from "node:crypto";
import { withAuth } from "@/lib/auth/withAuth";
import { successResponse, errorResponse } from "@/lib/apiResponse";
import { logAudit } from "@/lib/audit";
import { createOrganizerNotice, listOrganizerNotices } from "@/lib/v2/commerce-client";
import { contentErrorResponse } from "@/lib/v2/content-errors";
import { toClientNotice } from "@/lib/v2/organizer-content-view";
import { auditClientIp } from "@/lib/request-ip";

type Params = { eventId: string };

const NOTICE_TYPES = ["cancellation", "refund", "schedule_change", "general"];
const NOT_FOUND = "이벤트를 찾을 수 없습니다";

export const GET = withAuth<Params>(async (_request, { session, params }) => {
  const { eventId } = await params;
  try {
    const { notices } = await listOrganizerNotices(eventId, session.accountId);
    return successResponse(notices.map(toClientNotice));
  } catch (err: unknown) {
    // 🔴 목록 실패를 빈 배열로 폴백하지 않는다 — 주최자가 "공지가 다 사라졌다"고 읽는다.
    const mapped = contentErrorResponse(err, NOT_FOUND);
    if (mapped) return mapped;
    throw err;
  }
});

export const POST = withAuth<Params>(async (request, { session, params }) => {
  const { eventId } = await params;
  const body = (await request.json()) as {
    type: string; title: string; content: string; isPublished?: boolean;
  };

  if (!body.title || !body.content) return errorResponse("제목과 내용은 필수입니다", 400);
  if (!NOTICE_TYPES.includes(body.type)) {
    return errorResponse("유효하지 않은 공지 유형입니다", 400);
  }

  // 행 id 를 호출측이 만든다 → 네트워크 재시도로 같은 요청이 두 번 도착해도 중복 공지가 생기지 않는다.
  const itemId = randomUUID();

  try {
    const created = await createOrganizerNotice(eventId, session.accountId, itemId, {
      notice_type: body.type,
      title: body.title,
      content: body.content,
      is_published: body.isPublished ?? false,
    });

    await logAudit({
      userId: session.id, accountId: session.accountId, action: "create",
      tableName: "organizer_open_notices", recordId: created.id,
      changes: { type: body.type, title: body.title },
      ipAddress: auditClientIp(request.headers),
    });

    return successResponse(toClientNotice(created));
  } catch (err: unknown) {
    const mapped = contentErrorResponse(err, NOT_FOUND);
    if (mapped) return mapped;
    throw err;
  }
});
