"use client";

/**
 * BestAvailableButton — 최적 인접 좌석 자동 선택 (Phase 6)
 */

import React, { useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getBestAvailable } from "@/lib/seats/client";
import { showError } from "@/lib/hooks/useToast";
import type { Seat } from "@/lib/seats/types";

interface BestAvailableButtonProps {
  eventId: string;
  mapId: string;
  quantity: number;
  tierId?: string;
  onSelected: (seats: Seat[]) => void;
  disabled?: boolean;
  className?: string;
}

export function BestAvailableButton({
  eventId,
  mapId,
  quantity,
  tierId,
  onSelected,
  disabled,
  className,
}: BestAvailableButtonProps) {
  const [loading, setLoading] = useState(false);

  async function handleClick() {
    setLoading(true);
    try {
      const seats = await getBestAvailable(eventId, mapId, quantity, tierId);
      if (seats.length === 0) {
        showError("추천할 좌석이 없습니다");
        return;
      }
      onSelected(seats);
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "추천 좌석 조회 실패");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      onClick={handleClick}
      disabled={disabled || loading}
      className={className}
    >
      <Sparkles className="mr-2 size-4" aria-hidden />
      {loading ? "검색 중..." : "최적 좌석 자동 선택"}
    </Button>
  );
}
