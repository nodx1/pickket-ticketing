"use client";

import { useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { motion, AnimatePresence } from "motion/react";
import { Button } from "@pickket/ui";
import { toast } from "sonner";
import {
  QUESTIONS,
  DNA_AXES,
  calculateScores,
  getResult,
  getShareText,
  type DnaScores,
  type DnaResult,
} from "@/lib/dna-test";
import { Dna, ArrowRight, Share2, Send, RotateCcw } from "lucide-react";

type Phase = "intro" | "quiz" | "result";

export default function DnaTest() {
  const t = useTranslations("careers.dnaTest");
  const [phase, setPhase] = useState<Phase>("intro");
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<number[]>([]);
  const [scores, setScores] = useState<DnaScores | null>(null);
  const [result, setResult] = useState<DnaResult | null>(null);

  const handleStart = () => {
    setPhase("quiz");
    setStep(0);
    setAnswers([]);
  };

  const handleSelect = useCallback(
    (optionIndex: number) => {
      const newAnswers = [...answers, optionIndex];
      setAnswers(newAnswers);

      if (step < QUESTIONS.length - 1) {
        // Delay to show selection before advancing
        setTimeout(() => setStep(step + 1), 300);
      } else {
        // Calculate result
        setTimeout(() => {
          const s = calculateScores(newAnswers);
          const r = getResult(s);
          setScores(s);
          setResult(r);
          setPhase("result");
        }, 400);
      }
    },
    [answers, step],
  );

  const handleShare = async () => {
    if (!result || !scores) return;
    const text = getShareText(result, scores);
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t("copySuccess"));
    } catch {
      toast.error(t("copyError"));
    }
  };

  const handleReset = () => {
    setPhase("intro");
    setStep(0);
    setAnswers([]);
    setScores(null);
    setResult(null);
  };

  return (
    <div className="max-w-2xl mx-auto">
      <AnimatePresence mode="wait">
        {/* Phase 1: Intro */}
        {phase === "intro" && (
          <motion.div
            key="intro"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="bg-card rounded-2xl border border-border shadow-[0_2px_16px_rgba(0,0,0,0.06)] p-8 md:p-12 text-center"
          >
            <div className="inline-flex h-16 w-16 rounded-2xl bg-primary/10 items-center justify-center mb-6">
              <Dna className="h-8 w-8 text-primary" />
            </div>
            <h3 className="text-2xl font-bold text-foreground mb-3">
              {t("introTitle")}
            </h3>
            <p className="text-muted-foreground text-sm leading-relaxed mb-2">
              {t("introDesc")}
            </p>
            <p className="text-xs text-muted-foreground mb-8">
              {t("introDuration")}
            </p>
            <Button
              onClick={handleStart}
              className="rounded-full bg-primary hover:bg-brand-hover text-white px-8 h-12 text-base font-semibold"
            >
              <span className="flex items-center gap-2">
                {t("startButton")}
                <ArrowRight className="h-4 w-4" />
              </span>
            </Button>
          </motion.div>
        )}

        {/* Phase 2: Quiz */}
        {phase === "quiz" && (
          <motion.div
            key={`quiz-${step}`}
            initial={{ opacity: 0, x: 40 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -40 }}
            transition={{ duration: 0.25 }}
            className="bg-card rounded-2xl border border-border shadow-[0_2px_16px_rgba(0,0,0,0.06)] p-6 md:p-10"
          >
            {/* Progress */}
            <div className="flex items-center gap-3 mb-8">
              <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                <motion.div
                  className="h-full rounded-full bg-primary"
                  initial={{ width: `${(step / QUESTIONS.length) * 100}%` }}
                  animate={{
                    width: `${((step + 1) / QUESTIONS.length) * 100}%`,
                  }}
                  transition={{ duration: 0.3 }}
                />
              </div>
              <span className="text-xs text-muted-foreground font-mono flex-shrink-0">
                {step + 1}/{QUESTIONS.length}
              </span>
            </div>

            {/* Question */}
            <p className="text-lg font-semibold text-foreground mb-6 leading-relaxed">
              {QUESTIONS[step].scenario}
            </p>

            {/* Options */}
            <div className="space-y-3">
              {QUESTIONS[step].options.map((option, i) => (
                <button
                  key={`${step}-${option.text}`}
                  onClick={() => handleSelect(i)}
                  className="w-full text-left px-5 py-4 rounded-xl border border-border hover:border-primary/40 hover:bg-surface-dim hover:-translate-y-0.5 transition-all duration-200 group"
                >
                  <div className="flex items-start gap-3">
                    <span className="flex-shrink-0 h-6 w-6 rounded-full border-2 border-border group-hover:border-primary flex items-center justify-center text-xs font-bold text-muted-foreground group-hover:text-primary transition-colors">
                      {String.fromCharCode(65 + i)}
                    </span>
                    <span className="text-sm text-foreground group-hover:text-foreground transition-colors">
                      {option.text}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </motion.div>
        )}

        {/* Phase 3: Result */}
        {phase === "result" && result && scores && (
          <motion.div
            key="result"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            className="bg-card rounded-2xl border border-border shadow-[0_2px_16px_rgba(0,0,0,0.06)] p-6 md:p-10"
          >
            {/* Type badge */}
            <div className="text-center mb-8">
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{
                  type: "spring",
                  stiffness: 300,
                  damping: 20,
                  delay: 0.2,
                }}
                className="text-6xl mb-4"
              >
                {result.emoji}
              </motion.div>
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.4 }}
              >
                <p className="text-xs text-primary font-semibold tracking-wider uppercase mb-1">
                  Your Pickket DNA
                </p>
                <h3 className="text-2xl font-bold text-foreground">
                  {result.name}
                </h3>
                <p className="text-muted-foreground text-sm mt-1">
                  {result.description}
                </p>
              </motion.div>
            </div>

            {/* Score bars */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.6 }}
              className="space-y-3 mb-8"
            >
              {DNA_AXES.map(({ key, label, color }) => (
                <div key={key} className="flex items-center gap-3">
                  <span className="text-xs font-medium text-muted-foreground w-14 text-right">
                    {label}
                  </span>
                  <div className="flex-1 h-3 rounded-full bg-muted overflow-hidden">
                    <motion.div
                      className="h-full rounded-full"
                      style={{ backgroundColor: color }}
                      initial={{ width: 0 }}
                      animate={{ width: `${scores[key]}%` }}
                      transition={{
                        duration: 0.8,
                        delay: 0.8,
                        ease: "easeOut",
                      }}
                    />
                  </div>
                  <span className="text-xs font-mono font-bold text-foreground w-10">
                    {scores[key]}%
                  </span>
                </div>
              ))}
            </motion.div>

            {/* Detail */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 1 }}
              className="bg-surface-dim rounded-xl p-5 mb-6 space-y-2"
            >
              <p className="text-sm text-foreground leading-relaxed">
                {result.detail}
              </p>
              <p className="text-xs text-primary font-semibold">
                {t("bestRole", { role: result.bestRole ?? "" })}
              </p>
            </motion.div>

            {/* CTAs */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 1.2 }}
              className="flex flex-col sm:flex-row gap-3"
            >
              <Button
                onClick={() => {
                  const el = document.getElementById("positions");
                  el?.scrollIntoView({ behavior: "smooth" });
                }}
                className="flex-1 rounded-full bg-primary hover:bg-brand-hover text-white h-11 font-semibold"
              >
                <span className="flex items-center gap-2">
                  <Send className="h-4 w-4" />
                  {t("viewPositions")}
                </span>
              </Button>
              <Button
                onClick={handleShare}
                variant="outline"
                className="flex-1 rounded-full h-11 font-semibold"
              >
                <span className="flex items-center gap-2">
                  <Share2 className="h-4 w-4" />
                  {t("shareResult")}
                </span>
              </Button>
              <Button
                onClick={handleReset}
                variant="ghost"
                className="sm:w-11 rounded-full h-11"
              >
                <RotateCcw className="h-4 w-4" />
              </Button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
