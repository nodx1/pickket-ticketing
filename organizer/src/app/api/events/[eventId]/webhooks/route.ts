import crypto from "node:crypto";
import { z } from "zod";
import { errorResponse, listResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import {
  createWebhookSubscription,
  listWebhookSubscriptions,
  V2CommerceError,
} from "@/lib/v2/commerce-client";
import { EventAccessError, resolveOwnedV2EventId } from "@/lib/v2/event-access";

type Params = { eventId: string };

const schema = z.object({
  name: z.string().min(2, "이름을 입력해주세요"),
  endpointUrl: z.url("올바른 엔드포인트 URL을 입력해주세요"),
  subscribedEvents: z.array(z.string().min(1)).min(1, "구독 이벤트를 하나 이상 선택해주세요"),
});

export const GET = withRole<Params>("staff", async (_request, { session, params }) => {
  // ── 레벨2 컷오버 T2-EVT: go events 앵커 조회 제거. 옛 `AND account_id = $2` 테넌트 경계는
  //    v2 가 `organizer_ref` 로 강제한다(불일치 → 404 → null → 기존과 동일하게 409).
  let v2EventId: string | null;
  try {
    v2EventId = await resolveOwnedV2EventId(params.eventId, session.accountId);
  } catch (err: unknown) {
    // v2 장애를 "미동기화(409)"로 뭉개지 않는다 — 아래 catch 는 V2CommerceError 만 잡는다.
    if (err instanceof EventAccessError) {
      return errorResponse("커머스 서버에 연결할 수 없습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    throw err;
  }
  if (!v2EventId) {
    return errorResponse("이벤트가 아직 커머스에 동기화되지 않았습니다", 409);
  }

  try {
    const result = await listWebhookSubscriptions(v2EventId);
    const items = result.webhooks.map((webhook) => ({
      id: webhook.id,
      name: webhook.name,
      endpointUrl: webhook.url,
      signingSecret: webhook.secret,
      status: webhook.is_active ? "active" : "disabled",
      subscribedEvents: webhook.event_types,
      createdAt: webhook.created_at,
    }));
    return listResponse(items, result.total);
  } catch (error) {
    if (error instanceof V2CommerceError) {
      return errorResponse("웹훅 목록을 불러오지 못했습니다", 502);
    }
    throw error;
  }
});

export const POST = withRole<Params>("organizer", async (request, { session, params }) => {
  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await request.json());
  } catch (error) {
    if (error instanceof z.ZodError) {
      return errorResponse(error.issues[0]?.message ?? "입력값을 확인해주세요", 400);
    }
    return errorResponse("요청 본문을 해석할 수 없습니다", 400);
  }

  // ── 레벨2 컷오버 T2-EVT: go events 앵커 조회 제거. 테넌트 경계는 v2 `organizer_ref` 가 강제. ──
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
    return errorResponse("이벤트가 아직 커머스에 동기화되지 않았습니다", 409);
  }

  const externalRef = crypto.randomUUID();
  try {
    const result = await createWebhookSubscription(
      v2EventId,
      {
        external_ref: externalRef,
        name: body.name,
        url: body.endpointUrl,
        event_types: body.subscribedEvents,
      },
      { idempotencyKey: `webhook-create:${externalRef}` },
    );
    return successResponse({ id: result.id, signingSecret: result.secret }, 201);
  } catch (error) {
    if (error instanceof V2CommerceError) {
      if (error.status === 400 || error.status === 409 || error.status === 422) {
        return errorResponse(
          "웹훅 입력값을 확인해주세요",
          error.status === 422 ? 400 : error.status,
        );
      }
      return errorResponse("웹훅을 생성하지 못했습니다", 502);
    }
    throw error;
  }
});
