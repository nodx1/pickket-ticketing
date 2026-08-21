import crypto from "node:crypto";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { regenerateWebhookSecret, V2CommerceError } from "@/lib/v2/commerce-client";
import { EventAccessError, resolveOwnedV2EventId } from "@/lib/v2/event-access";

type Params = { eventId: string; webhookId: string };

/**
 * Rotate the v2-owned signing secret. The unmasked value is returned once;
 * list/detail reads remain masked by v2.
 */
export const POST = withRole<Params>("organizer", async (_request, { session, params }) => {
  // ── 레벨2 컷오버 T2-EVT: go events 앵커 조회 제거. 옛 `AND account_id` 테넌트 경계는
  //    v2 `organizer_ref` 가 강제한다(불일치 → null → 기존과 동일하게 404).
  let v2EventId: string | null;
  try {
    v2EventId = await resolveOwnedV2EventId(params.eventId, session.accountId);
  } catch (err: unknown) {
    if (err instanceof EventAccessError) {
      return errorResponse("커머스 서버에 연결할 수 없습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    throw err;
  }
  if (!v2EventId) {
    return errorResponse("웹훅을 찾을 수 없습니다", 404);
  }

  try {
    const result = await regenerateWebhookSecret(
      v2EventId,
      params.webhookId,
      { idempotencyKey: `webhook-secret:${params.webhookId}:${crypto.randomUUID()}` },
    );
    return successResponse({ id: result.id, signingSecret: result.secret });
  } catch (error) {
    if (error instanceof V2CommerceError) {
      if (error.status === 404) {
        return errorResponse("웹훅을 찾을 수 없습니다", 404);
      }
      return errorResponse("서명 시크릿을 재발급하지 못했습니다", 502);
    }
    throw error;
  }
});
