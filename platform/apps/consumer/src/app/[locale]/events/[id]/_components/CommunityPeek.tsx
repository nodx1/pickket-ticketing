"use client";

import { CommunityFeed } from "./CommunityFeed";

interface CommunityPeekProps {
  eventId: string;
  eventTitle: string;
  eventDate?: string;
  venue?: string;
  eventStatus?: string;
  category?: string;
  viewCount: number;
  bidCount: number;
  totalSeats: number;
}

export function CommunityPeek({
  eventId,
  eventTitle,
  eventDate,
  venue,
  eventStatus,
  category,
  viewCount,
  bidCount,
  totalSeats,
}: CommunityPeekProps) {
  return (
    <div className="space-y-3">
      <CommunityFeed
        eventTitle={eventTitle}
        eventId={eventId}
        eventDate={eventDate}
        venue={venue}
        eventStatus={eventStatus}
        category={category}
        viewCount={viewCount}
        bidCount={bidCount}
        totalSeats={totalSeats}
        peek={3}
      />
    </div>
  );
}
