import { EventCapacityClient } from "./_components/event-capacity-client";

export default async function EventCapacityPage({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  return <EventCapacityClient eventId={eventId} />;
}
