"use client";

/**
 * SeatMapPanel — 좌석 선택 전체 오케스트레이션 (Phase 6 포팅)
 *
 * ⚠️ DEPRECATED: checkout-ticket-step.tsx 가 SeatMap + BestAvailableButton +
 * SeatHoldTimer + CompanionPickerDialog 등을 직접 조합하므로 본 컴포넌트는
 * 현재 사용되지 않음. 향후 ticket-type별 분기가 필요해지면 부활 가능.
 */

import React, { useCallback, useMemo } from "react";
import { cn } from "@/lib/utils";
import { formatKRW } from "@/lib/format";
import type { Seat, SeatTier } from "@/lib/seats/types";
import { SeatPicker } from "./SeatPicker";
import { SeatMapLegend } from "./SeatMapLegend";
import { SeatHoldTimer } from "./SeatHoldTimer";
import { SeatViewPreview } from "./SeatViewPreview";
import { holdSeats, releaseHold } from "@/lib/seats/client";
import { showError } from "@/lib/hooks/useToast";

interface SeatMapPanelProps {
  eventId: string;
  seatMapId: string | null;
  tiers: SeatTier[];
  selectedTier: SeatTier | null;
  selectedSeats: Seat[];
  quantity: number;
  /** 외부에서 이미 조회한 좌석 데이터(옵션) */
  seats?: Seat[];
  /** 현재 홀드 만료시각 (ISO). 있으면 타이머를 표시 */
  holdExpiresAt?: string | null;
  holdId?: string | null;
  holdToken?: string | null;
  onSelectTier: (tierId: string) => void;
  onToggleSeat: (seat: Seat) => void;
  onSetSelectedSeats: (seats: Seat[]) => void;
  onSetQuantity: (qty: number) => void;
  onHoldCreated?: (hold: {
    holdId: string;
    holdToken: string;
    expiresAt: string;
  }) => void;
  onHoldExpired?: () => void;
  className?: string;
}

export function SeatMapPanel({
  eventId,
  seatMapId,
  tiers,
  selectedTier,
  selectedSeats,
  quantity,
  seats,
  holdExpiresAt,
  holdId,
  holdToken,
  onSelectTier,
  onToggleSeat,
  onSetSelectedSeats,
  onSetQuantity,
  onHoldCreated,
  onHoldExpired,
  className,
}: SeatMapPanelProps) {
  const sortedTiers = useMemo(
    () => [...tiers].sort((a, b) => a.displayOrder - b.displayOrder),
    [tiers],
  );

  const handleHoldClick = useCallback(async () => {
    if (selectedSeats.length === 0) {
      showError("먼저 좌석을 선택해주세요");
      return;
    }
    try {
      const result = await holdSeats(
        eventId,
        selectedSeats.map((s) => s.id),
      );
      onHoldCreated?.({
        holdId: result.holdId,
        holdToken: result.holdToken,
        expiresAt: result.expiresAt,
      });
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "좌석 잠금 실패");
    }
  }, [eventId, selectedSeats, onHoldCreated]);

  const handleHoldExpire = useCallback(() => {
    onSetSelectedSeats([]);
    onHoldExpired?.();
    if (holdId && holdToken) {
      // fire and forget — 서버가 이미 만료시킨 뒤여도 무관
      releaseHold(eventId, holdId, holdToken).catch(() => {});
    }
  }, [eventId, holdId, holdToken, onSetSelectedSeats, onHoldExpired]);

  return (
    <div className={cn("space-y-4", className)}>
      {holdExpiresAt ? (
        <SeatHoldTimer
          holdExpiresAt={holdExpiresAt}
          onExpire={handleHoldExpire}
        />
      ) : null}

      <SeatMapLegend tiers={sortedTiers} />

      <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
        {/* 티어 선택 + 시야 미리보기 */}
        <aside className="space-y-3">
          <h3 className="text-sm font-semibold text-foreground">등급 선택</h3>
          <div className="space-y-2">
            {sortedTiers.map((tier) => {
              const isActive = selectedTier?.id === tier.id;
              const price = tier.facePrice ?? tier.basePrice;
              return (
                <button
                  key={tier.id}
                  type="button"
                  onClick={() => onSelectTier(tier.id)}
                  aria-pressed={isActive}
                  className={cn(
                    "flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-left text-sm transition-all",
                    isActive
                      ? "border-primary bg-primary/5 shadow-sm"
                      : "border-border bg-card hover:border-primary/30",
                  )}
                >
                  <span className="flex items-center gap-2">
                    {tier.colorHex ? (
                      <span
                        aria-hidden
                        className="h-3 w-3 rounded-full"
                        style={{ backgroundColor: tier.colorHex }}
                      />
                    ) : null}
                    <span className="font-medium">{tier.name}</span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatKRW(price)}
                  </span>
                </button>
              );
            })}
          </div>

          {selectedTier ? <SeatViewPreview tier={selectedTier} /> : null}
        </aside>

        {/* 좌석/수량 선택 */}
        <div className="min-w-0">
          {selectedTier ? (
            <SeatPicker
              eventId={eventId}
              seatMapId={seatMapId}
              tier={selectedTier}
              selectedSeats={selectedSeats}
              quantity={quantity}
              seats={seats}
              onToggleSeat={onToggleSeat}
              onSetSelectedSeats={onSetSelectedSeats}
              onSetQuantity={onSetQuantity}
            />
          ) : (
            <div className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted-foreground">
              등급을 먼저 선택해주세요
            </div>
          )}

          {selectedSeats.length > 0 && !holdExpiresAt ? (
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={handleHoldClick}
                className="btn-gradient h-11 rounded-full px-6 text-sm font-semibold text-white shadow-sm transition-all hover:brightness-110"
              >
                선택한 {selectedSeats.length}석 잠금
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
