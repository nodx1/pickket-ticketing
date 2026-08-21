import { MessagesClient } from "./_components/messages-client";

export default async function EventMessagesPage({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  return <MessagesClient eventId={eventId} />;
}
