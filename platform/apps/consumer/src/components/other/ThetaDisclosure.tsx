"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { motion, AnimatePresence } from "motion/react";
import { Scale, ChevronDown, Info } from "lucide-react";
import { Card, CardContent } from "@pickket/ui";
import { Progress } from "@pickket/ui";

interface ThetaDisclosureProps {
  theta?: number; // 0-1, weight ratio between fan weight and price
  dimensions: {
    loyalty: number;
    history: number;
    fanclub: number;
    behavior: number;
    freshness: number;
  };
}

const DIMENSION_COLORS: Record<string, string> = {
  loyalty: "[&_[data-slot=progress-indicator]]:bg-primary",
  history: "[&_[data-slot=progress-indicator]]:bg-brand-lighter",
  fanclub: "[&_[data-slot=progress-indicator]]:bg-cyan",
  behavior: "[&_[data-slot=progress-indicator]]:bg-emerald-500",
  freshness: "[&_[data-slot=progress-indicator]]:bg-amber-500",
};

export default function ThetaDisclosure({
  theta = 0.5,
  dimensions,
}: ThetaDisclosureProps) {
  const t = useTranslations("event.thetaDisclosure");
  const [isOpen, setIsOpen] = useState(false);

  const fanWeightPercent = Math.round(theta * 100);
  const pricePercent = 100 - fanWeightPercent;

  // Normalize dimension weights to percentages
  const totalWeight = Object.values(dimensions).reduce((a, b) => a + b, 0);
  const dimensionEntries = Object.entries(dimensions).map(([key, value]) => ({
    key,
    value,
    percent: totalWeight > 0 ? Math.round((value / totalWeight) * 100) : 0,
    label: t(`dimension.${key}`),
    color: DIMENSION_COLORS[key],
  }));

  return (
    <Card className="overflow-hidden">
      {/* Clickable header */}
      <button
        type="button"
        className="w-full text-left"
        onClick={() => setIsOpen(!isOpen)}
      >
        <CardContent className="py-4 px-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Scale className="h-5 w-5 text-primary" />
              <span className="font-semibold text-sm">
                {t("title")}
              </span>
            </div>
            <motion.div
              animate={{ rotate: isOpen ? 180 : 0 }}
              transition={{ duration: 0.2 }}
            >
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            </motion.div>
          </div>
        </CardContent>
      </button>

      {/* Collapsible content */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            <div className="border-t border-border px-5 pb-5 pt-4 space-y-5">
              {/* Theta slider visualization */}
              <div>
                <p className="text-sm text-muted-foreground mb-3">
                  {t("priceVsFanWeightRatio")}
                </p>

                {/* Visual bar */}
                <div className="relative h-3 w-full rounded-full bg-muted overflow-hidden mb-2">
                  <div
                    className="absolute inset-y-0 left-0 bg-gradient-to-r from-cyan to-[#33D4B8] rounded-l-full transition-all"
                    style={{ width: `${pricePercent}%` }}
                  />
                  <div
                    className="absolute inset-y-0 right-0 bg-gradient-to-l from-primary to-brand-lighter rounded-r-full transition-all"
                    style={{ width: `${fanWeightPercent}%` }}
                  />
                  {/* Thumb indicator */}
                  <div
                    className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 h-5 w-5 rounded-full bg-white border-2 border-primary shadow-md transition-all"
                    style={{ left: `${pricePercent}%` }}
                  />
                </div>

                {/* Labels */}
                <div className="flex items-center justify-between text-sm">
                  <span className="text-cyan font-medium">
                    {t("pricePercent", { percent: pricePercent ?? 0 })}
                  </span>
                  <span className="text-xs text-muted-foreground font-tabular">
                    θ = {theta.toFixed(2)}
                  </span>
                  <span className="text-primary font-medium">
                    {t("fanWeightPercent", { percent: fanWeightPercent ?? 0 })}
                  </span>
                </div>
              </div>

              {/* Fan weight dimension breakdown */}
              <div>
                <p className="text-sm text-muted-foreground mb-3">
                  {t("fanWeightComposition")}
                </p>
                <div className="space-y-3">
                  {dimensionEntries.map((dim) => (
                    <div key={dim.key}>
                      <div className="flex items-center justify-between text-sm mb-1">
                        <span className="text-foreground/80">{dim.label}</span>
                        <span className="font-medium font-tabular text-muted-foreground">
                          {dim.percent}%
                        </span>
                      </div>
                      <Progress
                        value={dim.percent}
                        className={`h-2 ${dim.color}`}
                      />
                    </div>
                  ))}
                </div>
              </div>

              {/* Info note */}
              <div className="flex items-start gap-2 bg-muted/50 rounded-lg p-3">
                <Info className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {t("infoNote")}
                </p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  );
}
