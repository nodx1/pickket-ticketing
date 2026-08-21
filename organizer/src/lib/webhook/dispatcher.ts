import { logger } from "@/lib/logger";
import { dispatchWebhookEvent } from "@/lib/v2/commerce-client";
import { toV2EventId } from "@/lib/v2/event-access";

function extractEventId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  if ("eventId" in payload && typeof payload.eventId === "string") {
    return payload.eventId;
  }
  return null;
}

/**
 * Level2 B2-3 outbound webhook trigger.
 *
 * go no longer reads `webhooks`, signs requests, performs network delivery, or
 * writes `webhook_logs`. It asks v2 to create durable, idempotent delivery rows.
 * HMAC, retries, SSRF checks, and response logging are owned by v2 webhook_service.
 *
 * 레벨2 T2-EVT: go `events` 앵커 조회도 사라졌다 — event id 는 v2 canonical id 와 동일하다.
 */
export async function dispatchWebhook(eventType: string, payload: unknown) {
  const eventId = extractEventId(payload);
  if (!eventId || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    logger.warn("[webhook-dispatch] eventId 없는 payload — 발송 생략", { eventType });
    return { deliveryIds: [] as string[], queued: 0 };
  }

  // 레벨2 T2-EVT — go `events` 앵커 조회 제거(id 승격으로 go id == v2 id, 항등 변환).
  // ⚠️ 미스 시맨틱 변화: 옛 코드는 앵커가 NULL 이면 warn 로그 후 조용히 no-op 했다. 이제 이 레이어에는
  //    NULL 케이스가 없다 — 이벤트가 v2 에 없으면 아래 dispatchWebhookEvent 가 404(V2CommerceError)로
  //    알려준다. 조용한 폴백을 새로 만들지 않고 호출부의 기존 에러 처리에 그대로 맡긴다.
  const v2EventId = toV2EventId(eventId);

  const result = await dispatchWebhookEvent(
    v2EventId,
    eventType,
    payload as Record<string, unknown>,
  );
  return {
    deliveryIds: result.delivery_ids,
    queued: result.queued,
  };
}
