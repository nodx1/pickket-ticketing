/**
 * 주최자 판매 단계 목록 — v2 `phase_configs` 정본 조회 프록시.
 *
 * 레벨2 컷오버 T2-PHASE: go `sale_phases` 는 제거됐다. 이 라우트는 go DB 의 판매단계를
 * 전혀 읽지 않고, 주최자 세션 인증(withRole) + 계정 소유검증만 담당한 뒤 v2 정본을 중계한다.
 * (브라우저는 v2 internal API 의 서비스 토큰/HMAC 을 가질 수 없으므로 서버 프록시가 필요.)
 */
import { withRole } from "@/lib/auth/permissions";
import { errorResponse, listResponse } from "@/lib/apiResponse";
import { ERR } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { EventAccessError } from "@/lib/v2/event-access";
import { fetchSalePlan } from "@/lib/v2/phase-client";

type Params = { eventId: string };

export const GET = withRole<Params>("staff", async (_request, { session, params }) => {
  try {
    // 계정 스코프 전달 — 타 주최자 이벤트의 판매전략 조회(IDOR) 차단. (감사 P1-6)
    const plan = await fetchSalePlan(params.eventId, session.accountId);
    if (!plan) return errorResponse(ERR.NOT_FOUND, 404);
    return listResponse(plan.phases, plan.total);
  } catch (err: unknown) {
    logger.warn("v2 판매 단계 조회 실패", {
      eventId: params.eventId,
      error: err instanceof Error ? err.message : "unknown",
    });
    // 이벤트 확인 자체가 불가(v2 장애)면 재시도 가능 신호 — 미존재(404)로도, 게이트웨이
    // 오류(502)로도 뭉개지 않는다.
    if (err instanceof EventAccessError) {
      return errorResponse("판매 단계를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    return errorResponse("판매 단계를 불러오지 못했습니다", 502);
  }
});
