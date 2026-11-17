"use client";

import { Clock, TrendingUp, CheckCircle } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { CARD } from "@/lib/styles";

const STEP_ICONS = [Clock, TrendingUp, CheckCircle] as const;
const STEP_ACCENTS = ["#D97706", "var(--primary)", "#00A882"] as const;

export function MileageExplainer() {
  const t = useTranslations("event.mileageExplainer");

  const STEPS = [
    {
      icon: STEP_ICONS[0],
      label: t("step1Label"),
      desc: t("step1Desc"),
      accent: STEP_ACCENTS[0],
    },
    {
      icon: STEP_ICONS[1],
      label: t("step2Label"),
      desc: t("step2Desc"),
      accent: STEP_ACCENTS[1],
    },
    {
      icon: STEP_ICONS[2],
      label: t("step3Label"),
      desc: t("step3Desc"),
      accent: STEP_ACCENTS[2],
    },
  ];

  return (
    <div
      className={
        CARD.compact + " bg-background border border-border/50 shadow-sm"
      }
    >
      <h4 className="text-sm font-bold text-foreground mb-4">
        {t("title")}
      </h4>

      <div className="relative space-y-0">
        {STEPS.map((step, i) => {
          const Icon = step.icon;
          return (
            <div
              key={step.label}
              className="relative flex gap-3 pb-4 last:pb-0"
            >
              {/* Vertical connector line */}
              {i < STEPS.length - 1 && (
                <div
                  className="absolute left-[15px] top-[32px] w-px h-[calc(100%-24px)]"
                  style={{
                    backgroundImage: `repeating-linear-gradient(to bottom, var(--border)) 0px, var(--border)) 4px, transparent 4px, transparent 8px)`,
                  }}
                />
              )}

              {/* Icon circle */}
              <div
                className="relative z-10 flex items-center justify-center w-[30px] h-[30px] rounded-full shrink-0"
                style={{
                  background: `${step.accent}20`,
                  border: `1px solid ${step.accent}40`,
                }}
              >
                <Icon className="h-3.5 w-3.5" style={{ color: step.accent }} />
              </div>

              {/* Text */}
              <div className="pt-0.5">
                <p
                  className="text-sm font-semibold"
                  style={{ color: step.accent }}
                >
                  {step.label}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {step.desc}
                </p>
              </div>
            </div>
          );
        })}
      </div>

      <Link
        href="/fairness"
        className="block mt-3 text-xs text-primary/70 hover:underline text-center"
      >
        {t("learnMore")}
      </Link>
    </div>
  );
}
