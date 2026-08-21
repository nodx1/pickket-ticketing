/**
 * 이벤트 접근·앵커 해석 — v2 단일 SoT 판 (레벨2 컷오버 T2-EVT).
 *
 * ## 왜 옛 앵커 헬퍼(`ensureV2EventAnchor`, 삭제됨)를 대체하는가
 * v2 `_do_create_event` 는 **go event id 를 v2 events.id 로 그대로 채택**한다
 * (`canonical_id = uuid.UUID(external_ref)`). 즉 `go events.id == v2 events.id` 다.
 * 따라서 `SELECT v2_event_id FROM events WHERE id = $1` 이라는 앵커 조회는 **불필요**하고,
 * URL 의 eventId 를 그대로 v2 에 넘기면 된다(= go events 테이블 의존 소멸).
 *
 * ## 🔴 잃어버리면 안 되는 것: 테넌트 경계
 * 옛 앵커 조회의 상당수는 `AND account_id = $2` 를 달고 있었다 — 그게 **유일한 소유 검증**인
 * 라우트가 많다. 앵커만 지우고 eventId 를 그대로 쓰면 **크로스테넌트 누출(Critical)** 이 된다.
 * 그래서 이 모듈의 기본형은 "id 를 통과시키는 함수"가 아니라 **소유 검증을 포함한 조회**다.
 * 경계는 v2 가 강제한다(`GET /internal/events/{id}?organizer_ref=<accountId>` → 불일치 404).
 *
 * ## 조용한 폴백 금지
 * v2 가 404 를 주면 "앵커 미준비"로 뭉개지 말고 **없거나 내 것이 아님**으로 명확히 처리한다.
 * 옛 코드가 같은 앵커 미스에 404·409·200-빈배열·무시를 제각각 반환하던 것을 여기서 통일한다.
 */
import {
  type EventDetail,
  V2CommerceError,
  getEvent,
  getEventBySlug,
} from "@/lib/v2/commerce-client";

/**
 * 이벤트 접근 실패. `reason` 으로 호출측이 상태코드를 고른다.
 * - `not_found`  — 없거나 **내 계정 소유가 아님**(존재 사실을 노출하지 않기 위해 동일 취급)
 * - `unavailable` — v2 가 일시적으로 응답 불가(5xx/네트워크). 404 로 오인하면 안 된다.
 */
export class EventAccessError extends Error {
  constructor(
    message: string,
    readonly reason: "not_found" | "unavailable",
    readonly status: number,
  ) {
    super(message);
    this.name = "EventAccessError";
  }
}

/**
 * `EventAccessError` → HTTP 상태코드 (레벨2 컷오버 W2-EVT 라우트 컨벤션).
 *
 * 🔴 v2 장애를 404 로 뭉개면 주최자에게 "이벤트가 사라졌다"고 거짓말하게 된다.
 *    특히 DELETE 계열에서 그 오인은 **지우지 않은 것을 지웠다고 응답**하는 사고가 된다.
 *    - `not_found`  → 404 (없음 = 내 것이 아님)
 *    - `unavailable` → 503 (일시적 커머스 장애 — 재시도 가능)
 *
 * ⚠️ `EventAccessError.status` 필드는 502 를 담고 있다(선행 트랙 계약, 변경 금지).
 *    라우트 응답 코드는 이 함수를 써서 결정한다.
 */
export function eventAccessStatus(err: EventAccessError): 404 | 503 {
  return err.reason === "not_found" ? 404 : 503;
}

/**
 * go event id → v2 canonical event id.
 *
 * ID 승격(위 주석) 이후 둘은 **같은 값**이므로 순수 함수다. DB 왕복이 없다.
 * 앵커가 실제로 유효한지(= v2 에 그 이벤트가 있는지)는 이후 v2 호출이 404 로 알려준다 —
 * 여기서 존재를 보장하지 않는다. 소유 검증이 필요하면 `requireOwnedEvent` 를 써라.
 */
export function toV2EventId(goEventId: string): string {
  return goEventId;
}

/**
 * 소유 검증 포함 이벤트 조회. **주최자 스코프 라우트의 기본형.**
 *
 * @returns 이벤트 상세. 없거나 타 계정 소유면 `null`.
 * @throws EventAccessError(reason="unavailable") v2 장애 시 — 호출측이 404 로 뭉개면 안 된다.
 */
export async function getOwnedEvent(
  eventId: string,
  accountId: string,
): Promise<EventDetail | null> {
  try {
    // organizer_ref 를 넘기면 v2 가 organizer_id 경계를 강제한다(불일치 → 404).
    return await getEvent(eventId, { organizerRef: accountId });
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      if (err.status === 404) return null; // 없음 = 내 것이 아님(구분하지 않는다)
      throw new EventAccessError(
        "커머스 서버에 연결할 수 없어 이벤트를 확인하지 못했습니다",
        "unavailable",
        502,
      );
    }
    throw err;
  }
}

/**
 * 소유 검증 포함 이벤트 조회(필수형). 없으면 던진다.
 *
 * @throws EventAccessError(reason="not_found", status=404)
 * @throws EventAccessError(reason="unavailable", status=502)
 */
export async function requireOwnedEvent(
  eventId: string,
  accountId: string,
): Promise<EventDetail> {
  const event = await getOwnedEvent(eventId, accountId);
  if (!event) {
    throw new EventAccessError("이벤트를 찾을 수 없습니다", "not_found", 404);
  }
  return event;
}

/**
 * 앵커 조회 대체 — 소유 검증을 거친 v2 event id.
 *
 * 옛 `SELECT v2_event_id FROM events WHERE id=$1 AND account_id=$2` 의 1:1 대체다.
 * 반환값은 결국 eventId 와 같지만, **v2 에 실제로 존재하고 내 계정 소유임을 확인**한 뒤
 * 돌려준다는 점이 핵심이다(순수 통과 함수로 바꾸면 경계가 사라진다).
 *
 * @returns v2 event id. 없거나 타 계정 소유면 `null`.
 */
export async function resolveOwnedV2EventId(
  eventId: string,
  accountId: string,
): Promise<string | null> {
  const event = await getOwnedEvent(eventId, accountId);
  return event ? event.event_id : null;
}

/**
 * 공개(비인증) 라우트용 slug 조회.
 *
 * go 는 `WHERE slug=$1` 을 계정 스코프 없이 조회했고(테넌트별 UNIQUE 인데도 전역 LIMIT 1),
 * v2 slug 는 전역 UNIQUE 라 오히려 결정적이다.
 * ⚠️ 상태 게이트(`live` / `live|soldout` / `live|paused`)는 라우트마다 달라서 v2 가
 *    하드 필터하지 않는다 — **호출측이 반환된 `status` 로 판정**해야 한다.
 *
 * @returns 이벤트 상세. 없으면 `null`.
 * @throws EventAccessError(reason="unavailable") v2 장애 시.
 */
export async function getPublicEventBySlugV2(slug: string): Promise<EventDetail | null> {
  try {
    return await getEventBySlug(slug);
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      if (err.status === 404) return null;
      throw new EventAccessError(
        "커머스 서버에 연결할 수 없어 이벤트를 확인하지 못했습니다",
        "unavailable",
        502,
      );
    }
    throw err;
  }
}

/**
 * 판매 개시(공개) 전 커머스 정합성 게이트 (P1, 옛 앵커 모듈에서 이관 — 시그니처에 accountId 추가).
 *
 * v2(커머스 SoT)에 **판매 가능한 티어**(capacity>0)가 하나라도 있는지 검증한다.
 * 없으면 예외 — "재고 없이 공개"되어 소비자 상세가 렌더 실패하는 유령 이벤트를 원천 차단한다.
 * (무료 이벤트 대비 base_price 는 >=0 허용, capacity>0 만 필수.)
 *
 * @throws Error 커머스 미준비 시(호출측이 400 등으로 사용자 통지).
 */
export async function assertCommerceReadyForSale(
  eventId: string,
  accountId: string,
): Promise<void> {
  const { listTiers } = await import("@/lib/v2/commerce-client");
  const { logger } = await import("@/lib/logger");

  const event = await getOwnedEvent(eventId, accountId);
  if (!event) throw new Error("이벤트를 찾을 수 없습니다");

  const { tiers } = await listTiers(event.event_id);
  const sellable = tiers.some((t) => Number(t.capacity) > 0);
  if (!sellable) {
    // 관측성(P2): 재고 없는 공개 시도를 차단 — v2 커머스 동기화가 안 된 이벤트.
    logger.warn("판매 개시 차단: v2 에 판매가능 티어 없음", {
      eventId,
      v2EventId: event.event_id,
      tierCount: tiers.length,
    });
    throw new Error(
      "판매 정보(좌석 등급·재고)가 아직 준비되지 않았습니다. 상품/좌석 등급을 등록한 뒤 다시 개시해주세요.",
    );
  }
}
