"use client";

import React from "react";
import { Info } from "lucide-react";
import { useTranslations } from "next-intl";
import type { EventDetail, SeatTier, SeatData } from "@pickket/lib/api";
import { getSaleModeDescription, normalizeSaleMode } from "@pickket/lib";
import FcfsWidget from "./FcfsWidget";
import FanclubWidget from "./FanclubWidget";
import LotteryWidget from "./LotteryWidget";

interface ActionPanelProps {
  event: EventDetail;
  tier: SeatTier;
  selectedSeats?: SeatData[];
  quantity?: number;
  holdId?: string | null;
  onAuthRequired?: () => void;
}

function renderWidget(
  event: EventDetail,
  tier: SeatTier,
  selectedSeats?: SeatData[],
  quantity?: number,
  holdId?: string | null,
  onAuthRequired?: () => void,
): React.ReactNode {
  switch (normalizeSaleMode(tier.sale_mode)) {
    case "fixed_fcfs":
      return (
        <FcfsWidget
          event={event}
          tier={tier}
          selectedSeats={selectedSeats}
          externalQuantity={quantity}
          holdId={holdId}
          onAuthRequired={onAuthRequired}
        />
      );
    case "lottery":
      return (
        <LotteryWidget
          event={event}
          tier={tier}
          onAuthRequired={onAuthRequired}
        />
      );
    case "fanclub":
      return (
        <FanclubWidget
          event={event}
          tier={tier}
          selectedSeats={selectedSeats}
          externalQuantity={quantity}
          holdId={holdId}
          onAuthRequired={onAuthRequired}
        />
      );
    default:
      // Fallback: treat unknown/null sale_mode as FCFS (선착순)
      return (
        <FcfsWidget
          event={event}
          tier={tier}
          selectedSeats={selectedSeats}
          externalQuantity={quantity}
          holdId={holdId}
          onAuthRequired={onAuthRequired}
        />
      );
  }
}

export default function ActionPanel({
  event,
  tier,
  selectedSeats,
  quantity,
  holdId,
  onAuthRequired,
}: ActionPanelProps) {
  const t = useTranslations("event.actionPanel");
  return (
    <div className="bg-card/90 backdrop-blur-xl border border-border rounded-2xl shadow-xl p-5 lg:p-6 space-y-4">
      {/* Sale mode description banner */}
      <div className="bg-background/50 border border-border rounded-2xl p-3 flex items-center gap-2 text-sm">
        <Info className="h-4 w-4 text-primary shrink-0" />
        <span className="text-muted-foreground">
          {getSaleModeDescription(tier.sale_mode)}
        </span>
      </div>

      {/* Free event price indicator */}
      {(event.is_free || tier.face_price === 0) && (
        <div className="flex items-center justify-between px-1">
          <span className="text-sm font-medium text-muted-foreground">
            {t("price")}
          </span>
          {event.is_free && !event.deposit_amount ? (
            <span className="text-lg font-bold text-emerald-600 dark:text-emerald-400">
              {t("freeEntry")}
            </span>
          ) : event.is_free && event.deposit_amount ? (
            <span className="text-lg font-bold text-amber-600 dark:text-amber-400">
              {t("deposit", { amount: (event.deposit_amount ?? 0).toLocaleString() })}
            </span>
          ) : (
            <span className="text-lg font-bold text-emerald-600 dark:text-emerald-400">
              {t("freeEntry")}
            </span>
          )}
        </div>
      )}

      {/* Sale mode widget */}
      {renderWidget(
        event,
        tier,
        selectedSeats,
        quantity,
        holdId,
        onAuthRequired,
      )}
    </div>
  );
}
