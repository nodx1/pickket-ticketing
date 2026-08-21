/**
 * GET /api/events/[eventId]/widget — 임베드 코드 발급(주최자 전용).
 *
 * ── 레벨2 컷오버 W2-PUB ──
 * go `SELECT slug FROM events WHERE id=$1 AND account_id=$2` → v2 소유검증 read.
 * 🔴 `AND account_id = $2` 가 이 라우트의 **유일한 소유 검증**이었다 — 앵커만 지우고
 *    eventId 를 통과시키면 크로스테넌트 누출이다. `requireOwnedEvent` 가 v2 쪽에서
 *    organizer 경계를 강제한다(불일치 → 404).
 */
import { successResponse, errorResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { ERR } from "@/lib/errors";
import { EventAccessError, requireOwnedEvent } from "@/lib/v2/event-access";

type Params = { eventId: string };

export const GET = withRole<Params>("organizer", async (_request, { session, params }) => {
  let slug: string;
  try {
    slug = (await requireOwnedEvent(params.eventId, session.accountId)).slug;
  } catch (err: unknown) {
    if (err instanceof EventAccessError) {
      // 미존재·타계정 = 404, v2 불가 = 503(재시도 가능). 둘을 뭉개지 않는다.
      return err.reason === "not_found"
        ? errorResponse(ERR.NOT_FOUND, 404)
        : errorResponse("이벤트 정보를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    throw err;
  }

  const previewUrl = `/embed/${slug}`;
  const embedCode = `<iframe src="${previewUrl}" width="100%" height="720" style="border:0;"></iframe>`;
  return successResponse({ embedCode, previewUrl });
});
