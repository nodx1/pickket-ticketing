import { notFound, redirect } from "next/navigation";
import { getServerSession } from "@/lib/auth/server-session";
import { getEventSummary } from "@/lib/server/events";
import { RaffleClient } from "./_components/raffle-client";
import { RaffleDisabledNotice } from "./_components/raffle-disabled-notice";

export default async function RafflePage({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  const event = await getEventSummary(eventId, session.accountId);
  if (!event) {
    notFound();
  }

  // raffle_enabled 아니면 설정 유도(추첨 실행 게이트 — sale 개시 후 변경 제약은 설정 화면 소관).
  if (!event.raffleEnabled) {
    return <RaffleDisabledNotice eventId={eventId} />;
  }

  return <RaffleClient eventId={eventId} />;
}
