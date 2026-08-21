"use client";

/**
 * SeatViewPreview — 티어 시야 미리보기 카드 (Phase 6)
 *
 * v2 event-detail/SeatViewPreview는 Dialog 기반이지만 GO는 카드 inline 스타일로 단순화.
 */

import React from "react";
import Image from "next/image";
import { Card, CardContent } from "@/components/ui/card";
import type { SeatTier } from "@/lib/seats/types";

interface SeatViewPreviewProps {
  tier: SeatTier;
  className?: string;
}

export function SeatViewPreview({ tier, className }: SeatViewPreviewProps) {
  if (!tier.viewImageUrl && !tier.viewDescription) return null;

  return (
    <Card className={className}>
      <CardContent className="space-y-3 p-4">
        {tier.viewImageUrl ? (
          <div className="relative aspect-video overflow-hidden rounded-lg">
            <Image
              src={tier.viewImageUrl}
              alt={`${tier.name} 시야`}
              fill
              className="object-cover"
              unoptimized
              sizes="(max-width: 768px) 100vw, 512px"
            />
          </div>
        ) : null}
        {tier.viewDescription ? (
          <p className="text-sm text-muted-foreground">{tier.viewDescription}</p>
        ) : null}
        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
          {tier.distanceFromStage !== null ? (
            <span>무대 거리: {tier.distanceFromStage}m</span>
          ) : null}
          {tier.viewRating !== null ? (
            <span aria-label={`시야 평점 ${tier.viewRating}점`}>
              시야 평점: {"★".repeat(Math.max(0, Math.min(5, tier.viewRating)))}
            </span>
          ) : null}
          {tier.positionLabel ? <span>{tier.positionLabel}</span> : null}
        </div>
      </CardContent>
    </Card>
  );
}
