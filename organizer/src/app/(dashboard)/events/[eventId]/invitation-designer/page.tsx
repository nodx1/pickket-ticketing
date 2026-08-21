import { InvitationDesignerClient } from "./_components/invitation-designer-client";

export default async function InvitationDesignerPage({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  return <InvitationDesignerClient eventId={eventId} />;
}
