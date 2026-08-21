import { EventCheckInClient } from "./_components/event-check-in-client";

export default async function EventCheckInPage({
  params,
}: {
  params: Promise<{ eventId: string }>;
}) {
  const { eventId } = await params;
  return <EventCheckInClient eventId={eventId} />;
}
