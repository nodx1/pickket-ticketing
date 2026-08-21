/**
 * 정산 마감(동결) — 빅뱅 write-flip 완성.
 *
 * 정산 SoT = v2(OrganizerSettlement 동결값). go settlements 테이블 INSERT 제거.
 *   - #5 freezeSettlement(orgRef, {period_start, period_end, event_ids}) 단일 동결 위임.
 *   - 기존 501 스텁 제거.
 *
 * ⚠️ 모델 차이: v2 freeze 는 organizer·기간 단위 단일 동결(이벤트별 row 생성 아님).
 *   - 프런트(account-settlements-client.tsx handleFinalize)는 eventIds[] 송신 +
 *     {summary:{ok,skipped,error}, results:[{eventTitle,status,error?}]} 응답 기대.
 *   - 따라서 eventIds 전체를 event_ids 로 단일 freeze 호출 후, 결과를 단일 row 로 요약 매핑.
 *     (이벤트별 분해 결과는 v2 미제공 → results 는 동결 1건으로 표현.)
 *   - 기간: 명시 입력이 없으면 당월(1일 00:00 ~ 익월 1일 00:00, UTC) 산정.
 *     periodStart/periodEnd 를 ISO 로 받으면 우선 사용.
 */
import { z } from "zod";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import {
  freezeSettlement,
  resolveOrganizerRef,
  V2CommerceError,
} from "@/lib/v2/commerce-client";

const schema = z.object({
  eventIds: z.array(z.string().uuid()).min(1, "이벤트를 선택해주세요").max(50),
  // 선택: 정산 기간 직접 지정(미지정 시 당월).
  periodStart: z.string().datetime().optional(),
  periodEnd: z.string().datetime().optional(),
});

// 당월 [1일 00:00, 익월 1일 00:00) UTC 범위 산정.
function currentMonthRange(): { period_start: string; period_end: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  return { period_start: start.toISOString(), period_end: end.toISOString() };
}

// 정산 동결은 불가역 재무 작업 — staff/check_in 차단, admin 이상만 허용(P2-C11).
export const POST = withRole("admin", async (request, { session }) => {
  let parsed: z.infer<typeof schema>;
  try {
    parsed = schema.parse(await request.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? "입력값을 확인해주세요", 400);
    }
    return errorResponse("요청 본문을 파싱할 수 없습니다", 400);
  }

  const range =
    parsed.periodStart && parsed.periodEnd
      ? { period_start: parsed.periodStart, period_end: parsed.periodEnd }
      : currentMonthRange();

  if (new Date(range.period_end).getTime() <= new Date(range.period_start).getTime()) {
    return errorResponse("정산 종료일은 시작일보다 이후여야 합니다", 400);
  }

  try {
    const orgRef = resolveOrganizerRef(session.v2UserId) ?? session.accountId;
    const result = await freezeSettlement(
      orgRef,
      {
        period_start: range.period_start,
        period_end: range.period_end,
        event_ids: parsed.eventIds,
      },
      {
        // 동일 organizer·기간·이벤트셋 재호출은 동일 키로 재생(중복 동결 차단).
        idempotencyKey: `settlement-freeze:${orgRef}:${range.period_start}:${range.period_end}:${[...parsed.eventIds].sort().join(",")}`,
      },
    );

    // v2 단일 freeze 결과 → 프런트 기대 요약/결과 shape 으로 매핑.
    return successResponse({
      summary: { ok: 1, skipped: 0, error: 0 },
      results: [
        {
          eventTitle: `정산 동결 (${range.period_start.slice(0, 10)} ~ ${range.period_end.slice(0, 10)})`,
          status: "ok" as const,
          settlementId: result.settlement_id,
          grossAmount: result.gross_amount,
          netAmount: result.net_amount,
          orderCount: result.order_count,
        },
      ],
    });
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      // 동결 대상 매출이 없거나 검증 실패(400) 등은 results 의 error 로 표현(화면 비파괴).
      if (err.status >= 400 && err.status < 500) {
        return successResponse({
          summary: { ok: 0, skipped: 0, error: 1 },
          results: [
            {
              eventTitle: "정산 동결",
              status: "error" as const,
              error: err.message,
            },
          ],
        });
      }
      return errorResponse(err.message, 502);
    }
    return errorResponse(err instanceof Error ? err.message : "알 수 없는 오류", 500);
  }
});
