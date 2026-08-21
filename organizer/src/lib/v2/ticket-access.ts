/**
 * W4-ORD: v2 티켓 소유검증 — go `attendees` 앵커 조회를 대체하는 단일 진입점.
 *
 * 지금까지 참석자 상세·체크인은 go `attendees` 를 먼저 SELECT 해 세 가지를 동시에 얻었다:
 *   ① 테넌트 경계(account_id + event_id 조건) ② v2_ticket_id ③ 표시값(이름·티켓번호·상태).
 * 참석자 정본이 v2 티켓으로 넘어간 뒤 ②③ 은 v2 가 정본이므로, ① 만 v2 응답으로 옮기면
 * go 앵커 조회가 통째로 사라진다. v2 단건 티켓 응답은 `event_id` 와 `event.go_account_id`
 * (= go accounts.id)를 함께 내려주므로 두 값을 대조해 경계를 강제할 수 있다.
 *
 * 🔴 설계 원칙 — 세 결과를 **절대 뭉개지 않는다**:
 *   · 없음/미소유  → `null`  → 라우트는 404. (정보 누출 방지: 두 경우를 구분하지 않는다)
 *   · v2 장애      → throw   → 라우트는 503. **"없음"으로 위장 금지.**
 *     이걸 null 로 흘리면 v2 가 죽은 동안 모든 티켓이 "존재하지 않음"이 되고, DELETE/취소
 *     경로에서는 그게 "이미 처리됨 → 성공"으로 둔갑한다(과거 실결함 패턴).
 *   · `go_account_id` 가 null(= v2 네이티브 주최자)이면 **소유 증명 불가 → 거부**.
 *     열리는 방향이 아니라 닫히는 방향이다.
 */
import { getTicket, getTicketByNumber, V2CommerceError, type TicketDetail } from "@/lib/v2/commerce-client";

/** v2 장애로 티켓 소유 여부를 **판정하지 못했다**는 신호. 라우트는 503 으로 변환한다. */
export class TicketAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TicketAccessError";
  }
}

/** 소유 판정 — v2 티켓이 이 이벤트·이 계정 것인지. 아니면 null(404 대상). */
function ownedOrNull(ticket: TicketDetail, eventId: string, accountId: string): TicketDetail | null {
  // go event id == v2 event id 항등(T2-EVT). 이벤트 스코프가 어긋나면 남의 이벤트 티켓이다.
  if (ticket.event_id !== eventId) return null;
  // 소유 계정 증명 불가(null) 또는 불일치 → 거부.
  if (!ticket.event.go_account_id || ticket.event.go_account_id !== accountId) return null;
  return ticket;
}

function toAccessError(err: unknown, what: string): never {
  if (err instanceof V2CommerceError) {
    throw new TicketAccessError(`${what} 조회에 실패했습니다 (v2: ${err.message})`);
  }
  throw err;
}

/**
 * v2 ticket id 로 이 이벤트·계정 소유 티켓을 해석한다.
 * @returns 티켓 | null(없음·미소유 → 404)
 * @throws TicketAccessError v2 장애(→ 503)
 */
export async function resolveOwnedTicket(
  ticketId: string,
  eventId: string,
  accountId: string,
): Promise<TicketDetail | null> {
  let ticket: TicketDetail;
  try {
    ticket = await getTicket(ticketId);
  } catch (err: unknown) {
    // 404 만 "없음". 그 외(5xx/네트워크)는 판정 불가 → 장애로 올린다.
    if (err instanceof V2CommerceError && err.status === 404) return null;
    toAccessError(err, "티켓 정보");
  }
  return ownedOrNull(ticket, eventId, accountId);
}

/**
 * 티켓번호(TKT-…)로 이 이벤트·계정 소유 티켓을 해석한다(체크인 스캔·수기입력 진입점).
 * @returns 티켓 | null(없음·미소유 → 404)
 * @throws TicketAccessError v2 장애(→ 503)
 */
export async function resolveOwnedTicketByNumber(
  ticketNumber: string,
  eventId: string,
  accountId: string,
): Promise<TicketDetail | null> {
  let ticket: TicketDetail;
  try {
    ticket = await getTicketByNumber(ticketNumber);
  } catch (err: unknown) {
    if (err instanceof V2CommerceError && err.status === 404) return null;
    toAccessError(err, "티켓 정보");
  }
  return ownedOrNull(ticket, eventId, accountId);
}
