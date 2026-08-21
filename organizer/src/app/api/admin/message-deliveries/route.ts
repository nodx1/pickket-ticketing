/**
 * Owner-only unknown/manual-review delivery queue.
 * GET is read-only; state-changing recovery is intentionally on [deliveryId]/route.ts.
 *
 * 원장은 v2 소유(레벨2 컷오버 W5-MSG). go DB SQL 0. 연락처 마스킹은 v2 가 수행한다.
 */
import { withRole } from "@/lib/auth/permissions";
import { listResponse, errorResponse } from "@/lib/apiResponse";
import {
  ledgerErrorStatus,
  listDeliveryQueue,
  V2MessagingLedgerError,
} from "@/lib/v2/messaging-ledger-client";

const ALLOWED_STATUSES = new Set(["unknown", "manual_review", "failed", "sent", "delivered"]);

export const GET = withRole("owner", async (request, { session }) => {
  const search = new URL(request.url).searchParams;
  const requestedStatus = search.get("status") ?? "unknown";
  const status = ALLOWED_STATUSES.has(requestedStatus) ? requestedStatus : "unknown";
  const limit = Math.min(Math.max(Number(search.get("limit") ?? "50") || 50, 1), 100);
  try {
    const rows = await listDeliveryQueue(session.accountId, status, limit);
    return listResponse(
      rows.map((r) => ({
        id: r.id,
        message_id: r.message_id,
        channel: r.channel,
        status: r.status,
        reason: r.reason,
        request_id: r.request_id,
        reconcile_attempts: r.reconcile_attempts,
        created_at: r.created_at,
        updated_at: r.updated_at,
        event_id: r.event_id,
        title: r.title,
        contact_masked: r.contact_masked,
      })),
      rows.length,
      1,
      limit,
    );
  } catch (err: unknown) {
    // 🔴 fail-closed: 미확정 발송 큐가 "비어 보이면" 수동검토가 필요한 건이 사라진다.
    if (err instanceof V2MessagingLedgerError) {
      return errorResponse(err.message, ledgerErrorStatus(err));
    }
    return errorResponse("발송 큐 조회에 실패했습니다", 500);
  }
});
