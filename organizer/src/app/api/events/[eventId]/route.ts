import { z } from "zod";
import { cancellationTiersSchema } from "@/lib/events/cancellation-tier-schema";
import { toIsoFromKstLocal } from "@/lib/datetime/kst-local";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { EVENT_TYPES, EVENT_STATUS } from "@/lib/constants";
import { ERR } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { galleryImagesSchema } from "@/lib/events/gallery-schema";
import { contextBannerCacheKey } from "@/lib/public/context-banner";
import { getPrefixedRedis } from "@/lib/redis";
import { slugify } from "@/lib/slug";
import { toV2Category, goToV2WriteEventStatus, type GoEventStatus } from "@/lib/domain-model";
import {
  fetchBizVerification,
  V2BizVerifError,
} from "@/lib/v2/business-verification-client";
import {
  updateEvent,
  goAccountRef,
  listEventHostLinks,
  listTiers,
  putEventHostLinks,
  recordPublicationReview,
  type EventDetail,
  type EventHostLink,
  type EventWriteInput,
  V2CommerceError,
} from "@/lib/v2/commerce-client";
import { EventAccessError, eventAccessStatus, requireOwnedEvent } from "@/lib/v2/event-access";
import { toGoEventView } from "@/lib/v2/event-view";
import { pushReviewRequestToV2 } from "@/lib/v2/review-request-sync";
import { canTransition, type EventStatus } from "@/lib/events/status-machine";

type Params = { eventId: string };

const organizerEntrySchema = z.object({
  organizerId: z.string().uuid("올바른 주최자 ID가 아닙니다"),
  role: z.enum(["host", "coordinator", "sponsor"]),
  displayOrder: z.number().int().min(0).default(0),
});

const eventSchema = z.object({
  organizerId: z.string().uuid("주최자를 선택해주세요").optional(),
  organizers: z.array(organizerEntrySchema).optional(),
  title: z.string().min(2, "이벤트 제목은 2자 이상이어야 합니다"),
  slug: z.string().min(2, "슬러그는 2자 이상이어야 합니다"),
  summary: z.string().optional(),
  description: z.string().optional(),
  startsAt: z.string().min(1, "시작 일시는 필수입니다"),
  endsAt: z.string().min(1, "종료 일시는 필수입니다"),
  venueName: z.string().optional(),
  venueAddress: z.string().optional(),
  eventType: z.enum(EVENT_TYPES),
  ageRating: z.string().min(1, "연령 제한을 선택해주세요"),
  maxAttendees: z.string().optional(),
  isOnline: z.boolean(),
  status: z.enum(EVENT_STATUS),
  heroImageUrl: z.string().optional(),
  imageVariants: z.record(z.string(), z.string()).optional(),
  // 생성 라우트와 **같은 스키마 객체**를 쓴다 — 복붙하면 한쪽만 고쳐져 필드가 조용히 사라진다.
  galleryImages: galleryImagesSchema,
  transportInfo: z.string().optional(),
  /** 프로그램 탭 자유문구 — v2 events.program_notes / stage_info 로 간다. */
  programNotes: z.string().optional(),
  stageInfo: z.string().optional(),
  parkingInfo: z.string().optional(),
  // 규칙 정본은 `lib/events/cancellation-tier-schema.ts` 에 있다 — 테스트가 **같은 객체**를 import 해
  // 검사한다(손으로 복제한 규칙을 검사하면 라우트를 고쳐도 초록이다).
  cancellationPolicy: cancellationTiersSchema.optional(),
  runtimeMinutes: z.number().int().min(0).nullable().optional(),
  intermissionMinutes: z.number().int().min(0).nullable().optional(),
  // 트랙B U3 공개 랜딩 부속기능 게이트(주최자 opt-in) — v2 events(소비자 SoT) write-through.
  rsvpEnabled: z.boolean().optional(),
  groupBookingEnabled: z.boolean().optional(),
  contextBanner: z.string().max(500, "배너 문구는 500자 이내여야 합니다").nullable().optional(),
  // F1 입장방식 — single/daypass/allpass. v2 events.admission_mode(SoT).
  admissionMode: z.enum(["single", "daypass", "allpass"]).optional(),
  // 좌석 판매 방식 — assigned(지정석: 배치도로 좌석을 그림) / unassigned(자유입장: 등급 수량만).
  // 이 값으로 `티켓 & 좌석` 화면이 배치도 에디터 노출을 가른다. v2 events.seat_type(SoT).
  seatType: z.enum(["assigned", "unassigned"]).optional(),
  // F4 경품/추첨 활성 — v2 events.raffle_enabled(SoT).
  raffleEnabled: z.boolean().optional(),
  // 공식 홈페이지 URL(설정 화면과 공유하는 필드).
  homepageUrl: z.string().optional(),
});

const eventPatchSchema = eventSchema.partial();

/**
 * 이벤트 상세 (레벨2 컷오버 W2-EVT — go `events` SELECT 제거).
 *
 * 소유 경계는 v2 `organizer_ref` 가 강제한다(불일치 → 404). v2 장애는 **503**.
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

  // 주최자 표기(옛 event_organizers JOIN organizers).
  let hosts: EventHostLink[] = [];
  try {
    hosts = (await listEventHostLinks(session.accountId, event.event_id)).hosts;
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      return errorResponse(
        "커머스 서버에 연결할 수 없어 주최자 정보를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.",
        503,
      );
    }
    throw err;
  }
  const primary = hosts.find((h) => h.role === "host") ?? hosts[0] ?? null;

  // 커머스 집계 — v2 상세 응답에 이미 포함(별도 왕복 없음).
  const summary = event.summary;
  return successResponse({
    ...toGoEventView(event),
    organizerId: primary?.host_id ?? null,
    organizerName: primary?.name ?? null,
    organizers: hosts.map((h) => ({
      organizerId: h.host_id,
      name: h.name,
      role: h.role,
      displayOrder: h.display_order,
    })),
    productCount: summary.product_count ?? 0,
    orderCount: summary.order_count ?? 0,
    attendeeCount: summary.attendee_count ?? 0,
    revenue: (summary.total_revenue ?? 0) - (summary.refund_amount ?? 0),
  });
});

/** 유료 이벤트 판별 — v2 seat_tiers(= go products + seat_tiers 통합 정본)에 유료가 하나라도 있는가. */
async function isPaidEvent(v2EventId: string): Promise<boolean> {
  const { tiers } = await listTiers(v2EventId);
  return tiers.some((t) => Number(t.base_price) > 0);
}

export const PATCH = withRole<Params>("organizer", async (request, { session, params }) => {
  let body: z.infer<typeof eventPatchSchema>;
  try {
    body = eventPatchSchema.parse(await request.json());
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? ERR.INVALID_INPUT, 400);
    }
    return errorResponse(ERR.INVALID_INPUT, 400);
  }

  // ── 현재 상태 1회 read (소유 검증 겸용). 옛 코드의 go events SELECT 3회를 대체. ──
  let current: EventDetail;
  try {
    current = await requireOwnedEvent(params.eventId, session.accountId);
  } catch (err: unknown) {
    if (err instanceof EventAccessError) {
      return errorResponse(err.message, eventAccessStatus(err));
    }
    throw err;
  }

  const currentStatus = current.status as EventStatus;
  const v2EventId = current.event_id;

  // ── 상태 전이 검증 (organizer 액터 기준) ──
  if (body.status) {
    if (!canTransition(currentStatus, body.status as EventStatus, "organizer")) {
      return errorResponse(
        `주최자 권한으로 ${currentStatus} → ${body.status} 전이 불가. 어드민 승인 필요.`,
        403,
      );
    }

    // ── 유료판매 게이트 ── 유료 이벤트 심사 요청(draft→pending_review)은 사업자 인증 승인 필수.
    // 🔴 fail-closed: 판정 근거(v2 티어·인증상태)를 못 읽으면 통과시키지 않고 503 으로 끊는다.
    //    "조회 실패 → 무료로 간주 → 통과"는 인증 없는 유료 판매를 여는 우회로가 된다.
    if (currentStatus === "draft" && body.status === "pending_review") {
      let paid: boolean;
      try {
        paid = await isPaidEvent(v2EventId);
      } catch (err: unknown) {
        if (err instanceof V2CommerceError) {
          return errorResponse(
            "판매 정보를 확인하지 못해 심사 요청을 처리할 수 없습니다. 잠시 후 다시 시도해주세요.",
            503,
          );
        }
        throw err;
      }
      if (paid) {
        let verificationStatus: string;
        try {
          verificationStatus = (await fetchBizVerification(session.accountId)).verificationStatus;
        } catch (err: unknown) {
          if (err instanceof V2BizVerifError) {
            return errorResponse(
              "사업자 인증 상태를 확인하지 못해 심사 요청을 처리할 수 없습니다. 잠시 후 다시 시도해주세요.",
              503,
            );
          }
          throw err;
        }
        if (verificationStatus !== "approved") {
          return errorResponse(
            "유료 판매는 사업자 인증 승인 후 발행할 수 있습니다. 계정 설정 > 사업자 인증에서 신청해주세요.",
            403,
          );
        }
      }
    }
  }

  // ── 판매 개시 후(live/paused) 일정·이벤트유형 "변경" 차단 ──
  // ⚠️ presence 가 아니라 **값 비교**. 편집폼이 매 저장마다 startsAt/endsAt/eventType 를 항상
  //    보내므로 presence-check 로는 라이브 이벤트의 모든 설정 편집이 403 이 된다.
  if (currentStatus === "live" || currentStatus === "paused") {
    // 🔴 비교도 저장과 **같은 규칙**으로 — 한쪽만 KST 해석하면 "안 바꿨는데 바뀌었다" 로 403 이 난다.
    const ms = (v: string | null | undefined) =>
      v == null ? null : new Date(toIsoFromKstLocal(v) ?? v).getTime();
    const curEnds = current.event_date_end ?? current.event_date;
    const startsChanged = body.startsAt != null && ms(body.startsAt) !== ms(current.event_date);
    const endsChanged = body.endsAt != null && ms(body.endsAt) !== ms(curEnds);
    const typeChanged = body.eventType != null && body.eventType !== (current.event_type ?? null);
    if (startsChanged || endsChanged || typeChanged) {
      return errorResponse(
        "판매가 시작된 이벤트의 일시·이벤트 유형은 변경할 수 없습니다. 변경이 꼭 필요하면 운영팀에 문의해주세요.",
        403,
      );
    }
  }

  // ── v2 부분 patch 구성 (편집한 키만 — 다른 필드 비파괴) ──
  const patch: Partial<Omit<EventWriteInput, "external_ref">> = {
    organizer_ref: goAccountRef(session.accountId),
  };
  let touched = false;
  const mark = () => {
    touched = true;
  };

  if (body.title !== undefined) { patch.title = body.title; mark(); }
  // 🔴 v2 slug 는 전역 UNIQUE(go 는 계정별) — 충돌 시 409(아래 catch 가 한국어로 안내).
  if (body.slug !== undefined) { patch.slug = slugify(body.slug); mark(); }
  if (body.venueName !== undefined) { patch.venue = body.venueName || null; mark(); }
  if (body.description !== undefined) { patch.description = body.description || null; mark(); }
  if (body.venueAddress !== undefined) { patch.venue_address = body.venueAddress || null; mark(); }
  if (body.ageRating !== undefined) { patch.age_rating = body.ageRating || null; mark(); }
  if (body.isOnline !== undefined) { patch.is_online = body.isOnline; mark(); }
  if (body.homepageUrl !== undefined) { patch.homepage_url = body.homepageUrl || null; mark(); }
  // 정원(max_attendees) → v2 total_seats. 판매/홀드분 이하 축소는 v2 가 409 로 차단.
  if (body.maxAttendees !== undefined) {
    patch.total_seats = body.maxAttendees ? Number(body.maxAttendees) : null;
    mark();
  }
  if (body.eventType !== undefined) {
    patch.category = toV2Category(body.eventType);
    // 🔴 category 는 손실 매핑(conference/mice/workshop → exhibition) — go 원본을 함께 보낸다.
    patch.event_type = body.eventType;
    mark();
  }
  if (body.heroImageUrl !== undefined) { patch.image_url = body.heroImageUrl || null; mark(); }
  if (body.imageVariants !== undefined) { patch.image_variants = body.imageVariants ?? null; mark(); }
  if (body.galleryImages !== undefined) { patch.gallery_images = body.galleryImages ?? null; mark(); }
  if (body.cancellationPolicy !== undefined) {
    patch.cancellation_fee_tiers = (body.cancellationPolicy ?? []).map((t) => ({
      days_before: t.daysBefore,
      fee_pct: t.feePct,
    }));
    mark();
  }
  if (body.startsAt !== undefined) {
    // 🔴 서버 TZ(UTC) 해석이면 한국시각 입력이 9시간 밀린다 (2026-07-31 실사고).
    patch.event_date = toIsoFromKstLocal(body.startsAt) ?? undefined;
    mark();
  }
  // 🔴 W2-EVT — 종료 일시는 입장방식과 무관하게 항상 전파한다.
  //   옛 코드는 admissionMode==="single" 이면 event_date_end 를 null 로 지워, go events 를
  //   삭제하는 순간 종료 일시가 비가역 소실되는 구조였다.
  if (body.endsAt !== undefined) {
    patch.event_date_end = toIsoFromKstLocal(body.endsAt) ?? undefined;
    mark();
  }
  if (body.admissionMode !== undefined) {
    // F1: daypass/allpass 는 다일 이벤트여야 한다. 이번 요청 값(없으면 현재 값)으로 판정.
    const startsIso = patch.event_date ?? current.event_date;
    const endsIso = patch.event_date_end ?? current.event_date_end ?? current.event_date;
    if (body.admissionMode !== "single" && startsIso && endsIso) {
      if (endsIso.slice(0, 10) <= startsIso.slice(0, 10)) {
        return errorResponse(
          "지정일권·전일권은 다일 이벤트에만 사용할 수 있습니다. 종료 일시를 시작일 다음 날 이후로 설정해주세요.",
          400,
        );
      }
    }
    patch.admission_mode = body.admissionMode;
    mark();
  }
  if (body.raffleEnabled !== undefined) { patch.raffle_enabled = body.raffleEnabled; mark(); }
  // 좌석 배정 티켓이 있는 상태에서의 unassigned 전환은 v2 가 409 로 막는다(사유를 그대로 전달).
  if (body.seatType !== undefined) { patch.seat_type = body.seatType; mark(); }
  if (body.rsvpEnabled !== undefined) { patch.rsvp_enabled = body.rsvpEnabled; mark(); }
  if (body.groupBookingEnabled !== undefined) {
    patch.group_booking_enabled = body.groupBookingEnabled;
    mark();
  }
  // context_banner 는 빈문자열/null=배너 해제(명시 삭제), 미포함=v2 보존.
  if (body.contextBanner !== undefined) { patch.context_banner = body.contextBanner || null; mark(); }
  // ── 상세페이지 갭 필드(이 라우트가 편집하는 것만 부분 patch) ──
  //   schedules/questions/seo 는 각 전용 라우트가 담당 → 여기서 미터치(= v2 보존).
  if (body.summary !== undefined) { patch.summary = body.summary || null; mark(); }
  if (body.transportInfo !== undefined) { patch.transport_info = body.transportInfo || null; mark(); }
  // 🔴 빈 문자열은 `null` 로 보낸다 — 지우기가 되어야 한다(`""` 를 그대로 보내면
  //    v2 에 빈 문자열이 남아 "값이 있는데 안 보이는" 상태가 된다).
  if (body.programNotes !== undefined) { patch.program_notes = body.programNotes || null; mark(); }
  if (body.stageInfo !== undefined) { patch.stage_info = body.stageInfo || null; mark(); }
  if (body.parkingInfo !== undefined) { patch.parking_info = body.parkingInfo || null; mark(); }
  if (body.runtimeMinutes !== undefined) { patch.runtime_minutes = body.runtimeMinutes ?? null; mark(); }
  if (body.intermissionMinutes !== undefined) {
    patch.intermission_minutes = body.intermissionMinutes ?? null;
    mark();
  }

  // 상태 write (2026-06-03 계약):
  //  - paused: status enum/sale_window 금지(재개 불가). sales_paused=true 로 판매중지.
  //  - paused→live(재개): sales_paused=false → v2 가 직전 status(approved 등) 복원.
  //  - 그 외: go 4-상태 → v2 11-상태 매핑(live→approved, archived→cancelled).
  if (body.status !== undefined) {
    if (body.status === "paused") {
      patch.sales_paused = true;
    } else if (body.status === "live" && currentStatus === "paused") {
      patch.sales_paused = false;
    } else {
      const v2Status = goToV2WriteEventStatus(body.status as GoEventStatus);
      if (v2Status) patch.status = v2Status;
    }
    mark();
  }

  const hasOrganizers = Boolean(body.organizers?.length);
  if (!touched && !hasOrganizers) {
    return errorResponse("변경할 항목이 없습니다", 400);
  }

  if (touched) {
    try {
      await updateEvent(v2EventId, patch, {
        idempotencyKey: `event-update:${params.eventId}:${Date.now()}`,
      });
    } catch (err: unknown) {
      if (err instanceof V2CommerceError) {
        if (err.status === 409) {
          return errorResponse(
            "이미 사용 중인 주소(슬러그)입니다. 다른 값으로 변경해주세요.",
            409,
          );
        }
        return errorResponse(
          "이벤트 수정 중 커머스 동기화에 실패했습니다. 잠시 후 다시 시도해주세요.",
          503,
        );
      }
      throw err;
    }
  }

  // ── 주최자 연결 교체(옛 event_organizers DELETE+INSERT 트랜잭션) ──
  if (body.organizers?.length) {
    if (!body.organizers.some((o) => o.role === "host")) {
      return errorResponse("주최(host) 역할이 최소 1개 필요합니다", 400);
    }
    try {
      await putEventHostLinks(
        session.accountId,
        v2EventId,
        body.organizers.map((o) => ({
          host_id: o.organizerId,
          role: o.role,
          display_order: o.displayOrder,
        })),
      );
    } catch (err: unknown) {
      if (err instanceof V2CommerceError) {
        if (err.status === 400) {
          return errorResponse("존재하지 않는 주최자가 포함되어 있습니다", 400);
        }
        if (err.status === 404) return errorResponse(ERR.NOT_FOUND, 404);
        return errorResponse(
          "주최자 정보 저장 중 커머스 동기화에 실패했습니다. 잠시 후 다시 시도해주세요.",
          503,
        );
      }
      throw err;
    }
  }

  // pending_review 전이 시 심사 이력 기록 + v2 로 심사 요청 webhook 발송.
  if (body.status === "pending_review") {
    // ── 레벨2 컷오버 W5-SUPPORT: go `event_reviews` → v2 `event_publication_reviews`. ──
    // 감사 로그 — 실패해도 상태 전이는 이미 확정이므로 삼킨다(옛 go write 와 동일 계약).
    // organizer_ref 를 넘겨 v2 가 소유 경계를 한 번 더 검증하게 한다.
    await recordPublicationReview(params.eventId, {
      organizer_ref: session.accountId,
      action: "submit",
      reviewer_ref: session.id,
    }).catch((err: unknown) => {
      logger.warn("게시 심사 이력 기록 실패 (무시)", {
        eventId: params.eventId,
        error: err instanceof Error ? err.message : "unknown",
      });
    });
    void pushReviewRequestToV2(params.eventId, session.accountId);
  }

  // 🔴 상단 배너 캐시 무효화 (2026-07-30).
  //    배너는 이제 주최자가 직접 쓴 문구다. 문구를 비워 배너를 끄려 했는데 TTL 이
  //    남아 몇십 초 더 보이면 "왜 안 지워지지" 가 된다. 저장 즉시 반영시킨다.
  //    실패해도 저장은 성공이다 — TTL(30초)이 백스톱이라 곧 사라진다.
  if (body.contextBanner !== undefined) {
    void getPrefixedRedis()
      .del(contextBannerCacheKey(params.eventId))
      .catch((err: unknown) => {
        logger.warn("상단 배너 캐시 무효화 실패(TTL 로 수렴)", {
          eventId: params.eventId,
          error: err instanceof Error ? err.message : "unknown",
        });
      });
  }

  return successResponse({ id: v2EventId });
});

/**
 * 이벤트 보관(archive) — 하드삭제가 아니라 상태 전이.
 *
 * 🔴 fail-closed: v2 장애 시 **절대 200 을 반환하지 않는다**. 옛 구조는 go UPDATE 성공만으로
 *    응답을 확정할 수 있었지만 이제 v2 가 유일 정본이라, v2 write 가 실패했으면 아무것도
 *    보관되지 않은 것이다 — 503 으로 끊어야 주최자가 "보관됐다"고 오인하지 않는다.
 */
export const DELETE = withRole<Params>("organizer", async (_request, { session, params }) => {
  let current: EventDetail;
  try {
    current = await requireOwnedEvent(params.eventId, session.accountId);
  } catch (err: unknown) {
    if (err instanceof EventAccessError) {
      return errorResponse(err.message, eventAccessStatus(err));
    }
    throw err;
  }

  try {
    // go "archived" → v2 "cancelled" (v2엔 archived 없음 — 매핑 필수).
    await updateEvent(
      current.event_id,
      {
        organizer_ref: goAccountRef(session.accountId),
        status: goToV2WriteEventStatus("archived") ?? "cancelled",
      },
      { idempotencyKey: `event-archive:${params.eventId}` },
    );
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      return errorResponse(
        "이벤트 보관 중 커머스 동기화에 실패했습니다. 잠시 후 다시 시도해주세요.",
        503,
      );
    }
    throw err;
  }

  return successResponse({ archived: true });
});
