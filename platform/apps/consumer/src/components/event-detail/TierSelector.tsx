"use client";

import React, { useState, useCallback } from "react";
import { motion } from "motion/react";
import Image from "next/image";
import { Ticket, Star, Eye } from "lucide-react";
import { Badge } from "@pickket/ui";
import type { SeatTier } from "@pickket/lib/api";
import { formatKRW, getSaleModeLabel, normalizeSaleMode } from "@pickket/lib";
import { getOrganizerLabels } from "@pickket/lib";
import { useTranslations } from "next-intl";
import SeatViewPreview from "./SeatViewPreview";
import { CompetitionGauge } from "@/components/shared/CompetitionGauge";

interface TierSelectorProps {
  tiers: SeatTier[];
  selectedTierId: string | null;
  onSelect: (tierId: string) => void;
  category?: string;
}

const saleModeColors: Record<string, string> = {
  fixed_fcfs: "bg-emerald-600/10 text-emerald-600 dark:text-emerald-400",
  lottery: "bg-primary/10 text-primary/70",
  fanclub: "bg-pink-500/10 text-pink-400",
};

const containerVariants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08 } },
};
const cardVariants = {
  hidden: { opacity: 0, y: 16 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.35, ease: "easeOut" as const },
  },
};

function getProgressColor(soldPct: number): string {
  if (soldPct >= 80) return "bg-red-500";
  if (soldPct >= 50) return "bg-orange-400";
  return "bg-cyan";
}

export default function TierSelector({
  tiers,
  selectedTierId,
  onSelect,
  category,
}: TierSelectorProps) {
  const t = useTranslations("event.tierSelector");
  const distanceRef = getOrganizerLabels(category).distanceRefLabel;
  const [shakingTierId, setShakingTierId] = useState<string | null>(null);
  const [previewTier, setPreviewTier] = useState<SeatTier | null>(null);

  const handleClick = useCallback(
    (tier: SeatTier) => {
      if (tier.remaining === 0) {
        setShakingTierId(tier.id);
        setTimeout(() => setShakingTierId(null), 400);
        return;
      }
      onSelect(tier.id);
    },
    [onSelect],
  );

  return (
    <>
      <section data-tier-selector>
        <h2 className="flex items-center gap-2 text-lg font-bold text-foreground mb-4">
          <Ticket className="h-5 w-5 text-primary" />
          {t("heading")}
        </h2>

        <motion.div
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4"
          variants={containerVariants}
          initial="hidden"
          animate="show"
        >
          {tiers.map((tier) => {
            const isSoldOut = tier.remaining === 0;
            const isSelected = selectedTierId === tier.id;
            const isShaking = shakingTierId === tier.id;
            const soldPct =
              tier.capacity > 0
                ? ((tier.capacity - tier.remaining) / tier.capacity) * 100
                : 0;
            const badgeColor =
              saleModeColors[normalizeSaleMode(tier.sale_mode)] ??
              "bg-muted text-muted-foreground";

            return (
              <motion.button
                key={tier.id}
                type="button"
                tabIndex={isSoldOut ? -1 : 0}
                disabled={isSoldOut}
                aria-label={`${tier.name} - ${isSoldOut ? t("soldOut") : t("remainingSeats", { count: tier.remaining ?? 0 })} - ${formatKRW(tier.face_price || tier.base_price)}`}
                aria-pressed={isSelected}
                aria-disabled={isSoldOut}
                onClick={() => handleClick(tier)}
                variants={cardVariants}
                whileHover={!isSoldOut ? { scale: 1.02, y: -2 } : undefined}
                whileTap={!isSoldOut ? { scale: 0.98 } : undefined}
                transition={{ type: "spring", stiffness: 300, damping: 20 }}
                animate={
                  isShaking
                    ? { x: [0, -6, 6, -4, 4, 0] }
                    : { scale: isSelected ? 1.02 : 1 }
                }
                className={[
                  "bg-card/90 backdrop-blur-sm border border-border rounded-2xl shadow-[0_4px_20px_rgba(0,0,0,0.3)] p-4 cursor-pointer transition-all duration-200 text-left w-full hover:border-input",
                  isSelected && !isSoldOut
                    ? "ring-2 ring-primary shadow-[0_0_20px_rgba(10,10,10,0.3)]"
                    : "",
                  isSoldOut ? "opacity-40 grayscale cursor-not-allowed" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                {/* Top row: name + sale mode badge */}
                <div className="flex items-center justify-between gap-2 mb-2">
                  <span className="font-semibold text-sm text-foreground truncate">
                    {tier.name}
                  </span>
                  <div className="flex items-center gap-1.5">
                    {isSoldOut && (
                      <span className="text-2xs font-semibold bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400 px-1.5 py-0.5 rounded-full">
                        {t("soldOut")}
                      </span>
                    )}
                    <span
                      className={`text-2xs font-medium px-2 py-0.5 rounded-full whitespace-nowrap ${badgeColor}`}
                    >
                      {getSaleModeLabel(tier.sale_mode)}
                    </span>
                  </div>
                </div>

                {/* Price */}
                <div className="mb-3">
                  {tier.face_price === 0 ? (
                    <Badge className="bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400 border-green-200 dark:border-green-800">
                      {t("free")}
                    </Badge>
                  ) : (
                    <span className="text-xl font-bold text-foreground font-tabular">
                      {normalizeSaleMode(tier.sale_mode) === "fanclub"
                        ? formatKRW(
                            (tier.face_price || tier.base_price) *
                              (1 - (tier.fanclub_discount_pct ?? 0) / 100),
                          )
                        : formatKRW(tier.face_price || tier.base_price)}
                    </span>
                  )}
                </div>

                {/* View metadata */}
                {(tier.view_image_url ||
                  tier.position_label ||
                  tier.distance_from_stage != null) && (
                  <div className="flex items-start gap-3 mb-3 p-2.5 rounded-xl bg-surface-dim">
                    {tier.view_image_url && (
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setPreviewTier(tier);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            e.stopPropagation();
                            setPreviewTier(tier);
                          }
                        }}
                        className="relative w-[60px] h-[60px] rounded-lg overflow-hidden shrink-0 ring-1 ring-border hover:ring-primary transition-all cursor-pointer"
                      >
                        <Image
                          src={tier.view_image_url}
                          alt={t("viewAlt", { name: tier.name ?? "" })}
                          fill
                          className="object-cover"
                          sizes="60px"
                        />
                        <div className="absolute inset-0 flex items-center justify-center bg-black/20 opacity-0 hover:opacity-100 transition-opacity">
                          <Eye className="h-4 w-4 text-white" />
                        </div>
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      {tier.position_label && (
                        <p className="text-xs font-semibold text-foreground truncate">
                          {tier.position_label}
                        </p>
                      )}
                      <div className="flex items-center gap-2 mt-0.5">
                        {tier.distance_from_stage != null && (
                          <span className="text-xs-plus text-muted-foreground">
                            {distanceRef} {tier.distance_from_stage}m
                          </span>
                        )}
                        {tier.view_rating != null && (
                          <span className="flex items-center gap-0.5">
                            {Array.from({ length: 5 }, (_, i) => (
                              <Star
                                key={i}
                                className={`h-3 w-3 ${i < (tier.view_rating ?? 0) ? "fill-amber-400 text-amber-400" : "text-muted-foreground/30"}`}
                              />
                            ))}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {/* Progress bar */}
                <div className="h-2 rounded-full bg-border overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${getProgressColor(soldPct)}`}
                    style={{ width: `${soldPct}%` }}
                  />
                </div>

                {/* Remaining info */}
                <div className="flex items-center justify-between mt-1.5">
                  <span className="text-xs text-muted-foreground">
                    {t("remainingCapacity", { remaining: tier.remaining ?? 0, capacity: tier.capacity ?? 0 })}
                  </span>
                  {soldPct >= 80 && tier.remaining > 0 && (
                    <span className="text-2xs font-semibold bg-red-50 dark:bg-red-950/30 text-red-500 dark:text-red-400 px-1.5 py-0.5 rounded-full">
                      {t("almostSoldOut")}
                    </span>
                  )}
                </div>

                {/* Competition gauge */}
                <CompetitionGauge
                  ratio={
                    tier.capacity > 0
                      ? (tier.capacity - tier.remaining) / tier.capacity
                      : 0
                  }
                  size="sm"
                  showLabel={false}
                />
              </motion.button>
            );
          })}
        </motion.div>
      </section>

      <SeatViewPreview
        open={previewTier !== null}
        onOpenChange={(open) => !open && setPreviewTier(null)}
        tierName={previewTier?.name ?? ""}
        viewImageUrl={previewTier?.view_image_url}
        positionLabel={previewTier?.position_label}
        viewDescription={previewTier?.view_description}
        distanceFromStage={previewTier?.distance_from_stage}
        viewRating={previewTier?.view_rating}
        category={category}
      />
    </>
  );
}
