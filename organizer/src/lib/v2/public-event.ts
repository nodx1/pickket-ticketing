/**
 * 공개(비인증) 라우트용 이벤트 해석 — 레벨2 컷오버 W2-PUB.
 *
 * ## 무엇을 대체하나
 * go 공개 라우트가 공통으로 돌리던 두 SQL 을 v2 live read 로 바꾼다.
 *   · `SELECT id, status, v2_event_id FROM events WHERE slug = $1 LIMIT 1`
 *   · `SELECT ... FROM events WHERE id = $1 LIMIT 1`
 * ID 승격(go event id == v2 event id) 이후 앵커 조회는 없어졌고, 남은 건
 * **존재 확인 + 상태 게이트**뿐이다. 그 둘을 여기 한 곳에 모은다.
 *
 * ## 🔴 fail-closed 3원칙 (wave1 에서 실제로 터진 결함들)
 * 1. **v2 장애를 404/빈목록으로 위장하지 않는다.** 미존재=404, v2 불가=**503**(재시도 신호).
 *    둘을 뭉개면 "판매중인 이벤트가 사라진 화면"이 조용히 뜬다.
 * 2. **상태 게이트를 잃지 않는다.** 옛 SQL 의 `status='live'` 류 조건은 라우트마다 다르다
 *    (`live` / `live|soldout` / `live|paused`). v2 by-slug 는 하드 필터하지 않으므로
 *    호출측이 반드시 판정해야 한다 — 그 판정을 여기서 강제한다(allowed 필수 인자).
 * 3. **read 가 write 를 일으키지 않는다.** 이 모듈은 조회만 한다(이벤트 생성/앵커 write 없음).
 *
 * ## 상태 어휘
 * v2 는 `status` 를 go 4-상태(`draft|live|paused|archived`)로 이미 투영해 내려준다.
 * go 가 쓰던 `soldout` 은 v2 투영에 존재하지 않지만(재고 매진은 status 가 아니라 티어 집계),
 * 옛 게이트와의 동작 동일성을 위해 허용목록에는 그대로 남긴다(무해한 상위집합).
 */
import type { EventDetail } from "@/lib/v2/commerce-client";
import { V2CommerceError, getEvent } from "@/lib/v2/commerce-client";
import { EventAccessError, getPublicEventBySlugV2 } from "@/lib/v2/event-access";

/** 좌석/구매 UI 공개 조건 — 옛 `!["live","soldout"].includes(status)` 게이트. */
export const PUBLIC_PURCHASE_STATUSES = ["live", "soldout"] as const;
/** 공개 노출만 허용 — 옛 `WHERE status = 'live'` 게이트(캘린더·위젯·목록). */
export const PUBLIC_LIVE_STATUSES = ["live"] as const;
/** 문의 등 판매 중단 중에도 받아야 하는 경로 — 옛 `status IN ('live','paused')`. */
export const PUBLIC_LIVE_OR_PAUSED_STATUSES = ["live", "paused"] as const;

export type PublicEventResult =
  | { ok: true; event: EventDetail }
  /** 미존재 / 상태 게이트 탈락(존재 사실을 노출하지 않기 위해 동일 취급). */
  | { ok: false; status: 404; reason: "not_found"; error: string }
  /** v2 응답 불가 — 재시도 가능. 절대 404·빈결과로 강등하지 말 것. */
  | { ok: false; status: 503; reason: "unavailable"; error: string };

const NOT_FOUND_MESSAGE = "이벤트를 찾을 수 없습니다";
const UNAVAILABLE_MESSAGE =
  "이벤트 정보를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.";

function notFound(): PublicEventResult {
  return { ok: false, status: 404, reason: "not_found", error: NOT_FOUND_MESSAGE };
}

function unavailable(): PublicEventResult {
  return { ok: false, status: 503, reason: "unavailable", error: UNAVAILABLE_MESSAGE };
}

function gate(event: EventDetail, allowed: readonly string[]): PublicEventResult {
  // 상태 게이트 — 탈락은 404 로 투영한다(draft 이벤트의 존재를 공개 경로에 흘리지 않는다).
  return allowed.includes(event.status) ? { ok: true, event } : notFound();
}

/**
 * slug → 공개 이벤트. 옛 `SELECT ... FROM events WHERE slug=$1` + 상태검사의 1:1 대체.
 *
 * @param allowed 허용 status 목록. **생략 불가** — 기본값을 두면 라우트가 게이트를
 *   빠뜨렸는지 리뷰에서 보이지 않는다(draft 노출 사고의 씨앗).
 */
export async function resolvePublicEventBySlug(
  slug: string,
  allowed: readonly string[],
): Promise<PublicEventResult> {
  try {
    const event = await getPublicEventBySlugV2(slug);
    if (!event) return notFound();
    return gate(event, allowed);
  } catch (err: unknown) {
    if (err instanceof EventAccessError) {
      // reason==="unavailable" 만 던져진다(not_found 는 null 반환). 그래도 명시 분기.
      return err.reason === "not_found" ? notFound() : unavailable();
    }
    throw err;
  }
}

/**
 * event id → 공개 이벤트. 옛 `SELECT ... FROM events WHERE id=$1` 의 대체.
 * ID 승격으로 URL 의 eventId 가 곧 v2 canonical id 다(변환 없음).
 */
export async function resolvePublicEventById(
  eventId: string,
  allowed: readonly string[],
): Promise<PublicEventResult> {
  try {
    const event = await getEvent(eventId);
    return gate(event, allowed);
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      if (err.status === 404) return notFound();
      // 4xx(잘못된 uuid 등)도 미존재로 투영 — 공개 경로에 v2 내부 오류를 노출하지 않는다.
      if (err.status >= 400 && err.status < 500) return notFound();
      return unavailable();
    }
    throw err;
  }
}

/** 상태 게이트 없이 존재만 확인해야 하는 경로(예: 배너·캐시 갱신)용. */
export const PUBLIC_ANY_STATUS = ["draft", "live", "paused", "archived"] as const;
