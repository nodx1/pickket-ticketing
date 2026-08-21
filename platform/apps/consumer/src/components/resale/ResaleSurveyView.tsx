"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import {
  MessageSquare,
  Shield,
  ArrowRight,
  CheckCircle2,
  Check,
  AlertTriangle,
  Users,
  Scale,
} from "lucide-react";
import { motion } from "motion/react";
import { API_URL } from "@pickket/lib";

type SurveyAnswers = {
  q1: string | null;
  q2: string[];
  q3: string[];
  q4: string | null;
  q5: string;
};

function useQuestions(t: ReturnType<typeof useTranslations<"resale.survey">>) {
  return [
    {
      id: "q1",
      badge: "Q1",
      title: t("q1.title"),
      sub: t("q1.sub"),
      type: "radio" as const,
      options: [
        t("q1.opt1"),
        t("q1.opt2"),
        t("q1.opt3"),
        t("q1.opt4"),
      ],
    },
    {
      id: "q2",
      badge: "Q2",
      title: t("q2.title"),
      sub: t("q2.sub"),
      type: "checkbox" as const,
      options: [
        t("q2.opt1"),
        t("q2.opt2"),
        t("q2.opt3"),
        t("q2.opt4"),
      ],
    },
    {
      id: "q3",
      badge: "Q3",
      title: t("q3.title"),
      sub: t("q3.sub"),
      type: "checkbox" as const,
      maxSelect: 3,
      options: [
        t("q3.opt1"),
        t("q3.opt2"),
        t("q3.opt3"),
        t("q3.opt4"),
        t("q3.opt5"),
        t("q3.opt6"),
      ],
    },
    {
      id: "q4",
      badge: "Q4",
      title: t("q4.title"),
      sub: t("q4.sub"),
      type: "radio" as const,
      options: [
        t("q4.opt1"),
        t("q4.opt2"),
        t("q4.opt3"),
        t("q4.opt4"),
      ],
    },
  ];
}

export default function ResaleSurveyView() {
  const t = useTranslations("resale.survey");
  const QUESTIONS = useQuestions(t);
  const [answers, setAnswers] = useState<SurveyAnswers>({
    q1: null,
    q2: [],
    q3: [],
    q4: null,
    q5: "",
  });
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const answeredCount = [
    answers.q1 !== null,
    answers.q2.length > 0,
    answers.q3.length > 0,
    answers.q4 !== null,
  ].filter(Boolean).length;

  function handleRadio(qId: "q1" | "q4", value: string) {
    setAnswers((prev) => ({ ...prev, [qId]: value }));
  }

  function handleCheckbox(qId: "q2" | "q3", value: string, maxSelect?: number) {
    setAnswers((prev) => {
      const current = prev[qId];
      if (current.includes(value)) {
        return { ...prev, [qId]: current.filter((v) => v !== value) };
      }
      if (maxSelect && current.length >= maxSelect) return prev;
      return { ...prev, [qId]: [...current, value] };
    });
  }

  async function handleSubmit() {
    if (answeredCount < 4) return;
    setSubmitting(true);
    try {
      const res = await fetch(
        `${API_URL}/api/v1/surveys/resale_2026/responses`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            answers,
            metadata: { locale: navigator.language, timestamp: Date.now() },
          }),
        },
      );
      if (res.ok || res.status === 409) {
        setSubmitted(true);
      }
    } catch {
      // Fallback: show thank you even if API fails (survey data is nice-to-have)
      setSubmitted(true);
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <main className="min-h-screen bg-background">
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.4, ease: [0.34, 1.56, 0.64, 1] }}
          className="flex flex-col items-center justify-center min-h-[70vh] px-6 text-center"
        >
          <div className="w-16 h-16 rounded-full bg-cyan/10 flex items-center justify-center mb-6">
            <CheckCircle2 className="h-8 w-8 text-cyan" />
          </div>
          <h2 className="text-2xl font-bold text-foreground mb-2">
            {t("thankyou.title")}
          </h2>
          <p className="text-sm text-muted-foreground max-w-md mb-8">
            {t("thankyou.body")}
          </p>
          <Link
            href="/"
            className="inline-flex items-center gap-2 px-6 py-2.5 rounded-full bg-primary text-white font-semibold hover:bg-primary/90 transition-colors"
          >
            {t("thankyou.homeLink")}
          </Link>
        </motion.div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-background">
      {/* ── Hero ── */}
      <section className="relative overflow-hidden bg-gradient-to-br from-primary via-primary/80 to-violet text-white">
        <div className="max-w-5xl mx-auto px-6 py-16 md:py-20 text-center relative z-10">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full text-xs font-bold tracking-wider uppercase mb-6 bg-white/10 text-white/70">
            <MessageSquare className="h-3.5 w-3.5" />{t("hero.badge")}
          </div>
          <h1 className="text-4xl md:text-5xl font-extrabold tracking-tight leading-[1.15] mb-4">
            {t("hero.h1Line1")}
            <br />
            <span className="bg-gradient-to-r from-cyan to-cyan/80 bg-clip-text text-transparent">
              {t("hero.h1Line2")}
            </span>
          </h1>
          <p className="text-lg md:text-xl text-white/60 max-w-2xl mx-auto mb-6">
            {t("hero.body")}
          </p>
          <div className="inline-flex items-center gap-2 text-xs text-white/40">
            <Shield className="h-3.5 w-3.5" />
            {t("hero.legalNote")}
          </div>
        </div>
        <div className="absolute bottom-0 left-0 right-0 h-24 bg-gradient-to-t from-background to-transparent" />
      </section>

      {/* ── Stat Cards ── */}
      <section className="max-w-5xl mx-auto px-6 -mt-8 relative z-20">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[
            {
              value: t("stats.s1.value"),
              label: t("stats.s1.label"),
              sub: t("stats.s1.sub"),
              color: "text-red-400",
              icon: AlertTriangle,
            },
            {
              value: t("stats.s2.value"),
              label: t("stats.s2.label"),
              sub: t("stats.s2.sub"),
              color: "text-cyan",
              icon: Users,
            },
            {
              value: t("stats.s3.value"),
              label: t("stats.s3.label"),
              sub: t("stats.s3.sub"),
              color: "text-primary",
              icon: Scale,
            },
          ].map((stat) => (
            <div
              key={stat.label}
              className="rounded-2xl bg-card shadow-[0_2px_16px_rgba(0,0,0,0.06)] dark:shadow-[0_2px_16px_rgba(0,0,0,0.3)] p-5 text-center"
            >
              <stat.icon className={`h-5 w-5 mx-auto mb-2 ${stat.color}`} />
              <p className={`text-3xl font-extrabold font-mono ${stat.color}`}>
                {stat.value}
              </p>
              <p className="text-sm font-medium text-foreground mt-1">
                {stat.label}
              </p>
              <p className="text-xs-plus text-muted-foreground mt-0.5">
                {stat.sub}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Visual Divider ── */}
      <div className="flex items-center justify-center gap-2 my-12">
        <div className="w-8 h-0.5 bg-gradient-to-r from-transparent to-primary/30" />
        <div className="w-2 h-2 rounded-full bg-primary/20" />
        <div className="w-8 h-0.5 bg-gradient-to-l from-transparent to-primary/30" />
      </div>

      {/* ── Progress Bar ── */}
      <div className="sticky top-0 z-30 bg-background/95 backdrop-blur-sm border-b border-border">
        <div className="max-w-5xl mx-auto px-6 py-3 flex items-center gap-4">
          <span className="text-xs font-medium text-muted-foreground shrink-0">
            {t("progress.label", { answered: answeredCount ?? 0 })}
          </span>
          <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-gradient-to-r from-primary to-cyan transition-all duration-500"
              style={{ width: `${(answeredCount / 5) * 100}%` }}
            />
          </div>
        </div>
      </div>

      {/* ── Questions ── */}
      <section className="max-w-3xl mx-auto px-6 py-10 space-y-6">
        {QUESTIONS.map((q) => (
          <div
            key={q.id}
            className="rounded-2xl bg-card shadow-[0_2px_16px_rgba(0,0,0,0.06)] dark:shadow-[0_2px_16px_rgba(0,0,0,0.3)] overflow-hidden"
          >
            <div className="h-1 bg-gradient-to-r from-primary to-cyan" />
            <div className="p-6 md:p-8">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 text-primary text-xs font-bold mb-3">
                {q.badge}
              </div>
              <h3 className="text-lg font-bold text-foreground mb-1">
                {q.title}
              </h3>
              <p className="text-sm text-muted-foreground mb-5">{q.sub}</p>

              <div className="space-y-2.5">
                {q.options.map((opt) => {
                  const isRadio = q.type === "radio";
                  const qId = q.id as keyof SurveyAnswers;
                  const selected = isRadio
                    ? answers[qId] === opt
                    : (answers[qId] as string[]).includes(opt);
                  const disabled =
                    !isRadio &&
                    q.maxSelect !== undefined &&
                    (answers[qId] as string[]).length >= q.maxSelect &&
                    !selected;

                  return (
                    <label
                      key={opt}
                      className={`flex items-center gap-3 p-4 rounded-xl border cursor-pointer transition-all duration-200
                        ${
                          selected
                            ? "border-primary bg-primary/5 ring-1 ring-primary/20"
                            : disabled
                              ? "border-border opacity-40 cursor-not-allowed"
                              : "border-border hover:border-primary/30 hover:bg-muted/50"
                        }`}
                      onClick={(e) => {
                        if (disabled) {
                          e.preventDefault();
                          return;
                        }
                        if (isRadio) {
                          handleRadio(qId as "q1" | "q4", opt);
                        } else {
                          handleCheckbox(qId as "q2" | "q3", opt, q.maxSelect);
                        }
                      }}
                    >
                      {isRadio ? (
                        <div
                          className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors ${
                            selected
                              ? "border-primary"
                              : "border-muted-foreground/30"
                          }`}
                        >
                          {selected && (
                            <div className="w-2.5 h-2.5 rounded-full bg-primary" />
                          )}
                        </div>
                      ) : (
                        <div
                          className={`w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 transition-colors ${
                            selected
                              ? "border-primary bg-primary"
                              : "border-muted-foreground/30"
                          }`}
                        >
                          {selected && <Check className="h-3 w-3 text-white" />}
                        </div>
                      )}
                      <span className="text-sm font-medium text-foreground">
                        {opt}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          </div>
        ))}

        {/* Q5 Free text */}
        <div className="rounded-2xl bg-card shadow-[0_2px_16px_rgba(0,0,0,0.06)] dark:shadow-[0_2px_16px_rgba(0,0,0,0.3)] overflow-hidden">
          <div className="h-1 bg-gradient-to-r from-primary to-cyan" />
          <div className="p-6 md:p-8">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 text-primary text-xs font-bold mb-3">
              Q5
            </div>
            <h3 className="text-lg font-bold text-foreground mb-1">
              {t("q5.title")}
            </h3>
            <p className="text-sm text-muted-foreground mb-5">
              {t("q5.sub")}
            </p>
            <textarea
              className="w-full rounded-xl border border-border bg-background px-4 py-3 text-sm placeholder:text-muted-foreground/50 resize-none focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors"
              rows={4}
              maxLength={500}
              placeholder={t("q5.placeholder")}
              value={answers.q5}
              onChange={(e) =>
                setAnswers((prev) => ({ ...prev, q5: e.target.value }))
              }
            />
            <p className="text-right text-xs-plus text-muted-foreground mt-1">
              {answers.q5.length}/500
            </p>
          </div>
        </div>

        {/* Submit */}
        <div className="text-center pt-4 pb-8">
          <button
            onClick={handleSubmit}
            disabled={answeredCount < 4 || submitting}
            className="inline-flex items-center gap-2 px-8 py-3.5 rounded-full bg-primary text-white font-semibold hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? t("submit.submitting") : t("submit.label")}
            {!submitting && <ArrowRight className="h-4 w-4" />}
          </button>
          <p className="text-xs-plus text-muted-foreground mt-2">
            {t("submit.hint")}
          </p>
        </div>
      </section>
    </main>
  );
}
