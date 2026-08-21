/**
 * 이벤트 커스텀 환불 정책 — 레벨2 컷오버 **W5-COMMERCE**. (**신규 라우트**)
 *
 * ## 왜 신규인가
 * go `refund_policies` 는 **읽기만 있고 저장 경로가 아예 없었다**(writer 0 — 실측).
 * 즉 커스텀 환불 정책은 DB 를 손으로 만지지 않는 한 존재할 수 없었고, 주문상세의 예상
 * 환불액과 환불 API 는 언제나 기본규칙으로만 동작했다. 기능을 폐기하지 않는다는 방침에 따라
 * v2 로 옮기면서 **write 경로를 신설**해 실제로 동작하게 만든다.
 *
 * ⚠️ 주최자 화면(UI)은 아직 없다 — 이 API 가 저장 경로의 전부다(프론트 트랙 후속).
 *
 * ## 🔴 실패 취급
 * 환불 정책은 환불 금액에 직결된다. 조회 실패를 "정책 없음"으로 흘리면 커스텀 정책 이벤트에서
 * 기본규칙이 적용돼 실제 환불액이 달라진다. 미소유/미존재 404 · v2 장애 503.
 */
import { z } from "zod";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { ERR } from "@/lib/errors";
import {
  clearEventRefundRules,
  getEventRefundRules,
  refundPolicyErrorStatus,
  saveEventRefundRules,
} from "@/lib/refund/policy";

type Params = { eventId: string };

const schema = z.object({
  title: z.string().min(1, "정책 이름을 입력해주세요").max(200),
  description: z.string().max(2000).nullable().optional(),
  rules: z
    .array(
      z.object({
        daysBefore: z.number().int().min(0, "기준 일수는 0 이상이어야 합니다"),
        percent: z.number().int().min(0).max(100, "환불율은 0~100 사이여야 합니다"),
        label: z.string().min(1, "구간 이름을 입력해주세요").max(100),
      }),
    )
    .min(1, "환불 규칙을 1개 이상 등록해주세요")
    .max(50),
});

function mapError(err: unknown, action: string) {
  const status = refundPolicyErrorStatus(err);
  if (status === 404) return errorResponse("이벤트를 찾을 수 없습니다.", 404);
  if (status === 503) {
    return errorResponse(
      `환불 정책을 ${action}하지 못했습니다. 잠시 후 다시 시도해주세요.`,
      503,
    );
  }
  return null;
}

export const GET = withRole<Params>("organizer", async (_request, { session, params }) => {
  try {
    const rules = await getEventRefundRules(session.accountId, params.eventId);
    // rules=null 은 "커스텀 정책 없음(기본규칙 적용)" 이라는 확정된 사실이다.
    // 조회 실패는 위 헬퍼가 던지고 아래 catch 가 503 으로 끊는다 — 둘이 섞이지 않는다.
    return successResponse({ rules: rules ?? null });
  } catch (err: unknown) {
    return mapError(err, "조회") ?? errorResponse(ERR.SERVER, 500);
  }
});

export const PUT = withRole<Params>("organizer", async (request, { session, params }) => {
  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await request.json());
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? ERR.INVALID_INPUT, 400);
    }
    return errorResponse(ERR.INVALID_INPUT, 400);
  }

  // 같은 기준 일수에 규칙이 둘이면 어느 환불율이 적용될지 정렬 안정성(=우연)에 달린다.
  const days = body.rules.map((r) => r.daysBefore);
  if (days.length !== new Set(days).size) {
    return errorResponse("같은 기준 일수를 가진 규칙이 중복되었습니다", 400);
  }

  try {
    const rules = await saveEventRefundRules(session.accountId, params.eventId, {
      title: body.title,
      description: body.description ?? null,
      rules: body.rules,
    });
    return successResponse({ rules });
  } catch (err: unknown) {
    return mapError(err, "저장") ?? errorResponse(ERR.SERVER, 500);
  }
});

export const DELETE = withRole<Params>("organizer", async (_request, { session, params }) => {
  try {
    const removed = await clearEventRefundRules(session.accountId, params.eventId);
    if (!removed) {
      // "이미 없음"을 성공으로 흡수하지 않는다(호출측이 멱등 판단).
      return errorResponse("등록된 커스텀 환불 정책이 없습니다", 404);
    }
    return successResponse({ deleted: true });
  } catch (err: unknown) {
    return mapError(err, "삭제") ?? errorResponse(ERR.SERVER, 500);
  }
});
