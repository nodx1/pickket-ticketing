import React from "react";
import { renderToBuffer, type DocumentProps } from "@react-pdf/renderer";
import { errorResponse } from "@/lib/apiResponse";
import { formatDate } from "@/lib/format";
import { TicketPDF } from "@/lib/pdf/ticket-template";
import { canAccessTicketArtifact } from "@/lib/ticket/access";
import {
  resolveTicketArtifactContext,
  TicketArtifactNotFoundError,
  TicketArtifactUpstreamError,
  type TicketArtifactContext,
} from "@/lib/ticket/artifact-context";

type Params = { ticketNumber: string };

export async function GET(_request: Request, context: { params: Promise<Params> }) {
  const { ticketNumber } = await context.params;

  // T2-ORD: go attendees/orders JOIN → v2 티켓번호 조회(SoT).
  // PDF 는 이미 발권된 티켓의 재출력이므로 취소/만료 티켓도 상태 그대로 발급한다
  // (구 동작과 동일 — 옛 쿼리에도 status 가드가 없었다).
  let ticket: TicketArtifactContext;
  try {
    ticket = await resolveTicketArtifactContext(ticketNumber, { includeRevoked: true });
  } catch (err: unknown) {
    if (err instanceof TicketArtifactNotFoundError) {
      return errorResponse(err.message, 404);
    }
    if (err instanceof TicketArtifactUpstreamError) {
      return errorResponse(err.message, 502);
    }
    return errorResponse("티켓 PDF 생성에 실패했습니다", 500);
  }

  if (!(await canAccessTicketArtifact(ticket.buyerEmail, ticket.buyerPhone, ticket.eventAccountId, ticketNumber))) {
    return errorResponse("티켓에 접근할 수 없습니다", 403);
  }

  // 트랙 7.6 — 좌석 정보 (좌석 지정 이벤트만)
  const seatInfo: {
    section: string;
    row: string;
    seatNumber: string;
    floorLabel: string | null;
    tierName: string | null;
  } | null = null;
  // ── 레벨2 컷오버 T1 — 좌석 표기 조회 제거 ──
  // 이전엔 `seats WHERE reserved_order_id = $1` 로 주문의 좌석을 찾아 section/row/floor/tier 를 찍었다.
  // 그런데 `reserved_order_id` 는 코드베이스 어디에서도 **write 되지 않는다**(빅뱅 flip 때
  // markReserved/markSold 가 폐기되며 write 경로가 사라짐 — lib/seats/repo.ts 참조).
  // 즉 이 조회는 **이미 항상 0행**이었고 seatInfo 는 늘 null 이었다 → go 제거로 인한 기능 저하가 아니라
  // 이관 전부터 죽어 있던 링크다.
  // 복구하려면 v2 좌석↔티켓 매핑(주문→좌석) API 가 선행돼야 한다(별도 과제 — 체크인 overlay 와 동일 원인).

  const document = TicketPDF({
    eventName: ticket.eventTitle,
    eventDate: ticket.startsAt ? formatDate(ticket.startsAt) : "일시 미정",
    venueName: ticket.venueName ?? "장소 미정",
    attendeeName: ticket.attendeeName,
    ticketNumber: ticket.ticketNumber,
    orderNumber: ticket.orderNumber ?? "",
    seatInfo,
  }) as React.ReactElement<DocumentProps>;

  const buffer = await renderToBuffer(document);

  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="ticket-${ticket.ticketNumber}.pdf"`,
    },
  });
}
