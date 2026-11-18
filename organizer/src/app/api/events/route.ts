import { randomUUID } from "node:crypto";
import { toIsoFromKstLocal } from "@/lib/datetime/kst-local";
import { z } from "zod";
import { errorResponse, listResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { EVENT_TYPES, EVENT_STATUS } from "@/lib/constants";
import { ERR } from "@/lib/errors";
import { getAccountFeePlan } from "@/lib/fee/calculator";
import { logger } from "@/lib/logger";
import { galleryImagesSchema } from "@/lib/events/gallery-schema";
import { resolveInitialSaleWindow } from "@/lib/events/sale-window";
import { slugify } from "@/lib/slug";
import { toV2Category, goToV2WriteEventStatus } from "@/lib/domain-model";
import {
  batchEventHostLinks,
  createEvent,
  type EventHostLink,
  type FeePlanInput,
  goAccountRef,
  listOrganizerEvents,
  putEventHostLinks,
  upsertEventFeePlan,
  V2CommerceError,
} from "@/lib/v2/commerce-client";
import { DEFAULT_CANCELLATION_FEE_TIERS, toGoEventListView } from "@/lib/v2/event-view";

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
  status: z.enum(EVENT_STATUS).default("draft"),
  heroImageUrl: z.string().optional(),
  imageVariants: z.record(z.string(), z.string()).optional(),
  // 수정 라우트와 **같은 스키마 객체**를 쓴다 — 복붙하면 한쪽만 고쳐져 필드가 조용히 사라진다.
  galleryImages: galleryImagesSchema,
  transportInfo: z.string().optional(),
  parkingInfo: z.string().optional(),
  // 행사 유형: rsvpEnabled=true 면 유료 티켓 판매 대신 무료 참석(RSVP) 등록 폼을 노출한다.
  rsvpEnabled: z.boolean().optional().default(false),
  // U3 공개 랜딩 게이트: 단체 예약 문의 폼 노출·수신 허용 / 주최자 수동 상단 배너 문구.
  groupBookingEnabled: z.boolean().optional().default(false),
  contextBanner: z.string().max(500, "배너 문구는 500자 이내여야 합니다").optional(),
  // 공연시간/인터미션(분).
  runtimeMinutes: z.number().int().min(0).nullable().optional(),
  intermissionMinutes: z.number().int().min(0).nullable().optional(),
  // F1 입장방식 — single(기본)/daypass/allpass. v2 events.admission_mode(SoT)로 write-through.
  admissionMode: z.enum(["single", "daypass", "allpass"]).optional().default("single"),
  // F4 경품/추첨 활성 — v2 events.raffle_enabled(SoT)로 write-through.
  raffleEnabled: z.boolean().optional().default(false),
  // 좌석 판매 방식 — assigned(지정석·배치도) / unassigned(자유 입장·등급 수량만). v2 events.seat_type(SoT).
  // 🔴 이 필드가 생성 스키마에 없어서 만들기 폼의 「자유 입장」이 버려지고 항상 지정석으로 저장됐다.
  seatType: z.enum(["assigned", "unassigned"]).optional().default("assigned"),
});

const SORT_KEYS = new Set(["latest", "oldest", "created", "title"]);

function parsePositiveInt(value: string | null, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * 이벤트 목록 (레벨2 컷오버 W2-EVT — go `events` SELECT 제거).
 *
 * 필터/정렬/검색/페이지네이션 전부 v2 `GET /internal/organizers/{ref}/events` 가 수행한다.
 * 🔴 fail-closed: v2 장애를 "빈 목록"으로 위장하지 않는다. 옛 코드는 go 목록 + v2 집계 병합이라
 *    집계만 0 으로 떨어뜨릴 수 있었지만, 이제 목록 자체가 v2 이므로 장애는 **503** 이다.
 *    (빈 목록으로 내려보내면 주최자가 "내 이벤트가 다 사라졌다"고 오인한다.)
 */
export const GET = withRole("organizer", async (request, { session }) => {
  const { searchParams } = new URL(request.url);
  const page = parsePositiveInt(searchParams.get("page"), 1);
  const limit = Math.min(parsePositiveInt(searchParams.get("limit"), 12), 50);
  const search = searchParams.get("search")?.trim() ?? "";
  const status = searchParams.get("status")?.trim();
  const sortRaw = searchParams.get("sort")?.trim() ?? "latest";
  const sort = SORT_KEYS.has(sortRaw) ? sortRaw : "latest";

  const ALLOWED_STATUS = new Set([
    "ended", "scheduled",
    "draft", "pending_review", "rejected", "live", "paused", "archived",
  ]);

  let listed: Awaited<ReturnType<typeof listOrganizerEvents>>;
  try {
    listed = await listOrganizerEvents(session.accountId, {
      status: status && ALLOWED_STATUS.has(status) ? status : undefined,
      limit,
      offset: (page - 1) * limit,
      search: search || undefined,
      sort,
    });
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      return errorResponse(
        "커머스 서버에 연결할 수 없어 이벤트 목록을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.",
        503,
      );
    }
    throw err;
  }

  // 주최자 표기(옛 go event_organizers JOIN organizers) — 배치 1회로 N+1 회피.
  // 🔴 이것도 fail-closed: 목록은 이미 확보했으나 주최자명이 빠지면 화면이 "주최자 미지정"으로
  //    보여 주최자가 데이터 유실로 오인한다. v2 장애는 503 으로 끊는다.
  const eventIds = listed.events.map((e) => e.event_id);
  let hostsByEvent: Record<string, EventHostLink[]> = {};
  if (eventIds.length > 0) {
    try {
      hostsByEvent = (await batchEventHostLinks(session.accountId, eventIds)).hosts_by_event;
    } catch (err: unknown) {
      if (err instanceof V2CommerceError) {
        return errorResponse(
          "커머스 서버에 연결할 수 없어 이벤트 목록을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.",
          503,
        );
      }
      throw err;
    }
  }

  const merged = listed.events.map((e) => {
    const hosts = hostsByEvent[e.event_id] ?? [];
    const primary = hosts.find((h) => h.role === "host") ?? hosts[0] ?? null;
    return {
      ...toGoEventListView(e),
      organizerId: primary?.host_id ?? null,
      organizerName: primary?.name ?? null,
      organizers: hosts.map((h) => ({
        organizerId: h.host_id,
        name: h.name,
        role: h.role,
        displayOrder: h.display_order,
      })),
      // 커머스 집계(매출 헤드라인 net = revenue − refund_amount)는 v2 목록 응답이 이미 포함.
      attendeeCount: e.attendee_count ?? 0,
      orderCount: e.order_count ?? 0,
      revenue: (e.revenue ?? 0) - (e.refund_amount ?? 0),
    };
  });

  return listResponse(merged, listed.total, page, limit);
});

/**
 * 이벤트 생성 (레벨2 컷오버 W2-EVT — go `events`/`event_organizers` INSERT 제거).
 *
 * 순서: (1) 이벤트 id 를 go 가 채번 → (2) v2 createEvent(멱등키=그 id, `_do_create_event` 가
 * external_ref 를 canonical id 로 채택하므로 **go id == v2 id**) → (3) 주최자 연결 → (4) fee plan.
 * 실패 시 go 쪽에 정리할 앵커 행이 없다(테이블 자체가 없음) — 동일 멱등키 재시도로 수렴한다.
 */
export const POST = withRole("organizer", async (request, { session }) => {
  let body: z.infer<typeof eventSchema>;
  try {
    body = eventSchema.parse(await request.json());
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? ERR.INVALID_INPUT, 400);
    }
    return errorResponse(ERR.INVALID_INPUT, 400);
  }

  // organizers 배열 또는 레거시 organizerId → 통합
  const orgEntries = body.organizers?.length
    ? body.organizers
    : body.organizerId
      ? [{ organizerId: body.organizerId, role: "host" as const, displayOrder: 0 }]
      : null;

  if (!orgEntries || !orgEntries.some((o) => o.role === "host")) {
    return errorResponse("주최(host) 역할이 최소 1개 필요합니다", 400);
  }

  // 🔴 검증과 저장을 같은 함수로 — `Date.parse` 는 통과하는데 변환은 실패하는 값을 없앤다.
  const startsAtIso = toIsoFromKstLocal(body.startsAt);
  const endsAtIso = toIsoFromKstLocal(body.endsAt);
  if (!startsAtIso || !endsAtIso) {
    return errorResponse("시작/종료 일시 형식이 올바르지 않습니다", 400);
  }
  if (endsAtIso < startsAtIso) {
    return errorResponse("종료 일시는 시작 일시 이후여야 합니다", 400);
  }

  // F1: daypass/allpass 는 다일 이벤트여야 한다(종료일 관람 창). 시작·종료가 같은 날이면 반려.
  if (body.admissionMode !== "single") {
    if (endsAtIso.slice(0, 10) <= startsAtIso.slice(0, 10)) {
      return errorResponse(
        "지정일권·전일권은 다일 이벤트에만 사용할 수 있습니다. 종료 일시를 시작일 다음 날 이후로 설정해주세요.",
        400,
      );
    }
  }

  // go 가 채번한 id 가 곧 v2 canonical id 가 된다(멱등키 겸용).
  const eventId = randomUUID();
  const organizerRef = goAccountRef(session.accountId);

  let v2EventId: string;
  try {
    const result = await createEvent(
      {
        organizer_ref: organizerRef,
        external_ref: eventId,
        title: body.title,
        // 🔴 slug 를 반드시 전파한다. 미전송이면 v2 가 자체 slug 를 만들어 공개 라우트가 미스난다.
        // ⚠️ v2 slug 는 **전역 UNIQUE** — 타 계정과 겹치면 409.
        slug: slugify(body.slug),
        venue: body.venueName ?? null,
        description: body.description ?? null,
        venue_address: body.venueAddress ?? null,
        age_rating: body.ageRating ?? null,
        is_online: body.isOnline,
        // 정원(max_attendees) → v2 total_seats. 미입력(무제한)이면 미전송(v2 default 유지).
        total_seats: body.maxAttendees ? Number(body.maxAttendees) : null,
        category: toV2Category(body.eventType),
        // 🔴 category 는 손실 매핑 — go EventType 원본을 같이 보존한다.
        event_type: body.eventType,
        timezone: "Asia/Seoul",
        event_date: startsAtIso,
        // 🔴 W2-EVT — 종료 일시를 **입장방식과 무관하게 항상** 전파한다.
        //   옛 코드는 single 이면 null 을 보내 v2 에 종료 일시가 남지 않았다. go events 테이블을
        //   지우는 순간 그 값은 비가역 소실이므로(목록 "종료" 판정·설정 편집이 전부 못 씀) 항상 보낸다.
        event_date_end: endsAtIso,
        // 개설 시점엔 판매 단계 미설정 → 최선 추정. 이후 sale-plan 이 재계산한다.
        // 🔴 시작이 이미 지난 행사(당일 급조·진행 중·기록용 등록)에서 closes_at 이 과거가 되어
        //    v2 가 400 으로 거절하던 것을 막는다 — 상세 근거는 resolveInitialSaleWindow 참조.
        sale_window: resolveInitialSaleWindow(startsAtIso, endsAtIso, new Date().toISOString()),
        sale_channels: ["self"],
        status: goToV2WriteEventStatus(body.status) ?? "draft",
        image_url: body.heroImageUrl || null,
        image_variants: body.imageVariants ?? null,
        gallery_images: body.galleryImages ?? null,
        // 취소/환불정책 — 옛 go DB DEFAULT 를 코드 상수로 이관해 그대로 전파(정책 소실 방지).
        cancellation_fee_tiers: DEFAULT_CANCELLATION_FEE_TIERS,
        // F1 입장방식 — v2 events.admission_mode(SoT).
        admission_mode: body.admissionMode,
        // F4 경품 활성 — v2 events.raffle_enabled(SoT).
        raffle_enabled: body.raffleEnabled,
        // 좌석 판매 방식 — v2 events.seat_type(SoT). 수정(PATCH)과 같은 값을 생성 시에도 보낸다.
        seat_type: body.seatType,
        // U3 공개 랜딩 게이트 — consumer 가 이 플래그로 RSVP·단체예약 폼 노출을 판정(v2 SoT).
        rsvp_enabled: body.rsvpEnabled ?? false,
        group_booking_enabled: body.groupBookingEnabled ?? false,
        context_banner: body.contextBanner?.trim() || null,
        // 상세페이지 갭 필드 — 생성 폼이 받는 것만(schedules/questions 는 각 전용 라우트가 담당).
        summary: body.summary ?? null,
        transport_info: body.transportInfo || null,
        parking_info: body.parkingInfo || null,
        runtime_minutes: body.runtimeMinutes ?? null,
        intermission_minutes: body.intermissionMinutes ?? null,
      },
      { idempotencyKey: `event-create:${eventId}` },
    );
    v2EventId = result.event_id;
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      // v2 slug 는 전역 UNIQUE(go 는 계정별) — 충돌은 재시도로 풀리지 않으므로 원인을 명시한다.
      if (err.status === 409) {
        return errorResponse("이미 사용 중인 주소(슬러그)입니다. 다른 값으로 변경해주세요.", 409);
      }
      // 🔴 400 은 **입력 문제**라 재시도로 절대 풀리지 않는다. "잠시 후 다시 시도해주세요" 로
      //    뭉개면 주최자는 원인을 모른 채 영원히 재시도한다(실제로 이 경로에서 겪었다).
      //    사유를 그대로 올려 무엇을 고쳐야 하는지 보이게 한다.
      if (err.status === 400) {
        logger.warn("이벤트 생성 v2 검증 실패", { eventId, reason: err.message });
        return errorResponse(`행사 정보를 확인해주세요: ${err.message}`, 400);
      }
      return errorResponse(
        "이벤트 생성 중 커머스 동기화에 실패했습니다. 잠시 후 다시 시도해주세요.",
        503,
      );
    }
    throw err;
  }

  // ── 주최자 연결(옛 go event_organizers INSERT). v2 가 host 소유·역할을 서버 검증한다. ──
  try {
    await putEventHostLinks(
      session.accountId,
      v2EventId,
      orgEntries.map((o) => ({
        host_id: o.organizerId,
        role: o.role,
        display_order: o.displayOrder,
      })),
    );
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      // 400 = 타 계정 주최자 id 포함 등 입력 문제 → 사용자 교정 가능.
      if (err.status === 400) {
        return errorResponse("존재하지 않는 주최자가 포함되어 있습니다", 400);
      }
      // 이벤트는 이미 생성됐다(멱등키로 재시도 가능). 주최자 연결만 실패 → 명시 통지.
      logger.warn("이벤트 생성 후 주최자 연결 실패", { eventId, status: err.status });
      return errorResponse(
        "이벤트는 생성됐지만 주최자 연결에 실패했습니다. 이벤트 설정에서 주최자를 다시 저장해주세요.",
        503,
      );
    }
    throw err;
  }

  // ── 개설 직후 fee plan write-through (주문 전 fee 확정 — 청구=정산 일치) ──
  // ⚠️ go 의 fee_percentage 는 백분율(3.00=3%) → v2 platform_fee_rate 는 소수(0.03).
  // 실패해도 이벤트는 생성됨 → 차단하지 않는다(후속 재시도 가능).
  let feePlanInput: FeePlanInput = {
    fee_type: "percentage_plus_fixed",
    platform_fee_rate: 0.03,
    platform_fee_fixed: 300,
  };
  try {
    const accountPlan = await getAccountFeePlan(session.accountId);
    if (accountPlan) {
      feePlanInput = {
        fee_type: accountPlan.feeType,
        platform_fee_rate: accountPlan.feePercentage / 100,
        platform_fee_fixed: accountPlan.feeFixed,
      };
    }
  } catch (err: unknown) {
    if (!(err instanceof Error)) throw err;
  }
  try {
    await upsertEventFeePlan(v2EventId, feePlanInput, {
      idempotencyKey: `event-feeplan:${eventId}`,
    });
  } catch (err: unknown) {
    if (!(err instanceof V2CommerceError)) throw err;
  }

  return successResponse({ id: eventId, v2EventId }, 201);
});
