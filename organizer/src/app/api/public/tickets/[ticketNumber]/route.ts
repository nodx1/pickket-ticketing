/**
 * GET /api/public/tickets/[ticketNumber] — 공개 티켓 단건 조회(마스킹).
 *
 * ── 레벨2 컷오버 W2-PUB ──
 * go `attendees JOIN events JOIN orders` → v2 `GET /internal/tickets/by-number/{n}`.
 * 티켓번호 체계가 go 와 동일해 이미 배포된 링크가 그대로 유효하다.
 *
 * 실패 계약:
 *   · 미존재 티켓 → 404
 *   · v2 응답 불가 → **503**(재시도 가능). 404 로 뭉개면 "티켓이 사라졌다"는 오해를 준다.
 *   · 접근권 없음 → 403 (기존과 동일)
 *
 * ⚠️ 표시 필드 변경(불가피): go `attendees.name`(참석자명) → v2 주문 구매자명.
 *    v2 는 티켓별 참석자명을 보관하지 않는다(구매자만 SoT). venue_name 은 이벤트 상세에서
 *    보강한다(티켓 응답에는 없다).
 */
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRateLimit } from "@/lib/auth/withRateLimit";
import { canAccessTicketArtifact } from "@/lib/ticket/access";
import { V2CommerceError, getTicketByNumber } from "@/lib/v2/commerce-client";
import { PUBLIC_ANY_STATUS, resolvePublicEventById } from "@/lib/v2/public-event";

type Params = { ticketNumber: string };

/** go SQL 이 하던 마스킹과 동일 규칙(앞 3자 + 도메인 / 앞 3자 + 뒤 4자). */
function maskEmail(email: string | null | undefined): string | null {
  if (!email || !email.includes("@")) return null;
  return `${email.slice(0, 3)}***@${email.split("@")[1] ?? ""}`;
}

function maskPhone(phone: string | null | undefined): string | null {
  if (!phone || phone.length < 7) return null;
  return `${phone.slice(0, 3)}-****-${phone.slice(-4)}`;
}

async function ticketHandler(_request: Request, context: { params: Promise<Params> }) {
  const { ticketNumber } = await context.params;

  let ticket: Awaited<ReturnType<typeof getTicketByNumber>>;
  try {
    ticket = await getTicketByNumber(ticketNumber);
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      if (err.status === 404) return errorResponse("티켓을 찾을 수 없습니다", 404);
      if (err.status >= 400 && err.status < 500) {
        return errorResponse("티켓을 찾을 수 없습니다", 404);
      }
      return errorResponse("티켓 정보를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    return errorResponse("티켓 정보 조회에 실패했습니다", 500);
  }

  // 접근 판정에는 이벤트 소유 테넌트(go account_id)가 필요하다 — 티켓 응답에는 없으므로
  // 이벤트 상세에서 보강한다. 여기서 실패하면 **403 으로 강등하지 않고** 503 을 낸다
  // (경계 확인 실패를 "권한 없음"으로 위장하면 정상 구매자가 영구 차단된다).
  const eventResolved = await resolvePublicEventById(ticket.event_id, PUBLIC_ANY_STATUS);
  if (!eventResolved.ok) {
    return errorResponse(
      eventResolved.status === 404
        ? "티켓을 찾을 수 없습니다"
        : "티켓 정보를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.",
      eventResolved.status,
    );
  }
  const event = eventResolved.event;

  const buyer = ticket.order.buyer;
  if (
    !(await canAccessTicketArtifact(
      buyer?.email ?? "",
      buyer?.phone ?? null,
      event.go_account_id ?? null,
    ))
  ) {
    return errorResponse("티켓에 접근할 수 없습니다", 403);
  }

  return successResponse({
    id: ticket.ticket_id,
    ticketNumber: ticket.ticket_number,
    name: buyer?.name ?? null,
    email: maskEmail(buyer?.email),
    phone: maskPhone(buyer?.phone),
    status: ticket.status,
    raffleNumber: ticket.raffle_number,
    eventTitle: ticket.event.title ?? event.title,
    startsAt: ticket.event.starts_at ?? event.event_date,
    venueName: event.venue ?? null,
    orderNumber: ticket.order.order_number,
    productName: ticket.product_name,
  });
}

export const GET = withRateLimit({
  max: 20,
  windowMs: 60_000,
  keyPrefix: "public:ticket",
})(ticketHandler);
