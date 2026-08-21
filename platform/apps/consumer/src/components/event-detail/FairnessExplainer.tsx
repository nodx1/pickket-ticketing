"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import Image from "next/image";
import {
  Shield,
  BarChart3,
  ChevronDown,
  Sparkles,
  CheckCircle,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { getOrganizerLabels } from "@pickket/lib";

interface FairnessExplainerProps {
  eventId: string;
  category?: string;
}

const STEP_KEYS = ["apWeightedLottery", "fanWeightReflected", "faceValuePayment"] as const;

export default function FairnessExplainer({
  category,
}: FairnessExplainerProps) {
  const t = useTranslations("event.fairnessExplainer");
  const [isOpen, setIsOpen] = useState(false);
  const labels = getOrganizerLabels(category);

  return (
    <div className="rounded-2xl border border-border bg-card/90 backdrop-blur-sm shadow-[0_2px_16px_rgba(0,0,0,0.06)] dark:shadow-[0_2px_16px_rgba(0,0,0,0.2)] overflow-hidden">
      {/* Header — always visible */}
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left transition-colors hover:bg-muted/50"
      >
        <div className="flex items-center gap-2.5">
          <Image
            src="/icons/trust/fair-distribution.svg"
            alt=""
            width={20}
            height={20}
            className="shrink-0 dark:invert"
          />
          <span className="text-sm font-semibold text-foreground">
            {t("whyFair")}
          </span>
        </div>

        <motion.span
          animate={{ rotate: isOpen ? 180 : 0 }}
          transition={{ duration: 0.25, ease: "easeInOut" }}
        >
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        </motion.span>
      </button>

      {/* Collapsible body */}
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            key="fairness-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            <div className="space-y-5 px-5 pb-5">
              {/* ── Section 1: 공정 배분 메커니즘 ── */}
              <section className="space-y-3">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-primary" />
                  <h4 className="text-sm font-bold text-foreground">
                    {t("sectionFairDistribution")}
                  </h4>
                </div>

                <p className="text-xs text-muted-foreground leading-relaxed">
                  {t("fairDistributionDesc", { eventLabel: labels.eventLabel ?? "" })}
                </p>

                {/* Step flow */}
                <div className="flex items-stretch gap-2">
                  {STEP_KEYS.map((key, idx) => (
                    <div
                      key={key}
                      className="flex items-center gap-2 flex-1"
                    >
                      <div className="flex flex-col items-center gap-1.5 flex-1">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary text-sm font-bold dark:bg-primary/20">
                          {idx + 1}
                        </div>
                        <span className="text-xs-plus leading-tight text-center text-muted-foreground font-medium">
                          {t(`steps.${key}`)}
                        </span>
                      </div>

                      {idx < STEP_KEYS.length - 1 && (
                        <span className="text-muted-foreground/50 text-lg font-light mt-[-1rem]">
                          →
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </section>

              {/* Divider */}
              <div className="border-t border-border" />

              {/* ── Section 2: AP를 투입할수록 유리한 이유 ── */}
              <section className="space-y-3">
                <div className="flex items-center gap-2">
                  <Shield className="h-4 w-4 text-primary" />
                  <h4 className="text-sm font-bold text-foreground">
                    {t("sectionApAdvantage")}
                  </h4>
                </div>

                <div className="space-y-2">
                  <div className="flex items-start gap-2.5 rounded-xl bg-primary/5 dark:bg-primary/10 p-3">
                    <CheckCircle className="h-4 w-4 shrink-0 mt-0.5 text-primary" />
                    <p className="text-xs text-foreground leading-relaxed">
                      {t("apBenefit1")}
                    </p>
                  </div>

                  <div className="flex items-start gap-2.5 rounded-xl bg-primary/5 dark:bg-primary/10 p-3">
                    <CheckCircle className="h-4 w-4 shrink-0 mt-0.5 text-primary" />
                    <p className="text-xs text-foreground leading-relaxed font-semibold">
                      {t("apBenefit2")}
                    </p>
                  </div>
                </div>
              </section>

              {/* Divider */}
              <div className="border-t border-border" />

              {/* ── Section 3: 투명한 결과 공개 ── */}
              <section className="space-y-3">
                <div className="flex items-center gap-2">
                  <BarChart3 className="h-4 w-4 text-primary" />
                  <h4 className="text-sm font-bold text-foreground">
                    {t("sectionTransparency")}
                  </h4>
                </div>

                <div className="space-y-2">
                  <div className="flex items-start gap-2.5 rounded-xl bg-muted p-3">
                    <CheckCircle className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      {t("transparencyDesc1")}
                    </p>
                  </div>

                  <div className="flex items-start gap-2.5 rounded-xl bg-muted p-3">
                    <CheckCircle className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      {t("transparencyDesc2")}
                    </p>
                  </div>
                </div>
              </section>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
