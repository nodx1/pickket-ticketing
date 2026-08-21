"use client";

import React, { useState, useCallback } from "react";
import { Sparkles } from "lucide-react";
import { getBestAvailable, type SeatData } from "@pickket/lib/api";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

interface BestAvailableButtonProps {
  eventId: string;
  tierId: string;
  quantity: number;
  onResult: (seats: SeatData[]) => void;
}

export default function BestAvailableButton({
  eventId,
  tierId,
  quantity,
  onResult,
}: BestAvailableButtonProps) {
  const t = useTranslations("booking.bestAvailableButton");
  const [loading, setLoading] = useState(false);

  const handleClick = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getBestAvailable(eventId, {
        tier_id: tierId,
        quantity,
      });
      const seats = Array.isArray(res.data) ? res.data : [];
      if (seats.length === 0) {
        toast.error(t("noSeatsAvailable"));
        return;
      }
      onResult(seats);
      toast.success(t("autoSelectedSuccess", { count: seats.length }));
    } catch {
      toast.error(t("recommendFailed"));
    } finally {
      setLoading(false);
    }
  }, [eventId, tierId, quantity, onResult]);

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={loading}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-cyan/10 text-cyan hover:bg-cyan/20 transition-colors disabled:opacity-50"
    >
      <Sparkles className="h-3.5 w-3.5" />
      {loading ? t("loading") : t("buttonLabel")}
    </button>
  );
}
