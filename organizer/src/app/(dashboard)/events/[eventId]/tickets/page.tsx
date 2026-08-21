import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/auth/server-session";
import { getEventSummary } from "@/lib/server/events";
import { resolveSeatType } from "@/lib/seats/seat-type";
import { TicketsClient } from "./_components/tickets-client";

type PageProps = {
  params: Promise<{ eventId: string }>;
};

export default async function TicketsPage({ params }: PageProps) {
  const { eventId } = await params;
  const session = await getServerSession();
  if (!session) redirect("/login");

  // 좌석 판매 방식(v2 events.seat_type) — 자유입장 행사에 배치도 에디터를 강제하지 않는다.
  // 값이 없던 기존 이벤트는 assigned 로 본다 = 현행 화면 그대로(회귀 없음).
  const event = await getEventSummary(eventId, session.accountId);
  const seatType = resolveSeatType((event as { seatType?: string } | null)?.seatType);

  return <TicketsClient eventId={eventId} seatType={seatType} />;
}
