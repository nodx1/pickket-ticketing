import { z } from "zod";
import { withAuth } from "@/lib/auth/withAuth";
import { withRole } from "@/lib/auth/permissions";
import { successResponse, errorResponse } from "@/lib/apiResponse";
import { ERR } from "@/lib/errors";
import {
  updateEvent,
  goAccountRef,
  V2CommerceError,
  type EventDetail,
  type EventWriteInput,
} from "@/lib/v2/commerce-client";
import { EventAccessError, eventAccessStatus, requireOwnedEvent } from "@/lib/v2/event-access";

/**
 * 공개 랜딩 설정 (레벨2 컷오버 W2-EVT — go `events.custom_domain/landing_config` 제거).
 * 두 값 모두 v2 events 로 흡수됐다(마이그 ctevt_0727).
 */
export const GET = withAuth(async (_request, { session, params }) => {
  const { eventId } = params as { eventId: string };

  let event: EventDetail;
  try {
    event = await requireOwnedEvent(eventId, session.accountId);
  } catch (err: unknown) {
    if (err instanceof EventAccessError) {
      // 🔴 옛 코드는 광범위 catch 로 전부 500 이었다. v2 장애(503)와 미소유(404)를 구분한다.
      return errorResponse(err.message, eventAccessStatus(err));
    }
    throw err;
  }

  return successResponse({
    customDomain: event.custom_domain ?? null,
    landingConfig: event.landing_config ?? null,
  });
});

const updateSchema = z.object({
  customDomain: z.string().optional().nullable(),
  landingConfig: z.record(z.string(), z.unknown()).optional(),
});

// organizer 이상만 — 랜딩/도메인 설정 변경은 권한상승 하드닝 대상.
export const PATCH = withRole<{ eventId: string }>("organizer", async (request, { session, params }) => {
  const { eventId } = params;

  let body: z.infer<typeof updateSchema>;
  try {
    body = updateSchema.parse(await request.json());
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? ERR.INVALID_INPUT, 400);
    }
    return errorResponse(ERR.INVALID_INPUT, 400);
  }

  let event: EventDetail;
  try {
    event = await requireOwnedEvent(eventId, session.accountId);
  } catch (err: unknown) {
    if (err instanceof EventAccessError) {
      return errorResponse(err.message, eventAccessStatus(err));
    }
    throw err;
  }

  // 부분 patch — 보낸 키만 반영(v2 updateEvent 계약과 동일).
  const patch: Partial<Omit<EventWriteInput, "external_ref">> = {
    organizer_ref: goAccountRef(session.accountId),
  };
  let touched = false;
  if (body.customDomain !== undefined) {
    patch.custom_domain = body.customDomain || null;
    touched = true;
  }
  if (body.landingConfig !== undefined) {
    patch.landing_config = body.landingConfig ?? null;
    touched = true;
  }
  if (!touched) {
    return errorResponse("변경할 항목이 없습니다", 400);
  }

  try {
    await updateEvent(event.event_id, patch, {
      idempotencyKey: `event-landing:${eventId}:${Date.now()}`,
    });
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      // custom_domain 은 v2 에서 전역 UNIQUE — 충돌은 재시도로 풀리지 않으므로 원인을 명시한다.
      if (err.status === 409) {
        return errorResponse("이미 사용 중인 커스텀 도메인입니다. 다른 값으로 변경해주세요.", 409);
      }
      return errorResponse(
        "랜딩 설정 저장 중 커머스 동기화에 실패했습니다. 잠시 후 다시 시도해주세요.",
        503,
      );
    }
    throw err;
  }

  return successResponse({
    customDomain: body.customDomain !== undefined ? (body.customDomain || null) : (event.custom_domain ?? null),
    landingConfig: body.landingConfig !== undefined ? (body.landingConfig ?? null) : (event.landing_config ?? null),
  });
});
