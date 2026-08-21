"use client";

/**
 * SeatPicker — 단일 티어용 좌석/수량 선택기 (Phase 6 포팅)
 *
 * ⚠️ DEPRECATED: checkout-ticket-step.tsx 가 SeatMap 을 직접 사용하므로
 * 본 컴포넌트는 현재 사용되지 않음. 티어별 분기 + standing/quantity 모드가
 * 필요해지면 부활 가능.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { MapPin, Minus, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { showError } from "@/lib/hooks/useToast";
import { fetchSeats } from "@/lib/seats/client";
import { formatKRW } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Seat, SeatTier } from "@/lib/seats/types";
import { SeatMap } from "./SeatMap";
import { BestAvailableButton } from "./BestAvailableButton";

interface SeatPickerProps {
  eventId: string;
  seatMapId: string | null;
  tier: SeatTier;
  selectedSeats: Seat[];
  quantity: number;
  /** 외부에서 미리 조회한 좌석 목록(옵션). 없으면 내부에서 fetchSeats 호출 */
  seats?: Seat[];
  onToggleSeat: (seat: Seat) => void;
  onSetSelectedSeats: (seats: Seat[]) => void;
  onSetQuantity: (qty: number) => void;
  className?: string;
}

export function SeatPicker({
  eventId,
  seatMapId,
  tier,
  selectedSeats,
  quantity,
  seats: seatsProp,
  onToggleSeat,
  onSetSelectedSeats,
  onSetQuantity,
  className,
}: SeatPickerProps) {
  const isAssigned = tier.saleMode === "assigned" && seatMapId !== null;
  const maxGroup = tier.allowGroupTickets ? tier.maxGroupSize : 1;
  const [loading, setLoading] = useState(false);
  const [fetchedSeats, setFetchedSeats] = useState<Seat[]>([]);

  // seatsProp이 없을 때만 fetch (effect는 외부 동기화에만 사용)
  useEffect(() => {
    if (seatsProp) return;
    if (!isAssigned || !seatMapId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFetchedSeats([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchSeats(eventId, seatMapId, { tierId: tier.id })
      .then((result) => {
        if (!cancelled) setFetchedSeats(result.seats);
      })
      .catch(() => {
        if (!cancelled) {
          setFetchedSeats([]);
          showError("좌석 정보를 불러오지 못했습니다");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [eventId, seatMapId, tier.id, isAssigned, seatsProp]);

  // derived: prop이 우선, 없으면 fetched
  const internalSeats = seatsProp ?? fetchedSeats;

  const tierSeats = useMemo(
    () => internalSeats.filter((s) => s.tierId === tier.id || !tier.id),
    [internalSeats, tier.id],
  );

  // SeatMap이 선택 변경을 통지하면 부모 상태를 덮어쓴다
  const handleMapSelect = useCallback(
    (picked: Seat[]) => {
      onSetSelectedSeats(picked.slice(0, maxGroup));
    },
    [maxGroup, onSetSelectedSeats],
  );

  const price = tier.facePrice ?? tier.basePrice;

  /* ── 비지정(standing) 수량 모드 ── */
  if (!isAssigned) {
    return (
      <section className={cn("space-y-4", className)}>
        <h2 className="flex items-center gap-2 text-lg font-bold">
          <MapPin className="h-5 w-5 text-primary" aria-hidden />
          수량 선택
        </h2>
        <div className="rounded-lg border border-border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-semibold text-foreground">{tier.name}</div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {formatKRW(price)} · 최대 {maxGroup}매
              </p>
            </div>
            <div className="flex items-center gap-3">
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => onSetQuantity(Math.max(1, quantity - 1))}
                disabled={quantity <= 1}
                aria-label="수량 감소"
              >
                <Minus className="h-4 w-4" aria-hidden />
              </Button>
              <span
                className="w-8 text-center text-xl font-bold text-foreground"
                aria-live="polite"
              >
                {quantity}
              </span>
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() =>
                  onSetQuantity(Math.min(maxGroup, quantity + 1))
                }
                disabled={quantity >= maxGroup}
                aria-label="수량 증가"
              >
                <Plus className="h-4 w-4" aria-hidden />
              </Button>
            </div>
          </div>
        </div>
      </section>
    );
  }

  /* ── 지정석 모드 ── */
  return (
    <section className={cn("space-y-4", className)}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-bold">
          <MapPin className="h-5 w-5 text-primary" aria-hidden />
          좌석 선택
        </h2>
        {seatMapId ? (
          <BestAvailableButton
            eventId={eventId}
            mapId={seatMapId}
            tierId={tier.id}
            quantity={Math.max(1, selectedSeats.length || 1)}
            onSelected={(seats) => onSetSelectedSeats(seats.slice(0, maxGroup))}
          />
        ) : null}
      </div>

      {loading ? (
        <div className="animate-pulse rounded-lg border border-border bg-card p-6">
          <div className="aspect-[16/10] w-full rounded-lg bg-muted" />
        </div>
      ) : tierSeats.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-6 text-center text-sm text-muted-foreground">
          좌석 정보가 없습니다
        </div>
      ) : (
        <SeatMap
          eventId={eventId}
          seats={tierSeats}
          maxSelectable={maxGroup}
          onSelect={handleMapSelect}
        />
      )}

      {selectedSeats.length > 0 ? (
        <div className="rounded-lg border border-border bg-card p-3 shadow-sm">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              선택한 좌석 ({selectedSeats.length}/{maxGroup})
            </p>
            <button
              type="button"
              onClick={() => onSetSelectedSeats([])}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              전체 해제
            </button>
          </div>
          <div className="flex max-h-20 flex-wrap gap-2 overflow-y-auto">
            {selectedSeats.map((seat) => (
              <button
                key={seat.id}
                type="button"
                onClick={() => onToggleSeat(seat)}
                className="inline-flex max-w-[180px] items-center gap-1 rounded-full bg-primary px-2.5 py-1 text-xs text-white transition-colors hover:opacity-90"
                aria-label={`${seat.section} ${seat.row}열 ${seat.seatNumber}번 선택 해제`}
              >
                <span className="truncate">
                  {seat.label ??
                    `${seat.section} ${seat.row}열 ${seat.seatNumber}번`}
                </span>
                <X className="h-3 w-3 shrink-0" aria-hidden />
              </button>
            ))}
          </div>
          {selectedSeats.length < maxGroup ? (
            <p className="mt-1.5 text-xs text-muted-foreground">
              {maxGroup - selectedSeats.length}석 더 선택할 수 있습니다
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
