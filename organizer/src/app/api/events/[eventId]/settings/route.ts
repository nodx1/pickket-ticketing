import { z } from "zod";
import { toIsoFromKstLocal } from "@/lib/datetime/kst-local";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { EVENT_TYPES, EVENT_STATUS } from "@/lib/constants";
import { toV2Category } from "@/lib/domain-model";
import { ERR } from "@/lib/errors";
import { slugify } from "@/lib/slug";
import {
  updateEvent,
  goAccountRef,
  listEventHostLinks,
  V2CommerceError,
  type EventDetail,
  type EventWriteInput,
} from "@/lib/v2/commerce-client";
import { EventAccessError, eventAccessStatus, requireOwnedEvent } from "@/lib/v2/event-access";
import { toGoEventView } from "@/lib/v2/event-view";

type Params = { eventId: string };

const eventSettingsSchema = z.object({
  title: z.string().min(2, "이벤트 제목은 2자 이상이어야 합니다"),
  slug: z.string().min(2, "슬러그는 2자 이상이어야 합니다"),
  description: z.string().optional(),
  startsAt: z.string().min(1, "시작 일시는 필수입니다"),
  endsAt: z.string().min(1, "종료 일시는 필수입니다"),
  venueName: z.string().optional(),
  venueAddress: z.string().optional(),
  // Phase 5 migration 112에서 24종으로 확장. constants.ts가 single source.
  eventType: z.enum(EVENT_TYPES),
  ageRating: z.string().min(1, "연령 제한을 선택해주세요"),
  maxAttendees: z.string().optional(),
  isOnline: z.boolean(),
  homepageUrl: z.string().optional(),
  status: z.enum(EVENT_STATUS),
  heroImageUrl: z.string().optional(),
  transportInfo: z.string().optional(),
  parkingInfo: z.string().optional(),
  runtimeMinutes: z.number().int().min(1).optional().nullable(),
  intermissionMinutes: z.number().int().min(0).optional().nullable(),
});

/**
 * 이벤트 설정 조회 (레벨2 컷오버 W2-EVT — go `events` SELECT 제거).
 * 소유 경계는 v2 organizer_ref 가 강제(불일치 → 404). v2 장애 → 503.
 */
export const GET = withRole<Params>("organizer", async (_request, { session, params }) => {
  let event: EventDetail;
  try {
    event = await requireOwnedEvent(params.eventId, session.accountId);
  } catch (err: unknown) {
    if (err instanceof EventAccessError) {
      return errorResponse(err.message, eventAccessStatus(err));
    }
    throw err;
  }

  // 설정 화면은 대표 주최자 id 를 폼 초기값으로 쓴다(옛 events.organizer_id).
  let organizerId: string | null = null;
  try {
    const { hosts } = await listEventHostLinks(session.accountId, event.event_id);
    organizerId = (hosts.find((h) => h.role === "host") ?? hosts[0])?.host_id ?? null;
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      return errorResponse(
        "커머스 서버에 연결할 수 없어 주최자 정보를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.",
        503,
      );
    }
    throw err;
  }

  return successResponse({ ...toGoEventView(event), organizerId });
});

/**
 * 이벤트 설정 저장 (레벨2 컷오버 W2-EVT — go `events` UPDATE 제거, v2 단일 write).
 *
 * ⚠️ 상태(status)는 여기서 write-through 하지 않는다 — 상태 전이는 canTransition 가드가 있는
 *    `[eventId]` PATCH·발행/보관 전용 라우트가 담당(설정 저장으로 상태를 우회 변경하지 않음).
 * ⚠️ 타임테이블/설문/SEO 는 각 전용 라우트가 소유 → 이 patch 에 키를 싣지 않는다(= v2 보존).
 */
export const PATCH = withRole<Params>("organizer", async (request, { session, params }) => {
  let body: z.infer<typeof eventSettingsSchema>;
  try {
    body = eventSettingsSchema.parse(await request.json());
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? ERR.INVALID_INPUT, 400);
    }
    return errorResponse(ERR.INVALID_INPUT, 400);
  }

  const startsIso = toIsoFromKstLocal(body.startsAt);
  const endsIso = toIsoFromKstLocal(body.endsAt);
  if (!startsIso || !endsIso) {
    return errorResponse("시작/종료 일시 형식이 올바르지 않습니다", 400);
  }
  if (endsIso < startsIso) {
    return errorResponse("종료 일시는 시작 일시 이후여야 합니다", 400);
  }

  // 소유 검증(옛 `WHERE id=$1 AND account_id=$2` 의 대체).
  let current: EventDetail;
  try {
    current = await requireOwnedEvent(params.eventId, session.accountId);
  } catch (err: unknown) {
    if (err instanceof EventAccessError) {
      return errorResponse(err.message, eventAccessStatus(err));
    }
    throw err;
  }

  const patch: Partial<Omit<EventWriteInput, "external_ref">> = {
    organizer_ref: goAccountRef(session.accountId),
    title: body.title,
    // 🔴 slug 미전파 시 go/v2 slug 가 분기해 공개 라우트(v2 by-slug)가 404 가 된다.
    //    v2 slug 는 전역 UNIQUE → 타 계정과 충돌 시 409(아래에서 한국어 안내).
    slug: slugify(body.slug),
    venue: body.venueName || null,
    description: body.description || null,
    venue_address: body.venueAddress || null,
    age_rating: body.ageRating,
    is_online: body.isOnline,
    homepage_url: body.homepageUrl || null,
    category: toV2Category(body.eventType),
    // 🔴 category 는 손실 매핑 — go EventType 원본을 함께 보존한다.
    event_type: body.eventType,
    event_date: startsIso,
    // 🔴 W2-EVT — 종료 일시를 항상 전파(go events.ends_at 소실 방지).
    event_date_end: endsIso,
    image_url: body.heroImageUrl || null,
    transport_info: body.transportInfo || null,
    parking_info: body.parkingInfo || null,
    runtime_minutes: body.runtimeMinutes ?? null,
    intermission_minutes: body.intermissionMinutes ?? null,
  };
  // 정원(max_attendees) → v2 total_seats. 판매/홀드분 이하 축소는 v2 가 409 로 차단.
  if (body.maxAttendees) patch.total_seats = Number(body.maxAttendees);

  try {
    await updateEvent(current.event_id, patch, {
      idempotencyKey: `event-settings:${params.eventId}:${Date.now()}`,
    });
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      if (err.status === 409) {
        return errorResponse("이미 사용 중인 주소(슬러그)입니다. 다른 값으로 변경해주세요.", 409);
      }
      return errorResponse(
        "설정 저장 중 커머스 동기화에 실패했습니다. 잠시 후 다시 시도해주세요.",
        503,
      );
    }
    throw err;
  }

  return successResponse({
    id: current.event_id,
    title: body.title,
    slug: slugify(body.slug),
    description: body.description ?? null,
    startsAt: startsIso,
    endsAt: endsIso,
    venueName: body.venueName ?? null,
    venueAddress: body.venueAddress ?? null,
    eventType: body.eventType,
    ageRating: body.ageRating,
    maxAttendees: body.maxAttendees ? Number(body.maxAttendees) : null,
    isOnline: body.isOnline,
    homepageUrl: body.homepageUrl ?? null,
    // 상태는 이 라우트가 바꾸지 않는다 — 현재 값을 그대로 되돌려준다.
    status: current.status,
  });
});
