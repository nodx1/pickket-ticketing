import { EventQuestionsClient } from "./_components/event-questions-client";

export default async function EventQuestionsPage({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  return <EventQuestionsClient eventId={eventId} />;
}
