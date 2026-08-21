"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "motion/react";
import {
  ArrowRight,
  Sparkles,
  DollarSign,
  Lock,
  Users,
  Heart,
} from "lucide-react";
import { Button } from "@pickket/ui";
import { useTranslations } from "next-intl";

const SLIDE_META = [
  {
    icon: DollarSign,
    subtitle: "P1 ALL-IN PRICING",
    color: "text-emerald-600 dark:text-emerald-400",
    bg: "bg-emerald-500/10",
  },
  {
    icon: Lock,
    subtitle: "P2 LOCKED TICKET",
    color: "text-blue-600 dark:text-blue-400",
    bg: "bg-blue-500/10",
  },
  {
    icon: Users,
    subtitle: "P3 FACE-VALUE WAITLIST",
    color: "text-amber-600 dark:text-amber-400",
    bg: "bg-amber-500/10",
  },
  {
    icon: Heart,
    subtitle: "P4 FAIR DISTRIBUTION",
    color: "text-purple-600 dark:text-purple-400",
    bg: "bg-purple-500/10",
  },
];

export default function OnboardingPage() {
  const [step, setStep] = useState(0);
  const router = useRouter();
  const t = useTranslations("onboarding");

  const SLIDES = [
    {
      ...SLIDE_META[0],
      title: t("slide1Title"),
      desc: t("slide1Desc"),
    },
    {
      ...SLIDE_META[1],
      title: t("slide2Title"),
      desc: t("slide2Desc"),
    },
    {
      ...SLIDE_META[2],
      title: t("slide3Title"),
      desc: t("slide3Desc"),
    },
    {
      ...SLIDE_META[3],
      title: t("slide4Title"),
      desc: t("slide4Desc"),
    },
  ];

  const handleNext = () => {
    if (step < SLIDES.length - 1) {
      setStep(step + 1);
    } else {
      router.push("/");
    }
  };

  return (
    <div className="bg-background min-h-screen min-h-[70vh] flex flex-col items-center justify-center max-w-lg mx-auto px-4">
      {step === 0 && (
        <motion.div
          className="text-center mb-8"
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <div className="inline-flex h-14 w-14 rounded-full bg-primary items-center justify-center mb-4">
            <Sparkles className="h-7 w-7 text-primary-foreground" />
          </div>
          <h1 className="text-2xl font-bold mb-2 text-foreground">
            {t("heroTitle")}
          </h1>
          <p className="text-muted-foreground">{t("heroSubtitle")}</p>
        </motion.div>
      )}

      <AnimatePresence mode="wait">
        <motion.div
          key={step}
          initial={{ opacity: 0, x: 50 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -50 }}
          transition={{ duration: 0.3 }}
          className="w-full"
        >
          <div className="rounded-2xl shadow-xl overflow-hidden border border-border">
            <div className="pt-8 pb-8 text-center p-5 lg:p-6 bg-card">
              <div className="inline-flex h-16 w-16 rounded-2xl bg-muted backdrop-blur-xl shadow-xl items-center justify-center mb-5">
                {(() => {
                  const Icon = SLIDES[step].icon;
                  return <Icon className={`h-8 w-8 ${SLIDES[step].color}`} />;
                })()}
              </div>
              <div className="text-xs font-bold text-muted-foreground mb-1">
                {step + 1} / {SLIDES.length}
              </div>
              <h2 className="text-2xl font-bold mb-1 text-foreground">
                {SLIDES[step].title}
              </h2>
              <p className="text-sm text-primary font-medium mb-3">
                {SLIDES[step].subtitle}
              </p>
              <p className="text-muted-foreground">{SLIDES[step].desc}</p>
            </div>
          </div>
        </motion.div>
      </AnimatePresence>

      {/* Pill Dots */}
      <div
        className="flex gap-2 mt-6 mb-6"
        role="tablist"
        aria-label={t("slideNavLabel")}
      >
        {SLIDES.map((_, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setStep(i)}
            aria-label={t("slideLabel", { n: i + 1 })}
            aria-selected={i === step}
            role="tab"
            className={`h-2 rounded-full transition-all focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none ${
              i === step ? "w-6 bg-primary" : "w-2 bg-muted-foreground/30"
            }`}
          />
        ))}
      </div>

      <Button onClick={handleNext} size="lg" className="gap-2 rounded-full">
        {step < SLIDES.length - 1 ? t("next") : t("start")}
        <ArrowRight className="h-4 w-4" />
      </Button>

      {step < SLIDES.length - 1 && (
        <Button
          variant="ghost"
          className="mt-2 text-sm rounded-full"
          onClick={() => router.push("/")}
        >
          {t("skip")}
        </Button>
      )}
    </div>
  );
}
