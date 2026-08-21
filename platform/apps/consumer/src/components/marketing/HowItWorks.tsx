"use client";

import Image from "next/image";
import { Zap, Clock, Heart } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";

interface StepConfig {
  icon?: LucideIcon;
  iconSrc?: string;
  color: string;
  glowColor?: string;
  titleKey: string;
  descKey: string;
}

interface Step {
  icon?: LucideIcon;
  iconSrc?: string;
  color: string;
  glowColor?: string;
  title: string;
  desc: string;
}

const stepConfigs: StepConfig[] = [
  {
    icon: Zap,
    color: "bg-blue-100 text-blue-600 dark:bg-blue-900/40 dark:text-blue-400",
    titleKey: "step1Title",
    descKey: "step1Desc",
  },
  {
    icon: Clock,
    color:
      "bg-amber-100 text-amber-600 dark:bg-amber-900/40 dark:text-amber-400",
    titleKey: "step2Title",
    descKey: "step2Desc",
  },
  {
    iconSrc: "/icons/trust/price-guarantee.svg",
    color: "bg-green-100 dark:bg-green-900/40",
    glowColor: "rgba(0,210,160,0.15)",
    titleKey: "step3Title",
    descKey: "step3Desc",
  },
  {
    icon: Heart,
    color: "bg-pink-100 text-pink-600 dark:bg-pink-900/40 dark:text-pink-400",
    titleKey: "step4Title",
    descKey: "step4Desc",
  },
];

export default function HowItWorks() {
  const t = useTranslations("marketing.howItWorks");

  const steps: Step[] = stepConfigs.map((cfg) => ({
    icon: cfg.icon,
    iconSrc: cfg.iconSrc,
    color: cfg.color,
    glowColor: cfg.glowColor,
    title: t(cfg.titleKey),
    desc: t(cfg.descKey),
  }));

  return (
    <section className="py-10">
      <div className="max-w-7xl mx-auto px-4 md:px-10 lg:px-16">
        <h2 className="text-3xl font-serif font-bold text-foreground text-center mb-8">
          {t("heading")}
        </h2>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {steps.map((step) => {
            const Icon = step.icon;
            return (
              <div
                key={step.title}
                className="rounded-2xl bg-card shadow-[0_2px_16px_rgba(0,0,0,0.06)] dark:shadow-[0_2px_16px_rgba(0,0,0,0.2)] p-5 space-y-3 hover:shadow-xl hover:-translate-y-1 transition-all duration-200"
              >
                <div
                  className={`h-10 w-10 rounded-full flex items-center justify-center ${step.color}`}
                  style={
                    step.glowColor
                      ? { boxShadow: `0 0 12px ${step.glowColor}` }
                      : undefined
                  }
                >
                  {step.iconSrc ? (
                    <Image
                      src={step.iconSrc}
                      alt={step.title}
                      width={20}
                      height={20}
                      className="dark:invert"
                    />
                  ) : Icon ? (
                    <Icon className="h-5 w-5" />
                  ) : null}
                </div>
                <h3 className="font-semibold text-foreground">{step.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {step.desc}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
