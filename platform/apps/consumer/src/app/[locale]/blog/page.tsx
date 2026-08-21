"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import FormulaAnimation from "@/components/blog/FormulaAnimation";

/* ── Math block component ────────────────────────────────────────── */
function Math({ children }: { children: React.ReactNode }) {
  return (
    <div className="my-4 px-5 py-4 rounded-xl bg-[#0F1629] text-[#E8ECF8] font-mono text-sm leading-relaxed overflow-x-auto">
      {children}
    </div>
  );
}

function Keyword({ children }: { children: React.ReactNode }) {
  return <span className="text-cyan font-semibold">{children}</span>;
}

function Accent({ children }: { children: React.ReactNode }) {
  return <span className="text-[#7B8CDE]">{children}</span>;
}

/* ── Inline metric card ──────────────────────────────────────────── */
function MetricCard({
  value,
  label,
  accent,
}: {
  value: string;
  label: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-xl px-5 py-4 text-center ${
        accent
          ? "bg-gradient-to-br from-[#0a0a0a] to-[#404040] text-white"
          : "bg-surface-dim text-foreground"
      }`}
    >
      <p
        className={`text-2xl font-bold font-mono ${accent ? "text-white" : "text-primary"}`}
      >
        {value}
      </p>
      <p
        className={`text-xs mt-1 ${accent ? "text-white/70" : "text-muted-foreground"}`}
      >
        {label}
      </p>
    </div>
  );
}

/* ── Section wrapper ─────────────────────────────────────────────── */
function ArticleSection({
  id,
  badge,
  title,
  subtitle,
  children,
}: {
  id: string;
  badge: string;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      className="scroll-mt-24 py-16 border-b border-border last:border-b-0"
    >
      <div className="max-w-4xl mx-auto px-6">
        <span className="inline-flex items-center px-3 py-1 rounded-full bg-primary/10 text-primary text-xs font-semibold mb-4">
          {badge}
        </span>
        <h2 className="text-2xl md:text-3xl font-bold text-foreground mb-2">
          {title}
        </h2>
        <p className="text-muted-foreground text-sm mb-8 max-w-2xl">
          {subtitle}
        </p>
        <div className="text-sm leading-relaxed text-foreground">
          {children}
        </div>
      </div>
    </section>
  );
}

/* ══════════════════════════════════════════════════════════════════
   Blog Page
   ══════════════════════════════════════════════════════════════════ */

export default function BlogPage() {
  const t = useTranslations("blog");
  const [activeNav, setActiveNav] = useState<string | null>(null);

  const ARTICLES = [
    { id: "lottery", label: t("tab_lottery") },
    { id: "fan-weight", label: t("tab_fan_weight") },
    { id: "batch", label: t("tab_batch") },
    { id: "fairness", label: t("tab_fairness") },
    { id: "resale", label: t("tab_resale") },
    { id: "concert-index", label: t("tab_concert_index") },
    { id: "compliance", label: t("tab_compliance") },
  ] as const;

  return (
    <div className="bg-background min-h-screen pt-20">
      {/* ─── Hero ─────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden bg-gradient-to-br from-[#0F1629] via-[#0a0a0a] to-[#404040] text-white">
        <div className="absolute inset-0">
          {/* Grid pattern */}
          <svg
            className="w-full h-full opacity-[0.06]"
            xmlns="http://www.w3.org/2000/svg"
          >
            <defs>
              <pattern
                id="grid"
                width="40"
                height="40"
                patternUnits="userSpaceOnUse"
              >
                <path
                  d="M 40 0 L 0 0 0 40"
                  fill="none"
                  stroke="white"
                  strokeWidth="0.5"
                />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#grid)" />
          </svg>
        </div>
        <div className="max-w-4xl mx-auto px-6 py-20 md:py-28 relative z-10">
          <div className="flex items-center gap-2 mb-6">
            <div className="h-8 w-8 rounded-lg bg-white/10 backdrop-blur-sm flex items-center justify-center">
              <svg
                className="h-4 w-4 text-cyan"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
              </svg>
            </div>
            <span className="text-sm font-medium text-white/60">
              Pickket Tech
            </span>
          </div>
          <h1 className="text-4xl md:text-5xl font-extrabold tracking-tight leading-tight mb-5">
            {t("hero_title_line1")}
            <br />
            <span className="text-cyan">{t("hero_title_line2")}</span>
          </h1>
          <p className="text-base md:text-lg text-white/70 max-w-xl leading-relaxed mb-10">
            {t("hero_description")}
          </p>

          {/* RISE Engine solver animation */}
          <div className="mb-10">
            <FormulaAnimation />
          </div>

          {/* Hero metrics */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="rounded-xl bg-white/10 backdrop-blur-sm px-4 py-3 text-center">
              <p className="text-xl font-bold font-mono text-cyan">
                {t("hero_metric1_value")}
              </p>
              <p className="text-xs-plus text-white/50 mt-0.5">
                {t("hero_metric1_label")}
              </p>
            </div>
            <div className="rounded-xl bg-white/10 backdrop-blur-sm px-4 py-3 text-center">
              <p className="text-xl font-bold font-mono text-cyan">
                O(N log N)
              </p>
              <p className="text-xs-plus text-white/50 mt-0.5">
                {t("hero_metric2_label")}
              </p>
            </div>
            <div className="rounded-xl bg-white/10 backdrop-blur-sm px-4 py-3 text-center">
              <p className="text-xl font-bold font-mono text-cyan">5D</p>
              <p className="text-xs-plus text-white/50 mt-0.5">
                {t("hero_metric3_label")}
              </p>
            </div>
            <div className="rounded-xl bg-white/10 backdrop-blur-sm px-4 py-3 text-center">
              <p className="text-xl font-bold font-mono text-cyan">298</p>
              <p className="text-xs-plus text-white/50 mt-0.5">
                {t("hero_metric4_label")}
              </p>
            </div>
          </div>
        </div>
        {/* Wave */}
        <div className="absolute bottom-0 left-0 right-0">
          <svg viewBox="0 0 1440 60" fill="none" className="w-full block">
            <path
              d="M0 60V30C240 0 480 0 720 30C960 60 1200 60 1440 30V60H0Z"
              className="fill-background"
            />
          </svg>
        </div>
      </section>

      {/* ─── Sticky nav ──────────────────────────────────────────── */}
      <nav className="sticky top-0 z-30 bg-background/90 backdrop-blur-md border-b border-border">
        <div className="max-w-4xl mx-auto px-6">
          <div className="flex gap-1 overflow-x-auto py-3 scrollbar-hide">
            {ARTICLES.map((a) => (
              <a
                key={a.id}
                href={`#${a.id}`}
                onClick={() => setActiveNav(a.id)}
                className={`shrink-0 px-4 py-1.5 rounded-full text-sm font-medium transition-all duration-200 ${
                  activeNav === a.id
                    ? "bg-primary text-white"
                    : "text-muted-foreground hover:bg-muted"
                }`}
              >
                {a.label}
              </a>
            ))}
          </div>
        </div>
      </nav>

      {/* ═══════════════════════════════════════════════════════════
         Article 1 — Point Weighted Lottery Mechanism
         ═══════════════════════════════════════════════════════════ */}
      <ArticleSection
        id="lottery"
        badge="Core Mechanism"
        title={t("lottery_title")}
        subtitle={t("lottery_subtitle")}
      >
        <h3 className="text-lg font-bold text-foreground mb-3">
          {t("lottery_section1_title")}
        </h3>
        <p className="mb-4">{t("lottery_section1_p1")}</p>

        <h3 className="text-lg font-bold text-foreground mb-3">
          {t("lottery_section2_title")}
        </h3>
        <p className="mb-2">{t("lottery_section2_p1")}</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
          <div className="rounded-lg bg-surface-dim p-4 text-sm">
            <p className="font-semibold text-foreground mb-1">
              {t("lottery_lp_title")}
            </p>
            <p className="text-muted-foreground">{t("lottery_lp_desc")}</p>
          </div>
          <div className="rounded-lg bg-surface-dim p-4 text-sm">
            <p className="font-semibold text-foreground mb-1">
              {t("lottery_ap_title")}
            </p>
            <p className="text-muted-foreground">{t("lottery_ap_desc")}</p>
          </div>
        </div>

        <h3 className="text-lg font-bold text-foreground mb-3">
          {t("lottery_section3_title")}
        </h3>
        <p className="mb-2">{t("lottery_section3_p1")}</p>
        <Math>
          <Keyword>
            P({t("lottery_math_win")}
            <sub>i</sub>)
          </Keyword>{" "}
          = ( w<sub>i</sub> &times; AP<sub>i</sub> ) / <Accent>{"Σ"}</Accent> (
          w<sub>j</sub> &times; AP<sub>j</sub> ){"  "}
          &times; K
        </Math>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
          <div className="rounded-lg bg-surface-dim p-4 text-sm">
            <p className="font-semibold text-foreground mb-1">
              w<sub>i</sub> — {t("lottery_wi_title")}
            </p>
            <p className="text-muted-foreground">{t("lottery_wi_desc")}</p>
          </div>
          <div className="rounded-lg bg-surface-dim p-4 text-sm">
            <p className="font-semibold text-foreground mb-1">
              AP<sub>i</sub> — {t("lottery_api_title")}
            </p>
            <p className="text-muted-foreground">{t("lottery_api_desc")}</p>
          </div>
        </div>

        <h3 className="text-lg font-bold text-foreground mb-3">
          {t("lottery_section4_title")}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <div className="rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] dark:shadow-[0_2px_16px_rgba(0,0,0,0.3)] bg-card p-5 hover:shadow-lg transition-shadow">
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center mb-3">
              <svg
                className="h-5 w-5 text-primary"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                <path d="M9 12l2 2 4-4" />
              </svg>
            </div>
            <h4 className="font-bold text-foreground text-sm mb-1">
              {t("lottery_guarantee1_title")}
            </h4>
            <p className="text-xs text-muted-foreground">
              {t("lottery_guarantee1_desc")}
            </p>
          </div>
          <div className="rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] dark:shadow-[0_2px_16px_rgba(0,0,0,0.3)] bg-card p-5 hover:shadow-lg transition-shadow">
            <div className="w-10 h-10 rounded-xl bg-cyan/10 flex items-center justify-center mb-3">
              <svg
                className="h-5 w-5 text-cyan"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <circle cx="12" cy="12" r="10" />
                <path d="M8 14s1.5 2 4 2 4-2 4-2" />
                <line x1="9" y1="9" x2="9.01" y2="9" />
                <line x1="15" y1="9" x2="15.01" y2="9" />
              </svg>
            </div>
            <h4 className="font-bold text-foreground text-sm mb-1">
              {t("lottery_guarantee2_title")}
            </h4>
            <p className="text-xs text-muted-foreground">
              {t("lottery_guarantee2_desc")}
            </p>
          </div>
          <div className="rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] dark:shadow-[0_2px_16px_rgba(0,0,0,0.3)] bg-card p-5 hover:shadow-lg transition-shadow">
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center mb-3">
              <svg
                className="h-5 w-5 text-primary"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M18 20V10" />
                <path d="M12 20V4" />
                <path d="M6 20v-6" />
              </svg>
            </div>
            <h4 className="font-bold text-foreground text-sm mb-1">
              {t("lottery_guarantee3_title")}
            </h4>
            <p className="text-xs text-muted-foreground">
              {t("lottery_guarantee3_desc")}
            </p>
          </div>
        </div>

        {/* Proof box */}
        <div className="rounded-xl bg-surface-dim border border-border p-5 mb-4">
          <h4 className="font-bold text-foreground text-sm mb-2 flex items-center gap-2">
            <svg
              className="h-4 w-4 text-primary"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M9 18l6-6-6-6" />
            </svg>
            {t("lottery_proof_title")}
          </h4>
          <div className="text-sm text-muted-foreground space-y-1 font-mono">
            <p>{t("lottery_proof_line1")}</p>
            <p>{t("lottery_proof_line2")}</p>
            <p className="text-cyan">{t("lottery_proof_line3")}</p>
          </div>
        </div>

        {/* Theory refs */}
        <div className="text-xs text-muted-foreground mt-6 space-y-0.5">
          <p>
            Pathak, P.A. &amp; Sethuraman, J. (2011). Lotteries in Student
            Assignment.
          </p>
          <p>
            Abdulkadiroglu, A. &amp; Sonmez, T. (2003). School Choice: A
            Mechanism Design Approach.
          </p>
          <p>Budish, E. (2011). The Combinatorial Assignment Problem.</p>
        </div>
      </ArticleSection>

      {/* ═══════════════════════════════════════════════════════════
         Article 2 — Fan Weight System
         ═══════════════════════════════════════════════════════════ */}
      <ArticleSection
        id="fan-weight"
        badge="Fan Recognition"
        title={t("fan_weight_title")}
        subtitle={t("fan_weight_subtitle")}
      >
        <h3 className="text-lg font-bold text-foreground mb-3">
          {t("fan_weight_section1_title")}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-5 gap-3 mb-6">
          {[
            {
              dim: "s\u2081",
              name: t("fan_weight_dim1_name"),
              desc: t("fan_weight_dim1_desc"),
              alpha: "30%",
              color: "#0a0a0a",
            },
            {
              dim: "s\u2082",
              name: t("fan_weight_dim2_name"),
              desc: t("fan_weight_dim2_desc"),
              alpha: "25%",
              color: "#404040",
            },
            {
              dim: "s\u2083",
              name: t("fan_weight_dim3_name"),
              desc: t("fan_weight_dim3_desc"),
              alpha: "15%",
              color: "#00C9A7",
            },
            {
              dim: "s\u2084",
              name: t("fan_weight_dim4_name"),
              desc: t("fan_weight_dim4_desc"),
              alpha: "15%",
              color: "#00C9A7",
            },
            {
              dim: "s\u2085",
              name: t("fan_weight_dim5_name"),
              desc: t("fan_weight_dim5_desc"),
              alpha: "15%",
              color: "#404040",
            },
          ].map((d) => (
            <div
              key={d.dim}
              className="rounded-xl border border-border p-4 text-center hover:shadow-lg transition-shadow"
            >
              <div
                className="w-10 h-10 rounded-full mx-auto mb-2 flex items-center justify-center font-mono text-sm font-bold text-white"
                style={{ background: d.color }}
              >
                {d.dim}
              </div>
              <p className="font-bold text-sm text-foreground mb-1">{d.name}</p>
              <p className="text-xs-plus text-muted-foreground mb-2">
                {d.desc}
              </p>
              <span className="inline-block px-2 py-0.5 rounded-full bg-muted text-xs-plus font-semibold text-muted-foreground">
                {d.alpha}
              </span>
            </div>
          ))}
        </div>

        <h3 className="text-lg font-bold text-foreground mb-3">
          {t("fan_weight_section2_title")}
        </h3>
        <p className="mb-2">{t("fan_weight_section2_p1")}</p>
        <Math>
          <p>
            <Keyword>Raw</Keyword> = <Accent>{"Σ"}</Accent> &alpha;<sub>k</sub>{" "}
            &times; s<sub>k</sub>
            {"   "}(k=1..5,{"  "}
            <Accent>{"Σ"}</Accent>&alpha;<sub>k</sub> = 1.0)
          </p>
          <p className="mt-2">
            <Keyword>
              w<sub>i</sub>
            </Keyword>{" "}
            = 0.5 + 1.5 &times; &sigma;( &kappa; &times; (Raw - &mu;) )
          </p>
          <p className="mt-1 text-[#7B8CDE]">
            &sigma;(x) = 1/(1 + e<sup>-x</sup>){"   "}&kappa; = 6.0{"   "}&mu; =
            0.5
          </p>
        </Math>

        <h3 className="text-lg font-bold text-foreground mb-3">
          {t("fan_weight_section3_title")}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          <div className="rounded-xl bg-surface-dim p-5">
            <h4 className="font-bold text-sm text-foreground mb-2">
              {t("fan_weight_linear_title")}
            </h4>
            <p className="text-sm text-muted-foreground">
              {t("fan_weight_linear_desc")}
            </p>
          </div>
          <div className="rounded-xl bg-surface-dim p-5">
            <h4 className="font-bold text-sm text-foreground mb-2">
              {t("fan_weight_sigmoid_title")}
            </h4>
            <p className="text-sm text-muted-foreground">
              {t("fan_weight_sigmoid_desc")}
            </p>
          </div>
        </div>

        <h3 className="text-lg font-bold text-foreground mb-3">
          {t("fan_weight_section4_title")}
        </h3>
        <div className="grid grid-cols-3 gap-3 mb-6">
          <MetricCard value="0.57" label={t("fan_weight_metric1_label")} />
          <MetricCard
            value="1.93"
            label={t("fan_weight_metric2_label")}
            accent
          />
          <MetricCard value="3.38x" label={t("fan_weight_metric3_label")} />
        </div>
        <p className="text-sm text-muted-foreground mb-6">
          {t("fan_weight_range_desc")}
        </p>

        <h3 className="text-lg font-bold text-foreground mb-3">
          {t("fan_weight_section5_title")}
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-muted">
                <th className="border border-border px-3 py-2 text-left font-semibold text-foreground">
                  {t("fan_weight_table_col_template")}
                </th>
                <th className="border border-border px-3 py-2 text-center font-semibold text-foreground">
                  {t("fan_weight_table_col_loyalty")}
                </th>
                <th className="border border-border px-3 py-2 text-center font-semibold text-foreground">
                  {t("fan_weight_table_col_history")}
                </th>
                <th className="border border-border px-3 py-2 text-center font-semibold text-foreground">
                  {t("fan_weight_table_col_fanclub")}
                </th>
                <th className="border border-border px-3 py-2 text-center font-semibold text-foreground">
                  {t("fan_weight_table_col_behavior")}
                </th>
                <th className="border border-border px-3 py-2 text-center font-semibold text-foreground">
                  {t("fan_weight_table_col_freshness")}
                </th>
              </tr>
            </thead>
            <tbody>
              {[
                {
                  name: t("fan_weight_template_general"),
                  vals: [30, 25, 15, 15, 15],
                },
                {
                  name: t("fan_weight_template_fanclub"),
                  vals: [20, 15, 40, 10, 15],
                },
                {
                  name: t("fan_weight_template_festival"),
                  vals: [15, 10, 5, 20, 50],
                },
                {
                  name: t("fan_weight_template_hightour"),
                  vals: [35, 30, 10, 15, 10],
                },
                {
                  name: t("fan_weight_template_rookie"),
                  vals: [10, 5, 5, 30, 50],
                },
              ].map((row) => (
                <tr key={row.name}>
                  <td className="border border-border px-3 py-2 font-medium">
                    {row.name}
                  </td>
                  {row.vals.map((v, i) => (
                    <td
                      key={`${row.name}-${v}-${i}`}
                      className="border border-border px-3 py-2 text-center font-mono text-sm"
                    >
                      {v}%
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ArticleSection>

      {/* ═══════════════════════════════════════════════════════════
         Article 3 — Batch Application Window
         ═══════════════════════════════════════════════════════════ */}
      <ArticleSection
        id="batch"
        badge="Lottery Design"
        title={t("batch_title")}
        subtitle={t("batch_subtitle")}
      >
        <h3 className="text-lg font-bold text-foreground mb-3">
          {t("batch_section1_title")}
        </h3>
        {/* State machine diagram */}
        <div className="overflow-x-auto mb-6">
          <div className="flex items-center gap-2 min-w-[700px] py-4">
            {[
              { label: "DRAFT", color: "#999" },
              { label: "APPLY\nOPEN", color: "#0a0a0a" },
              { label: "APPLY\nCLOSING", color: "#404040" },
              { label: "CLOSED", color: "#0a0a0a" },
              { label: "ALLOCATING", color: "#00C9A7" },
              { label: "ALLOCATED", color: "#00C9A7" },
              { label: "COMPLETED", color: "#0a0a0a" },
            ].map((s, i, arr) => (
              <div key={s.label} className="flex items-center gap-2">
                <div
                  className="px-3 py-2 rounded-lg text-white text-xs-plus font-bold text-center whitespace-pre-line leading-tight min-w-[72px]"
                  style={{ background: s.color }}
                >
                  {s.label}
                </div>
                {i < arr.length - 1 && (
                  <svg
                    className="shrink-0"
                    width="20"
                    height="12"
                    viewBox="0 0 20 12"
                    fill="none"
                  >
                    <line
                      x1="0"
                      y1="6"
                      x2="14"
                      y2="6"
                      stroke="#ccc"
                      strokeWidth="1.5"
                    />
                    <polyline
                      points="12,2 18,6 12,10"
                      fill="none"
                      stroke="#ccc"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </div>
            ))}
          </div>
        </div>

        <h3 className="text-lg font-bold text-foreground mb-3">
          {t("batch_section2_title")}
        </h3>
        <Math>
          <Keyword>
            t<sub>actual</sub>
          </Keyword>{" "}
          = t<sub>scheduled</sub> + <Accent>Uniform</Accent>(0,{" "}
          {t("batch_math_30min")})
        </Math>
        <p className="mb-6 text-sm text-muted-foreground">
          {t("batch_section2_p1")}
        </p>

        <h3 className="text-lg font-bold text-foreground mb-3">
          {t("batch_section3_title")}
        </h3>
        <Math>
          <Keyword>intensity</Keyword> = 1 / (1 + e
          <sup>-2 &times; (ratio - 1.5)</sup>)
          <br />
          <Accent>ratio</Accent> = apply_count / total_seats
        </Math>
        <p className="mb-4 text-sm text-muted-foreground">
          {t("batch_section3_p1")}
        </p>

        <h3 className="text-lg font-bold text-foreground mb-3">
          {t("batch_section4_title")}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="rounded-xl bg-surface-dim p-4 text-center">
            <p className="text-xl font-bold text-primary font-mono">
              {t("batch_limit1_value")}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {t("batch_limit1_label")}
            </p>
          </div>
          <div className="rounded-xl bg-surface-dim p-4 text-center">
            <p className="text-xl font-bold text-primary font-mono">
              {t("batch_limit2_value")}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {t("batch_limit2_label")}
            </p>
          </div>
          <div className="rounded-xl bg-surface-dim p-4 text-center">
            <p className="text-xl font-bold text-primary font-mono">
              {t("batch_limit3_value")}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {t("batch_limit3_label")}
            </p>
          </div>
        </div>
      </ArticleSection>

      {/* ═══════════════════════════════════════════════════════════
         Article 4 — Fairness Metrics
         ═══════════════════════════════════════════════════════════ */}
      <ArticleSection
        id="fairness"
        badge="Transparency"
        title={t("fairness_title")}
        subtitle={t("fairness_subtitle")}
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          {[
            {
              name: t("fairness_metric1_name"),
              formula: "\u03A3(w\u1D62 \u00D7 AP\u1D62) / Total",
              desc: t("fairness_metric1_desc"),
            },
            {
              name: t("fairness_metric2_name"),
              formula: "Corr(LP_rank, win_rate)",
              desc: t("fairness_metric2_desc"),
            },
            {
              name: t("fairness_metric3_name"),
              formula: "Lorenz Curve",
              desc: t("fairness_metric3_desc"),
            },
            {
              name: t("fairness_metric4_name"),
              formula: "median(AP) / median(AP_win)",
              desc: t("fairness_metric4_desc"),
            },
            {
              name: t("fairness_metric5_name"),
              formula: "Pearson(w, win_prob)",
              desc: t("fairness_metric5_desc"),
            },
            {
              name: t("fairness_metric6_name"),
              formula: "resale_rate \u00D7 (P_resale / P_face) / w\u1D62\u00B2",
              desc: t("fairness_metric6_desc"),
            },
          ].map((m) => (
            <div
              key={m.name}
              className="rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] dark:shadow-[0_2px_16px_rgba(0,0,0,0.3)] bg-card p-5 hover:shadow-lg transition-shadow"
            >
              <h4 className="font-bold text-sm text-foreground mb-2">
                {m.name}
              </h4>
              <code className="inline-block px-3 py-1 rounded-lg bg-[#0F1629] text-cyan text-xs font-mono mb-2">
                {m.formula}
              </code>
              <p className="text-xs text-muted-foreground">{m.desc}</p>
            </div>
          ))}
        </div>

        <h3 className="text-lg font-bold text-foreground mb-3">
          {t("fairness_section2_title")}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="rounded-xl border border-[#0a0a0a]/10 p-5">
            <h4 className="font-bold text-sm text-primary mb-2">
              {t("fairness_winner_title")}
            </h4>
            <ul className="space-y-1.5 text-sm text-muted-foreground">
              <li>&bull; {t("fairness_winner_item1")}</li>
              <li>&bull; {t("fairness_winner_item2")}</li>
              <li>&bull; {t("fairness_winner_item3")}</li>
              <li>&bull; {t("fairness_winner_item4")}</li>
            </ul>
            <p className="text-xs text-muted-foreground mt-3">
              Thaler (1985): {t("fairness_winner_ref")}
            </p>
          </div>
          <div className="rounded-xl border border-[#00C9A7]/20 p-5">
            <h4 className="font-bold text-sm text-cyan mb-2">
              {t("fairness_loser_title")}
            </h4>
            <ul className="space-y-1.5 text-sm text-muted-foreground">
              <li>&bull; {t("fairness_loser_item1")}</li>
              <li>&bull; {t("fairness_loser_item2")}</li>
              <li>&bull; {t("fairness_loser_item3")}</li>
            </ul>
            <p className="text-xs text-muted-foreground mt-3">
              Loomes &amp; Sugden (1982): {t("fairness_loser_ref")}
            </p>
          </div>
        </div>
      </ArticleSection>

      {/* ═══════════════════════════════════════════════════════════
         Article 5 — Resale Profit Recapture Model
         ═══════════════════════════════════════════════════════════ */}
      <ArticleSection
        id="resale"
        badge="Resale Recapture"
        title={t("resale_title")}
        subtitle={t("resale_subtitle")}
      >
        <h3 className="text-lg font-bold text-foreground mb-3">
          {t("resale_section1_title")}
        </h3>
        {/* Revenue split diagram */}
        <div className="rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] dark:shadow-[0_2px_16px_rgba(0,0,0,0.3)] bg-white p-6 md:p-8 mb-6">
          <div className="flex flex-col md:flex-row items-center gap-6">
            {/* Source */}
            <div className="shrink-0 w-28 h-28 rounded-full bg-gradient-to-br from-[#0a0a0a] to-[#404040] flex items-center justify-center">
              <span className="text-white font-bold text-sm text-center leading-tight">
                {t("resale_diagram_source")}
              </span>
            </div>
            {/* Splits */}
            <div className="flex-1 space-y-3 w-full">
              <div className="flex items-center gap-3">
                <div className="w-16 h-3 rounded-full bg-primary" />
                <div className="flex-1 rounded-xl bg-primary/5 px-4 py-3 flex items-center justify-between">
                  <div>
                    <p className="font-bold text-primary text-sm">
                      {t("resale_seller_label")}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t("resale_seller_desc")}
                    </p>
                  </div>
                  <span className="font-mono font-bold text-primary text-lg">
                    {t("resale_seller_amount")}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="w-16 h-3 rounded-full bg-[#404040]" />
                <div className="flex-1 rounded-xl bg-[#404040]/5 px-4 py-3 flex items-center justify-between">
                  <div>
                    <p className="font-bold text-[#404040] text-sm">
                      {t("resale_platform_label")}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t("resale_platform_desc")}
                    </p>
                  </div>
                  <span className="font-mono font-bold text-[#404040] text-lg">
                    {t("resale_platform_amount")}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="w-16 h-3 rounded-full bg-[#00C9A7]" />
                <div className="flex-1 rounded-xl bg-[#00C9A7]/5 px-4 py-3 flex items-center justify-between">
                  <div>
                    <p className="font-bold text-cyan text-sm">
                      {t("resale_organizer_label")}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t("resale_organizer_desc")}
                    </p>
                  </div>
                  <span className="font-mono font-bold text-cyan text-lg">
                    {t("resale_organizer_amount")}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <h3 className="text-lg font-bold text-foreground mb-3">
          {t("resale_section2_title")}
        </h3>
        <Math>
          <Keyword>seller_receives</Keyword> = original_price +{" "}
          <Accent>premium</Accent> &times; 40%
          <br />
          <span className="text-[#7B8CDE]">{t("resale_math_note")}</span>
        </Math>
        <p className="mb-6 text-sm text-muted-foreground">
          {t("resale_section2_p1")}
        </p>

        <h3 className="text-lg font-bold text-foreground mb-3">
          {t("resale_section3_title")}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {[
            {
              name: t("resale_orderbook1_name"),
              desc: t("resale_orderbook1_desc"),
              icon: "\u2193",
            },
            {
              name: t("resale_orderbook2_name"),
              desc: t("resale_orderbook2_desc"),
              icon: "\u2191",
            },
            {
              name: t("resale_orderbook3_name"),
              desc: t("resale_orderbook3_desc"),
              icon: "\u21C4",
            },
          ].map((item) => (
            <div
              key={item.name}
              className="rounded-xl bg-surface-dim p-4 text-center"
            >
              <div className="text-2xl mb-2">{item.icon}</div>
              <h4 className="font-bold text-sm text-foreground mb-1">
                {item.name}
              </h4>
              <p className="text-xs text-muted-foreground">{item.desc}</p>
            </div>
          ))}
        </div>
      </ArticleSection>

      {/* ═══════════════════════════════════════════════════════════
         Article 6 — K-POP Concert Index
         ═══════════════════════════════════════════════════════════ */}
      <ArticleSection
        id="concert-index"
        badge="Market Intelligence"
        title={t("concert_index_title")}
        subtitle={t("concert_index_subtitle")}
      >
        <h3 className="text-lg font-bold text-foreground mb-3">
          {t("concert_index_section1_title")}
        </h3>
        <p className="mb-4">{t("concert_index_section1_p1")}</p>

        <h3 className="text-lg font-bold text-foreground mb-3">
          {t("concert_index_section2_title")}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          {[
            {
              name: t("concert_index_tpi_name"),
              formula:
                "\u03A3(w\u1D62 \u00D7 P\u1D62) / \u03A3(w\u1D62) by tier",
              desc: t("concert_index_tpi_desc"),
            },
            {
              name: t("concert_index_cdi_name"),
              formula: "applies / seats \u00D7 \u03C3(competition)",
              desc: t("concert_index_cdi_desc"),
            },
            {
              name: t("concert_index_fsi_name"),
              formula: "mean(surplus_ratio) \u00D7 (1 - gini)",
              desc: t("concert_index_fsi_desc"),
            },
            {
              name: t("concert_index_rhi_name"),
              formula: "1 - mean(resale_risk) \u00D7 P_resale/P_face",
              desc: t("concert_index_rhi_desc"),
            },
          ].map((m) => (
            <div
              key={m.name}
              className="rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] dark:shadow-[0_2px_16px_rgba(0,0,0,0.3)] bg-card p-5 hover:shadow-lg transition-shadow"
            >
              <h4 className="font-bold text-sm text-foreground mb-2">
                {m.name}
              </h4>
              <code className="inline-block px-3 py-1 rounded-lg bg-[#0F1629] text-cyan text-xs font-mono mb-2">
                {m.formula}
              </code>
              <p className="text-xs text-muted-foreground">{m.desc}</p>
            </div>
          ))}
        </div>

        {/* ── Live Index Prototype Dashboard ── */}
        <h3 className="text-lg font-bold text-foreground mb-3">
          {t("concert_index_dashboard_title")}
        </h3>
        <p className="mb-4 text-sm text-muted-foreground">
          {t("concert_index_dashboard_desc")}
        </p>

        <div className="rounded-2xl shadow-[0_4px_24px_rgba(0,0,0,0.08)] bg-white overflow-hidden mb-8">
          {/* Dashboard header */}
          <div className="px-6 py-4 bg-gradient-to-r from-[#0F1629] to-[#0a0a0a] flex items-center justify-between">
            <div className="flex items-center gap-3">
              <svg
                className="h-5 w-5 text-cyan"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
              </svg>
              <span className="text-white font-bold text-sm">
                Pickket Concert Index
              </span>
            </div>
            <span className="text-xs text-white/40 bg-white/10 px-3 py-1 rounded-full">
              PROTOTYPE · {t("concert_index_demo_data")}
            </span>
          </div>

          <div className="p-6">
            {/* Top-level index summary */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
              {[
                {
                  label: t("concert_index_summary_composite"),
                  value: "1,247",
                  change: "+3.2%",
                  up: true,
                },
                {
                  label: t("concert_index_summary_avg_tpi"),
                  value: "\u20A9142,500",
                  change: "+1.8%",
                  up: true,
                },
                {
                  label: t("concert_index_summary_avg_cdi"),
                  value: "5.14",
                  change: "-0.3%",
                  up: false,
                },
                {
                  label: t("concert_index_summary_avg_fsi"),
                  value: "0.87",
                  change: "+0.05",
                  up: true,
                },
              ].map((m) => (
                <div key={m.label} className="rounded-xl bg-surface-dim p-4">
                  <p className="text-xs-plus text-muted-foreground mb-1">
                    {m.label}
                  </p>
                  <p className="text-xl font-bold font-mono text-foreground">
                    {m.value}
                  </p>
                  <p
                    className={`text-xs font-semibold mt-1 ${m.up ? "text-cyan" : "text-destructive"}`}
                  >
                    {m.up ? "\u25B2" : "\u25BC"} {m.change}
                  </p>
                </div>
              ))}
            </div>

            {/* Artist-level TPI bar chart */}
            <div className="mb-6">
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm font-semibold text-foreground">
                  {t("concert_index_tpi_chart_title")}
                </p>
                <span className="text-2xs text-muted-foreground bg-surface-dim px-2 py-1 rounded-full">
                  {t("concert_index_tpi_chart_note")}
                </span>
              </div>
              <div className="space-y-2">
                {[
                  {
                    artist: "Coldplay",
                    tpi: 218000,
                    max: 350000,
                    bar: 95,
                    bids: 3421,
                    seats: 25000,
                  },
                  {
                    artist: "BTS",
                    tpi: 195000,
                    max: 300000,
                    bar: 85,
                    bids: 1523,
                    seats: 40000,
                  },
                  {
                    artist: "IU",
                    tpi: 132000,
                    max: 200000,
                    bar: 72,
                    bids: 2847,
                    seats: 15000,
                  },
                  {
                    artist: "NewJeans",
                    tpi: 128000,
                    max: 200000,
                    bar: 68,
                    bids: 2103,
                    seats: 20000,
                  },
                  {
                    artist: "\uBC15\uD6A8\uC2E0",
                    tpi: 162000,
                    max: 250000,
                    bar: 78,
                    bids: 1891,
                    seats: 3000,
                  },
                  {
                    artist: "aespa",
                    tpi: 115000,
                    max: 180000,
                    bar: 58,
                    bids: 756,
                    seats: 12000,
                  },
                  {
                    artist: "DAY6",
                    tpi: 78000,
                    max: 110000,
                    bar: 38,
                    bids: 432,
                    seats: 2800,
                  },
                ].map((a) => (
                  <div key={a.artist} className="flex items-center gap-3">
                    <span className="text-xs font-medium text-muted-foreground w-16 shrink-0 text-right">
                      {a.artist}
                    </span>
                    <div className="flex-1 h-6 rounded-full bg-muted overflow-hidden relative">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-[#0a0a0a] to-[#404040] transition-all duration-700"
                        style={{ width: `${a.bar}%` }}
                      />
                      <span className="absolute right-2 top-1/2 -translate-y-1/2 text-2xs font-mono text-muted-foreground">
                        \u20A9{a.tpi.toLocaleString()}
                      </span>
                    </div>
                    <span className="text-2xs text-muted-foreground w-20 shrink-0">
                      {a.bids.toLocaleString()}
                      {t("concert_index_bids_suffix")}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* CDI & FSI side by side */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
              {/* Competition Intensity (CDI) */}
              <div className="rounded-xl border border-border p-4">
                <p className="text-sm font-semibold text-foreground mb-3">
                  {t("concert_index_cdi_chart_title")}
                </p>
                <div className="space-y-2">
                  {[
                    {
                      artist: "\uBC15\uD6A8\uC2E0",
                      cdi: 63.0,
                      bar: 100,
                      label: t("concert_index_cdi_extreme"),
                    },
                    {
                      artist: "IU",
                      cdi: 19.0,
                      bar: 82,
                      label: t("concert_index_cdi_very_high"),
                    },
                    {
                      artist: "Coldplay",
                      cdi: 13.7,
                      bar: 72,
                      label: t("concert_index_cdi_high"),
                    },
                    {
                      artist: "NewJeans",
                      cdi: 10.5,
                      bar: 62,
                      label: t("concert_index_cdi_high"),
                    },
                    {
                      artist: "DAY6",
                      cdi: 15.4,
                      bar: 76,
                      label: t("concert_index_cdi_high"),
                    },
                  ].map((c) => (
                    <div key={c.artist} className="flex items-center gap-2">
                      <span className="text-xs-plus text-muted-foreground w-14 shrink-0 text-right">
                        {c.artist}
                      </span>
                      <div className="flex-1 h-4 rounded-full bg-muted overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all duration-700"
                          style={{
                            width: `${c.bar}%`,
                            background:
                              c.bar >= 80
                                ? "#FF6B6B"
                                : c.bar >= 60
                                  ? "#FFB86C"
                                  : "#00C9A7",
                          }}
                        />
                      </div>
                      <span className="text-2xs font-mono text-muted-foreground w-12 shrink-0">
                        {c.cdi}:1
                      </span>
                    </div>
                  ))}
                </div>
                <p className="text-2xs text-muted-foreground mt-2">
                  {t("concert_index_cdi_formula_note")}
                </p>
              </div>

              {/* Fan Satisfaction (FSI) */}
              <div className="rounded-xl border border-border p-4">
                <p className="text-sm font-semibold text-foreground mb-3">
                  {t("concert_index_fsi_chart_title")}
                </p>
                <div className="space-y-3">
                  {[
                    { artist: "DAY6", fsi: 0.94, gini: 0.96 },
                    { artist: "aespa", fsi: 0.91, gini: 0.93 },
                    { artist: "IU", fsi: 0.88, gini: 0.91 },
                    { artist: "NewJeans", fsi: 0.86, gini: 0.9 },
                    { artist: "Coldplay", fsi: 0.79, gini: 0.85 },
                  ].map((f) => (
                    <div key={f.artist} className="flex items-center gap-2">
                      <span className="text-xs-plus text-muted-foreground w-14 shrink-0 text-right">
                        {f.artist}
                      </span>
                      <div className="flex-1">
                        <div className="h-4 rounded-full bg-muted overflow-hidden">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-[#00C9A7] to-[#00E5BE] transition-all duration-700"
                            style={{ width: `${f.fsi * 100}%` }}
                          />
                        </div>
                      </div>
                      <span className="text-2xs font-mono text-cyan w-8 shrink-0 font-bold">
                        {f.fsi}
                      </span>
                      <span className="text-2xs text-muted-foreground w-16 shrink-0">
                        Gini {f.gini}
                      </span>
                    </div>
                  ))}
                </div>
                <p className="text-2xs text-muted-foreground mt-2">
                  {t("concert_index_fsi_formula_note")}
                </p>
              </div>
            </div>

            {/* Resale Health Index (RHI) */}
            <div className="rounded-xl border border-border p-4 mb-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm font-semibold text-foreground">
                  {t("concert_index_rhi_chart_title")}
                </p>
                <div className="flex items-center gap-3 text-2xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-[#00C9A7]" />
                    {t("concert_index_rhi_healthy")}
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-[#FFB86C]" />
                    {t("concert_index_rhi_caution")}
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-[#FF6B6B]" />
                    {t("concert_index_rhi_overheated")}
                  </span>
                </div>
              </div>
              <div className="grid grid-cols-4 md:grid-cols-8 gap-2">
                {[
                  { event: "IU", rhi: 0.91, color: "#00C9A7" },
                  { event: "BTS", rhi: 0.72, color: "#FFB86C" },
                  { event: "aespa", rhi: 0.93, color: "#00C9A7" },
                  { event: "DAY6", rhi: 0.97, color: "#00C9A7" },
                  { event: "\uBC15\uD6A8\uC2E0", rhi: 0.68, color: "#FFB86C" },
                  { event: "NJ", rhi: 0.85, color: "#00C9A7" },
                  { event: "CP", rhi: 0.61, color: "#FF6B6B" },
                  { event: "\uC774\uBB34\uC9C4", rhi: 0.95, color: "#00C9A7" },
                ].map((r) => (
                  <div key={r.event} className="text-center">
                    <div
                      className="w-full aspect-square rounded-xl flex items-center justify-center mb-1"
                      style={{
                        background: `${r.color}15`,
                        border: `1.5px solid ${r.color}40`,
                      }}
                    >
                      <span
                        className="font-mono font-bold text-sm"
                        style={{ color: r.color }}
                      >
                        {r.rhi}
                      </span>
                    </div>
                    <span className="text-2xs text-muted-foreground">
                      {r.event}
                    </span>
                  </div>
                ))}
              </div>
              <p className="text-2xs text-muted-foreground mt-3">
                {t("concert_index_rhi_formula_note")}
              </p>
            </div>

            {/* Dashboard footer */}
            <div className="flex items-center justify-between pt-3 border-t border-border">
              <span className="text-2xs text-muted-foreground">
                {t("concert_index_dashboard_footer_data")}
              </span>
              <span className="text-2xs text-muted-foreground">
                {t("concert_index_dashboard_footer_date")}
              </span>
            </div>
          </div>
        </div>

        <h3 className="text-lg font-bold text-foreground mb-3">
          {t("concert_index_section3_title")}
        </h3>
        <div className="overflow-x-auto mb-6">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-muted">
                <th className="border border-border px-3 py-2 text-left font-semibold text-foreground">
                  {t("concert_index_table_col_stakeholder")}
                </th>
                <th className="border border-border px-3 py-2 text-left font-semibold text-foreground">
                  {t("concert_index_table_col_usage")}
                </th>
                <th className="border border-border px-3 py-2 text-left font-semibold text-foreground">
                  {t("concert_index_table_col_effect")}
                </th>
              </tr>
            </thead>
            <tbody>
              {[
                {
                  who: t("concert_index_stakeholder1"),
                  use: t("concert_index_usage1"),
                  effect: t("concert_index_effect1"),
                },
                {
                  who: t("concert_index_stakeholder2"),
                  use: t("concert_index_usage2"),
                  effect: t("concert_index_effect2"),
                },
                {
                  who: t("concert_index_stakeholder3"),
                  use: t("concert_index_usage3"),
                  effect: t("concert_index_effect3"),
                },
                {
                  who: t("concert_index_stakeholder4"),
                  use: t("concert_index_usage4"),
                  effect: t("concert_index_effect4"),
                },
              ].map((r) => (
                <tr key={r.who}>
                  <td className="border border-border px-3 py-2 font-medium">
                    {r.who}
                  </td>
                  <td className="border border-border px-3 py-2 text-muted-foreground">
                    {r.use}
                  </td>
                  <td className="border border-border px-3 py-2 text-muted-foreground">
                    {r.effect}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h3 className="text-lg font-bold text-foreground mb-3">
          {t("concert_index_section4_title")}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="rounded-xl bg-surface-dim p-4 text-center">
            <div className="w-10 h-10 rounded-full mx-auto mb-2 flex items-center justify-center bg-primary/10">
              <svg
                className="h-5 w-5 text-primary"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                <path d="M9 12l2 2 4-4" />
              </svg>
            </div>
            <p className="font-bold text-sm text-foreground mb-1">
              {t("concert_index_principle1_title")}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("concert_index_principle1_desc")}
            </p>
          </div>
          <div className="rounded-xl bg-surface-dim p-4 text-center">
            <div className="w-10 h-10 rounded-full mx-auto mb-2 flex items-center justify-center bg-[#404040]/10">
              <svg
                className="h-5 w-5 text-[#404040]"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="M3 9h18" />
                <path d="M9 21V9" />
              </svg>
            </div>
            <p className="font-bold text-sm text-foreground mb-1">
              {t("concert_index_principle2_title")}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("concert_index_principle2_desc")}
            </p>
          </div>
          <div className="rounded-xl bg-surface-dim p-4 text-center">
            <div className="w-10 h-10 rounded-full mx-auto mb-2 flex items-center justify-center bg-cyan/10">
              <svg
                className="h-5 w-5 text-cyan"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M18 20V10" />
                <path d="M12 20V4" />
                <path d="M6 20v-6" />
              </svg>
            </div>
            <p className="font-bold text-sm text-foreground mb-1">
              {t("concert_index_principle3_title")}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("concert_index_principle3_desc")}
            </p>
          </div>
        </div>
      </ArticleSection>

      {/* ═══════════════════════════════════════════════════════════
         Article 7 — Regulatory Compliance
         ═══════════════════════════════════════════════════════════ */}
      <ArticleSection
        id="compliance"
        badge="Compliance"
        title={t("compliance_title")}
        subtitle={t("compliance_subtitle")}
      >
        <h3 className="text-lg font-bold text-foreground mb-3">
          {t("compliance_section1_title")}
        </h3>
        <div className="overflow-x-auto mb-6">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-muted">
                <th className="border border-border px-3 py-2 text-left font-semibold text-foreground">
                  {t("compliance_table1_col_pool")}
                </th>
                <th className="border border-border px-3 py-2 text-center font-semibold text-foreground">
                  {t("compliance_table1_col_ratio")}
                </th>
                <th className="border border-border px-3 py-2 text-left font-semibold text-foreground">
                  {t("compliance_table1_col_method")}
                </th>
                <th className="border border-border px-3 py-2 text-left font-semibold text-foreground">
                  {t("compliance_table1_col_target")}
                </th>
              </tr>
            </thead>
            <tbody>
              {[
                {
                  pool: "A",
                  ratio: "65%",
                  method: t("compliance_pool_a_method"),
                  who: t("compliance_pool_a_target"),
                },
                {
                  pool: "D",
                  ratio: "10%",
                  method: t("compliance_pool_d_method"),
                  who: t("compliance_pool_d_target"),
                },
                {
                  pool: "B",
                  ratio: "15%",
                  method: t("compliance_pool_b_method"),
                  who: t("compliance_pool_b_target"),
                },
                {
                  pool: "C",
                  ratio: "10%",
                  method: t("compliance_pool_c_method"),
                  who: t("compliance_pool_c_target"),
                },
              ].map((p) => (
                <tr key={p.pool}>
                  <td className="border border-border px-3 py-2 font-mono font-bold text-primary">
                    {p.pool}
                  </td>
                  <td className="border border-border px-3 py-2 text-center font-medium">
                    {p.ratio}
                  </td>
                  <td className="border border-border px-3 py-2">{p.method}</td>
                  <td className="border border-border px-3 py-2 text-muted-foreground">
                    {p.who}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-sm text-muted-foreground mb-6">
          {t("compliance_pool_order")}
        </p>

        <h3 className="text-lg font-bold text-foreground mb-3">
          {t("compliance_section2_title")}
        </h3>
        <Math>
          <Keyword>abuse_score</Keyword> = 0.3 &times; I
          <sub>[{t("compliance_abuse_multi_ip")}&ge;3]</sub> + 0.15 &times; I
          <sub>[{t("compliance_abuse_cancel")}&ge;3]</sub> + 0.3 &times; I
          <sub>[{t("compliance_abuse_cancel")}&ge;5]</sub> + 0.5 &times; I
          <sub>[{t("compliance_abuse_bot")}]</sub>
          <br />
          <span className="text-[#7B8CDE]">
            {t("compliance_abuse_threshold")}
          </span>
        </Math>

        <h3 className="text-lg font-bold text-foreground mb-3">
          {t("compliance_section3_title")}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
          {[
            {
              name: t("compliance_collusion1_name"),
              weight: "30%",
              desc: t("compliance_collusion1_desc"),
            },
            {
              name: t("compliance_collusion2_name"),
              weight: "30%",
              desc: t("compliance_collusion2_desc"),
            },
            {
              name: t("compliance_collusion3_name"),
              weight: "40%",
              desc: t("compliance_collusion3_desc"),
            },
          ].map((c) => (
            <div key={c.name} className="rounded-xl border border-border p-4">
              <div className="flex items-center justify-between mb-2">
                <h4 className="font-bold text-sm text-foreground">{c.name}</h4>
                <span className="text-xs font-mono text-primary bg-primary/10 px-2 py-0.5 rounded-full">
                  {c.weight}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">{c.desc}</p>
            </div>
          ))}
        </div>

        <h3 className="text-lg font-bold text-foreground mb-3">
          {t("compliance_section4_title")}
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-muted">
                <th className="border border-border px-3 py-2 text-left font-semibold text-foreground">
                  {t("compliance_table2_col_requirement")}
                </th>
                <th className="border border-border px-3 py-2 text-left font-semibold text-foreground">
                  {t("compliance_table2_col_implementation")}
                </th>
              </tr>
            </thead>
            <tbody>
              {[
                {
                  req: t("compliance_reg1_req"),
                  impl: t("compliance_reg1_impl"),
                },
                {
                  req: t("compliance_reg2_req"),
                  impl: t("compliance_reg2_impl"),
                },
                {
                  req: t("compliance_reg3_req"),
                  impl: t("compliance_reg3_impl"),
                },
                {
                  req: t("compliance_reg4_req"),
                  impl: t("compliance_reg4_impl"),
                },
                {
                  req: t("compliance_reg5_req"),
                  impl: t("compliance_reg5_impl"),
                },
              ].map((r) => (
                <tr key={r.req}>
                  <td className="border border-border px-3 py-2 font-medium">
                    {r.req}
                  </td>
                  <td className="border border-border px-3 py-2 text-muted-foreground">
                    {r.impl}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ArticleSection>

      {/* ─── CTA ─────────────────────────────────────────────────── */}
      <section className="py-20">
        <div className="max-w-4xl mx-auto px-6 text-center">
          <div
            className="rounded-2xl p-10 md:p-14"
            style={{
              background:
                "linear-gradient(135deg, #0F1629 0%, #0a0a0a 50%, #404040 100%)",
            }}
          >
            <h2 className="text-2xl md:text-3xl font-bold text-white mb-3">
              {t("cta_title")}
            </h2>
            <p className="text-white/60 mb-8 max-w-lg mx-auto text-sm">
              {t("cta_description")}
            </p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <Link
                href="/events"
                className="inline-flex items-center justify-center gap-2 px-7 py-3 rounded-full bg-[#00C9A7] text-white font-semibold hover:bg-[#00B396] transition-colors text-sm"
              >
                {t("cta_browse_tickets")}
              </Link>
              <Link
                href="/fairness"
                className="inline-flex items-center justify-center gap-2 px-7 py-3 rounded-full border border-white/20 text-white font-semibold hover:bg-white/10 transition-colors text-sm"
              >
                {t("cta_about_pickket")}
              </Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
