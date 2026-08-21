import { z } from "zod";
import { errorResponse, listResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { ERR } from "@/lib/errors";
import {
  createEventQuestion,
  listEventQuestions,
  V2CommerceError,
} from "@/lib/v2/commerce-client";

/**
 * 레벨2 컷오버 W5-ATTENDEE — 예매 설문 문항 정의를 v2 정본으로 전환.
 *
 * 옛 경로는 go `event_questions` 에 직접 CRUD 한 뒤 `pushEventGapFields` 로 v2
 * `events.questions`(JSONB) 를 다시 밀어 넣는 **이중 저장소**였다. 이제 문항 정본이 v2
 * 테이블이고, v2 가 같은 트랜잭션에서 `events.questions` 투영을 갱신한다 → 정본/투영이
 * 갈라질 창이 구조적으로 없어졌고 go DB 참조가 0 이 됐다.
 *
 * 🔴 fail-closed: v2 조회 실패를 "설문 없음(빈 목록)"으로 위장하지 않는다. 체크아웃 폼에서
 *    빈 목록은 "이 행사는 설문이 없다"로 읽혀 **필수 응답을 받지 않고 결제**로 넘어간다.
 */
type Params = { eventId: string };

const schema = z.object({
  label: z.string().min(2, "질문 문구를 입력해주세요"),
  questionType: z.enum(["short_text", "long_text", "single_choice", "multiple_choice", "checkbox"]),
  isRequired: z.boolean(),
  options: z.array(z.string()).default([]),
  sortOrder: z.number().int().nonnegative().optional(),
});

const UNAVAILABLE = "설문 정보를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.";

export const GET = withRole<Params>("organizer", async (_request, { session, params }) => {
  try {
    const { questions } = await listEventQuestions(params.eventId, {
      accountId: session.accountId,
    });
    const rows = questions.map((q) => ({
      id: q.id,
      label: q.label,
      questionType: q.question_type,
      isRequired: q.is_required,
      options: q.options,
      sortOrder: q.sort_order,
    }));
    return listResponse(rows, rows.length);
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      // 404 = 이벤트 없음/타테넌트. 그 외(5xx·네트워크)는 장애 → 503.
      if (err.status === 404) return errorResponse(ERR.NOT_FOUND, 404);
      return errorResponse(UNAVAILABLE, 503);
    }
    throw err;
  }
});

export const POST = withRole<Params>("organizer", async (request, { session, params }) => {
  try {
    const body = schema.parse(await request.json());
    const { question } = await createEventQuestion(params.eventId, session.accountId, {
      label: body.label,
      question_type: body.questionType,
      is_required: body.isRequired,
      options: body.options,
      sort_order: body.sortOrder ?? null,
    });
    return successResponse({ id: question.id }, 201);
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? ERR.INVALID_INPUT, 400);
    }
    if (err instanceof V2CommerceError) {
      if (err.status === 404) return errorResponse(ERR.NOT_FOUND, 404);
      return errorResponse("설문 저장 중 커머스 동기화에 실패했습니다. 잠시 후 다시 시도해주세요.", 502);
    }
    return errorResponse(ERR.SERVER, 500);
  }
});
