/**
 * GET /api/events/[eventId]/live/summary — **주최자 인증** 라이브 요약.
 *
 * 공개 라우트(`/api/public/live/summary`)와 **응답 모양이 같다**(`LiveSummary` 그대로).
 * 다른 점은 하나뿐이다: 🔴 **리허설(`is_rehearsal: true`)이어도 그대로 내려준다.**
 *
 * ## 왜 별도 경로인가 — 🔴 경로 자체가 권한이다
 *
 * 8/6~8/19 의 리허설 데이터는 **다른 대회의 실제 스코어**다. 관중이 그걸 우리 대회로
 * 읽으면 엉뚱한 홀로 이동한다. 그래서 관중 경로에서는 막는다.
 *
 * 그런데 대회 전까지 화면을 확인할 방법이 없으면 아무도 검증을 못 한다 ⟹ **인증된
 * 경로에만** 리허설 통과를 둔다.
 *
 * ```
 * ✅ 경로 분리      /api/events/[eventId]/live/summary   (주최자 세션 + 소유 확인)
 * ❌ 쿼리 플래그    ?rehearsal=1 · X-Allow-Rehearsal 헤더 · 바디 필드
 *    🔴 클라이언트가 만들 수 있는 스위치는 스위치가 아니라 **구멍**이다.
 *       공개 라우트에 그런 인자를 하나라도 두면 그 순간 관중이 켤 수 있다.
 * ```
 *
 * ⚠️ 공개 라우트는 이 동작을 **절대 하지 않는다**. 그쪽은 `?ticket=` 만 받고, 리허설
 *    통과 인자를 받지 않는다(테스트로 고정돼 있다).
 */
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { getLiveSnapshot } from "@/lib/live/cache";
import { buildSummary, emptySummary } from "@/lib/live/summary";
import { EventAccessError, resolveOwnedV2EventId } from "@/lib/v2/event-access";

type Params = { eventId: string };

export const GET = withRole<Params>("organizer", async (_request, { session, params }) => {
  const { eventId } = await params;

  // 🔴 소유 확인 — 남의 행사 경로로 들어와도 데이터를 주지 않는다.
  //    ⚠️ v2 장애를 "권한 없음" 으로 강등하지 않는다. 정상 주최자가 영구 차단된다.
  try {
    const owned = await resolveOwnedV2EventId(eventId, session.accountId);
    if (!owned) {
      return errorResponse("행사를 찾을 수 없습니다", 404);
    }
  } catch (err: unknown) {
    if (err instanceof EventAccessError) {
      return errorResponse("행사 정보를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    throw err;
  }

  // 🔴 리허설이어도 그대로 내려준다. 걸러내는 판정(`isSpectatorVisible`)은 관중 화면의 몫이고,
  //    이 경로는 애초에 관중이 도달할 수 없다.
  const snap = await getLiveSnapshot();
  return successResponse(snap ? buildSummary(snap) : emptySummary());
});
