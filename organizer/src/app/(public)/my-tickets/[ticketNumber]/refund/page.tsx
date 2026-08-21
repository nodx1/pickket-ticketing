import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { verifySession } from "@/lib/auth/session";
import {
  matchesPublicLookup,
  PUBLIC_LOOKUP_COOKIE,
  verifyPublicLookupToken,
} from "@/lib/public-access";
import { V2CommerceError, getEvent, getTicketByNumber } from "@/lib/v2/commerce-client";
import { ContactVerifyClient } from "./contact-verify-client";
import { RefundRequestClient } from "./refund-request-client";

/**
 * ── 레벨2 컷오버 W2-PUB ──
 * go `attendees JOIN orders JOIN events` → v2 `tickets/by-number` 단건 read.
 *
 * ⚠️ 클라이언트에 넘기는 `orderId` 는 **go order id(external_ref)** 를 유지한다.
 *    `/api/public/refund` 가 접수 원장(`refund_requests.order_id`, go orders FK)에 그 값을
 *    쓰기 때문이다. v2 order id 로 바꾸면 FK 위반이 난다.
 *    external_ref 가 없는 v2-네이티브 주문은 go 접수 원장에 쓸 수 없으므로 404 로 막는다.
 *
 * v2 장애를 notFound() 로 뭉개면 "티켓이 사라졌다"가 되므로 throw 해서 error.tsx 로 보낸다.
 */
export default async function TicketRefundPage({
  params,
}: {
  params: Promise<{ ticketNumber: string }>;
}) {
  const { ticketNumber } = await params;
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get("pickket_session")?.value ?? null;
  const session = sessionToken ? await verifySession(sessionToken) : null;
  const lookup = verifyPublicLookupToken(cookieStore.get(PUBLIC_LOOKUP_COOKIE)?.value);

  let ticket: Awaited<ReturnType<typeof getTicketByNumber>>;
  try {
    ticket = await getTicketByNumber(ticketNumber);
  } catch (err: unknown) {
    if (err instanceof V2CommerceError && err.status >= 400 && err.status < 500) {
      notFound();
    }
    // 5xx/네트워크 — 미존재로 위장하지 않는다.
    throw err;
  }

  const goOrderId = ticket.order.external_ref ?? null;
  if (!goOrderId) {
    notFound();
  }

  const buyer = ticket.order.buyer;
  // 🔴 미인증을 404 로 답하지 않는다 (2026-07-31). 티켓은 **실재하는데** "찾을 수 없습니다"
  //    라고 하면 구매자는 *"내 티켓이 사라졌다"* 로 이해한다 — 실제로 그 문의가 들어왔다.
  //    같은 상황에서 티켓 화면은 `/my-tickets?reason=verify_required` 로 보내는데
  //    환불 화면만 404 였다. 두 화면의 처리가 갈라져 있었다.
  //
  //    본인확인 화면을 대신 띄운다. 통과하면 조회쿠키가 구워지고 이 페이지가 다시 그려진다.
  //    ⚠️ 이 분기에서는 `buyer` 를 **한 조각도 넘기지 않는다** — 넘기면 확인 화면에
  //       답이 적혀 있는 꼴이고, 링크를 전달받은 제3자에게 구매자 연락처가 노출된다.
  if (
    !session &&
    !matchesPublicLookup(lookup, {
      email: buyer?.email ?? "",
      phone: buyer?.phone ?? null,
    })
  ) {
    return <ContactVerifyClient ticketNumber={ticketNumber} />;
  }

  // 🔴 행사로 돌아갈 길을 주려면 슬러그가 필요한데 v2 티켓 응답에는 없다(event_id 뿐).
  //    한 번 더 조회한다. ⚠️ **관대하게 폴백한다** — 이건 부가 링크라, 실패했다고
  //    환불 화면 전체를 떨어뜨리면 안 된다(주최자 표기·좌석배치도와 같은 정책).
  let eventSlug: string | null = null;
  try {
    eventSlug = (await getEvent(ticket.event_id)).slug ?? null;
  } catch (err: unknown) {
    if (!(err instanceof V2CommerceError)) throw err;
  }

  return (
    <RefundRequestClient
      eventSlug={eventSlug}
      ticket={{
        ticketNumber: ticket.ticket_number ?? ticketNumber,
        orderId: goOrderId,
        orderNumber: ticket.order.order_number ?? goOrderId,
        buyerEmail: buyer?.email ?? "",
        buyerPhone: buyer?.phone ?? null,
        eventTitle: ticket.event.title ?? "",
      }}
    />
  );
}
