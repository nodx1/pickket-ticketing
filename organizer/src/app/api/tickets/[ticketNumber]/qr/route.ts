import { NextRequest, NextResponse } from "next/server";
import { generateDynamicQRPayload, generateDynamicQRPayloads } from "@/lib/ticket/dynamic-qr";
import { canAccessTicketArtifact } from "@/lib/ticket/access";
import {
  resolveTicketArtifactContext,
  TicketArtifactNotFoundError,
  TicketArtifactUpstreamError,
} from "@/lib/ticket/artifact-context";

/** 한 번에 내려주는 창 수 — 20창 = 10분치. 상한(MAX_PREFETCH_WINDOWS)과 같다. */
const PREFETCH_WINDOWS = 20;

export async function GET(_request: NextRequest, { params }: { params: Promise<{ ticketNumber: string }> }) {
  const { ticketNumber } = await params;
  try {
    // T2-ORD: go attendees/orders JOIN → v2 티켓번호 조회(상태 SoT). 취소/만료 티켓은 404.
    const ticket = await resolveTicketArtifactContext(ticketNumber);

    if (!(await canAccessTicketArtifact(ticket.buyerEmail, ticket.buyerPhone, ticket.eventAccountId, ticketNumber))) {
      return NextResponse.json({ error: "티켓에 접근할 수 없습니다" }, { status: 403 });
    }

    // QR 페이로드 키는 종전과 동일하게 **티켓번호**(스캐너 계약 불변).
    //
    // 🔴 앞으로 쓸 창들을 **함께** 내려준다 — 골프장에서 LTE 가 끊겨도 폰이 QR 을 계속
    //    갱신할 수 있어야 한다. 종전엔 30초마다 이 API 를 불러야 했고, 그 호출이 실패하면
    //    QR 이 죽어 게이트 입장이 막혔다.
    //    `payload` 는 옛 클라이언트 호환용으로 남긴다(배포 순서 무관).
    const payloads = generateDynamicQRPayloads(ticketNumber, PREFETCH_WINDOWS);
    return NextResponse.json({
      data: {
        payload: generateDynamicQRPayload(ticketNumber),
        payloads,
        windowSeconds: 30,
        expiresIn: 30,
      },
    });
  } catch (err: unknown) {
    if (err instanceof TicketArtifactNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof TicketArtifactUpstreamError) {
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    return NextResponse.json({ error: "QR 코드 생성에 실패했습니다" }, { status: 500 });
  }
}
