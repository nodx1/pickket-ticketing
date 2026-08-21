import { PublishChecklistClient } from "./_components/publish-checklist-client";

export default async function PublishPage({
  params,
}: {
  params: Promise<{ eventId: string }>;
}) {
  const { eventId } = await params;

  return <PublishChecklistClient eventId={eventId} />;
}
