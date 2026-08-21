"use client";

import { SubdomainShell } from "./SubdomainShell";
import { CommunityFeed } from "@/app/[locale]/events/[id]/_components/CommunityFeed";
import { PollCards } from "@/app/[locale]/events/[id]/_components/PollCard";
import { FanLetterSection } from "./FanLetterSection";
import { AnticipationSession } from "./AnticipationSession";

interface EventData {
  id: string;
  title: string;
  description?: string;
  event_date: string;
  event_date_end?: string;
  venue?: string;
  image_url?: string;
  status?: string;
  category?: string;
  bid_count?: number;
  view_count?: number;
  total_seats?: number;
  page_theme?: { logoUrl?: string } | null;
}

export function SubdomainCommunityClient({ event }: { event: EventData }) {
  return (
    <SubdomainShell event={event}>
      <div className="max-w-[1100px] mx-auto px-4 sm:px-6 py-8 space-y-6">
        {/* Anticipation sessions — 같이 기대하기 */}
        <AnticipationSession eventId={event.id} />

        {/* Main community feed with all built-in sub-components */}
        <CommunityFeed
          eventTitle={event.title}
          eventId={event.id}
          eventDate={event.event_date}
          venue={event.venue}
          eventStatus={event.status}
          category={event.category}
          viewCount={event.view_count ?? 0}
          bidCount={event.bid_count ?? 0}
          totalSeats={event.total_seats}
        />

        {/* Poll cards — fetches its own data by eventId */}
        <PollCards eventId={event.id} />

        {/* Fan letter section */}
        <FanLetterSection eventId={event.id} />

        {/* Bottom spacing for mobile fixed comment bar */}
        <div className="h-4" />
      </div>
    </SubdomainShell>
  );
}
