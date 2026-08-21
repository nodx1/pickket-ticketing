import { AffiliatesClient } from "./_components/affiliates-client";

export default async function AffiliatesPage({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  return <AffiliatesClient eventId={eventId} />;
}
