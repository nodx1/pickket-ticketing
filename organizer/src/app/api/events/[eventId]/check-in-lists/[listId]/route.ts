import { z } from "zod";
import { toIsoFromKstLocal } from "@/lib/datetime/kst-local";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { ERR } from "@/lib/errors";
import {
  deleteCheckInList,
  patchCheckInList,
  V2CommerceError,
} from "@/lib/v2/commerce-client";

/**
 * 레벨2 컷오버 W5-ATTENDEE — 체크인 명단 수정/삭제를 v2 정본으로 전환.
 *
 * 🔴 DELETE 멱등 흡수 금지: v2 장애를 "조회 실패 → 이미 없음 → 200 deleted" 로 흘리지
 *    않는다(503). 명단이 남아 있는데 지워진 줄 알면 현장에서 잘못된 게이트가 열린다.
 *    실제로 없을 때만 404 다(v2 가 404 로 구분해 준다).
 */
type Params = { eventId: string; listId: string };

const schema = z.object({
  name: z.string().min(2).optional(),
  productIds: z.array(z.string().uuid()).optional(),
  opensAt: z.string().optional(),
  closesAt: z.string().optional(),
  status: z.enum(["draft", "active", "closed"]).optional(),
});

const UNAVAILABLE = "체크인 명단 정보를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.";

export const PATCH = withRole<Params>("organizer", async (request, { session, params }) => {
  try {
    const body = schema.parse(await request.json());
    const { list } = await patchCheckInList(
      params.eventId,
      params.listId,
      session.accountId,
      {
        name: body.name,
        product_ids: body.productIds,
        opens_at: body.opensAt ? toIsoFromKstLocal(body.opensAt) : undefined,
        closes_at: body.closesAt ? toIsoFromKstLocal(body.closesAt) : undefined,
        status: body.status,
      },
    );
    return successResponse({ id: list.id });
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(ERR.INVALID_INPUT, 400);
    }
    if (err instanceof V2CommerceError) {
      if (err.status === 404) return errorResponse(ERR.NOT_FOUND, 404);
      return errorResponse(UNAVAILABLE, 503);
    }
    return errorResponse(ERR.SERVER, 500);
  }
});

export const DELETE = withRole<Params>("organizer", async (_request, { session, params }) => {
  try {
    await deleteCheckInList(params.eventId, params.listId, session.accountId);
    return successResponse({ deleted: true });
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      if (err.status === 404) return errorResponse(ERR.NOT_FOUND, 404);
      return errorResponse(UNAVAILABLE, 503);
    }
    return errorResponse(ERR.SERVER, 500);
  }
});
