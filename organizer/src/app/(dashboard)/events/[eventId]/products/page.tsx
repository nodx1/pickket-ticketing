import { EventProductsClient } from "./_components/event-products-client";

export default async function EventProductsPage({
  params,
}: {
  params: Promise<{ eventId: string }>;
}) {
  const { eventId } = await params;
  return <EventProductsClient eventId={eventId} />;
}
