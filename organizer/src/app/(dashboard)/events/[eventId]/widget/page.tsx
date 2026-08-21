import { EventWidgetPageClient } from "./_components/event-widget-page-client";

export default async function EventWidgetPage({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  return <EventWidgetPageClient eventId={eventId} />;
}
