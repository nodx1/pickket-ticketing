/**
 * 이벤트 감사 추적(compliance) 조회 — 레벨2 컷오버 스코프A.
 *
 * 감사 정본이 v2(AuditLog)로 이관됨 → go audit_logs 직접조회 폐지, v2 내부 compliance
 * 엔드포인트로 프록시(fetchComplianceAudit). account_id·event_id 경계는 v2 가 강제.
 * userName/userEmail 은 go user 가 v2 users FK 가 아니라 null(UI 는 '-' 표시).
 */
import { withAuth } from "@/lib/auth/withAuth";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { requireFeature } from "@/lib/server/require-feature";
import { fetchComplianceAudit, V2AuditReadError } from "@/lib/v2/audit-read-client";

type Params = { eventId: string };

export const GET = withAuth<Params>(async (request, { session, params }) => {
  const { eventId } = await params;
  const featureBlock = await requireFeature(eventId, session.accountId, "compliance");
  if (featureBlock) return featureBlock;

  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);

  try {
    const { logs, stats } = await fetchComplianceAudit({
      accountId: session.accountId,
      eventId,
      limit,
      offset,
    });
    return successResponse({ logs, stats });
  } catch (err: unknown) {
    // fail-closed(P1): 감사 이력 장애를 "없음"으로 위장 금지 → 명시적 502/503.
    if (err instanceof V2AuditReadError) {
      return errorResponse("감사 이력 조회 서비스에 일시적으로 접근할 수 없습니다. 잠시 후 다시 시도해 주세요.", err.status);
    }
    return errorResponse("감사 이력 조회 중 오류가 발생했습니다.", 500);
  }
});
