import { WebhooksClient } from "./_components/webhooks-client";

export default async function EventWebhooksPage({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  return <WebhooksClient eventId={eventId} />;
}
