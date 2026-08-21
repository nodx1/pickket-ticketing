import { notFound } from "next/navigation";
import { normalizeEventSlug } from "@/lib/public/event-slug";
import { getPublicEventBySlug } from "@/lib/server/events";
import { GroupBookingRequestClient } from "./_components/group-booking-request-client";

export default async function PublicGroupBookingPage({
  params,
}: {
  params: Promise<{ eventSlug: string }>;
}) {
  // 한글 slug 이벤트가 404 로 죽던 결함 — normalizeEventSlug 주석 참조.
  const { eventSlug: rawSlug } = await params;
  const eventSlug = normalizeEventSlug(rawSlug);
  const event = await getPublicEventBySlug(eventSlug);

  if (!event) {
    notFound();
  }

  return (
    <GroupBookingRequestClient
      event={event as { id: string; title: string; products: Array<{ id: string; name: string }> }}
      eventSlug={eventSlug}
    />
  );
}
