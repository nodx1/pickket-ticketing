"use client";

/**
 * SeatViewPreviewSheet — 좌석 길게 누름(500ms) → 시야 미리보기 슬라이드 패널 (Phase 1.5)
 *
 * SeatMap 의 onSeatLongPress 콜백으로부터 좌석을 받아서, 해당 좌석의 tier 정보를
 * 모달 시트로 표시한다. 모바일에서 좌석을 길게 눌렀을 때 시야 사진/거리/시야 등급을
 * 한 번에 확인할 수 있게 한다.
 */

import React from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { SeatViewPreview } from "./SeatViewPreview";
import { formatKRW } from "@/lib/format";
import type { Seat, SeatTier } from "@/lib/seats/types";

interface SeatViewPreviewSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  seat: Seat | null;
  tier: SeatTier | null;
}

export function SeatViewPreviewSheet({
  open,
  onOpenChange,
  seat,
  tier,
}: SeatViewPreviewSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>
            {seat
              ? `${seat.section}섹션 ${seat.row}열 ${seat.seatNumber}번`
              : "좌석 정보"}
          </SheetTitle>
        </SheetHeader>
        <div className="mt-4 space-y-4">
          {tier ? (
            <>
              <div className="flex items-center justify-between rounded-lg border border-border bg-muted p-3">
                <div>
                  <p className="text-sm text-muted-foreground">{tier.name}</p>
                  <p className="text-xl font-bold text-primary">
                    {formatKRW(tier.basePrice ?? 0)}
                  </p>
                </div>
                {tier.viewRating !== null ? (
                  <span aria-label={`시야 평점 ${tier.viewRating}점`}>
                    {"★".repeat(Math.max(0, Math.min(5, tier.viewRating)))}
                  </span>
                ) : null}
              </div>
              <SeatViewPreview tier={tier} />
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              이 좌석의 등급 정보가 없습니다.
            </p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
