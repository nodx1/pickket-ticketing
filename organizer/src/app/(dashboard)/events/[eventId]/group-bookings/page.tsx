import { GroupBookingsClient } from "./_components/group-bookings-client";

export default async function GroupBookingsPage({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  return <GroupBookingsClient eventId={eventId} />;
}
