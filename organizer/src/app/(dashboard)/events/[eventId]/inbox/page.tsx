import { InboxClient } from "./_components/inbox-client";

export default async function InboxPage({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  return <InboxClient eventId={eventId} />;
}
