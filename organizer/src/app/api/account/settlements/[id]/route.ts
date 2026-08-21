/**
 * 정산 row 단건 — 빅뱅 read/write-flip 완성.
 *
 * 정산 SoT = v2(OrganizerSettlement 동결값). go settlements 테이블 미사용.
 *   - GET: #5 getSettlement(orgRef, settlementId) 단건 live read.
 *     (기존 listSettlements 페이지 스캔 워크어라운드 제거.)
 *   - PATCH: #5 updateSettlement 위임(입금완료/은행정보/메모). 기존 501 스텁 제거.
 *     go PATCH 스키마(status: pending|processing|completed, bankName/bankAccount/bankHolder)를
 *     v2 status 6값(draft|pending_review|reviewed|approved|paid|disputed) +
 *     bank_name/account_number/account_holder 로 매핑.
 *
 * ⚠️ 상태 매핑 주의: 프런트(account-settlements-client.tsx statusMeta)는 go 3값만 인식.
 *   - go→v2 (PATCH 송신): pending→draft, processing→approved, completed→paid
 *   응답의 status 는 v2 원본을 그대로 전달(목록 라우트 route.ts 와 동일 정책 — 매핑 불일치는 issues 참고).
 */
import { z } from "zod";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { projectToGoSettlementStatus } from "@/lib/domain-model";
import {
  getSettlement,
  resolveOrganizerRef,
  updateSettlement,
  V2CommerceError,
  type SettlementPatchInput,
} from "@/lib/v2/commerce-client";

const patchSchema = z.object({
  status: z.enum(["pending", "processing", "completed"]).optional(),
  bankName: z.string().max(50).nullable().optional(),
  bankAccount: z.string().max(50).nullable().optional(),
  bankHolder: z.string().max(50).nullable().optional(),
  memo: z.string().max(1000).nullable().optional(),
  paidAt: z.string().datetime().nullable().optional(),
});

type Params = { id: string };

// go 정산 상태(3값) → v2 정산 상태(6값) 매핑. completed=입금완료=paid.
const GO_TO_V2_STATUS: Record<"pending" | "processing" | "completed", string> = {
  pending: "draft",
  processing: "approved",
  completed: "paid",
};

// 정산 단건 read (account 소유 검증은 organizer_ref 스코프로 v2 가 보장).
export const GET = withRole<Params>("admin", async (_request, { session, params }) => {
  try {
    const orgRef = resolveOrganizerRef(session.v2UserId) ?? session.accountId;
    const row = await getSettlement(orgRef, params.id);
    return successResponse({
      id: row.settlement_id,
      accountId: session.accountId,
      eventId: null, // v2 정산은 organizer 단위 동결 — 이벤트 분해 미제공
      eventTitle: null, // SettlementDetail 에는 event_title 없음(기간 라벨로 대체)
      periodStart: row.period_start,
      periodEnd: row.period_end,
      grossAmount: row.gross_amount,
      platformFee: row.platform_fee,
      platformFeeRate: row.platform_fee_rate,
      pgFee: row.pg_fee,
      refundAmount: row.refund_amount,
      netAmount: row.net_amount,
      orderCount: row.order_count,
      status: projectToGoSettlementStatus(row.status), // v2 6-상태 → go 3-상태(프론트 정합)
      paidAt: row.paid_at,
      bankName: row.bank_name,
      bankAccount: row.account_number,
      bankHolder: row.account_holder,
      memo: row.memo,
    });
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      // 미존재/타 organizer 정산 → 404 SETTLEMENT_NOT_FOUND
      if (err.status === 404) {
        return errorResponse("정산 내역을 찾을 수 없습니다", 404);
      }
      return errorResponse(err.message, err.status >= 400 ? err.status : 502);
    }
    return errorResponse(err instanceof Error ? err.message : "알 수 없는 오류", 500);
  }
});

// 정산 입금완료/은행정보/메모 변경 = 정산 상태 write → #5 updateSettlement 위임.
export const PATCH = withRole<Params>("admin", async (request, { session, params }) => {
  let parsed: z.infer<typeof patchSchema>;
  try {
    parsed = patchSchema.parse(await request.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? "입력값을 확인해주세요", 400);
    }
    return errorResponse("요청 본문을 파싱할 수 없습니다", 400);
  }

  // go 페이로드 → v2 SettlementPatchInput 매핑(undefined 필드는 미전송).
  const input: SettlementPatchInput = {};
  if (parsed.status !== undefined) input.status = GO_TO_V2_STATUS[parsed.status];
  if (parsed.bankName !== undefined) input.bank_name = parsed.bankName;
  if (parsed.bankAccount !== undefined) input.account_number = parsed.bankAccount;
  if (parsed.bankHolder !== undefined) input.account_holder = parsed.bankHolder;
  if (parsed.memo !== undefined) input.memo = parsed.memo;
  // 입금완료 처리 시 paid_at 미지정이면 현재 시각으로 동결.
  if (parsed.paidAt !== undefined) {
    input.paid_at = parsed.paidAt;
  } else if (parsed.status === "completed") {
    input.paid_at = new Date().toISOString();
  }

  try {
    const orgRef = resolveOrganizerRef(session.v2UserId) ?? session.accountId;
    const result = await updateSettlement(orgRef, params.id, input, {
      idempotencyKey: `settlement-update:${params.id}:${parsed.status ?? "patch"}:${input.paid_at ?? "nopay"}`,
    });
    return successResponse({
      id: result.settlement_id,
      status: result.status,
      paidAt: result.paid_at,
    });
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      if (err.status === 404) {
        return errorResponse("정산 내역을 찾을 수 없습니다", 404);
      }
      return errorResponse(err.message, err.status >= 400 ? err.status : 502);
    }
    return errorResponse(err instanceof Error ? err.message : "알 수 없는 오류", 500);
  }
});
