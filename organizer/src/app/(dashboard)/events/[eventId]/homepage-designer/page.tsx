import { HomepageDesignerClient } from "./_components/homepage-designer-client";

export default async function HomepageDesignerPage({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  return <HomepageDesignerClient eventId={eventId} />;
}
