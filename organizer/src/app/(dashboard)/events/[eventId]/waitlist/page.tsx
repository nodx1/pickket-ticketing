import { EventWaitlistClient } from "./_components/event-waitlist-client";

export default async function EventWaitlistPage({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  return <EventWaitlistClient eventId={eventId} />;
}
