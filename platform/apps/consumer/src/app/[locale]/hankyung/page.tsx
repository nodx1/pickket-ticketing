"use client";

import Link from "next/link";
import Image from "next/image";
import { useTranslations } from "next-intl";
import { motion } from "motion/react";
import {
  Shield,
  Zap,
  Users,
  TrendingUp,
  Lock,
  RotateCcw,
  Globe,
  ChevronRight,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  ArrowRight,
} from "lucide-react";

/* ── constants ──────────────────────────────────────────── */

const W = "max-w-[1200px] mx-auto px-6 sm:px-10";

const FADE_UP = {
  initial: { opacity: 0, y: 20 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: "-60px" } as const,
  transition: { duration: 0.55, ease: [0.22, 1, 0.36, 1] as const },
};

const stagger = (i: number) => ({
  ...FADE_UP,
  transition: { ...FADE_UP.transition, delay: i * 0.08 },
});

/* ══════════════════════════════════════════════════════════
   About Page — 피켓 소개
   ══════════════════════════════════════════════════════════ */

export default function AboutPage() {
  const t = useTranslations("hankyung");
  return (
    <div className="min-h-screen bg-white text-gray-900 overflow-clip">
      {/* ─── S1. Hero ──────────────────────────────────── */}
      <section className="relative pt-36 pb-24 sm:pt-44 sm:pb-32 overflow-hidden">
        {/* bg accents */}
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-10%,rgba(99,102,241,0.08),transparent)]" />
        <div className="absolute top-32 right-0 w-96 h-96 rounded-full bg-violet-100/40 blur-[120px] pointer-events-none" />
        <div className="absolute bottom-0 left-0 w-72 h-72 rounded-full bg-emerald-100/30 blur-[100px] pointer-events-none" />

        <div className={`${W} relative z-10 text-center`}>
          <motion.p
            {...FADE_UP}
            className="text-[11px] font-bold tracking-[0.18em] uppercase text-violet-600 dark:text-violet-400 mb-5"
          >
            Fair Ticketing Platform
          </motion.p>
          <motion.h1
            {...FADE_UP}
            transition={{ ...FADE_UP.transition, delay: 0.1 }}
            className="font-black tracking-tight leading-[1.05] mb-6"
            style={{ fontSize: "clamp(2.2rem, 5vw, 3.8rem)" }}
          >
            {t("hero.title")}
          </motion.h1>
          <motion.p
            {...FADE_UP}
            transition={{ ...FADE_UP.transition, delay: 0.2 }}
            className="text-base sm:text-lg text-gray-500 max-w-2xl mx-auto leading-relaxed"
          >
            {t("hero.desc1")}
            <br className="hidden sm:block" />
            {t("hero.desc2")}
          </motion.p>
        </div>
      </section>

      {/* ─── S2. 한국 티켓 시장의 문제 ─────────────────── */}
      <section className="py-20 sm:py-28 bg-gray-50">
        <div className={W}>
          <motion.div {...FADE_UP} className="mb-14">
            <p className="text-[11px] font-bold tracking-[0.14em] uppercase text-red-400 mb-3">
              Problem
            </p>
            <h2
              className="font-black tracking-tight text-gray-900"
              style={{ fontSize: "clamp(1.6rem, 3vw, 2.4rem)" }}
            >
              {t("problem.title1")}
              <br />
              {t("problem.title2")}
            </h2>
          </motion.div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {[
              {
                icon: <Zap className="h-5 w-5" />,
                title: t("problem.p1.title"),
                stat: t("problem.p1.stat"),
                desc: t("problem.p1.desc"),
                accent: "text-red-500",
                bg: "bg-red-50",
              },
              {
                icon: <AlertTriangle className="h-5 w-5" />,
                title: t("problem.p2.title"),
                stat: t("problem.p2.stat"),
                desc: t("problem.p2.desc"),
                accent: "text-amber-500",
                bg: "bg-amber-50",
              },
              {
                icon: <XCircle className="h-5 w-5" />,
                title: t("problem.p3.title"),
                stat: t("problem.p3.stat"),
                desc: t("problem.p3.desc"),
                accent: "text-gray-500",
                bg: "bg-gray-100",
              },
            ].map((item, i) => (
              <motion.div
                key={item.title}
                {...stagger(i)}
                className="rounded-2xl bg-white p-7 border border-gray-100 shadow-[0_1px_8px_rgba(0,0,0,0.04)]"
              >
                <div
                  className={`inline-flex items-center justify-center w-10 h-10 rounded-xl ${item.bg} ${item.accent} mb-4`}
                >
                  {item.icon}
                </div>
                <h3 className="text-lg font-black text-gray-900 mb-1">
                  {item.title}
                </h3>
                <p className={`text-xs font-bold ${item.accent} mb-3`}>
                  {item.stat}
                </p>
                <p className="text-[13px] text-gray-500 leading-relaxed">
                  {item.desc}
                </p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── S3. 글로벌의 시도 ─────────────────────────── */}
      <section className="py-20 sm:py-28">
        <div className={W}>
          <motion.div {...FADE_UP} className="mb-14">
            <p className="text-[11px] font-bold tracking-[0.14em] uppercase text-gray-400 mb-3">
              Global Attempts
            </p>
            <h2
              className="font-black tracking-tight text-gray-900"
              style={{ fontSize: "clamp(1.6rem, 3vw, 2.4rem)" }}
            >
              {t("global.title1")}
              <br />
              {t("global.title2")}
            </h2>
          </motion.div>

          <div className="space-y-4">
            {[
              {
                flag: "🇺🇸",
                name: "Ticketmaster",
                label: "Verified Fan",
                attempt: t("global.g1.attempt"),
                limit: t("global.g1.limit"),
              },
              {
                flag: "🇬🇧",
                name: "DICE",
                label: "Waitlist Resale",
                attempt: t("global.g2.attempt"),
                limit: t("global.g2.limit"),
              },
              {
                flag: "🇺🇸🇦🇺",
                name: "AXS",
                label: "ID-Gated Entry",
                attempt: t("global.g3.attempt"),
                limit: t("global.g3.limit"),
              },
            ].map((item, i) => (
              <motion.div
                key={item.name}
                {...stagger(i)}
                className="group rounded-2xl border border-gray-100 bg-white p-6 sm:p-7 shadow-[0_1px_8px_rgba(0,0,0,0.03)] hover:border-gray-200 transition-colors"
              >
                <div className="flex flex-col sm:flex-row sm:items-start gap-4">
                  <div className="flex items-center gap-3 sm:w-52 shrink-0">
                    <span className="text-2xl">{item.flag}</span>
                    <div>
                      <p className="font-black text-gray-900 text-[15px]">
                        {item.name}
                      </p>
                      <p className="text-[11px] font-bold text-violet-600 dark:text-violet-400 tracking-wide">
                        {item.label}
                      </p>
                    </div>
                  </div>
                  <div className="flex-1 grid sm:grid-cols-2 gap-3 text-[13px]">
                    <div>
                      <p className="font-bold text-gray-900 text-[11px] uppercase tracking-wider mb-1">
                        {t("global.attemptLabel")}
                      </p>
                      <p className="text-gray-500 leading-relaxed">
                        {item.attempt}
                      </p>
                    </div>
                    <div>
                      <p className="font-bold text-red-400 text-[11px] uppercase tracking-wider mb-1">
                        {t("global.limitLabel")}
                      </p>
                      <p className="text-gray-400 leading-relaxed">
                        {item.limit}
                      </p>
                    </div>
                  </div>
                </div>
              </motion.div>
            ))}
          </div>

          <motion.p
            {...FADE_UP}
            className="mt-8 text-[13px] text-gray-400 text-center sm:text-right font-medium"
          >
            {t("global.lesson1")}{" "}
            <span className="text-gray-900 font-bold">
              {t("global.lesson2")}
            </span>
          </motion.p>
        </div>
      </section>

      {/* ─── S4. 일본의 선례 ───────────────────────────── */}
      <section className="py-20 sm:py-28 bg-gray-50">
        <div className={W}>
          <motion.div {...FADE_UP} className="mb-14">
            <p className="text-[11px] font-bold tracking-[0.14em] uppercase text-gray-400 mb-3">
              Proven Model — Japan
            </p>
            <h2
              className="font-black tracking-tight text-gray-900"
              style={{ fontSize: "clamp(1.6rem, 3vw, 2.4rem)" }}
            >
              {t("japan.title")}
            </h2>
            <p className="text-sm text-gray-500 mt-3 max-w-xl">
              {t("japan.subtitle")}
            </p>
          </motion.div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
            {[
              {
                tag: t("japan.j1.tag"),
                title: t("japan.j1.title"),
                year: "2019",
                desc: t("japan.j1.desc"),
              },
              {
                tag: t("japan.j2.tag"),
                title: "ぴあ (Pia) Cloak",
                year: "2018~",
                desc: t("japan.j2.desc"),
              },
              {
                tag: t("japan.j3.tag"),
                title: t("japan.j3.title"),
                year: t("japan.j3.year"),
                desc: t("japan.j3.desc"),
              },
              {
                tag: t("japan.j4.tag"),
                title: t("japan.j4.title"),
                year: t("japan.j4.year"),
                desc: t("japan.j4.desc"),
              },
            ].map((item, i) => (
              <motion.div
                key={item.title}
                {...stagger(i)}
                className="rounded-2xl bg-white p-6 border border-gray-100 shadow-[0_1px_8px_rgba(0,0,0,0.04)]"
              >
                <div className="flex items-center gap-2 mb-3">
                  <span className="px-2 py-0.5 rounded-md bg-gray-900 text-white text-[10px] font-bold tracking-wider uppercase">
                    {item.tag}
                  </span>
                  <span className="text-[11px] text-gray-400 font-mono">
                    {item.year}
                  </span>
                </div>
                <h3 className="text-base font-black text-gray-900 mb-2">
                  {item.title}
                </h3>
                <p className="text-[13px] text-gray-500 leading-relaxed">
                  {item.desc}
                </p>
              </motion.div>
            ))}
          </div>

          <motion.div
            {...FADE_UP}
            className="mt-10 rounded-2xl bg-gray-900 text-white p-6 sm:p-8"
          >
            <p className="text-[13px] sm:text-sm leading-relaxed text-gray-300">
              <span className="text-white font-bold">
                {t("japan.summary1")}
              </span>
              <br />
              {t("japan.summary2")}
            </p>
          </motion.div>
        </div>
      </section>

      {/* ─── S5. 피켓의 해법 — 4단계 순차 판매 ──────── */}
      <section className="py-20 sm:py-28">
        <div className={W}>
          <motion.div {...FADE_UP} className="mb-14">
            <p className="text-[11px] font-bold tracking-[0.14em] uppercase text-violet-600 dark:text-violet-400 mb-3">
              Pickket&apos;s Solution
            </p>
            <h2
              className="font-black tracking-tight text-gray-900"
              style={{ fontSize: "clamp(1.6rem, 3vw, 2.4rem)" }}
            >
              {t("solution.title")}
            </h2>
            <p className="text-sm text-gray-500 mt-3 max-w-xl">
              {t("solution.subtitle")}
            </p>
          </motion.div>

          {/* Pipeline visual */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              {
                step: "01",
                mode: t("solution.s1.mode"),
                en: "Members Presale",
                color: "bg-violet-500",
                desc: t("solution.s1.desc"),
                diff: t("solution.s1.diff"),
              },
              {
                step: "02",
                mode: t("solution.s2.mode"),
                en: "Fair Lottery",
                color: "bg-indigo-500",
                desc: t("solution.s2.desc"),
                diff: t("solution.s2.diff"),
              },
              {
                step: "03",
                mode: t("solution.s3.mode"),
                en: "Queue Sale",
                color: "bg-emerald-500",
                desc: t("solution.s3.desc"),
                diff: t("solution.s3.diff"),
              },
              {
                step: "04",
                mode: t("solution.s4.mode"),
                en: "First Come First Served",
                color: "bg-gray-400",
                desc: t("solution.s4.desc"),
                diff: t("solution.s4.diff"),
              },
            ].map((item, i) => (
              <motion.div
                key={item.step}
                {...stagger(i)}
                className="relative rounded-2xl border border-gray-100 bg-white p-6 shadow-[0_1px_8px_rgba(0,0,0,0.04)] group hover:border-gray-200 transition-colors"
              >
                {/* Step connector (desktop) */}
                {i < 3 && (
                  <div className="hidden lg:block absolute -right-3 top-1/2 -translate-y-1/2 z-10">
                    <ChevronRight className="h-5 w-5 text-gray-200" />
                  </div>
                )}
                <div className="flex items-center gap-2 mb-4">
                  <span
                    className={`w-7 h-7 rounded-lg ${item.color} text-white text-[11px] font-black flex items-center justify-center`}
                  >
                    {item.step}
                  </span>
                  <span className="text-[10px] font-bold text-gray-300 tracking-wider uppercase">
                    {item.en}
                  </span>
                </div>
                <h3 className="text-[15px] font-black text-gray-900 mb-2">
                  {item.mode}
                </h3>
                <p className="text-[12px] text-gray-500 leading-relaxed mb-3">
                  {item.desc}
                </p>
                <span className="inline-block px-2.5 py-1 rounded-full bg-gray-50 text-[10px] font-bold text-gray-500">
                  {item.diff}
                </span>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── S6. 방어 체계 ─────────────────────────────── */}
      <section className="py-20 sm:py-28 bg-gray-50">
        <div className={W}>
          <motion.div {...FADE_UP} className="mb-14">
            <p className="text-[11px] font-bold tracking-[0.14em] uppercase text-gray-400 mb-3">
              Defense System
            </p>
            <h2
              className="font-black tracking-tight text-gray-900"
              style={{ fontSize: "clamp(1.6rem, 3vw, 2.4rem)" }}
            >
              {t("defense.title")}
            </h2>
          </motion.div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Locked Ticket */}
            <motion.div
              {...stagger(0)}
              className="rounded-2xl bg-gray-900 text-white p-7 sm:p-8"
            >
              <div className="flex items-center gap-3 mb-5">
                <div className="w-10 h-10 rounded-xl bg-white/10 flex items-center justify-center">
                  <Lock className="h-5 w-5 text-red-400" />
                </div>
                <div>
                  <p className="text-[10px] font-bold tracking-[0.14em] text-red-400 uppercase">
                    Locked Ticket
                  </p>
                  <h3 className="text-lg font-black">{t("defense.locked.title")}</h3>
                </div>
              </div>
              <ul className="space-y-3">
                {[
                  t("defense.locked.b1"),
                  t("defense.locked.b2"),
                  t("defense.locked.b3"),
                  t("defense.locked.b4"),
                ].map((text) => (
                  <li
                    key={text}
                    className="flex items-start gap-2 text-[13px] text-gray-300 leading-relaxed"
                  >
                    <span className="text-red-400 shrink-0 mt-0.5">×</span>
                    {text}
                  </li>
                ))}
              </ul>
            </motion.div>

            {/* Fair Resale */}
            <motion.div
              {...stagger(1)}
              className="rounded-2xl bg-white border border-gray-100 p-7 sm:p-8 shadow-[0_1px_8px_rgba(0,0,0,0.04)]"
            >
              <div className="flex items-center gap-3 mb-5">
                <div className="w-10 h-10 rounded-xl bg-emerald-50 flex items-center justify-center">
                  <RotateCcw className="h-5 w-5 text-emerald-500" />
                </div>
                <div>
                  <p className="text-[10px] font-bold tracking-[0.14em] text-emerald-500 uppercase">
                    Face-Value Waitlist
                  </p>
                  <h3 className="text-lg font-black text-gray-900">
                    {t("defense.resale.title")}
                  </h3>
                </div>
              </div>
              <ul className="space-y-3">
                {[
                  t("defense.resale.b1"),
                  t("defense.resale.b2"),
                  t("defense.resale.b3"),
                  t("defense.resale.b4"),
                ].map((text) => (
                  <li
                    key={text}
                    className="flex items-start gap-2 text-[13px] text-gray-500 leading-relaxed"
                  >
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0 mt-0.5" />
                    {text}
                  </li>
                ))}
              </ul>
            </motion.div>
          </div>
        </div>
      </section>

      {/* ─── S7. 리세일 시장의 미래 ────────────────────── */}
      <section className="py-20 sm:py-28">
        <div className={W}>
          <motion.div {...FADE_UP} className="mb-14">
            <p className="text-[11px] font-bold tracking-[0.14em] uppercase text-violet-600 dark:text-violet-400 mb-3">
              Resale Market Future
            </p>
            <h2
              className="font-black tracking-tight text-gray-900"
              style={{ fontSize: "clamp(1.6rem, 3vw, 2.4rem)" }}
            >
              {t("resale.title1")}
              <br />
              {t("resale.title2")}
            </h2>
          </motion.div>

          {/* Why legalization is needed */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-10">
            {[
              {
                title: t("resale.r1.title"),
                desc: t("resale.r1.desc"),
              },
              {
                title: t("resale.r2.title"),
                desc: t("resale.r2.desc"),
              },
              {
                title: t("resale.r3.title"),
                desc: t("resale.r3.desc"),
              },
            ].map((item, i) => (
              <motion.div
                key={item.title}
                {...stagger(i)}
                className="rounded-2xl border border-gray-100 bg-white p-6 shadow-[0_1px_8px_rgba(0,0,0,0.04)]"
              >
                <h3 className="text-[15px] font-black text-gray-900 mb-2">
                  {item.title}
                </h3>
                <p className="text-[13px] text-gray-500 leading-relaxed">
                  {item.desc}
                </p>
              </motion.div>
            ))}
          </div>

          {/* If not legalized — who benefits? */}
          <motion.div {...FADE_UP}>
            <h3 className="text-sm font-black text-gray-900 mb-5">
              {t("resale.scenarioHeading")}
            </h3>
            <div className="space-y-3">
              {[
                {
                  scenario: t("resale.sc1.scenario"),
                  result: t("resale.sc1.result"),
                  bad: true,
                },
                {
                  scenario: t("resale.sc2.scenario"),
                  result: t("resale.sc2.result"),
                  bad: true,
                },
                {
                  scenario: t("resale.sc3.scenario"),
                  result: t("resale.sc3.result"),
                  bad: false,
                },
              ].map((item, i) => (
                <motion.div
                  key={item.scenario}
                  {...stagger(i)}
                  className={`rounded-xl p-5 flex flex-col sm:flex-row sm:items-center gap-3 ${
                    item.bad
                      ? "bg-red-50/60 border border-red-100"
                      : "bg-emerald-50/60 border border-emerald-100"
                  }`}
                >
                  <div className="flex items-center gap-2 sm:w-44 shrink-0">
                    {item.bad ? (
                      <XCircle className="h-4 w-4 text-red-400 shrink-0" />
                    ) : (
                      <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                    )}
                    <span className="text-[13px] font-black text-gray-900">
                      {item.scenario}
                    </span>
                  </div>
                  <p className="text-[13px] text-gray-500 leading-relaxed flex-1">
                    {item.result}
                  </p>
                </motion.div>
              ))}
            </div>
          </motion.div>

          {/* Key message */}
          <motion.div
            {...FADE_UP}
            className="mt-10 rounded-2xl bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 text-white p-8 sm:p-10 text-center"
          >
            <p
              className="font-black leading-snug mb-3"
              style={{ fontSize: "clamp(1.1rem, 2vw, 1.5rem)" }}
            >
              {t("resale.keyMsg1")}
            </p>
            <p className="text-gray-400 text-[13px] sm:text-sm max-w-lg mx-auto leading-relaxed">
              {t("resale.keyMsg2")}
              <br />
              {t("resale.keyMsg3")}
            </p>
          </motion.div>
        </div>
      </section>

      {/* ─── S7.5. 두 제품 라인업 ──────────────────────── */}
      <section className="py-20 sm:py-28 bg-gray-50">
        <div className={W}>
          <motion.div {...FADE_UP} className="mb-14">
            <p className="text-[11px] font-bold tracking-[0.14em] uppercase text-violet-600 dark:text-violet-400 mb-3">
              Two Product Lines
            </p>
            <h2
              className="font-black tracking-tight text-gray-900"
              style={{ fontSize: "clamp(1.6rem, 3vw, 2.4rem)" }}
            >
              {t("products.title1")}
              <br />{t("products.title2")}
            </h2>
            <p className="text-sm text-gray-500 mt-3 max-w-xl">
              {t("products.subtitle")}
            </p>
          </motion.div>

          {/* Product cards with screenshots */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-12">
            {/* Pickket Consumer */}
            <motion.div
              {...stagger(0)}
              className="rounded-2xl bg-white border border-gray-100 overflow-hidden shadow-[0_2px_20px_rgba(0,0,0,0.06)]"
            >
              <div className="relative aspect-[16/10] overflow-hidden bg-gray-900">
                <Image
                  src="/images/about/consumer-hero.png"
                  alt={t("products.consumer.imgAlt")}
                  fill
                  className="object-cover object-top opacity-90"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-gray-900/80 via-transparent to-transparent" />
                <div className="absolute bottom-4 left-5">
                  <span className="px-2.5 py-1 rounded-lg bg-white/15 backdrop-blur-sm text-white text-[11px] font-bold tracking-wider">
                    pickket.kr
                  </span>
                </div>
              </div>
              <div className="p-6">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-9 h-9 rounded-xl bg-violet-50 flex items-center justify-center">
                    <Users className="h-4.5 w-4.5 text-violet-600 dark:text-violet-400" />
                  </div>
                  <div>
                    <h3 className="text-lg font-black text-gray-900">
                      Pickket
                    </h3>
                    <p className="text-[11px] text-gray-400 font-medium">
                      {t("products.consumer.label")}
                    </p>
                  </div>
                </div>
                <p className="text-[13px] text-gray-500 leading-relaxed mb-4">
                  {t("products.consumer.desc")}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {[
                    t("products.consumer.tag1"),
                    t("products.consumer.tag2"),
                    t("products.consumer.tag3"),
                    t("products.consumer.tag4"),
                    t("products.consumer.tag5"),
                  ].map((tag) => (
                    <span
                      key={tag}
                      className="px-2 py-0.5 rounded-md bg-violet-50 text-violet-600 text-[10px] font-bold"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            </motion.div>

            {/* Pickket Studio (Go) */}
            <motion.div
              {...stagger(1)}
              className="rounded-2xl bg-white border border-gray-100 overflow-hidden shadow-[0_2px_20px_rgba(0,0,0,0.06)]"
            >
              <div className="relative aspect-[16/10] overflow-hidden bg-[#0f1117]">
                <Image
                  src="/images/about/studio-dashboard.png"
                  alt={t("products.studio.imgAlt")}
                  fill
                  className="object-cover object-top opacity-90"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-[#0f1117]/80 via-transparent to-transparent" />
                <div className="absolute bottom-4 left-5">
                  <span className="px-2.5 py-1 rounded-lg bg-white/15 backdrop-blur-sm text-white text-[11px] font-bold tracking-wider">
                    go.pickket.kr
                  </span>
                </div>
              </div>
              <div className="p-6">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-9 h-9 rounded-xl bg-indigo-50 flex items-center justify-center">
                    <TrendingUp className="h-4.5 w-4.5 text-indigo-500" />
                  </div>
                  <div>
                    <h3 className="text-lg font-black text-gray-900">
                      Pickket Studio
                    </h3>
                    <p className="text-[11px] text-gray-400 font-medium">
                      {t("products.studio.label")}
                    </p>
                  </div>
                </div>
                <p className="text-[13px] text-gray-500 leading-relaxed mb-4">
                  {t("products.studio.desc")}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {[
                    t("products.studio.tag1"),
                    t("products.studio.tag2"),
                    t("products.studio.tag3"),
                    t("products.studio.tag4"),
                    t("products.studio.tag5"),
                  ].map((tag) => (
                    <span
                      key={tag}
                      className="px-2 py-0.5 rounded-md bg-indigo-50 text-indigo-500 text-[10px] font-bold"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            </motion.div>
          </div>

          {/* Synergy diagram */}
          <motion.div
            {...FADE_UP}
            className="rounded-2xl bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 p-8 sm:p-10"
          >
            <h3 className="text-base font-black text-white mb-6 text-center">
              {t("products.synergy.heading")}
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-5 items-center">
              {/* Left - Consumer */}
              <div className="text-center">
                <div className="w-12 h-12 rounded-2xl bg-violet-500/20 flex items-center justify-center mx-auto mb-3">
                  <Users className="h-5 w-5 text-violet-300" />
                </div>
                <p className="text-sm font-black text-white mb-1">Pickket</p>
                <p className="text-[11px] text-gray-400">{t("products.synergy.consumerLabel")}</p>
              </div>

              {/* Center - Synergy arrows */}
              <div className="space-y-3">
                {[
                  {
                    left: t("products.synergy.row1Left"),
                    right: t("products.synergy.row1Right"),
                    dir: "→",
                  },
                  {
                    left: t("products.synergy.row2Left"),
                    right: t("products.synergy.row2Right"),
                    dir: "←",
                  },
                  {
                    left: t("products.synergy.row3Left"),
                    right: t("products.synergy.row3Right"),
                    dir: "↔",
                  },
                  {
                    left: t("products.synergy.row4Left"),
                    right: t("products.synergy.row4Right"),
                    dir: "↔",
                  },
                ].map((row) => (
                  <div
                    key={row.left}
                    className="flex items-center gap-2 text-[11px]"
                  >
                    <span className="flex-1 text-right text-violet-300 font-medium truncate">
                      {row.left}
                    </span>
                    <span className="text-gray-500 font-mono text-xs shrink-0 w-5 text-center">
                      {row.dir}
                    </span>
                    <span className="flex-1 text-left text-indigo-300 font-medium truncate">
                      {row.right}
                    </span>
                  </div>
                ))}
              </div>

              {/* Right - Studio */}
              <div className="text-center">
                <div className="w-12 h-12 rounded-2xl bg-indigo-500/20 flex items-center justify-center mx-auto mb-3">
                  <TrendingUp className="h-5 w-5 text-indigo-300" />
                </div>
                <p className="text-sm font-black text-white mb-1">Studio</p>
                <p className="text-[11px] text-gray-400">{t("products.synergy.studioLabel")}</p>
              </div>
            </div>

            <p className="text-[12px] text-gray-500 text-center mt-6 max-w-lg mx-auto leading-relaxed">
              {t("products.synergy.flywheel")}
            </p>
          </motion.div>
        </div>
      </section>

      {/* ─── S8. 3개년 성장 로드맵 ─────────────────────── */}
      <section className="py-20 sm:py-28 bg-gray-50">
        <div className={W}>
          <motion.div {...FADE_UP} className="mb-14">
            <p className="text-[11px] font-bold tracking-[0.14em] uppercase text-violet-600 dark:text-violet-400 mb-3">
              Growth Roadmap
            </p>
            <h2
              className="font-black tracking-tight text-gray-900"
              style={{ fontSize: "clamp(1.6rem, 3vw, 2.4rem)" }}
            >
              {t("roadmap.title")}
            </h2>
          </motion.div>

          {/* Year cards */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 mb-10">
            {[
              {
                year: "2026",
                label: t("roadmap.y1.label"),
                phase: t("roadmap.y1.phase"),
                color: "border-violet-200",
                accent: "text-violet-600 dark:text-violet-400",
                bg: "bg-violet-50",
                metrics: [
                  { label: t("roadmap.metricOrganizers"), value: t("roadmap.y1.mv1") },
                  { label: t("roadmap.metricMAU"), value: t("roadmap.y1.mv2") },
                  { label: t("roadmap.metricGMV"), value: t("roadmap.y1.mv3") },
                  { label: t("roadmap.metricRevenue"), value: t("roadmap.y1.mv4") },
                ],
                milestones: [
                  t("roadmap.y1.ms1"),
                  t("roadmap.y1.ms2"),
                  t("roadmap.y1.ms3"),
                ],
                status: t("roadmap.y1.status"),
              },
              {
                year: "2027",
                label: t("roadmap.y2.label"),
                phase: t("roadmap.y2.phase"),
                color: "border-indigo-200",
                accent: "text-indigo-500",
                bg: "bg-indigo-50",
                metrics: [
                  { label: t("roadmap.metricOrganizers"), value: t("roadmap.y2.mv1") },
                  { label: t("roadmap.metricMAU"), value: t("roadmap.y2.mv2") },
                  { label: t("roadmap.metricGMV"), value: t("roadmap.y2.mv3") },
                  { label: t("roadmap.metricRevenue"), value: t("roadmap.y2.mv4") },
                ],
                milestones: [
                  t("roadmap.y2.ms1"),
                  t("roadmap.y2.ms2"),
                  t("roadmap.y2.ms3"),
                ],
                status: t("roadmap.y2.status"),
              },
              {
                year: "2028",
                label: t("roadmap.y3.label"),
                phase: t("roadmap.y3.phase"),
                color: "border-emerald-200",
                accent: "text-emerald-500",
                bg: "bg-emerald-50",
                metrics: [
                  { label: t("roadmap.metricOrganizers"), value: t("roadmap.y3.mv1") },
                  { label: t("roadmap.metricMAU"), value: t("roadmap.y3.mv2") },
                  { label: t("roadmap.metricGMV"), value: t("roadmap.y3.mv3") },
                  { label: t("roadmap.metricRevenue"), value: t("roadmap.y3.mv4") },
                ],
                milestones: [
                  t("roadmap.y3.ms1"),
                  t("roadmap.y3.ms2"),
                  t("roadmap.y3.ms3"),
                ],
                status: t("roadmap.y3.status"),
              },
            ].map((yr, i) => (
              <motion.div
                key={yr.year}
                {...stagger(i)}
                className={`rounded-2xl bg-white border ${yr.color} p-6 sm:p-7 shadow-[0_1px_8px_rgba(0,0,0,0.04)]`}
              >
                {/* Header */}
                <div className="flex items-center gap-3 mb-5">
                  <span
                    className={`px-2.5 py-1 rounded-lg ${yr.bg} ${yr.accent} text-[11px] font-black tracking-wider`}
                  >
                    {yr.label}
                  </span>
                  <span className="text-2xl font-black text-gray-900 font-mono">
                    {yr.year}
                  </span>
                </div>
                <p className="text-[13px] font-bold text-gray-900 mb-4">
                  {yr.phase}
                </p>

                {/* Metrics grid */}
                <div className="grid grid-cols-2 gap-2 mb-5">
                  {yr.metrics.map((m) => (
                    <div
                      key={m.label}
                      className="rounded-lg bg-gray-50 px-3 py-2.5 text-center"
                    >
                      <p className="text-[15px] font-black text-gray-900 font-mono">
                        {m.value}
                      </p>
                      <p className="text-[10px] text-gray-400 font-medium">
                        {m.label}
                      </p>
                    </div>
                  ))}
                </div>

                {/* Milestones */}
                <ul className="space-y-2 mb-4">
                  {yr.milestones.map((ms) => (
                    <li
                      key={ms}
                      className="flex items-start gap-2 text-[12px] text-gray-500 leading-relaxed"
                    >
                      <span className={`${yr.accent} shrink-0 mt-0.5`}>·</span>
                      {ms}
                    </li>
                  ))}
                </ul>

                {/* Status badge */}
                <div
                  className={`inline-block px-3 py-1.5 rounded-full ${yr.bg} text-[11px] font-bold ${yr.accent}`}
                >
                  {yr.status}
                </div>
              </motion.div>
            ))}
          </div>

          {/* Revenue structure evolution */}
          <motion.div {...FADE_UP}>
            <h3 className="text-sm font-black text-gray-900 mb-5">
              {t("roadmap.revenueHeading")}
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {[
                {
                  year: t("roadmap.y1.label"),
                  items: [
                    { label: t("roadmap.rev.booking"), pct: "75%", w: "w-3/4" },
                    { label: t("roadmap.rev.orgSub"), pct: "25%", w: "w-1/4" },
                  ],
                },
                {
                  year: t("roadmap.y2.label"),
                  items: [
                    { label: t("roadmap.rev.booking"), pct: "50%", w: "w-1/2" },
                    { label: t("roadmap.rev.resale"), pct: "20%", w: "w-1/5" },
                    { label: t("roadmap.rev.orgSub"), pct: "20%", w: "w-1/5" },
                    { label: t("roadmap.rev.addOn"), pct: "10%", w: "w-[10%]" },
                  ],
                },
                {
                  year: t("roadmap.y3.label"),
                  items: [
                    { label: t("roadmap.rev.booking"), pct: "35%", w: "w-[35%]" },
                    { label: t("roadmap.rev.resale"), pct: "30%", w: "w-[30%]" },
                    { label: t("roadmap.rev.orgSub"), pct: "15%", w: "w-[15%]" },
                    { label: t("roadmap.rev.addOn"), pct: "20%", w: "w-1/5" },
                  ],
                },
              ].map((col) => (
                <div
                  key={col.year}
                  className="rounded-xl bg-white border border-gray-100 p-5"
                >
                  <p className="text-[11px] font-black text-gray-400 mb-3">
                    {col.year}
                  </p>
                  <div className="space-y-2">
                    {col.items.map((item) => (
                      <div key={item.label}>
                        <div className="flex justify-between text-[11px] mb-1">
                          <span className="text-gray-500">{item.label}</span>
                          <span className="font-bold text-gray-900 font-mono">
                            {item.pct}
                          </span>
                        </div>
                        <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                          <div
                            className={`h-full bg-violet-400 rounded-full ${item.w}`}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        </div>
      </section>

      {/* ─── S8.5. 한경미디어그룹 시너지 ─────────────── */}
      <section className="py-20 sm:py-28">
        <div className={W}>
          <motion.div {...FADE_UP} className="mb-14">
            <p className="text-[11px] font-bold tracking-[0.14em] uppercase text-gray-400 mb-3">
              Strategic Partnership
            </p>
            <h2
              className="font-black tracking-tight text-gray-900"
              style={{ fontSize: "clamp(1.6rem, 3vw, 2.4rem)" }}
            >
              {t("partner.title")}
              <br />× Pickket
            </h2>
            <p className="text-sm text-gray-500 mt-3 max-w-xl">
              {t("partner.subtitle")}
            </p>
          </motion.div>

          {/* Three-way synergy cards */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 mb-10">
            {/* 한경TV */}
            <motion.div
              {...stagger(0)}
              className="rounded-2xl bg-white border border-gray-100 p-6 sm:p-7 shadow-[0_1px_8px_rgba(0,0,0,0.04)]"
            >
              <div className="flex items-center gap-3 mb-5">
                <div className="w-10 h-10 rounded-xl bg-amber-50 flex items-center justify-center">
                  <Globe className="h-5 w-5 text-amber-500" />
                </div>
                <div>
                  <h3 className="text-[15px] font-black text-gray-900">
                    {t("partner.hktv.name")}
                  </h3>
                  <p className="text-[10px] font-bold text-amber-500 tracking-wide uppercase">
                    {t("partner.hktv.label")}
                  </p>
                </div>
              </div>
              <p className="text-[13px] text-gray-500 leading-relaxed mb-4">
                {t("partner.hktv.desc1")}{" "}
                <span className="text-gray-900 font-bold">
                  {t("partner.hktv.desc2")}
                </span>
                {t("partner.hktv.desc3")}
              </p>
              <ul className="space-y-2">
                {[
                  t("partner.hktv.b1"),
                  t("partner.hktv.b2"),
                  t("partner.hktv.b3"),
                ].map((text) => (
                  <li
                    key={text}
                    className="flex items-start gap-2 text-[12px] text-gray-500 leading-relaxed"
                  >
                    <span className="text-amber-400 shrink-0 mt-0.5">·</span>
                    {text}
                  </li>
                ))}
              </ul>
            </motion.div>

            {/* Pickket */}
            <motion.div
              {...stagger(1)}
              className="rounded-2xl bg-gray-900 text-white p-6 sm:p-7"
            >
              <div className="flex items-center gap-3 mb-5">
                <div className="w-10 h-10 rounded-xl bg-violet-500/20 flex items-center justify-center">
                  <Shield className="h-5 w-5 text-violet-300" />
                </div>
                <div>
                  <h3 className="text-[15px] font-black text-white">Pickket</h3>
                  <p className="text-[10px] font-bold text-violet-300 tracking-wide uppercase">
                    {t("partner.pickket.label")}
                  </p>
                </div>
              </div>
              <p className="text-[13px] text-gray-300 leading-relaxed mb-4">
                {t("partner.pickket.desc")}
              </p>
              <ul className="space-y-2">
                {[
                  t("partner.pickket.b1"),
                  t("partner.pickket.b2"),
                  t("partner.pickket.b3"),
                ].map((text) => (
                  <li
                    key={text}
                    className="flex items-start gap-2 text-[12px] text-gray-400 leading-relaxed"
                  >
                    <span className="text-violet-400 shrink-0 mt-0.5">·</span>
                    {text}
                  </li>
                ))}
              </ul>
            </motion.div>

            {/* 텐아시아 */}
            <motion.div
              {...stagger(2)}
              className="rounded-2xl bg-white border border-gray-100 p-6 sm:p-7 shadow-[0_1px_8px_rgba(0,0,0,0.04)]"
            >
              <div className="flex items-center gap-3 mb-5">
                <div className="w-10 h-10 rounded-xl bg-rose-50 flex items-center justify-center">
                  <TrendingUp className="h-5 w-5 text-rose-500" />
                </div>
                <div>
                  <h3 className="text-[15px] font-black text-gray-900">
                    {t("partner.ten.name")}
                  </h3>
                  <p className="text-[10px] font-bold text-rose-500 tracking-wide uppercase">
                    {t("partner.ten.label")}
                  </p>
                </div>
              </div>
              <p className="text-[13px] text-gray-500 leading-relaxed mb-4">
                {t("partner.ten.desc1")}{" "}
                <span className="text-gray-900 font-bold">{t("partner.ten.desc2")}</span>
                {t("partner.ten.desc3")}
              </p>
              <ul className="space-y-2">
                {[
                  t("partner.ten.b1"),
                  t("partner.ten.b2"),
                  t("partner.ten.b3"),
                ].map((text) => (
                  <li
                    key={text}
                    className="flex items-start gap-2 text-[12px] text-gray-500 leading-relaxed"
                  >
                    <span className="text-rose-400 shrink-0 mt-0.5">·</span>
                    {text}
                  </li>
                ))}
              </ul>
            </motion.div>
          </div>

          {/* Triangular flywheel */}
          <motion.div
            {...FADE_UP}
            className="rounded-2xl bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 p-8 sm:p-10"
          >
            <h3 className="text-base font-black text-white mb-8 text-center">
              {t("partner.flywheel.heading")}
            </h3>

            {/* Flywheel cycle */}
            <div className="max-w-2xl mx-auto">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 items-center mb-8">
                {/* 텐아시아 */}
                <div className="text-center">
                  <div className="w-14 h-14 rounded-2xl bg-rose-500/15 flex items-center justify-center mx-auto mb-2">
                    <TrendingUp className="h-6 w-6 text-rose-300" />
                  </div>
                  <p className="text-sm font-black text-white">{t("partner.ten.name")}</p>
                  <p className="text-[10px] text-gray-500">{t("partner.flywheel.tenLabel")}</p>
                </div>

                {/* Pickket */}
                <div className="text-center">
                  <div className="w-14 h-14 rounded-2xl bg-violet-500/15 flex items-center justify-center mx-auto mb-2">
                    <Shield className="h-6 w-6 text-violet-300" />
                  </div>
                  <p className="text-sm font-black text-white">Pickket</p>
                  <p className="text-[10px] text-gray-500">{t("partner.flywheel.pickketLabel")}</p>
                </div>

                {/* 한경TV */}
                <div className="text-center">
                  <div className="w-14 h-14 rounded-2xl bg-amber-500/15 flex items-center justify-center mx-auto mb-2">
                    <Globe className="h-6 w-6 text-amber-300" />
                  </div>
                  <p className="text-sm font-black text-white">{t("partner.hktv.name")}</p>
                  <p className="text-[10px] text-gray-500">{t("partner.flywheel.hktvLabel")}</p>
                </div>
              </div>

              {/* Cycle flow */}
              <div className="space-y-2.5">
                {[
                  {
                    from: t("partner.ten.name"),
                    arrow: "→",
                    to: "Pickket",
                    desc: t("partner.flywheel.flow1"),
                    fromColor: "text-rose-300",
                    toColor: "text-violet-300",
                  },
                  {
                    from: "Pickket",
                    arrow: "→",
                    to: t("partner.hktv.name"),
                    desc: t("partner.flywheel.flow2"),
                    fromColor: "text-violet-300",
                    toColor: "text-amber-300",
                  },
                  {
                    from: t("partner.hktv.name"),
                    arrow: "→",
                    to: t("partner.ten.name"),
                    desc: t("partner.flywheel.flow3"),
                    fromColor: "text-amber-300",
                    toColor: "text-rose-300",
                  },
                ].map((flow) => (
                  <div
                    key={flow.from + flow.to}
                    className="flex items-center gap-3 rounded-xl bg-white/5 px-5 py-3"
                  >
                    <span
                      className={`text-[13px] font-black ${flow.fromColor} w-16 shrink-0 text-right`}
                    >
                      {flow.from}
                    </span>
                    <span className="text-gray-500 font-mono text-xs">
                      {flow.arrow}
                    </span>
                    <span
                      className={`text-[13px] font-black ${flow.toColor} w-16 shrink-0`}
                    >
                      {flow.to}
                    </span>
                    <span className="text-[12px] text-gray-400 leading-relaxed flex-1">
                      {flow.desc}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <p className="text-[12px] text-gray-500 text-center mt-8 max-w-lg mx-auto leading-relaxed">
              {t("partner.flywheel.summary1")}
              <br />
              <span className="text-gray-300 font-bold">
                {t("partner.flywheel.summary2")}
              </span>
            </p>
          </motion.div>
        </div>
      </section>

      {/* ─── S9. CTA ───────────────────────────────────── */}
      <section className="py-24 sm:py-32">
        <div className={W}>
          <motion.div
            {...FADE_UP}
            className="rounded-2xl bg-gradient-to-br from-gray-900 via-[#2A3A9E] to-gray-800 p-10 sm:p-16 text-center"
          >
            <div className="w-14 h-14 rounded-2xl bg-white/10 flex items-center justify-center mx-auto mb-6">
              <Shield className="h-7 w-7 text-emerald-300" />
            </div>
            <h2
              className="font-black text-white leading-tight mb-4"
              style={{ fontSize: "clamp(1.4rem, 3vw, 2rem)" }}
            >
              {t("cta.title1")}
              <br />
              {t("cta.title2")}
            </h2>
            <p className="text-gray-400 text-[13px] sm:text-sm mb-8 max-w-md mx-auto">
              {t("cta.desc")}
            </p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <Link
                href="/events"
                className="inline-flex items-center justify-center gap-2 px-7 py-3 rounded-full bg-white text-gray-900 font-bold text-sm hover:bg-gray-100 transition-colors"
              >
                {t("cta.browseEvents")}
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="/for-organizers"
                className="inline-flex items-center justify-center gap-2 px-7 py-3 rounded-full border border-white/20 text-white font-semibold text-sm hover:bg-white/10 transition-colors"
              >
                {t("cta.forOrganizers")}
              </Link>
            </div>
          </motion.div>
        </div>
      </section>
    </div>
  );
}
