import { InquiriesClient } from "./_components/inquiries-client";

export default async function EventInquiriesPage({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  return <InquiriesClient eventId={eventId} />;
}
