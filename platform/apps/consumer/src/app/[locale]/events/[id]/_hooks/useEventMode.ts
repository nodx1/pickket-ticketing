"use client";

import { useMemo } from "react";
import type { EventDetail, SeatTier } from "@pickket/lib/api";

export function useEventMode(
  event: EventDetail | null,
  tiers: SeatTier[],
  userId?: string,
) {
  return useMemo(() => {
    const isOwner = userId != null && userId === event?.organizer_id;
    const canAllocate =
      isOwner &&
      event != null &&
      ["bidding_open", "bidding_closed"].includes(event.status);
    const hasEvent = Boolean(event);

    const resaleTiers = event?.resale_enabled && tiers.length > 0 ? tiers : [];
    const showResale = resaleTiers.length > 0;
    const soldOutTiers = tiers.filter((t) => t.remaining === 0);
    const hasSoldOut = soldOutTiers.length > 0;
    const showTransferSection = hasSoldOut || showResale;
    const firstTier = tiers.length > 0 ? tiers[0] : null;

    return {
      isOwner,
      canAllocate,
      hasEvent,
      resaleTiers,
      showResale,
      soldOutTiers,
      hasSoldOut,
      showTransferSection,
      firstTier,
    };
  }, [event, tiers, userId]);
}
