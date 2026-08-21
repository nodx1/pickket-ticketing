import { EventSchedulesClient } from "./_components/event-schedules-client";

export default async function EventSchedulesPage({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  return <EventSchedulesClient eventId={eventId} />;
}
