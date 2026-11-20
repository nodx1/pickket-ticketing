/**
 * v2 `EventDetail` → go 주최자 화면이 기대하는 camelCase 뷰 (레벨2 컷오버 W2-EVT).
 *
 * ## 왜 필요한가
 * 이 트랙에서 go `events` 테이블 read 를 전부 없앴다. 옛 라우트들이 `SELECT ... AS "venueName"`
 * 로 만들던 응답 shape 을 **한 곳에서** 재생산해, 라우트마다 필드명이 미묘하게 갈라지는 것을 막는다.
 *
 * ## 🔴 endsAt 폴백
 * go `events.ends_at` 은 NOT NULL 이었지만 v2 `event_date_end` 는 **다일(daypass/allpass)일 때만**
 * 채워지던 컬럼이다. W2-EVT 부터 go 는 단일일 이벤트도 `event_date_end` 를 항상 전파한다
 * (그러지 않으면 go DB 제거 시 종료 일시가 비가역 소실). 다만 **이 트랙 이전에 생성된 이벤트**는
 * v2 에 값이 없으므로 `event_date` 로 폴백한다 — 값이 없다고 화면을 깨뜨리지 않는다.
 */
import type { EventDetail, EventListItem } from "@/lib/v2/commerce-client";

/** go `events.cancellation_policy` 형태. */
export interface GoCancellationTier {
  daysBefore: number;
  feePct: number;
}

/**
 * 신규 이벤트 기본 취소/환불 정책.
 *
 * 🔴 옛 go `events.cancellation_policy` 컬럼의 **DB DEFAULT**(마이그 111)를 코드로 옮긴 값이다.
 * go events 테이블이 사라지면 그 DEFAULT 도 함께 사라지므로, 여기서 명시하지 않으면
 * 신규 이벤트가 "취소 수수료 정책 없음"으로 생성되어 환불 규칙이 통째로 바뀐다.
 * v2 스키마(`cancellation_fee_tiers`) 형태로 바로 쓸 수 있게 snake_case 로 둔다.
 */
export const DEFAULT_CANCELLATION_FEE_TIERS: Array<{ days_before: number; fee_pct: number }> = [
  { days_before: 30, fee_pct: 0 },
  { days_before: 7, fee_pct: 30 },
  { days_before: 3, fee_pct: 50 },
  { days_before: 1, fee_pct: 80 },
  { days_before: 0, fee_pct: 100 },
];

function contentOf(event: EventDetail): Record<string, unknown> {
  return (event.content ?? {}) as Record<string, unknown>;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** v2 `cancellation_fee_tiers`([{days_before,fee_pct}]) → go `cancellation_policy`. */
export function toGoCancellationPolicy(event: EventDetail): GoCancellationTier[] {
  return (event.cancellation_fee_tiers ?? []).map((t) => ({
    daysBefore: t.days_before,
    feePct: t.fee_pct,
  }));
}

/**
 * 종료 일시. v2 `event_date_end` 우선, 없으면 `event_date` 폴백(위 주석 참조).
 * 둘 다 없으면 null — 호출측이 "미설정"으로 판정한다(가짜 값을 지어내지 않는다).
 */
export function resolveEndsAt(event: EventDetail): string | null {
  return event.event_date_end ?? event.event_date ?? null;
}

/** 상세/설정 화면 공통 뷰. */
export function toGoEventView(event: EventDetail) {
  const content = contentOf(event);
  return {
    id: event.event_id,
    title: event.title,
    slug: event.slug,
    summary: str(content.summary),
    description: event.description,
    venueName: event.venue,
    venueAddress: event.venue_address ?? null,
    venueLat: event.venue_lat ?? null,
    venueLng: event.venue_lng ?? null,
    startsAt: event.event_date,
    endsAt: resolveEndsAt(event),
    timezone: event.timezone ?? "Asia/Seoul",
    /**
     * 🔴 구매 대기열 사용 여부. **공개 상세 페이지가 이 값을 알아야 한다**(2026-08-01).
     *
     * 종전엔 이 값이 뷰에 없어서, 대기열을 **안 쓰는 행사에서도** 상세 페이지가
     * `POST .../queue/join` 을 무조건 한 번 던지고 그 응답이 와야 구매 버튼이 풀렸다.
     * 그 왕복은 내부에서 v2 를 부르므로, v2 가 한 번 흔들리면 페이지는 멀쩡한데
     * **구매 버튼만 "대기열 확인 중..." 으로 잠긴 채 복구되지 않았다.**
     * 안 쓰는 기능 때문에 결제가 막히는 구조라 값을 내려 **부르지 않게** 한다.
     */
    queueEnabled: event.queue_enabled === true,
    status: event.status,
    // 🔴 category 가 아니라 event_type(go 원본 13종+). category 는 손실 파생이라 편집 UI 가 쓰면 안 된다.
    eventType: event.event_type ?? null,
    ageRating: event.age_rating ?? null,
    maxAttendees: event.total_seats ?? null,
    isOnline: event.is_online ?? false,
    homepageUrl: event.homepage_url ?? null,
    heroImageUrl: event.image_url,
    imageVariants: event.image_variants ?? null,
    galleryImages: event.gallery_images ?? null,
    transportInfo: str(content.transport_info),
    parkingInfo: str(content.parking_info),
    /**
     * 🔴 프로그램 탭 자유문구 (2026-08-02).
     *
     * v2 는 이 값을 **컬럼으로 갖고 있고 `EventUpdate` 로 받기도 하는데**,
     * `internal_commerce.py` 의 `_event_detail_dict` content 블록에 **노출이 없어서**
     * organizer 로 돌아오지 않았다(그 파일에 이름이 0건). 그래서 주최자가 저장해도
     * 설정 화면에도 공개 상세에도 나타나지 않았다 — 「반쪽 배포」의 실체다.
     *
     * ⚠️ v2 노출 2줄이 선행이다(메인 세션). 그 전까지는 여기서 `null` 이 되고,
     *    탭·화면은 **값이 없는 경우로 정상 동작**한다(만들지 않고 비워둔다).
     */
    programNotes: str(content.program_notes),
    stageInfo: str(content.stage_info),
    runtimeMinutes: num(content.runtime_minutes),
    intermissionMinutes: num(content.intermission_minutes),
    seoMetadata: (content.seo_metadata ?? null) as Record<string, unknown> | null,
    enabledFeatures: event.enabled_features ?? [],
    saleChannels: event.sale_channels ?? ["self"],
    cancellationPolicy: toGoCancellationPolicy(event),
    rsvpEnabled: event.rsvp_enabled ?? false,
    groupBookingEnabled: event.group_booking_enabled ?? false,
    contextBanner: event.context_banner ?? null,
    admissionMode: event.admission_mode ?? "single",
    raffleEnabled: event.raffle_enabled ?? false,
    // 좌석 판매 방식 — `티켓 & 좌석` 화면이 배치도 에디터 노출을 이 값으로 가른다.
    // v2 미전송(구버전 응답)이면 assigned 로 본다 = 현행 동작 유지.
    seatType: event.seat_type ?? "assigned",
    homepageDesign: event.homepage_design ?? null,
    landingConfig: event.landing_config ?? null,
    customDomain: event.custom_domain ?? null,
  };
}

/** 목록 화면 공통 뷰(집계는 호출측이 병합). */
export function toGoEventListView(item: EventListItem) {
  return {
    id: item.event_id,
    title: item.title,
    slug: item.slug ?? "",
    summary: item.summary ?? null,
    venueName: item.venue ?? null,
    startsAt: item.event_date,
    // 목록도 상세와 같은 폴백 규칙(단일일 이벤트는 event_date_end 가 비어 있을 수 있다).
    endsAt: item.event_date_end ?? item.event_date,
    status: item.status,
    eventType: item.event_type ?? null,
    ageRating: item.age_rating ?? null,
    maxAttendees: item.total_seats ?? null,
    isOnline: item.is_online ?? false,
    heroImageUrl: item.image_url ?? null,
  };
}
