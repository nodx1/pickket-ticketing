import { z } from "zod";
import { toIsoFromKstLocal } from "@/lib/datetime/kst-local";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { ERR } from "@/lib/errors";
import {
  goAccountRef,
  updateEvent,
  V2CommerceError,
  type EventDetail,
} from "@/lib/v2/commerce-client";
import { EventAccessError, eventAccessStatus, requireOwnedEvent } from "@/lib/v2/event-access";
import { parseV2Schedules, toV2Schedules, type EventScheduleItem } from "@/lib/v2/event-schedules";

type Params = { eventId: string; scheduleId: string };

const schema = z.object({
  title: z.string().min(2).optional(),
  description: z.string().optional(),
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
  venueName: z.string().optional(),
  sortOrder: z.number().int().min(0).optional(),
  /**
   * 🔴 일정에 딸린 안내 이미지. `null` 을 명시하면 **뗀다**.
   * ⚠️ `undefined`(키 없음)와 `null`(빼달라)은 다르다 — 아래 `!== undefined` 로 가른다.
   */
  imageUrl: z.string().url("이미지 주소가 올바르지 않습니다").nullable().optional(),
});

/** 소유 검증 + 현재 일정 스냅샷. 실패 사유를 상태코드로 그대로 전달한다. */
async function loadSchedules(
  eventId: string,
  accountId: string,
): Promise<
  { ok: true; event: EventDetail; items: EventScheduleItem[] } | { ok: false; response: Response }
> {
  try {
    const event = await requireOwnedEvent(eventId, accountId);
    return { ok: true, event, items: parseV2Schedules((event.content ?? {}).event_schedules) };
  } catch (err: unknown) {
    if (err instanceof EventAccessError) {
      return {
        ok: false,
        response: errorResponse(
          err.reason === "not_found" ? "이벤트를 찾을 수 없습니다" : err.message,
          eventAccessStatus(err),
        ),
      };
    }
    throw err;
  }
}

async function persist(
  event: EventDetail,
  accountId: string,
  items: EventScheduleItem[],
  failureMessage: string,
): Promise<Response | null> {
  try {
    await updateEvent(
      event.event_id,
      { organizer_ref: goAccountRef(accountId), event_schedules: toV2Schedules(items) },
      { idempotencyKey: `event-schedules:${event.event_id}:${Date.now()}` },
    );
    return null;
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      return errorResponse(failureMessage, 503);
    }
    throw err;
  }
}

/**
 * 타임테이블 수정 (레벨2 컷오버 W2-EVT — go `event_schedules` UPDATE 제거).
 *
 * 🔴 옛 코드는 UPDATE 의 `rowCount` 를 보지 않아 **없는 일정·타 계정 일정에도 200** 을 냈다.
 *    이제 대상이 없으면 404 다(존재하지 않는 것을 고쳤다고 말하지 않는다).
 */
export const PATCH = withRole<Params>("organizer", async (request, { session, params }) => {
  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await request.json());
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? "입력값을 확인해주세요", 400);
    }
    return errorResponse(ERR.INVALID_INPUT, 400);
  }

  if (body.startsAt !== undefined && Number.isNaN(Date.parse(body.startsAt))) {
    return errorResponse("시작 시간 형식이 올바르지 않습니다", 400);
  }
  if (body.endsAt !== undefined && Number.isNaN(Date.parse(body.endsAt))) {
    return errorResponse("종료 시간 형식이 올바르지 않습니다", 400);
  }

  const loaded = await loadSchedules(params.eventId, session.accountId);
  if (!loaded.ok) return loaded.response;

  const target = loaded.items.find((s) => s.id === params.scheduleId);
  if (!target) return errorResponse("일정을 찾을 수 없습니다", 404);

  // COALESCE 시맨틱 유지 — 보낸 키만 반영.
  if (body.title !== undefined) target.title = body.title;
  if (body.description !== undefined) target.description = body.description || null;
  // 🔴 변환 실패를 조용히 넘기지 않는다 — 빈 값이 저장되면 일정이 사라진 것처럼 보인다.
  if (body.startsAt !== undefined) {
    const iso = toIsoFromKstLocal(body.startsAt);
    if (!iso) return errorResponse("시작 시간 형식이 올바르지 않습니다", 400);
    target.startsAt = iso;
  }
  if (body.endsAt !== undefined) {
    const iso = toIsoFromKstLocal(body.endsAt);
    if (!iso) return errorResponse("종료 시간 형식이 올바르지 않습니다", 400);
    target.endsAt = iso;
  }
  if (body.venueName !== undefined) target.venueName = body.venueName || null;
  if (body.sortOrder !== undefined) target.sortOrder = body.sortOrder;
  if (body.imageUrl !== undefined) target.imageUrl = body.imageUrl || null;

  loaded.items.sort((a, b) => a.sortOrder - b.sortOrder || a.startsAt.localeCompare(b.startsAt));

  const failed = await persist(
    loaded.event,
    session.accountId,
    loaded.items,
    "일정 수정 중 커머스 동기화에 실패했습니다. 잠시 후 다시 시도해주세요.",
  );
  if (failed) return failed;

  return successResponse({ updated: true });
});

/**
 * 타임테이블 삭제.
 *
 * 🔴 fail-closed: "조회 실패 → 이미 없음 → deleted:true" 경로를 만들지 않는다. v2 장애는 503 이고,
 *    **v2 read 로 실제로 없음을 확인한 경우에만** 멱등 성공(200)으로 흡수한다.
 */
export const DELETE = withRole<Params>("organizer", async (_request, { session, params }) => {
  const loaded = await loadSchedules(params.eventId, session.accountId);
  if (!loaded.ok) return loaded.response;

  const remaining = loaded.items.filter((s) => s.id !== params.scheduleId);
  if (remaining.length === loaded.items.length) {
    // 이미 없음이 **확인된** 상태 → 목표 상태 도달. write 없이 멱등 성공.
    return successResponse({ deleted: true });
  }

  const failed = await persist(
    loaded.event,
    session.accountId,
    remaining,
    "일정 삭제 중 커머스 동기화에 실패했습니다. 잠시 후 다시 시도해주세요.",
  );
  if (failed) return failed;

  return successResponse({ deleted: true });
});
