import { errorResponse } from "@/lib/apiResponse";
import { EventAccessError, getOwnedEvent } from "@/lib/v2/event-access";

/**
 * 토글 기능 API 서버측 가드.
 *
 * 사이드바는 enabled_features 로 메뉴만 숨기므로, URL 직접 호출로 꺼진 기능
 * (플랜/과금 단위) API 를 계속 쓸 수 있다. 각 토글 기능 라우트 핸들러 초입에서 호출한다.
 *
 * ── 레벨2 컷오버 T2-EVT ──
 * 정본이 go `events.enabled_features` → **v2 `events.enabled_features`** 로 이관됐다
 * (마이그 ctevt_0727). 소유 검증(옛 `AND account_id = $2`)도 v2 가 organizer_ref 로 강제한다.
 *
 * 🔴 fail-closed 원칙: 이벤트를 못 찾으면 404, 기능이 목록에 없으면 403.
 * v2 장애(5xx/타임아웃)는 **503 으로 차단**한다 — "확인 불가"를 "허용"으로 바꾸면
 * 과금 대상 기능이 무료로 열린다. 게이트는 모르면 막는다.
 *
 * @returns 차단 시 Response, 통과 시 null
 */
export async function requireFeature(
  eventId: string,
  accountId: string,
  feature: string,
): Promise<Response | null> {
  let enabledFeatures: string[];
  try {
    const event = await getOwnedEvent(eventId, accountId);
    if (!event) {
      return errorResponse("이벤트를 찾을 수 없습니다", 404);
    }
    // v2 는 항상 배열을 내려준다. 그래도 방어적으로 비배열이면 빈 배열(=전부 차단)로 본다.
    enabledFeatures = Array.isArray(event.enabled_features) ? event.enabled_features : [];
  } catch (err: unknown) {
    if (err instanceof EventAccessError) {
      // 🔴 확인 불가 ≠ 허용. 게이트는 열지 않는다.
      return errorResponse(
        "기능 사용 권한을 확인할 수 없습니다. 잠시 후 다시 시도해주세요.",
        503,
      );
    }
    throw err;
  }

  if (!enabledFeatures.includes(feature)) {
    return errorResponse("이 기능이 활성화되지 않았습니다. 기능 관리에서 먼저 켜주세요.", 403);
  }
  return null;
}
