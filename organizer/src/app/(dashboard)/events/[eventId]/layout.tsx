import { notFound, redirect } from "next/navigation";
import { EventSidebar } from "@/components/layout/event-sidebar";
import { getServerSession } from "@/lib/auth/server-session";
import { getEventSummary } from "@/lib/server/events";

type LayoutProps = {
  children: React.ReactNode;
  params: Promise<{ eventId: string }>;
};

export default async function EventDetailLayout({ children, params }: LayoutProps) {
  const { eventId } = await params;
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  const event = await getEventSummary(eventId, session.accountId);
  if (!event) {
    notFound();
  }

  return (
    <div className="flex flex-col gap-6 xl:flex-row">
      <EventSidebar event={event} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
