import { BulkInvitationsClient } from "./_components/bulk-invitations-client";

export default async function InvitationsPage({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  return <BulkInvitationsClient eventId={eventId} />;
}
