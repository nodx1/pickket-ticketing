import { errorResponse, listResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
// ── 레벨2 컷오버 W5-SUPPORT: go `event_reviews` → v2 `event_publication_reviews`. ──
//
// 🔴 v2 에 이미 있는 `reviews` 는 **관람객 후기**다. 이름만 비슷할 뿐 완전히 다른 개념이라
//    재사용하지 않고 별도 테이블(`event_publication_reviews`)을 신설했다. 둘을 섞으면
//    "후기 1건 = 승인 1건"이 되어 **미심사 이벤트가 공개**된다.
//
// 🔴 이 원장은 이벤트 공개 여부를 좌우한다 — 조회 실패를 "승인됨"으로도 "반려됨"으로도
//    흘리면 안 된다. 빈 목록(200)은 "심사 이력 없음"이라는 확정 사실로 오독되므로 금지.
//    v2 장애는 503 으로 **모른다고** 알린다.
import { listPublicationReviews, V2CommerceError } from "@/lib/v2/commerce-client";
import { EventAccessError, eventAccessStatus, getOwnedEvent } from "@/lib/v2/event-access";

type Params = { eventId: string };

/**
 * 이벤트 게시 심사 이력 조회 — 최신 순.
 * 주최자(자기 이벤트) 또는 어드민이 접근.
 *
 * 테넌트 경계: go `event_reviews` 에는 account_id 컬럼이 **없었고**(마이그 152)
 * `INNER JOIN events ... AND e.account_id = $2` 가 유일한 경계였다. v2 원장에도 account
 * 축을 두지 않았으므로 경계는 **v2 `events.organizer_id`** 가 강제한다.
 * 여기서 소유 검증 한 번(go 측 조기 차단), v2 조회에서 organizer_ref 로 또 한 번 — 이중으로
 * 건다(어느 한쪽이 느슨해져도 남의 반려 사유가 새지 않도록).
 *
 * 옛 `LEFT JOIN users u` 로 붙이던 심사자 이름은 v2 가 기록 시점 스냅샷(`reviewer_name`)으로
 * 보관한다 — 심사자가 go 유저/v2 어드민 양쪽이라 조인 대상 테이블이 하나가 아니기 때문.
 */
export const GET = withRole<Params>("staff", async (_request, { session, params }) => {
  try {
    const owned = await getOwnedEvent(params.eventId, session.accountId);
    if (!owned) {
      return errorResponse("이벤트를 찾을 수 없습니다", 404);
    }
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
    const result = await listPublicationReviews(params.eventId, session.accountId, { limit: 20 });
    const rows = result.reviews.map((r) => ({
      id: r.id,
      action: r.action,
      reason: r.reason,
      checklist: r.checklist,
      created_at: r.created_at,
      reviewer_name: r.reviewer_name,
    }));
    return listResponse(rows, rows.length);
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      // 🔴 404 조차 빈 목록으로 바꾸지 않는다. 위 소유 검증을 통과한 뒤의 404 는 경계
      //    불일치이므로 404 그대로, 그 밖의 장애는 전부 503(모름).
      if (err.status === 404) return errorResponse("이벤트를 찾을 수 없습니다", 404);
      return errorResponse("심사 이력을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    throw err;
  }
});
