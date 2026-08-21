/**
 * 감사 로그 조회 — owner 전용, append-only(읽기만).
 *
 * 레벨2 컷오버 스코프A: 감사 정본이 v2(AuditLog)로 이관됨 → go audit_logs 직접조회 폐지,
 * v2 내부 감사 조회 엔드포인트로 프록시(fetchAuditLogs). account_id 경계는 v2 가 강제.
 *  - GET: 계정(account_id) 범위의 감사 로그 최신순. ?limit=N (1~200, 기본 50).
 *  - 권한: withRole("owner") → owner(5)만. admin(4) 이하는 403. 비인증 401(withAuth).
 *  - PATCH/DELETE 라우트는 의도적으로 부재(append-only) → 404. 불변은 v2 DB 트리거가 강제.
 */
import { errorResponse, listResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { fetchAuditLogs, V2AuditReadError } from "@/lib/v2/audit-read-client";

export const GET = withRole("owner", async (request, { session }) => {
  const limitParam = new URL(request.url).searchParams.get("limit");
  const limit = Math.min(Math.max(Number(limitParam) || 50, 1), 200);

  let logs;
  try {
    ({ logs } = await fetchAuditLogs({ accountId: session.accountId, limit }));
  } catch (err: unknown) {
    // fail-closed(P1): 감사 조회 장애를 "없음(200 빈목록)"으로 위장 금지 → 명시적 502/503.
    if (err instanceof V2AuditReadError) {
      return errorResponse("감사 로그 조회 서비스에 일시적으로 접근할 수 없습니다. 잠시 후 다시 시도해 주세요.", err.status);
    }
    return errorResponse("감사 로그 조회 중 오류가 발생했습니다.", 500);
  }

  const rows = logs.map((log) => ({
    id: log.id,
    account_id: log.accountId,
    user_id: log.userId,
    action: log.action,
    table_name: log.tableName,
    record_id: log.recordId,
    changes: log.changes,
    ip_address: log.ipAddress,
    created_at: log.createdAt,
  }));

  return listResponse(rows, rows.length, 1, limit);
});
