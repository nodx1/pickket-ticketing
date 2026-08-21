import { redirect } from "next/navigation";
import { EventDashboardClient } from "./_components/event-dashboard-client";
import { getServerSession } from "@/lib/auth/server-session";
import { getEventSummary } from "@/lib/server/events";

type PageProps = {
  params: Promise<{ eventId: string }>;
};

export default async function EventDashboardPage({ params }: PageProps) {
  const { eventId } = await params;
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  // 처방 엔진 신호(상태·정원·D-day)는 이벤트 요약에서 확보 — 추가 API 호출 없음.
  const event = await getEventSummary(eventId, session.accountId);

  return (
    <EventDashboardClient
      eventId={eventId}
      status={event?.status ?? "draft"}
      maxAttendees={event?.maxAttendees ?? null}
      startsAt={event?.startsAt ?? null}
    />
  );
}
