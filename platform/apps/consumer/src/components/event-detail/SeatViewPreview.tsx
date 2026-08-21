"use client";

import React from "react";
import Image from "next/image";
import { MapPin, Star, Ruler } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@pickket/ui";
import { getOrganizerLabels } from "@pickket/lib";
import { useTranslations } from "next-intl";

interface SeatViewPreviewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tierName: string;
  viewImageUrl?: string | null;
  positionLabel?: string | null;
  viewDescription?: string | null;
  distanceFromStage?: number | null;
  viewRating?: number | null;
  category?: string;
}

export default function SeatViewPreview({
  open,
  onOpenChange,
  tierName,
  viewImageUrl,
  positionLabel,
  viewDescription,
  distanceFromStage,
  viewRating,
  category,
}: SeatViewPreviewProps) {
  const t = useTranslations("event.seatViewPreview");
  const distanceRef = getOrganizerLabels(category).distanceRefLabel;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg p-0 overflow-hidden rounded-2xl">
        <DialogHeader className="px-5 pt-5 pb-0">
          <DialogTitle className="text-lg font-bold">
            {t("title", { tierName: tierName ?? "" })}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("description", { tierName: tierName ?? "" })}
          </DialogDescription>
        </DialogHeader>

        {/* View image */}
        <div className="relative w-full aspect-[16/10] bg-muted">
          {viewImageUrl ? (
            <Image
              src={viewImageUrl}
              alt={t("imageAlt", { tierName: tierName ?? "" })}
              fill
              className="object-cover"
              sizes="(max-width: 512px) 100vw, 512px"
            />
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground">
              <MapPin className="h-10 w-10 mb-2 opacity-30" />
              <p className="text-sm">{t("noImage")}</p>
            </div>
          )}
        </div>

        {/* Metadata */}
        <div className="px-5 pb-5 space-y-3">
          {/* Position label */}
          {positionLabel && (
            <div className="flex items-center gap-2">
              <MapPin className="h-4 w-4 text-primary shrink-0" />
              <span className="text-sm font-semibold text-foreground">
                {positionLabel}
              </span>
            </div>
          )}

          {/* Distance + Rating row */}
          <div className="flex items-center gap-4">
            {distanceFromStage != null && (
              <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <Ruler className="h-4 w-4 shrink-0" />
                <span>
                  {t("distance", { ref: distanceRef ?? "", distance: distanceFromStage ?? 0 })}
                </span>
              </div>
            )}
            {viewRating != null && (
              <div className="flex items-center gap-1">
                {Array.from({ length: 5 }, (_, i) => (
                  <Star
                    key={i}
                    className={`h-4 w-4 ${i < viewRating ? "fill-amber-400 text-amber-400" : "text-muted-foreground/30"}`}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Description */}
          {viewDescription && (
            <p className="text-sm text-muted-foreground leading-relaxed">
              {viewDescription}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
