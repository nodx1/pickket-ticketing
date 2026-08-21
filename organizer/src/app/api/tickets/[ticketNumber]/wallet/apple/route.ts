import { NextRequest, NextResponse } from "next/server";
import { generateApplePass } from "@/lib/wallet/apple";
import { canAccessTicketArtifact } from "@/lib/ticket/access";
import {
  resolveTicketArtifactContext,
  TicketArtifactNotFoundError,
  TicketArtifactUpstreamError,
} from "@/lib/ticket/artifact-context";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ ticketNumber: string }> }) {
  const { ticketNumber } = await params;
  try {
    // T2-ORD: go attendees/orders/events JOIN → v2 티켓번호 조회(SoT). 취소/만료 티켓은 404.
    const ticket = await resolveTicketArtifactContext(ticketNumber);

    if (!(await canAccessTicketArtifact(ticket.buyerEmail, ticket.buyerPhone, ticket.eventAccountId, ticketNumber))) {
      return NextResponse.json({ error: "티켓에 접근할 수 없습니다" }, { status: 403 });
    }

    const buffer = await generateApplePass({
      ticketId: ticketNumber,
      eventTitle: ticket.eventTitle,
      eventDate: ticket.startsAt ?? "",
      venueName: ticket.venueName ?? "",
      attendeeName: ticket.attendeeName,
      ticketNumber: ticket.ticketNumber,
    });

    if (!buffer) {
      return NextResponse.json({ error: "Apple Wallet이 아직 설정되지 않았습니다" }, { status: 501 });
    }

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/vnd.apple.pkpass",
        "Content-Disposition": `attachment; filename=ticket-${ticketNumber}.pkpass`,
      },
    });
  } catch (err: unknown) {
    if (err instanceof TicketArtifactNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof TicketArtifactUpstreamError) {
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    return NextResponse.json({ error: "Apple Wallet 패스 생성에 실패했습니다" }, { status: 500 });
  }
}
