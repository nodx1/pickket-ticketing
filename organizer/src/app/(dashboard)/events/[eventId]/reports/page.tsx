import { EventReportsClient } from "./_components/event-reports-client";

export default async function EventReportsPage({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  return <EventReportsClient eventId={eventId} />;
}
