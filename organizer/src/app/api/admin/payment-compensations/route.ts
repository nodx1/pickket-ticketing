import { withRole } from "@/lib/auth/permissions";
import { getPool } from "@/lib/db/pool";
import { listResponse } from "@/lib/apiResponse";

const ALLOWED_STATUSES = new Set(["pending", "processing", "failed", "failed_retryable", "unknown", "manual_review"]);

export const GET = withRole("owner", async (request, { session }) => {
  const search = new URL(request.url).searchParams;
  const requestedStatus = search.get("status") ?? "unknown";
  const status = ALLOWED_STATUSES.has(requestedStatus) ? requestedStatus : "unknown";
  const limit = Math.min(Math.max(Number(search.get("limit") ?? "50") || 50, 1), 100);
  // ── 레벨2 컷오버 W3-OPS ──
  // `payment_compensation_actions` 는 T3 **소멸군**이다(go 커머스 트랜잭션과 원자적으로 기록되는
  // 안전망 — v2 로 옮기면 패턴이 붕괴한다. 정본: LEVEL2-CUTOVER-EXEC-PLAN §T3). 따라서 go read 유지.
  //
  // 🔴 테넌트 앵커는 **orders.account_id** 다. `payment_compensation_actions` 에 account_id
  //    컬럼은 존재하지 않는다(196 생성문에 없음 · prod 실측 0건). 옛 쿼리는 `a.account_id` 를
  //    참조해 이 목록이 매 호출 42703(undefined_column) → 500 이었다 — 즉 미처리 환불
  //    (manual_review) 대기열이 운영 화면에서 아예 열리지 않았다.
  //    LEFT JOIN 이던 것을 INNER JOIN 으로 되돌리는 이유: 스코프가 orders 에 걸리므로 조인이
  //    필수다. 행 손실 우려는 없다 — order_id 는 NOT NULL + FK(ON DELETE CASCADE) 라
  //    짝 없는 보상 행이 존재할 수 없다(실 PG 통합테스트로 확인).
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT a.id, a.order_id, a.v2_order_id, a.status, a.reason,
            a.requested_amount, a.confirmed_refund_amount, a.attempt_count, a.max_attempts,
            a.provider_refund_id, a.provider_status, a.last_error_summary,
            a.manual_review_reason, a.unknown_since, a.created_at, a.updated_at,
            o.event_id
       FROM payment_compensation_actions a
       JOIN orders o ON o.id = a.order_id
      WHERE o.account_id = $1 AND a.status = $2
      ORDER BY a.created_at ASC
      LIMIT $3`,
    [session.accountId, status, limit],
  );
  return listResponse(rows, rows.length, 1, limit);
});
