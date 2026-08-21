import { EventAttendeesClient } from "./_components/attendees-client";

export default async function EventAttendeesPage({
  params,
}: {
  params: Promise<{ eventId: string }>;
}) {
  const { eventId } = await params;
  return <EventAttendeesClient eventId={eventId} />;
}
