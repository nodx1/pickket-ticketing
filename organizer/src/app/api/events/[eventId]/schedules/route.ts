import { randomUUID } from "node:crypto";
import { toIsoFromKstLocal } from "@/lib/datetime/kst-local";
import { z } from "zod";
import { errorResponse, listResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { ERR } from "@/lib/errors";
import {
  goAccountRef,
  updateEvent,
  V2CommerceError,
  type EventDetail,
} from "@/lib/v2/commerce-client";
import { EventAccessError, eventAccessStatus, requireOwnedEvent } from "@/lib/v2/event-access";
import { parseV2Schedules, toV2Schedules } from "@/lib/v2/event-schedules";

type Params = { eventId: string };

const schema = z.object({
  title: z.string().min(2, "제목을 입력해주세요"),
  description: z.string().optional(),
  startsAt: z.string().min(1, "시작 시간을 입력해주세요"),
  endsAt: z.string().min(1, "종료 시간을 입력해주세요"),
  venueName: z.string().optional(),
  /** 🔴 일정에 딸린 안내 이미지(조편성표 등). 없으면 아무것도 안 그린다. */
  imageUrl: z.string().url("이미지 주소가 올바르지 않습니다").optional().nullable(),
  sortOrder: z.number().int().min(0).optional(),
});

/**
 * 이벤트 타임테이블 목록 (레벨2 컷오버 W2-EVT — go `event_schedules` 테이블 제거).
 * 정본은 v2 `events.event_schedules`(JSONB). 소유 경계는 v2 organizer_ref 가 강제.
 */
export const GET = withRole<Params>("staff", async (_request, { session, params }) => {
  let event: EventDetail;
  try {
    event = await requireOwnedEvent(params.eventId, session.accountId);
  } catch (err: unknown) {
    if (err instanceof EventAccessError) {
      // 🔴 옛 코드는 소유 JOIN 미스를 **빈 목록**으로 응답했다(v2 장애도 빈 목록이 될 뻔).
      //    없음=404 / 장애=503 으로 구분한다.
      return errorResponse(err.message, eventAccessStatus(err));
    }
    throw err;
  }

  const items = parseV2Schedules((event.content ?? {}).event_schedules);
  return listResponse(items, items.length);
});

/**
 * 타임테이블 추가.
 *
 * ⚠️ JSONB 배열 read-modify-write 다(옛 테이블 INSERT 와 달리 원자적이지 않다).
 *    같은 이벤트의 일정을 **동시에** 두 번 추가하면 나중 write 가 앞선 항목을 덮을 수 있다.
 *    주최자 1인 편집 화면이라 실사용 위험은 낮지만, 다중 편집이 생기면 v2 에 항목 단위
 *    엔드포인트를 두어야 한다(잔여 리스크로 기록).
 */
export const POST = withRole<Params>("organizer", async (request, { session, params }) => {
  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await request.json());
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? "입력값을 확인해주세요", 400);
    }
    return errorResponse(ERR.INVALID_INPUT, 400);
  }

  // 🔴 검증과 저장을 **같은 함수**로 한다. 따로 두면 `Date.parse` 는 통과하는데
  //    저장 변환이 실패하는 값이 생긴다(그 경우 조용히 빈 값이 들어간다).
  const startsIso = toIsoFromKstLocal(body.startsAt);
  const endsIso = toIsoFromKstLocal(body.endsAt);
  if (!startsIso || !endsIso) {
    return errorResponse("시작/종료 시간 형식이 올바르지 않습니다", 400);
  }

  let event: EventDetail;
  try {
    event = await requireOwnedEvent(params.eventId, session.accountId);
  } catch (err: unknown) {
    if (err instanceof EventAccessError) {
      return errorResponse(
        err.reason === "not_found" ? "이벤트를 찾을 수 없습니다" : err.message,
        eventAccessStatus(err),
      );
    }
    throw err;
  }

  const items = parseV2Schedules((event.content ?? {}).event_schedules);
  const id = randomUUID();
  items.push({
    id,
    title: body.title,
    description: body.description ?? null,
    startsAt: startsIso,
    endsAt: endsIso,
    venueName: body.venueName ?? null,
    imageUrl: body.imageUrl ?? null,
    sortOrder: body.sortOrder ?? 0,
  });
  items.sort((a, b) => a.sortOrder - b.sortOrder || a.startsAt.localeCompare(b.startsAt));

  try {
    await updateEvent(
      event.event_id,
      { organizer_ref: goAccountRef(session.accountId), event_schedules: toV2Schedules(items) },
      { idempotencyKey: `event-schedules:${params.eventId}:${Date.now()}` },
    );
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      return errorResponse(
        "일정 저장 중 커머스 동기화에 실패했습니다. 잠시 후 다시 시도해주세요.",
        503,
      );
    }
    throw err;
  }

  return successResponse({ id }, 201);
});
