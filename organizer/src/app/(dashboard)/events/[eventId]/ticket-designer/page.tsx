import { TicketDesignerClient } from "./_components/ticket-designer-client";

export default async function TicketDesignerPage({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  return <TicketDesignerClient eventId={eventId} />;
}
