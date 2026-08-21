"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { motion } from "motion/react";
import {
  Ticket,
  BarChart3,
  Heart,
  ChevronLeft,
  ChevronRight,
  X,
} from "lucide-react";
import { Dialog, DialogContent, DialogTitle, Button } from "@pickket/ui";

const STORAGE_KEY = "pickket_onboarding_complete";

interface StepMeta {
  icon: React.ReactNode;
  illustrationBg: string;
  illustrationLabel: string;
}

// 🔴 `StepMeta` 가 이 배열을 위해 정의돼 있었는데 **붙어 있지 않아** 미사용 오류가 났다.
// 지우는 대신 적용한다 — 항목을 추가할 때 필드 누락이 tsc 에서 걸린다.
const STEP_META: StepMeta[] = [
  {
    icon: <Ticket className="size-8 text-indigo-500" />,
    illustrationBg: "from-indigo-500/20 to-purple-500/20",
    illustrationLabel: "FCFS / AP",
  },
  {
    icon: <BarChart3 className="size-8 text-emerald-500" />,
    illustrationBg: "from-emerald-500/20 to-teal-500/20",
    illustrationLabel: "FAIR",
  },
  {
    icon: <Heart className="size-8 text-rose-500" />,
    illustrationBg: "from-rose-500/20 to-pink-500/20",
    illustrationLabel: "PICK",
  },
];

const slideVariants = {
  enter: (direction: number) => ({
    x: direction > 0 ? 200 : -200,
    opacity: 0,
  }),
  center: {
    x: 0,
    opacity: 1,
  },
  exit: (direction: number) => ({
    x: direction > 0 ? -200 : 200,
    opacity: 0,
  }),
};

export default function OnboardingTutorial() {
  const t = useTranslations("onboarding");
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState(1);

  const STEPS = STEP_META.map((meta, i) => ({
    ...meta,
    title: t(`steps.${i}.title`),
    description: t(`steps.${i}.description`),
  }));

  useEffect(() => {
    try {
      const done = localStorage.getItem(STORAGE_KEY);
      if (!done) {
        setOpen(true);
      }
    } catch {
      // localStorage unavailable — skip
    }
  }, []);

  const complete = useCallback(() => {
    try {
      localStorage.setItem(STORAGE_KEY, "true");
    } catch {
      // ignore
    }
    setOpen(false);
  }, []);

  const goNext = useCallback(() => {
    // ⚠️ `STEPS.length` 가 아니라 `STEP_META.length` 다. STEPS 는 매 렌더 t 로 새로
    //    만들어지므로 콜백이 t 를 가둬 React Compiler 가 최적화를 포기했다.
    //    두 길이는 항상 같다 — STEPS 는 STEP_META.map(...) 이고 map 은 길이를 보존한다.
    if (step < STEP_META.length - 1) {
      setDirection(1);
      setStep((s) => s + 1);
    } else {
      complete();
    }
  }, [step, complete]);

  const goPrev = useCallback(() => {
    if (step > 0) {
      setDirection(-1);
      setStep((s) => s - 1);
    }
  }, [step]);

  const currentStep = STEPS[step];
  const isLast = step === STEPS.length - 1;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && complete()}>
      <DialogContent
        showCloseButton={false}
        className="max-w-sm gap-0 overflow-hidden p-0 sm:max-w-sm"
      >
        {/* Hidden accessible title */}
        <DialogTitle className="sr-only">{t("title")}</DialogTitle>

        {/* Skip button */}
        <button
          type="button"
          onClick={complete}
          className="absolute top-3 right-3 z-10 rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label={t("skipAriaLabel")}
        >
          <X className="size-4" />
        </button>

        {/* Illustration area */}
        <div
          className={`relative flex h-44 items-center justify-center bg-gradient-to-br ${currentStep.illustrationBg}`}
        >
          <motion.div
            key={`illustration-${step}`}
            custom={direction}
            variants={slideVariants}
            initial="enter"
            animate="center"
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            className="flex flex-col items-center gap-3"
          >
            <div className="rounded-2xl bg-background/80 p-4 shadow-lg backdrop-blur-sm dark:bg-background/60">
              {currentStep.icon}
            </div>
            <span className="text-xs font-bold tracking-widest text-muted-foreground uppercase">
              {currentStep.illustrationLabel}
            </span>
          </motion.div>
        </div>

        {/* Content area */}
        <div className="flex flex-col gap-4 px-6 pt-5 pb-6">
          <motion.div
            key={`content-${step}`}
            custom={direction}
            variants={slideVariants}
            initial="enter"
            animate="center"
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            className="min-h-[5.5rem]"
          >
            <h3 className="mb-2 text-lg font-bold text-foreground">
              {currentStep.title}
            </h3>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {currentStep.description}
            </p>
          </motion.div>

          {/* Step indicators */}
          <div className="flex items-center justify-center gap-1.5">
            {STEPS.map((_, i) => (
              <div
                key={i}
                className={`h-1.5 rounded-full transition-all duration-300 ${
                  i === step ? "w-6 bg-primary" : "w-1.5 bg-muted-foreground/30"
                }`}
              />
            ))}
          </div>

          {/* Navigation buttons */}
          <div className="flex items-center gap-2">
            {step > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={goPrev}
                className="gap-1"
              >
                <ChevronLeft className="size-4" />
                {t("prev")}
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={complete}
                className="text-muted-foreground"
              >
                {t("skip")}
              </Button>
            )}

            <div className="flex-1" />

            <Button size="sm" onClick={goNext} className="gap-1">
              {isLast ? (
                t("start")
              ) : (
                <>
                  {t("next")}
                  <ChevronRight className="size-4" />
                </>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
