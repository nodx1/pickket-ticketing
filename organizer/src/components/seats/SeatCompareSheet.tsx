"use client";

/**
 * SeatCompareSheet — 트랙 1.10 좌석 비교 (시야 동시 보기)
 *
 * 사용자가 비교 모드에서 최대 3개 좌석을 선택하면 가로 스크롤 시트로
 * tier 시야 사진/거리/등급/가격을 나란히 비교한다.
 */

import React from "react";
import Image from "next/image";
import { X } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { formatKRW } from "@/lib/format";
import type { Seat, SeatTier } from "@/lib/seats/types";

interface CompareItem {
  seat: Seat;
  tier: SeatTier | null;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: CompareItem[];
  onRemove: (seatId: string) => void;
  onClear: () => void;
}

export function SeatCompareSheet({
  open,
  onOpenChange,
  items,
  onRemove,
  onClear,
}: Props) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center justify-between gap-2">
            <span>좌석 비교 ({items.length}/3)</span>
            {items.length > 0 ? (
              <Button variant="ghost" size="sm" onClick={onClear}>
                전체 삭제
              </Button>
            ) : null}
          </SheetTitle>
        </SheetHeader>
        {items.length === 0 ? (
          <p className="mt-6 text-center text-sm text-muted-foreground">
            비교할 좌석이 없습니다. 좌석 위에서 우클릭하여 비교 목록에
            추가해주세요.
          </p>
        ) : (
          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
            {items.map(({ seat, tier }) => (
              <div
                key={seat.id}
                className="relative rounded-lg border border-border bg-card p-4 shadow-sm"
              >
                <button
                  type="button"
                  className="absolute right-2 top-2 rounded-full p-1 text-muted-foreground hover:bg-muted"
                  onClick={() => onRemove(seat.id)}
                  aria-label="비교 목록에서 제거"
                >
                  <X className="size-4" />
                </button>
                <p className="text-sm font-semibold text-foreground">
                  {seat.section}섹션 {seat.row}열 {seat.seatNumber}번
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {tier?.name ?? "등급 정보 없음"}
                </p>
                {tier ? (
                  <p className="mt-2 text-xl font-bold text-primary">
                    {formatKRW(tier.basePrice)}
                  </p>
                ) : null}
                {tier?.viewImageUrl ? (
                  <div className="relative mt-3 aspect-video overflow-hidden rounded-md bg-muted">
                    <Image
                      src={tier.viewImageUrl}
                      alt={`${tier.name} 시야`}
                      fill
                      className="object-cover"
                      unoptimized
                      sizes="(max-width:768px) 100vw, 33vw"
                    />
                  </div>
                ) : (
                  <div className="mt-3 flex aspect-video items-center justify-center rounded-md border border-dashed border-border bg-muted text-xs text-muted-foreground">
                    시야 이미지 없음
                  </div>
                )}
                {tier?.viewDescription ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {tier.viewDescription}
                  </p>
                ) : null}
                <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
                  {tier?.distanceFromStage !== undefined &&
                  tier?.distanceFromStage !== null ? (
                    <li>무대 거리: {tier.distanceFromStage}m</li>
                  ) : null}
                  {tier?.viewRating !== undefined &&
                  tier?.viewRating !== null ? (
                    <li>
                      시야 평점: {"★".repeat(Math.max(0, Math.min(5, tier.viewRating)))}
                    </li>
                  ) : null}
                  {tier?.positionLabel ? <li>{tier.positionLabel}</li> : null}
                </ul>
              </div>
            ))}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
