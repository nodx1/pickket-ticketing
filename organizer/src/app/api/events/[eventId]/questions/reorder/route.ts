import { z } from "zod";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { ERR } from "@/lib/errors";
import { reorderEventQuestions, V2CommerceError } from "@/lib/v2/commerce-client";

/**
 * 레벨2 컷오버 W5-ATTENDEE — 문항 순서 변경을 v2 정본으로 전환.
 * 옛 go 트랜잭션(UNNEST UPDATE) + 별도 write-through 2단계가 v2 한 번의 원자 연산이 됐다.
 */
type Params = { eventId: string };

const schema = z.object({
  orderedIds: z.array(z.string().uuid()).min(1),
});

export const PUT = withRole<Params>("organizer", async (request, { session, params }) => {
  try {
    const body = schema.parse(await request.json());
    const { reordered } = await reorderEventQuestions(
      params.eventId,
      session.accountId,
      body.orderedIds,
    );
    return successResponse({ reordered: true, count: reordered });
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(ERR.INVALID_INPUT, 400);
    }
    if (err instanceof V2CommerceError) {
      if (err.status === 404) return errorResponse(ERR.NOT_FOUND, 404);
      return errorResponse("설문 순서 변경 중 커머스 동기화에 실패했습니다. 잠시 후 다시 시도해주세요.", 502);
    }
    return errorResponse(ERR.SERVER, 500);
  }
});
