import { z } from "zod";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { ERR } from "@/lib/errors";
import {
  archiveEventQuestion,
  patchEventQuestion,
  V2CommerceError,
} from "@/lib/v2/commerce-client";

/**
 * 레벨2 컷오버 W5-ATTENDEE — 문항 수정/삭제를 v2 정본으로 전환.
 *
 * 🔴 삭제 의미 변경(의도): v2 는 물리 DELETE 가 아니라 **보관(archived_at)** 이다.
 *    go 는 문항 행을 지웠고, 그러면 이미 발권된 티켓의 `answers`(문항 id 로 키잉)가
 *    라벨을 잃어 참석자 상세에서 **통째로 사라졌다**(응답은 남는데 보이지 않는 무성 손실).
 *    이제 주최자 폼에서는 사라지지만 응답 해석 경로(include_archived)에서는 살아 있다.
 *
 * 🔴 DELETE 멱등 흡수 금지: v2 장애를 "이미 없음 → 삭제 성공"으로 흘리지 않는다(503).
 */
type Params = { eventId: string; questionId: string };

const schema = z.object({
  label: z.string().min(2).optional(),
  questionType: z.enum(["short_text", "long_text", "single_choice", "multiple_choice", "checkbox"]).optional(),
  isRequired: z.boolean().optional(),
  options: z.array(z.string()).optional(),
});

const UNAVAILABLE = "설문 정보를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.";

export const PATCH = withRole<Params>("organizer", async (request, { session, params }) => {
  try {
    const body = schema.parse(await request.json());
    const { question } = await patchEventQuestion(
      params.eventId,
      params.questionId,
      session.accountId,
      {
        label: body.label,
        question_type: body.questionType,
        is_required: body.isRequired,
        options: body.options,
      },
    );
    return successResponse({ id: question.id });
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(ERR.INVALID_INPUT, 400);
    }
    if (err instanceof V2CommerceError) {
      if (err.status === 404) return errorResponse(ERR.NOT_FOUND, 404);
      if (err.status >= 400 && err.status < 500) {
        return errorResponse("설문 수정 중 커머스 동기화에 실패했습니다. 잠시 후 다시 시도해주세요.", 502);
      }
      return errorResponse(UNAVAILABLE, 503);
    }
    return errorResponse(ERR.SERVER, 500);
  }
});

export const DELETE = withRole<Params>("organizer", async (_request, { session, params }) => {
  try {
    await archiveEventQuestion(params.eventId, params.questionId, session.accountId);
    return successResponse({ deleted: true });
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      if (err.status === 404) return errorResponse(ERR.NOT_FOUND, 404);
      // 🔴 장애를 "이미 삭제됨"으로 흡수 금지 — 주최자가 지워졌다고 믿게 두지 않는다.
      return errorResponse(UNAVAILABLE, 503);
    }
    return errorResponse(ERR.SERVER, 500);
  }
});
