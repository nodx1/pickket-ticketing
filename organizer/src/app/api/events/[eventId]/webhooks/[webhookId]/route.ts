import { z } from "zod";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import {
  deleteWebhookSubscription,
  getWebhookSubscription,
  patchWebhookSubscription,
  V2CommerceError,
} from "@/lib/v2/commerce-client";
import { EventAccessError, resolveOwnedV2EventId } from "@/lib/v2/event-access";

type Params = { eventId: string; webhookId: string };

const schema = z.object({
  name: z.string().min(2).optional(),
  endpointUrl: z.url().optional(),
  subscribedEvents: z.array(z.string().min(1)).min(1).optional(),
  status: z.enum(["active", "disabled"]).optional(),
});

/**
 * 부모 이벤트 소유 검증 + v2 event id 해석.
 *
 * ── 레벨2 컷오버 T2-EVT ──
 * go events 앵커 조회(`SELECT v2_event_id ... AND account_id = $2`)를 제거했다.
 * 옛 쿼리의 `AND account_id` 가 이 라우트의 유일한 테넌트 경계였고, 그 경계는 이제
 * v2 가 `organizer_ref` 로 강제한다(불일치 → 404).
 *
 * 반환은 성공/차단 응답의 합집합 — 없거나 타 계정 소유면 기존과 동일한 404,
 * v2 장애는 404 로 뭉개지 않고 503 으로 구분한다(3개 핸들러가 같은 처리를 공유).
 */
async function resolveV2EventId(
  eventId: string,
  accountId: string,
): Promise<{ v2EventId: string } | { error: Response }> {
  try {
    const v2EventId = await resolveOwnedV2EventId(eventId, accountId);
    if (!v2EventId) {
      return { error: errorResponse("웹훅을 찾을 수 없습니다", 404) };
    }
    return { v2EventId };
  } catch (err: unknown) {
    if (err instanceof EventAccessError) {
      return {
        error: errorResponse("커머스 서버에 연결할 수 없습니다. 잠시 후 다시 시도해주세요.", 503),
      };
    }
    throw err;
  }
}

export const GET = withRole<Params>("staff", async (_request, { session, params }) => {
  const gate = await resolveV2EventId(params.eventId, session.accountId);
  if ("error" in gate) return gate.error;
  const v2EventId = gate.v2EventId;

  try {
    const webhook = await getWebhookSubscription(v2EventId, params.webhookId);
    return successResponse({
      id: webhook.id,
      name: webhook.name,
      endpointUrl: webhook.url,
      signingSecret: webhook.secret,
      status: webhook.is_active ? "active" : "disabled",
      subscribedEvents: webhook.event_types,
      createdAt: webhook.created_at,
      logs: webhook.deliveries.map((delivery) => ({
        id: delivery.id,
        eventType: delivery.event_type,
        responseStatus: delivery.response_code,
        responseBody: delivery.response_body,
        status: delivery.status,
        attempts: delivery.attempts,
        createdAt: delivery.created_at,
      })),
    });
  } catch (error) {
    if (error instanceof V2CommerceError) {
      if (error.status === 404) {
        return errorResponse("웹훅을 찾을 수 없습니다", 404);
      }
      return errorResponse("웹훅을 불러오지 못했습니다", 502);
    }
    throw error;
  }
});

export const PATCH = withRole<Params>("organizer", async (request, { session, params }) => {
  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await request.json());
  } catch (error) {
    if (error instanceof z.ZodError) {
      return errorResponse(error.issues[0]?.message ?? "입력값을 확인해주세요", 400);
    }
    return errorResponse("요청 본문을 해석할 수 없습니다", 400);
  }

  const gate = await resolveV2EventId(params.eventId, session.accountId);
  if ("error" in gate) return gate.error;
  const v2EventId = gate.v2EventId;

  try {
    await patchWebhookSubscription(v2EventId, params.webhookId, {
      name: body.name,
      url: body.endpointUrl,
      event_types: body.subscribedEvents,
      is_active: body.status === undefined ? undefined : body.status === "active",
    });
    return successResponse({ updated: true });
  } catch (error) {
    if (error instanceof V2CommerceError) {
      if (error.status === 404) {
        return errorResponse("웹훅을 찾을 수 없습니다", 404);
      }
      if (error.status === 400 || error.status === 422) {
        return errorResponse("웹훅 입력값을 확인해주세요", 400);
      }
      return errorResponse("웹훅을 수정하지 못했습니다", 502);
    }
    throw error;
  }
});

export const DELETE = withRole<Params>("organizer", async (_request, { session, params }) => {
  const gate = await resolveV2EventId(params.eventId, session.accountId);
  if ("error" in gate) return gate.error;
  const v2EventId = gate.v2EventId;

  try {
    await deleteWebhookSubscription(v2EventId, params.webhookId);
    return successResponse({ deleted: true });
  } catch (error) {
    if (error instanceof V2CommerceError) {
      if (error.status === 404) {
        return errorResponse("웹훅을 찾을 수 없습니다", 404);
      }
      return errorResponse("웹훅을 삭제하지 못했습니다", 502);
    }
    throw error;
  }
});
