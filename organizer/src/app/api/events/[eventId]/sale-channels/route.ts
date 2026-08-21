import { withAuth } from "@/lib/auth/withAuth";
import { withRole } from "@/lib/auth/permissions";
import { successResponse, errorResponse } from "@/lib/apiResponse";
import {
  updateEvent,
  goAccountRef,
  V2CommerceError,
  type EventDetail,
  type EventWriteInput,
} from "@/lib/v2/commerce-client";
import { EventAccessError, eventAccessStatus, requireOwnedEvent } from "@/lib/v2/event-access";

type Params = { eventId: string };

const VALID_CHANNELS = new Set(["self", "marketplace"]);

/** 판매 채널 조회 (레벨2 W2-EVT — go `events.sale_channels` 제거, v2 SoT). */
export const GET = withAuth<Params>(async (_request, { session, params }) => {
  const { eventId } = await params;
  let event: EventDetail;
  try {
    event = await requireOwnedEvent(eventId, session.accountId);
  } catch (err: unknown) {
    if (err instanceof EventAccessError) {
      return errorResponse(err.message, eventAccessStatus(err));
    }
    throw err;
  }
  return successResponse({ saleChannels: event.sale_channels ?? ["self"] });
});

// organizer 이상만 — 판매 채널 변경은 권한상승 하드닝 대상.
export const PUT = withRole<Params>("organizer", async (request, { session, params }) => {
  const { eventId } = await params;

  let body: { saleChannels?: unknown };
  try {
    body = (await request.json()) as { saleChannels?: unknown };
  } catch {
    return errorResponse("요청 본문을 해석할 수 없습니다", 400);
  }

  if (!Array.isArray(body.saleChannels) || body.saleChannels.length === 0) {
    return errorResponse("최소 하나의 판매 채널을 선택해야 합니다", 400);
  }
  const validated = body.saleChannels.filter(
    (c): c is string => typeof c === "string" && VALID_CHANNELS.has(c),
  );
  if (validated.length === 0) return errorResponse("유효한 판매 채널이 없습니다", 400);

  // 소유 검증(옛 `WHERE id=$1 AND account_id=$2`).
  let event: EventDetail;
  try {
    event = await requireOwnedEvent(eventId, session.accountId);
  } catch (err: unknown) {
    if (err instanceof EventAccessError) {
      return errorResponse(err.message, eventAccessStatus(err));
    }
    throw err;
  }

  const patch: Partial<Omit<EventWriteInput, "external_ref">> = {
    organizer_ref: goAccountRef(session.accountId),
    sale_channels: validated,
  };
  try {
    await updateEvent(event.event_id, patch, {
      idempotencyKey: `event-sale-channels:${eventId}:${Date.now()}`,
    });
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      return errorResponse(
        "판매 채널 변경 중 커머스 동기화에 실패했습니다. 잠시 후 다시 시도해주세요.",
        503,
      );
    }
    throw err;
  }

  return successResponse({ saleChannels: validated });
});
