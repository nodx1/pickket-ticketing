/**
 * T2-ORD: 티켓번호 → 산출물(QR/PDF/Apple·Google 지갑/공개조회) 컨텍스트 해석.
 *
 * 기존엔 go `attendees INNER JOIN orders INNER JOIN events` 로 한 방에 읽었다.
 * go `orders`·`attendees` 가 사라지면 이 경로가 통째로 죽으므로(= 이미 발급된 티켓의
 * QR·PDF·지갑 패스 전멸) **티켓/주문 부분을 v2 로 이관**했다.
 *
 * ── W2-ORD: 마지막 go 의존(events) 제거 ──
 * 남아 있던 `SELECT account_id, venue_name FROM events` 는 (a) 접근제어용 go account id,
 * (b) 표시용 공연장명 — 딱 두 값 때문이었다. v2 티켓 상세 응답에 `event.go_account_id`·
 * `event.venue` 를 가산해 그 두 값을 함께 받는다 → **이 경로에 go DB 접근 0**.
 * (v2 왕복이 늘지 않는다 — 같은 응답에 실어 온다.)
 *
 * 실패 정책: v2 404 = 티켓 없음(404). 그 외 v2 오류는 **502 전파** — 티켓이 없는 것처럼
 * 위장하면 구매자가 "티켓이 사라졌다"고 오인한다.
 *
 * 🔴 접근제어 fail-closed: `eventAccountId` 가 null 이면 주최자 세션 경로는 **거부**된다
 * (canAccessTicketArtifact 는 구매자 이메일/전화 일치만 허용). 값을 못 받았을 때 열리는
 * 방향이 아니라 닫히는 방향이므로 v2 미제공 시에도 안전하다.
 */
import { getTicketByNumber, V2CommerceError, type TicketDetail } from "@/lib/v2/commerce-client";

export interface TicketArtifactContext {
  ticketNumber: string;
  /** v2 canonical ticket id — 동적 QR 페이로드 키. */
  v2TicketId: string;
  /** 표시용 참석자명 = v2 주문 구매자명(go attendees.name 과 동일 값으로 write-through 됐다). */
  attendeeName: string;
  orderNumber: string | null;
  productName: string | null;
  status: string;
  buyerEmail: string | null;
  buyerPhone: string | null;
  eventTitle: string;
  startsAt: string | null;
  venueName: string | null;
  /** 접근제어(주최자 세션 소유검증)용 go account id. */
  eventAccountId: string | null;
}

export class TicketArtifactNotFoundError extends Error {
  constructor() {
    super("티켓을 찾을 수 없습니다");
    this.name = "TicketArtifactNotFoundError";
  }
}

export class TicketArtifactUpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TicketArtifactUpstreamError";
  }
}

/** v2 ticket status 중 산출물 발급을 막는 상태(= 구 go `attendees.status != 'cancelled'` 가드). */
const REVOKED_TICKET_STATUSES = new Set(["cancelled", "expired"]);

/**
 * 티켓번호로 산출물 컨텍스트를 해석한다.
 * @param includeRevoked true 면 취소/만료 티켓도 반환(공개 조회 페이지는 상태를 그대로 보여준다).
 */
export async function resolveTicketArtifactContext(
  ticketNumber: string,
  opts: { includeRevoked?: boolean } = {},
): Promise<TicketArtifactContext> {
  let ticket: TicketDetail;
  try {
    ticket = await getTicketByNumber(ticketNumber);
  } catch (err: unknown) {
    if (err instanceof V2CommerceError && err.status === 404) {
      throw new TicketArtifactNotFoundError();
    }
    throw new TicketArtifactUpstreamError(
      `티켓 정보 조회에 실패했습니다: ${err instanceof Error ? err.message : "알 수 없는 오류"}`,
    );
  }

  if (!opts.includeRevoked && REVOKED_TICKET_STATUSES.has(ticket.status.toLowerCase())) {
    throw new TicketArtifactNotFoundError();
  }

  // W2-ORD: 접근제어 account id + 표시용 공연장명은 v2 티켓 상세가 함께 내려준다(go DB read 0).
  const eventAccountId = ticket.event.go_account_id ?? null;
  const venueName = ticket.event.venue ?? null;

  return {
    ticketNumber: ticket.ticket_number ?? ticketNumber,
    v2TicketId: ticket.ticket_id,
    attendeeName: ticket.order.buyer?.name ?? "",
    orderNumber: ticket.order.order_number,
    productName: ticket.product_name,
    status: ticket.status,
    buyerEmail: ticket.order.buyer?.email ?? null,
    buyerPhone: ticket.order.buyer?.phone ?? null,
    eventTitle: ticket.event.title ?? "",
    startsAt: ticket.event.starts_at,
    venueName,
    eventAccountId,
  };
}
