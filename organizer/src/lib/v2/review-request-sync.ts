/**
 * GO → v2 이벤트 심사 요청 webhook.
 *
 * 주최자가 'pending_review' 로 전이할 때 v2 로 이벤트를 upsert 시킴.
 * v2 에서는 어드민 심사 큐에 이벤트가 노출됨.
 *
 * v2 수신 엔드포인트: POST /api/v1/internal/events/review-requested
 *
 * 환경변수:
 *   V2_INTERNAL_BASE_URL
 *   V2_EVENT_SYNC_SECRET (v2 쪽 GO_WEBHOOK_SECRET 과 동일 값)
 *
 * ## 레벨2 컷오버 W2-EVT
 * 페이로드 소스가 **go `events` SELECT → v2 이벤트 상세 read** 로 바뀌었다. 이벤트 정본이 이미
 * v2 에 있으므로 이 호출은 "심사 큐 등재 + venue 자동생성 + phase 재계산" 트리거 역할만 한다.
 *
 * ⚠️ 옛 페이로드의 `organizerName` / `organizerTrustTier` 는 go `accounts` JOIN 으로 채우던
 *    값인데, v2 수신 모델(`ReviewRequestPayload`)에 해당 필드가 **없어 무시된다**(실측:
 *    platform/backend/app/api/v1/internal_sync.py). go accounts 의존을 없애기 위해 전송을
 *    중단한다 — v2 동작에는 변화가 없다.
 */
import crypto from "node:crypto";
import { logger } from "@/lib/logger";
import { getOwnedEvent } from "@/lib/v2/event-access";

const V2_PATH = "/api/v1/internal/events/review-requested";

/**
 * 판매 단계 일정 payload 타입 (v2 계약 유지용).
 *
 * ⚠️ 레벨2 컷오버 T2-PHASE 이후 go 는 **항상 빈 배열**을 보낸다. 판매계획 SSOT 는
 * v2 `phase_configs` 이고 정본 write 는 `PUT /internal/events/{id}/sale-plan` 이다.
 * 타입은 v2 스키마 호환을 위해 남긴다(필드 제거는 계약 변경이므로 금지).
 */
interface PhaseSchedule {
  mode: string;
  phaseOrder: number;
  opensAt: string;
  closesAt: string;
}

interface ReviewRequestedPayload {
  eventId: string;
  slug: string;
  title: string;
  summary?: string;
  description?: string;
  eventType: string;
  startsAt: string;
  endsAt: string;
  venueName?: string;
  venueAddress?: string;
  heroImageUrl?: string;
  maxAttendees?: number;
  ageRating?: string;
  isOnline?: boolean;
  submittedAt: string;
  /** 주최자 조직 식별 (심사 참고용) */
  organizerAccountId: string;
  /** 판매 단계 일정 — phase SSOT 이관 후 항상 빈 배열. */
  phaseSchedules: PhaseSchedule[];
}

function sign(secret: string, timestamp: string, body: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
}

/**
 * 이벤트가 심사 요청 상태(pending_review)로 전이했을 때 v2 로 push.
 * fire-and-forget — 실패해도 go 응답에 영향 없음(호출부가 `void` 로 부른다).
 *
 * @param accountId 소유 계정. **테넌트 경계용으로 필수** — v2 read 에 organizer_ref 로 넘겨
 *   타 계정 이벤트를 심사 큐에 밀어넣지 못하게 한다.
 */
export async function pushReviewRequestToV2(
  eventId: string,
  accountId: string,
): Promise<boolean> {
  const baseUrl = process.env.V2_INTERNAL_BASE_URL;
  const secret = process.env.V2_EVENT_SYNC_SECRET;

  if (!baseUrl || !secret) {
    logger.debug("v2 review-requested 스킵: env 미설정");
    return false;
  }

  try {
    const event = await getOwnedEvent(eventId, accountId);
    if (!event) {
      logger.warn("review-requested 스킵: 이벤트 없음(또는 타 계정)", { eventId });
      return false;
    }

    const content = (event.content ?? {}) as Record<string, unknown>;
    const startsAt = event.event_date;
    // v2 는 종료 일시를 event_date_end 에 담는다. 미설정(옛 단일일 이벤트) → 시작 일시 폴백.
    const endsAt = event.event_date_end ?? event.event_date;
    if (!startsAt || !endsAt) {
      logger.warn("review-requested 스킵: 일시 미설정", { eventId });
      return false;
    }

    const payload: ReviewRequestedPayload = {
      eventId: event.event_id,
      slug: event.slug,
      title: event.title,
      summary: typeof content.summary === "string" ? content.summary : undefined,
      description: event.description ?? undefined,
      // 🔴 category 가 아니라 go EventType 원본. v2 가 자체 매핑표로 category 를 재계산한다.
      eventType: event.event_type ?? "conference",
      startsAt: new Date(startsAt).toISOString(),
      endsAt: new Date(endsAt).toISOString(),
      venueName: event.venue ?? undefined,
      venueAddress: event.venue_address ?? undefined,
      heroImageUrl: event.image_url ?? undefined,
      maxAttendees: event.total_seats ?? undefined,
      ageRating: event.age_rating ?? undefined,
      isOnline: event.is_online ?? false,
      submittedAt: new Date().toISOString(),
      organizerAccountId: accountId,
      // 판매계획 SSOT 는 v2 phase_configs — 빈 배열이면 v2 가 "변경 없음"으로 흡수한다.
      phaseSchedules: [],
    };

    const url = `${baseUrl.replace(/\/$/, "")}${V2_PATH}`;
    const timestamp = new Date().toISOString();
    const deliveryId = crypto.randomUUID();
    const body = JSON.stringify(payload);
    const signature = sign(secret, timestamp, body);

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Pickket-Signature": signature,
        "X-Pickket-Timestamp": timestamp,
        "X-Pickket-Event": "event.review_requested",
        "X-Pickket-Delivery-Id": deliveryId,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });

    if (res.ok) {
      logger.info("v2 심사 요청 전송 성공", { eventId, deliveryId });
      return true;
    }

    logger.warn("v2 심사 요청 전송 실패", {
      eventId,
      status: res.status,
      body: await res.text().catch(() => ""),
    });
    return false;
  } catch (err) {
    logger.warn("v2 심사 요청 전송 에러", {
      eventId,
      error: err instanceof Error ? err.message : "unknown",
    });
    return false;
  }
}
