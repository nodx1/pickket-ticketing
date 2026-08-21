"use client";

import dynamic from "next/dynamic";

const ReviewSection = dynamic(
  () => import("@/components/event-detail/ReviewSection"),
);

interface ReviewPeekProps {
  eventId: string;
}

export function ReviewPeek({ eventId }: ReviewPeekProps) {
  return (
    <div className="space-y-3">
      <ReviewSection eventId={eventId} peek={3} />
    </div>
  );
}
