import { listResponse, errorResponse } from "@/lib/apiResponse";
import { withAuth } from "@/lib/auth/withAuth";
import { projectToGoSettlementStatus } from "@/lib/domain-model";
import { listSettlements, resolveOrganizerRef, V2CommerceError } from "@/lib/v2/commerce-client";

// 빅뱅 read-flip D — 정산 목록은 v2 가 SoT(OrganizerSettlement 동결값).
// go settlements 테이블 JOIN 제거 → §12 listSettlements live read.
// organizer_ref = 세션 v2UserId(resolveOrganizerRef, go DB 미조회). null 시 account_id 폴백(v2 go_account_id 재해석).
// 매출 헤드라인: net_amount = net_payout(순지급액). month_summary → totalSummary.
export const GET = withAuth(async (request, { session }) => {
  const { searchParams } = new URL(request.url);
  const page = Math.max(Number(searchParams.get("page") ?? "1") || 1, 1);
  const limit = Math.min(Math.max(Number(searchParams.get("limit") ?? "20") || 20, 1), 100);
  const offset = (page - 1) * limit;

  try {
    const orgRef = resolveOrganizerRef(session.v2UserId) ?? session.accountId;
    const r = await listSettlements(orgRef, { limit, offset });

    const items = r.settlements.map((s) => ({
      id: s.settlement_id,
      accountId: session.accountId,
      eventId: null, // v2 정산은 organizer 단위 동결 — 이벤트 분해는 v2 미제공
      eventTitle: s.event_title, // v2 settlement=organizer·period 집계 → 항상 null(표시 라벨은 기간으로 대체 권장)
      periodStart: s.period_start,
      periodEnd: s.period_end,
      grossAmount: s.gross_amount,
      platformFee: s.platform_fee,
      platformFeeRate: s.platform_fee_rate,
      pgFee: s.pg_fee,
      refundAmount: s.refund_amount,
      netAmount: s.net_amount, // = net_payout(순지급액)
      orderCount: s.order_count,
      status: projectToGoSettlementStatus(s.status), // v2 6-상태 → go 3-상태(프론트 statusMeta 크래시 방지)
      paidAt: s.paid_at,
      bankName: s.bank_name,
      bankAccount: s.account_number,
      bankHolder: s.account_holder,
      memo: s.memo,
      v2ComputedAt: null,
      createdAt: null,
      updatedAt: null,
    }));

    const response = listResponse(items, r.total, page, limit);
    const body = await response.json();
    body.totalSummary = {
      grossAmount: r.month_summary.gross_amount,
      platformFee: r.month_summary.platform_fee,
      netAmount: r.month_summary.net_amount,
    };
    return Response.json(body, { status: response.status, headers: response.headers });
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      // 화면 비파괴: 빈 목록 + 0 요약 폴백
      const response = listResponse([], 0, page, limit);
      const body = await response.json();
      body.totalSummary = { grossAmount: 0, platformFee: 0, netAmount: 0 };
      return Response.json(body, { status: response.status, headers: response.headers });
    }
    return errorResponse(err instanceof Error ? err.message : "알 수 없는 오류", 500);
  }
});
