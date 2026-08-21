"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@pickket/ui";
import {
  getEventSessions,
  getVenue,
  type EventDetail,
  type SeatTier,
  type SessionData,
  type VenueData,
} from "@pickket/lib/api";
import BookingFlow, {
  type BookingStateInfo,
} from "@/components/booking/BookingFlow";
import type { BookingStep } from "@/hooks/useBookingFlow";

interface SubdomainBookingSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  event: EventDetail;
  tiers: SeatTier[];
  initialTierId?: string | null;
  initialQuantity?: number;
  onBookingStateChange?: (state: BookingStateInfo) => void;
}

export function SubdomainBookingSheet({
  open,
  onOpenChange,
  event,
  tiers,
  initialTierId,
  initialQuantity,
  onBookingStateChange,
}: SubdomainBookingSheetProps) {
  const t = useTranslations("booking.subdomainSheet");
  const [sessions, setSessions] = useState<SessionData[]>([]);
  const [venue, setVenue] = useState<VenueData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!open) return;
    setLoading(true);

    const fetchData = async () => {
      try {
        const [sessionsRes, venueRes] = await Promise.allSettled([
          getEventSessions(event.id),
          event.venue_id ? getVenue(event.venue_id) : Promise.resolve(null),
        ]);

        if (sessionsRes.status === "fulfilled" && sessionsRes.value) {
          const data = sessionsRes.value.data;
          setSessions(Array.isArray(data) ? data : []);
        }
        if (venueRes.status === "fulfilled" && venueRes.value) {
          const data = (venueRes.value as { data: VenueData })?.data;
          setVenue(data ?? null);
        }
      } catch {
        // Silently fail — BookingFlow handles missing data gracefully
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [open, event.id, event.venue_id]);

  const handleStepChange = useCallback((step: BookingStep) => {
    // Could track step for analytics later
    void step;
  }, []);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="h-[90vh] overflow-y-auto bg-background border-t border-white/10 p-0 sm:max-w-full"
      >
        <SheetHeader className="sticky top-0 z-10 bg-background/95 backdrop-blur-xl border-b border-white/5 px-6 py-4">
          <SheetTitle className="text-foreground">
            {t("title", { title: event.title ?? "" })}
          </SheetTitle>
        </SheetHeader>

        <div className="px-4 sm:px-6 py-6">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-20 gap-3">
              <Loader2 className="h-8 w-8 text-primary/70 animate-spin" />
              <p className="text-sm text-muted-foreground">
                {t("loading")}
              </p>
            </div>
          ) : (
            <BookingFlow
              event={event}
              sessions={sessions}
              tiers={tiers}
              venue={venue}
              initialTierId={initialTierId}
              initialQuantity={initialQuantity}
              onStepChange={handleStepChange}
              onBookingStateChange={onBookingStateChange}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
