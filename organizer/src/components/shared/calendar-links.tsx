"use client";

import { Calendar } from "lucide-react";
import { Button } from "@/components/ui/button";
import { googleCalendarUrl, naverCalendarUrl } from "@/lib/calendar/links";

interface CalendarLinksProps {
  title: string;
  startsAt: string;
  endsAt: string;
  venueName?: string | null;
  venueAddress?: string | null;
  eventSlug: string;
  description?: string | null;
}

export function CalendarLinks({
  title,
  startsAt,
  endsAt,
  venueName,
  venueAddress,
  eventSlug,
  description,
}: CalendarLinksProps) {
  const appUrl = typeof window !== "undefined" ? window.location.origin : "";
  const eventUrl = `${appUrl}/e/${eventSlug}`;

  const params = { title, startsAt, endsAt, venueName, venueAddress, description, url: eventUrl };

  return (
    <div className="space-y-2">
      <p className="flex items-center gap-2 text-sm font-medium text-foreground">
        <Calendar className="size-4" />
        캘린더에 추가
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" asChild>
          <a href={googleCalendarUrl(params)} target="_blank" rel="noopener noreferrer">
            Google
          </a>
        </Button>
        <Button variant="outline" size="sm" asChild>
          <a href={`/api/public/events/${eventSlug}/calendar`} download={`${eventSlug}.ics`}>
            Apple / Outlook
          </a>
        </Button>
        <Button variant="outline" size="sm" asChild>
          <a href={naverCalendarUrl(params)} target="_blank" rel="noopener noreferrer">
            Naver
          </a>
        </Button>
      </div>
    </div>
  );
}
