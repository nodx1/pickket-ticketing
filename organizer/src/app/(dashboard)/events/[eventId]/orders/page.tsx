import { EventOrdersClient } from "./_components/event-orders-client";

export default async function EventOrdersPage({
  params,
}: {
  params: Promise<{ eventId: string }>;
}) {
  const { eventId } = await params;
  return <EventOrdersClient eventId={eventId} />;
}
