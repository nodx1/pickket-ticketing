"use client";

import { useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { motion } from "motion/react";
import { Ticket, Loader2, AlertCircle } from "lucide-react";
import {
  getEventTiers,
  type SeatTier,
  type EventDetail,
} from "@pickket/lib/api";
import { useQuery } from "@tanstack/react-query";
import { SubdomainShell } from "./SubdomainShell";
import { BookingSidebar } from "@/app/[locale]/events/[id]/_components/BookingSidebar";
import { MobileStickyBottom } from "@/app/[locale]/events/[id]/_components/MobileStickyBottom";
import { SubdomainBookingSheet } from "./SubdomainBookingSheet";
import type { BookingStateInfo } from "@/components/booking/BookingFlow";
import { normalizeSaleMode } from "@pickket/lib";

/* eslint-disable @typescript-eslint/no-explicit-any */

interface EventData {
  id: string;
  title: string;
  description?: string;
  event_date: string;
  event_date_end?: string;
  venue?: string;
  venue_id?: string;
  image_url?: string;
  status?: string;
  category?: string;
  bid_count?: number;
  view_count?: number;
  total_seats?: number;
  min_price?: number;
  max_price?: number;
  organizer_name?: string;
  organizer_id?: string;
  artist_name?: string;
  bidding_closes_at?: string;
  page_theme?: { logoUrl?: string } | null;
  [key: string]: any;
}

function fmt(n: number): string {
  return n.toLocaleString("ko-KR");
}

const TIER_DOT_COLORS = [
  "bg-violet-500",
  "bg-blue-500",
  "bg-cyan-500",
  "bg-emerald-500",
  "bg-amber-500",
  "bg-rose-500",
];

export function SubdomainTicketsClient({ event }: { event: EventData }) {
  const t = useTranslations("ticket.subdomainTickets");
  const [selectedTierIdx, setSelectedTierIdx] = useState(0);
  const [qty, setQty] = useState(1);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [bookingState, setBookingState] = useState<BookingStateInfo | null>(
    null,
  );

  const {
    data: tiers = [],
    isLoading: loading,
    isError: error,
    refetch: fetchTiers,
  } = useQuery<SeatTier[]>({
    queryKey: ["events", event.id, "tiers", "subdomain"],
    queryFn: async () => {
      const res = await getEventTiers(event.id);
      const data = Array.isArray(res.data) ? res.data : [];
      setSelectedTierIdx(data.length > 1 ? 1 : 0);
      return data;
    },
  });

  const selectedTier = tiers[selectedTierIdx] ?? null;
  const displayPrice = selectedTier
    ? (selectedTier.face_price ?? selectedTier.base_price)
    : 0;

  const competitionRatio =
    event.total_seats && event.total_seats > 0
      ? (event.bid_count ?? 0) / event.total_seats
      : undefined;

  // Map subdomain event data → BookingSidebar props shape
  const sidebarEvent = {
    id: event.id,
    title: event.title,
    status: event.status ?? "open",
    bid_count: event.bid_count,
    total_seats: event.total_seats ?? 0,
    bidding_close_date: event.bidding_closes_at,
    organizer_name: event.organizer_name,
  };

  // Map subdomain event data → EventDetail shape for BookingFlow
  const bookingEvent: EventDetail = {
    id: event.id,
    title: event.title,
    description: event.description ?? null,
    image_url: event.image_url ?? null,
    category: event.category ?? "",
    status: event.status ?? "open",
    venue: event.venue ?? null,
    venue_id: event.venue_id,
    event_date: event.event_date,
    event_date_end: event.event_date_end,
    time_slot_enabled: event.time_slot_enabled,
    organizer_id: event.organizer_id ?? "",
    organizer_name: event.organizer_name ?? "",
    bidding_opens_at: event.bidding_opens_at ?? "",
    bidding_closes_at: event.bidding_closes_at ?? "",
    total_seats: event.total_seats ?? 0,
    bid_count: event.bid_count ?? 0,
    view_count: event.view_count ?? 0,
    min_price: event.min_price ?? null,
    max_price: event.max_price ?? null,
  } as EventDetail;

  const handleCTA = useCallback(() => {
    setSheetOpen(true);
  }, []);

  const handleTierChange = useCallback(
    (tierId: string) => {
      const idx = tiers.findIndex((t) => t.id === tierId);
      if (idx >= 0) setSelectedTierIdx(idx);
    },
    [tiers],
  );

  const handleQtyChange = useCallback((q: number) => {
    setQty(q);
  }, []);

  return (
    <SubdomainShell event={event}>
      <div className="max-w-[1100px] mx-auto px-4 sm:px-6 py-8">
        {/* Loading state */}
        {loading && (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <Loader2 className="h-8 w-8 text-primary/70 animate-spin" />
            <p className="text-sm text-muted-foreground">
              {t("loadingSeats")}
            </p>
          </div>
        )}

        {/* Error state */}
        {!loading && error && (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <AlertCircle className="h-8 w-8 text-red-600 dark:text-red-400" />
            <p className="text-sm text-muted-foreground">
              {t("loadError")}
            </p>
            <button
              onClick={() => fetchTiers()}
              className="text-sm text-primary/70 hover:underline"
            >
              {t("retry")}
            </button>
          </div>
        )}

        {/* Main content */}
        {!loading && !error && (
          <div className="flex flex-col lg:flex-row gap-8">
            {/* Tier cards — main column */}
            <div className="flex-1 space-y-4">
              <h2 className="text-xl font-bold text-foreground mb-2">
                {t("selectSeat")}
              </h2>

              {tiers.length === 0 && (
                <div className="rounded-2xl border border-white/5 bg-card p-8 text-center">
                  <Ticket className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
                  <p className="text-sm text-muted-foreground">
                    {t("noSeats")}
                  </p>
                </div>
              )}

              {tiers.map((tier, idx) => {
                const isSelected = selectedTierIdx === idx;
                const dot = TIER_DOT_COLORS[idx % TIER_DOT_COLORS.length];
                const pct =
                  tier.capacity > 0
                    ? Math.round(
                        ((tier.capacity - tier.remaining) / tier.capacity) *
                          100,
                      )
                    : 0;
                const price = tier.face_price ?? tier.base_price;

                return (
                  <motion.button
                    key={tier.id}
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: idx * 0.05 }}
                    onClick={() => {
                      setSelectedTierIdx(idx);
                    }}
                    className={`w-full text-left rounded-2xl border p-5 transition-all ${
                      isSelected
                        ? "border-primary bg-primary/5 shadow-[0_0_24px_-8px_rgba(10,10,10,0.3)]"
                        : "border-white/5 bg-card hover:border-white/10 hover:bg-white/[0.02]"
                    }`}
                  >
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2.5">
                        <span className={`h-3 w-3 rounded-full ${dot}`} />
                        <span className="text-base font-bold text-foreground">
                          {tier.name}
                        </span>
                        <span className="text-xs px-2 py-0.5 rounded-full bg-white/5 text-muted-foreground">
                          {normalizeSaleMode(tier.sale_mode) === "lottery"
                            ? t("saleModeLottery")
                            : t("saleModeFirstCome")}
                        </span>
                      </div>
                      <span className="text-lg font-bold text-emerald-600 dark:text-emerald-400">
                        {t("price", { price: fmt(price) })}
                      </span>
                    </div>

                    {/* Remaining seats progress */}
                    <div className="space-y-1.5">
                      <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all duration-700"
                          style={{
                            width: `${pct}%`,
                            backgroundColor:
                              pct >= 80
                                ? "#DC2626"
                                : pct >= 50
                                  ? "var(--primary)"
                                  : "#00A882",
                          }}
                        />
                      </div>
                      <div className="flex justify-between text-xs-plus text-muted-foreground">
                        <span>
                          {t("remaining", { remaining: fmt(tier.remaining), capacity: fmt(tier.capacity) })}
                        </span>
                        <span>{t("soldPct", { pct: pct ?? 0 })}</span>
                      </div>
                    </div>

                    {/* View description */}
                    {tier.view_description && (
                      <p className="mt-2 text-xs text-muted-foreground">
                        {tier.view_description}
                      </p>
                    )}

                    {/* Section / Position */}
                    {(tier.section_name || tier.position_label) && (
                      <div className="mt-2 flex gap-2 text-xs-plus text-muted-foreground">
                        {tier.section_name && (
                          <span>{t("section", { name: tier.section_name ?? "" })}</span>
                        )}
                        {tier.position_label && (
                          <span>{t("position", { label: tier.position_label ?? "" })}</span>
                        )}
                      </div>
                    )}
                  </motion.button>
                );
              })}
            </div>

            {/* Desktop sidebar — real BookingSidebar */}
            {tiers.length > 0 && (
              <div className="hidden lg:block w-[380px] shrink-0">
                <div className="sticky top-16">
                  <BookingSidebar
                    event={sidebarEvent}
                    tiers={tiers.map((t) => ({
                      id: t.id,
                      name: t.name,
                      base_price: t.base_price,
                      face_price: t.face_price,
                      remaining: t.remaining,
                      total: t.capacity,
                      sale_mode: t.sale_mode,
                    }))}
                    onCTAClick={handleCTA}
                    onTierChange={handleTierChange}
                    onQtyChange={handleQtyChange}
                    externalTierId={selectedTier?.id}
                    bookingState={bookingState}
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {/* Trust badges section */}
        {!loading && !error && tiers.length > 0 && (
          <div className="mt-12 rounded-2xl border border-white/5 bg-card p-6">
            <h3 className="text-sm font-semibold text-foreground mb-4 text-center">
              {t("trustTitle")}
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="flex flex-col items-center text-center gap-2 py-3">
                <span className="text-2xl">🛡️</span>
                <span className="text-sm font-medium text-foreground">
                  {t("trustFairLabel")}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t("trustFairDesc")}
                </span>
              </div>
              <div className="flex flex-col items-center text-center gap-2 py-3">
                <span className="text-2xl">✅</span>
                <span className="text-sm font-medium text-foreground">
                  {t("trustPriceLabel")}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t("trustPriceDesc")}
                </span>
              </div>
              <div className="flex flex-col items-center text-center gap-2 py-3">
                <span className="text-2xl">🎫</span>
                <span className="text-sm font-medium text-foreground">
                  {t("trustPayLabel")}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t("trustPayDesc")}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Bottom spacing for mobile sticky */}
        <div className="h-24 lg:h-8" />
      </div>

      {/* Mobile sticky bottom */}
      {!loading && !error && selectedTier && (
        <MobileStickyBottom
          tierName={selectedTier.name}
          price={displayPrice}
          qty={qty}
          onCTAClick={handleCTA}
          status={event.status ?? "open"}
          competitionRatio={competitionRatio}
          salesPaused={(event as { sales_paused?: boolean }).sales_paused ?? false}
        />
      )}

      {/* Booking flow sheet */}
      {tiers.length > 0 && (
        <SubdomainBookingSheet
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          event={bookingEvent}
          tiers={tiers}
          initialTierId={selectedTier?.id}
          initialQuantity={qty}
          onBookingStateChange={setBookingState}
        />
      )}
    </SubdomainShell>
  );
}
