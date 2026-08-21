"use client";

import React, { useState, useEffect, useMemo, useCallback } from "react";
import { MapPin, Minus, Plus, X } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import {
  type VenueData,
  type SeatData,
  type SeatTier,
  getEventSeats,
} from "@pickket/lib/api";
import { buildFallbackSeatsForTier } from "@/lib/fallback-data";
import VenueMap from "./VenueMap";
import SectionDetail from "./SectionDetail";
import BestAvailableButton from "./BestAvailableButton";

interface SeatPickerProps {
  eventId: string;
  venue: VenueData | null;
  tier: SeatTier;
  selectedSeats: SeatData[];
  quantity: number;
  onToggleSeat: (seat: SeatData) => void;
  onSetSelectedSeats: (seats: SeatData[]) => void;
  onSetQuantity: (qty: number) => void;
  category?: string;
  homeTeam?: string;
  awayTeam?: string;
}

export default function SeatPicker({
  eventId,
  venue,
  tier,
  selectedSeats,
  quantity,
  onToggleSeat,
  onSetSelectedSeats,
  onSetQuantity,
  category,
  homeTeam,
  awayTeam,
}: SeatPickerProps) {
  const t = useTranslations("booking.seatPicker");
  const [allSeats, setAllSeats] = useState<SeatData[]>([]);
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(
    null,
  );
  const [loadingSeats, setLoadingSeats] = useState(false);

  const isAssigned = tier.seating_type === "assigned" && venue;

  /**
   * `t` 는 콜백 안에서 부르지 않는다 — 렌더 시점 문자열로 뽑아 deps 에 넣는다.
   *
   * `loadSeats` 는 아래 `useEffect` 의 deps 다. React Compiler 가 요구하는 대로
   * `t` 를 deps 에 넣으면 **테스트 환경에서 좌석을 무한 재요청**한다
   * (전역 목의 t 가 매 렌더 새 함수다 — `use-translations-mock-instability.test.tsx`).
   * 진짜 next-intl 의 t 는 안정 참조라 프로덕션은 무사하지만, 구매 경로라
   * 환경에 안 기대는 쪽을 쓴다. 부수 효과로 문구가 언어 변경을 따라간다.
   */
  const loadErrorMessage = t("loadError");

  // Load seats for this tier
  const loadSeats = useCallback(() => {
    if (!isAssigned) {
      setAllSeats([]);
      setLoadingSeats(false);
      return;
    }

    let cancelled = false;
    setLoadingSeats(true);
    const useFallbackSeats = !!venue;
    getEventSeats(eventId, { tier_id: tier.id })
      .then((res) => {
        if (!cancelled) {
          const data = Array.isArray(res.data) ? res.data : [];
          // If API returns empty and venue is fallback, generate seats
          if (data.length === 0 && useFallbackSeats) {
            setAllSeats(buildFallbackSeatsForTier(tier, venue));
          } else {
            setAllSeats(data);
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          // API failed — use fallback seats if venue is fallback
          if (useFallbackSeats) {
            setAllSeats(buildFallbackSeatsForTier(tier, venue));
          } else {
            setAllSeats([]);
            toast.error(loadErrorMessage);
          }
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingSeats(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [eventId, tier, isAssigned, venue, loadErrorMessage]);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    const timeoutId = window.setTimeout(() => {
      cleanup = loadSeats();
    }, 0);
    return () => {
      window.clearTimeout(timeoutId);
      cleanup?.();
    };
  }, [loadSeats]);

  // Build section availability — only include sections that have seats for the selected tier
  const sectionAvailability = useMemo(() => {
    if (!venue) return {};
    const map: Record<
      string,
      { total: number; available: number; tierName: string; price: number }
    > = {};
    for (const section of venue.sections) {
      const sectionSeats = allSeats.filter((s) => s.section === section.name);
      // Skip sections with no matching seats for this tier
      if (sectionSeats.length === 0) continue;
      map[section.id] = {
        total: sectionSeats.length,
        available: sectionSeats.filter((s) => s.status === "available").length,
        tierName: tier.name,
        price: tier.face_price ?? tier.base_price,
      };
    }
    return map;
  }, [venue, allSeats, tier]);

  // Seats for selected section
  const sectionSeats = useMemo(() => {
    if (!selectedSectionId || !venue) return [];
    const section = venue.sections.find((s) => s.id === selectedSectionId);
    if (!section) return [];
    return allSeats.filter((s) => s.section === section.name);
  }, [selectedSectionId, venue, allSeats]);

  const selectedSectionData = venue?.sections.find(
    (s) => s.id === selectedSectionId,
  );

  const handleBack = useCallback(() => {
    setSelectedSectionId(null);
  }, []);

  const handleSelectRange = useCallback(
    (rangeSeats: SeatData[]) => {
      const maxGroup = tier.max_group_size ?? 4;
      const currentSeats = selectedSeats;
      const currentIds = new Set(currentSeats.map((s) => s.id));
      const newSeats = rangeSeats.filter((s) => !currentIds.has(s.id));
      const canAdd = maxGroup - currentSeats.length;
      const toAdd = newSeats.slice(0, Math.max(0, canAdd));
      if (toAdd.length > 0) {
        onSetSelectedSeats([...currentSeats, ...toAdd]);
      }
    },
    [selectedSeats, tier, onSetSelectedSeats],
  );

  // Non-assigned seating — quantity selector
  if (!isAssigned) {
    const maxSeats = tier.max_group_size ?? 4;
    return (
      <section className="space-y-4">
        <h2 className="flex items-center gap-2 text-lg font-bold">
          <MapPin className="h-5 w-5 text-primary" />
          {t("quantitySelect")}
        </h2>
        <div className="bg-card/90 backdrop-blur-sm border border-border rounded-2xl shadow-[0_4px_16px_rgba(0,0,0,0.3)] p-5">
          <div className="flex items-center justify-between">
            <div>
              <span className="font-semibold text-foreground">{tier.name}</span>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t("remaining", { count: tier.remaining })}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => onSetQuantity(quantity - 1)}
                disabled={quantity <= 1}
                className="size-10 rounded-full border border-border text-foreground flex items-center justify-center disabled:opacity-30 hover:bg-muted transition-colors"
              >
                <Minus className="h-4 w-4" />
              </button>
              <span className="text-xl font-bold w-8 text-center text-foreground">
                {quantity}
              </span>
              <button
                type="button"
                onClick={() => onSetQuantity(quantity + 1)}
                disabled={quantity >= Math.min(maxSeats, tier.remaining)}
                className="size-10 rounded-full border border-border text-foreground flex items-center justify-center disabled:opacity-30 hover:bg-muted transition-colors"
              >
                <Plus className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      </section>
    );
  }

  // Assigned seating with venue map
  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-lg font-bold">
          <MapPin className="h-5 w-5 text-primary" />
          {selectedSectionId ? t("seatSelect") : t("sectionSelect")}
        </h2>
        <BestAvailableButton
          eventId={eventId}
          tierId={tier.id}
          quantity={Math.max(1, selectedSeats.length || 1)}
          onResult={onSetSelectedSeats}
        />
      </div>

      {loadingSeats ? (
        <div className="bg-card rounded-2xl p-6 space-y-4 animate-pulse">
          {/* Venue map skeleton */}
          <div className="w-full aspect-[16/10] bg-muted rounded-2xl" />
          {/* Legend skeleton */}
          <div className="flex items-center gap-3">
            <div className="h-4 w-16 bg-muted rounded-full" />
            <div className="h-4 w-16 bg-muted rounded-full" />
            <div className="h-4 w-14 bg-muted rounded-full" />
            <div className="h-4 w-12 bg-muted rounded-full" />
          </div>
          {/* Section buttons skeleton */}
          <div className="flex items-center gap-2">
            <div className="h-8 w-20 bg-muted rounded-lg" />
            <div className="h-8 w-20 bg-muted rounded-lg" />
            <div className="h-8 w-16 bg-muted rounded-lg" />
          </div>
        </div>
      ) : selectedSectionId && selectedSectionData ? (
        <div
          key={`section-${selectedSectionId}`}
          className="animate-fade-in"
          style={{ animationDuration: "150ms" }}
        >
          <SectionDetail
            sectionName={selectedSectionData.name}
            seats={sectionSeats}
            selectedSeats={selectedSeats}
            onToggleSeat={onToggleSeat}
            onSelectRange={handleSelectRange}
            onBack={handleBack}
            tier={tier}
            category={category}
          />
        </div>
      ) : (
        <div
          key="venue-map"
          className="animate-fade-in"
          style={{ animationDuration: "150ms" }}
        >
          <VenueMap
            venue={venue!}
            sectionAvailability={sectionAvailability}
            selectedSectionId={selectedSectionId}
            onSelectSection={setSelectedSectionId}
            category={category}
            homeTeam={homeTeam}
            awayTeam={awayTeam}
          />
        </div>
      )}

      {/* Selected seats — sticky bottom bar */}
      <AnimatePresence>
        {selectedSeats.length > 0 && (
          <motion.div
            initial={{ y: 60, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 60, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.3, 0, 0, 1] }}
            className="sticky bottom-0 z-10 bg-card/95 backdrop-blur-xl border-t border-border shadow-[0_-4px_16px_rgba(0,0,0,0.4)] rounded-t-2xl px-4 py-3"
          >
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs text-muted-foreground">
                {t("selectedSeats", { selected: selectedSeats.length, max: tier.max_group_size ?? 4 })}
              </p>
              <button
                type="button"
                onClick={() => onSetSelectedSeats([])}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                {t("clearAll")}
              </button>
            </div>
            <div className="flex flex-wrap gap-2 max-h-20 overflow-y-auto">
              {selectedSeats.map((seat) => (
                <motion.button
                  key={seat.id}
                  layout
                  initial={{ scale: 0.8, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0.8, opacity: 0 }}
                  type="button"
                  onClick={() => onToggleSeat(seat)}
                  className="inline-flex items-center gap-1 bg-primary text-white text-xs px-2.5 py-1 rounded-full hover:bg-primary/80 transition-colors max-w-[160px]"
                >
                  <span className="truncate">
                    {seat.label ||
                      t("seatLabel", { section: seat.section, row: seat.row_number, number: seat.seat_number })}
                  </span>
                  <X className="h-3 w-3 shrink-0" />
                </motion.button>
              ))}
            </div>
            {selectedSeats.length < (tier.max_group_size ?? 4) && (
              <p className="text-xs text-muted-foreground mt-1.5">
                {t("canSelectMore", { count: (tier.max_group_size ?? 4) - selectedSeats.length })}
              </p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
