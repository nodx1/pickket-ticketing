"use client";

import React from "react";
import { ShoppingCart } from "lucide-react";
import {
  type SeatData,
  type SeatTier,
  type SessionData,
} from "@pickket/lib/api";
import { formatKRW, getOrganizerLabels } from "@pickket/lib";
import { useTranslations } from "next-intl";
import SeatHoldTimer from "./SeatHoldTimer";

interface BookingSummaryProps {
  eventTitle: string;
  session: SessionData | null;
  tier: SeatTier | null;
  selectedSeats: SeatData[];
  quantity: number;
  holdExpiresAt: string | null;
  onHoldExpire: () => void;
  isAssigned: boolean;
  category?: string;
  homeTeam?: string;
  awayTeam?: string;
  subjectName?: string | null;
  eventDateEnd?: string | null;
}

export default function BookingSummary({
  eventTitle,
  session,
  tier,
  selectedSeats,
  quantity,
  holdExpiresAt,
  onHoldExpire,
  isAssigned,
  category,
  homeTeam,
  awayTeam,
  subjectName,
  eventDateEnd,
}: BookingSummaryProps) {
  const t = useTranslations("booking.bookingSummary");
  const orgLabels = getOrganizerLabels(category);
  const count = isAssigned ? selectedSeats.length : quantity;
  const tierAny = tier as
    | (typeof tier & { is_free?: boolean; deposit_amount?: number })
    | null;
  const isFreeWithDeposit =
    tierAny?.is_free && (tierAny.deposit_amount ?? 0) > 0;
  const unitPrice = isFreeWithDeposit
    ? tierAny!.deposit_amount!
    : tier
      ? (tier.face_price ?? tier.base_price)
      : 0;
  const totalPrice = unitPrice * count;

  return (
    <div className="bg-card/90 backdrop-blur-sm border border-border rounded-2xl shadow-[0_4px_16px_rgba(0,0,0,0.3)] p-4 space-y-3">
      <div className="flex items-center gap-2">
        <ShoppingCart className="h-4 w-4 text-primary" />
        <h3 className="font-semibold text-sm text-foreground">
          {t("summaryTitle", { ticketNoun: orgLabels.ticketNoun, ctaVerb: orgLabels.ctaVerb })}
        </h3>
      </div>

      <div className="text-sm font-medium truncate text-foreground">
        {eventTitle}
      </div>
      {category?.toLowerCase() === "sports" && homeTeam && awayTeam && (
        <div className="text-xs text-muted-foreground font-medium">
          {homeTeam} vs {awayTeam}
        </div>
      )}
      {category?.toLowerCase() === "festival" && eventDateEnd && (
        <div className="text-xs text-muted-foreground">
          {t("festivalDuration", {
            days: Math.ceil(
              (new Date(eventDateEnd).getTime() -
                new Date(session?.event_date || "").getTime()) /
                86400000,
            ),
          })}
        </div>
      )}
      {category?.toLowerCase() === "classical" && subjectName && (
        <div className="text-xs text-muted-foreground">{t("conductor", { subjectName })}</div>
      )}

      {session && (
        <div className="text-xs text-muted-foreground">
          {new Date(session.event_date).toLocaleDateString("ko-KR", {
            month: "long",
            day: "numeric",
            weekday: "short",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </div>
      )}

      {tier && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground font-tabular">
            {isFreeWithDeposit
              ? t("depositLabel", { amount: formatKRW(unitPrice), count })
              : tier.name}
          </span>
          <span className="font-medium text-foreground font-tabular">
            {isFreeWithDeposit ? formatKRW(totalPrice) : formatKRW(unitPrice)}
          </span>
        </div>
      )}

      {isAssigned && selectedSeats.length > 0 && (
        <div className="space-y-1">
          {selectedSeats.map((seat) => (
            <div
              key={seat.id}
              className="text-xs text-muted-foreground pl-2 border-l-2 border-primary/20"
            >
              {seat.label ||
                t("seatLabel", { section: seat.section, row: seat.row_number, number: seat.seat_number })}
            </div>
          ))}
        </div>
      )}

      {!isAssigned && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            {t("quantityLabel", { ticketNoun: orgLabels.ticketNoun })}
          </span>
          <span className="font-medium text-foreground">{t("quantityValue", { quantity })}</span>
        </div>
      )}

      <div className="border-t border-border pt-2">
        <div className="flex items-center justify-between">
          <span className="font-semibold text-sm text-foreground">
            {t("totalAmountLabel", { ctaVerb: orgLabels.ctaVerb })}
          </span>
          <span className="text-lg font-bold text-emerald-600 dark:text-emerald-400 font-tabular">
            {formatKRW(totalPrice)}
          </span>
        </div>
        <p className="text-xs text-muted-foreground/60 mt-0.5">{t("vatIncluded")}</p>
      </div>

      {holdExpiresAt && (
        <SeatHoldTimer holdExpiresAt={holdExpiresAt} onExpire={onHoldExpire} />
      )}
    </div>
  );
}
