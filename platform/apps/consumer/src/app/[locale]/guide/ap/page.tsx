"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import {
  Star,
  Zap,
  Trophy,
  Shield,
  Gift,
  TrendingUp,
  Users,
  CheckCircle2,
  ArrowRight,
  Sparkles,
  Calendar,
  Heart,
  Target,
  Award,
} from "lucide-react";
import { Button } from "@pickket/ui";

/* ── Animation ─────────────────────────────────────────── */

function useInView(threshold = 0.15) {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          obs.disconnect();
        }
      },
      { threshold },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [threshold]);
  return { ref, inView };
}

function FadeIn({
  children,
  delay = 0,
}: {
  children: ReactNode;
  delay?: number;
}) {
  const { ref, inView } = useInView();
  return (
    <div
      ref={ref}
      className="transition-all duration-700 ease-out"
      style={{
        opacity: inView ? 1 : 0,
        transform: inView ? "translateY(0)" : "translateY(32px)",
        transitionDelay: `${delay}ms`,
      }}
    >
      {children}
    </div>
  );
}

function SectionLabel({
  children,
  light,
}: {
  children: React.ReactNode;
  light?: boolean;
}) {
  return (
    <div
      className={`inline-flex items-center gap-2 px-4 py-1.5 rounded-full text-xs font-bold tracking-wider uppercase mb-6 ${light ? "bg-white/10 text-white/70" : "bg-primary/8 text-primary/70"}`}
    >
      {children}
    </div>
  );
}

function Divider() {
  return (
    <div className="w-16 h-0.5 bg-gradient-to-r from-primary to-cyan mx-auto my-2" />
  );
}

/* ── Page ───────────────────────────────────────────────── */

export default function PointsPage() {
  const t = useTranslations("points");

  const earnActions = [
    {
      icon: Users,
      label: t("earn_signup"),
      ap: "500",
      color: "#00C9A7",
      once: true,
    },
    {
      icon: CheckCircle2,
      label: t("earn_profile"),
      ap: "200",
      color: "#8B5CF6",
      once: true,
    },
    {
      icon: Calendar,
      label: t("earn_attendance"),
      ap: "10~150",
      color: "#FFB86C",
      once: false,
    },
    {
      icon: Heart,
      label: t("earn_fanclub"),
      ap: "1,000",
      color: "#FF6B6B",
      once: false,
    },
    {
      icon: Star,
      label: t("earn_watch"),
      ap: "150",
      color: "#6C5CE7",
      once: false,
    },
    {
      icon: Sparkles,
      label: t("earn_review"),
      ap: "80~120",
      color: "#8B5CF6",
      once: false,
    },
    {
      icon: Gift,
      label: t("earn_purchase"),
      ap: "200",
      color: "#00C9A7",
      once: false,
    },
    {
      icon: Users,
      label: t("earn_invite"),
      ap: "200",
      color: "#FF6B6B",
      once: false,
    },
  ];

  const tiers = [
    {
      name: t("tier_rookie"),
      range: "0~999",
      mult: "1.00x",
      color: "#94A3B8",
      icon: Star,
    },
    {
      name: t("tier_fan"),
      range: "1,000~4,999",
      mult: "1.05x",
      color: "#00C9A7",
      icon: Heart,
    },
    {
      name: t("tier_supporter"),
      range: "5,000~14,999",
      mult: "1.10x",
      color: "#8B5CF6",
      icon: Shield,
    },
    {
      name: t("tier_corefan"),
      range: "15,000~49,999",
      mult: "1.15x",
      color: "#8B5CF6",
      icon: Trophy,
    },
    {
      name: t("tier_legend"),
      range: "50,000+",
      mult: "1.20x",
      color: "#FFB86C",
      icon: Award,
    },
  ];

  return (
    <div className="bg-background min-h-screen pt-20">
      {/* ━━━ HERO ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      <section className="relative overflow-hidden bg-gradient-to-br from-primary via-primary/80 to-violet">
        <div className="max-w-6xl mx-auto px-6 py-16 md:py-20 relative z-10">
          <div className="text-center">
            <SectionLabel light>
              <Zap className="h-3.5 w-3.5" />
              Mileage
            </SectionLabel>
            <h1 className="text-4xl md:text-5xl font-extrabold text-white leading-[1.15] mb-6">
              {t("hero_title_1")}
              <br />
              <span className="bg-gradient-to-r from-cyan to-cyan/80 bg-clip-text text-transparent">
                {t("hero_title_2")}
              </span>
            </h1>
            <p className="text-lg md:text-xl text-white/60 max-w-3xl mx-auto leading-relaxed">
              {t("hero_desc")}
            </p>

            {/* Key stats */}
            <div className="grid grid-cols-3 gap-4 max-w-xl mx-auto mt-12">
              {[
                { value: t("stat_earn_value"), label: t("stat_earn_label") },
                { value: t("stat_mode_value"), label: t("stat_mode_label") },
                {
                  value: t("stat_refund_value"),
                  label: t("stat_refund_label"),
                },
              ].map((s) => (
                <div key={s.label} className="text-center">
                  <div className="text-2xl md:text-3xl font-extrabold text-cyan">
                    {s.value}
                  </div>
                  <div className="text-xs md:text-sm text-white/50 mt-1">
                    {s.label}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="absolute bottom-0 left-0 right-0 h-24 bg-gradient-to-t from-background to-transparent" />
      </section>

      {/* ━━━ 마일리지란? ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      <section className="py-14">
        <div className="max-w-6xl mx-auto px-6">
          <div className="text-center mb-14">
            <SectionLabel>
              <Zap className="h-3.5 w-3.5" />
              {t("what_label")}
            </SectionLabel>
            <h2 className="text-3xl md:text-4xl font-bold text-foreground mb-3">
              {t("what_title")}
            </h2>
            <Divider />
            <p className="text-base text-muted-foreground max-w-2xl mx-auto mt-4">
              {t("what_desc")}
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {[
              {
                icon: TrendingUp,
                title: t("what_card1_title"),
                desc: t("what_card1_desc"),
                accent: "#00C9A7",
              },
              {
                icon: Shield,
                title: t("what_card2_title"),
                desc: t("what_card2_desc"),
                accent: "#8B5CF6",
              },
              {
                icon: Gift,
                title: t("what_card3_title"),
                desc: t("what_card3_desc"),
                accent: "#FFB86C",
              },
            ].map((card, i) => (
              <FadeIn key={card.title} delay={i * 100}>
                <div className="rounded-2xl bg-card border border-border p-8 hover:shadow-xl hover:-translate-y-1 transition-all duration-300 h-full">
                  <div
                    className="w-12 h-12 rounded-xl flex items-center justify-center mb-5"
                    style={{ background: `${card.accent}15` }}
                  >
                    <card.icon
                      className="h-6 w-6"
                      style={{ color: card.accent }}
                    />
                  </div>
                  <h3 className="text-lg font-bold text-foreground mb-3">
                    {card.title}
                  </h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {card.desc}
                  </p>
                </div>
              </FadeIn>
            ))}
          </div>
        </div>
      </section>

      {/* ━━━ 이렇게 모을 수 있어요 ━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      <section className="py-14 bg-gradient-to-br from-primary via-primary/80 to-violet">
        <div className="max-w-6xl mx-auto px-6">
          <div className="text-center mb-14">
            <SectionLabel light>
              <Star className="h-3.5 w-3.5" />
              {t("earn_label")}
            </SectionLabel>
            <h2 className="text-3xl md:text-4xl font-bold text-white mb-3">
              {t("earn_title")}
            </h2>
            <div className="w-16 h-0.5 bg-gradient-to-r from-cyan to-cyan/40 mx-auto my-2" />
            <p className="text-base text-white/50 max-w-2xl mx-auto mt-4">
              {t("earn_desc")}
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {earnActions.map((action, i) => (
              <FadeIn key={action.label} delay={i * 80}>
                <div className="rounded-2xl bg-white/[0.04] backdrop-blur-sm border border-white/[0.06] p-6 h-full">
                  <div className="flex items-start justify-between mb-4">
                    <div
                      className="w-10 h-10 rounded-xl flex items-center justify-center"
                      style={{ background: `${action.color}20` }}
                    >
                      <action.icon
                        className="h-5 w-5"
                        style={{ color: action.color }}
                      />
                    </div>
                    <span className="text-lg font-extrabold text-cyan">
                      +{action.ap}
                    </span>
                  </div>
                  <h4 className="text-sm font-semibold text-white mb-1">
                    {action.label}
                  </h4>
                  {action.once && (
                    <span className="text-2xs font-medium text-white/40 bg-white/[0.06] px-2 py-0.5 rounded-full">
                      {t("earn_once")}
                    </span>
                  )}
                </div>
              </FadeIn>
            ))}
          </div>

          {/* 패시브 적립 안내 */}
          <FadeIn>
            <div className="mt-10 rounded-2xl bg-cyan/10 border border-cyan/20 p-6 md:p-8">
              <div className="flex items-start gap-4">
                <div className="w-10 h-10 rounded-xl bg-cyan/20 flex items-center justify-center shrink-0">
                  <Sparkles className="h-5 w-5 text-cyan" />
                </div>
                <div>
                  <h4 className="text-base font-bold text-white mb-2">
                    {t("passive_title")}
                  </h4>
                  <p className="text-sm text-white/60 leading-relaxed">
                    {t("passive_desc")}
                  </p>
                </div>
              </div>
            </div>
          </FadeIn>
        </div>
      </section>

      {/* ━━━ 출석 & 스트릭 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      <section className="py-14">
        <div className="max-w-6xl mx-auto px-6">
          <div className="text-center mb-14">
            <SectionLabel>
              <Calendar className="h-3.5 w-3.5" />
              {t("streak_label")}
            </SectionLabel>
            <h2 className="text-3xl md:text-4xl font-bold text-foreground mb-3">
              {t("streak_title")}
            </h2>
            <Divider />
            <p className="text-base text-muted-foreground max-w-2xl mx-auto mt-4">
              {t("streak_desc")}
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* 주간 출석 */}
            <FadeIn>
              <div className="rounded-2xl border border-border p-8 h-full">
                <h3 className="text-lg font-bold text-foreground mb-6 flex items-center gap-2">
                  <Calendar className="h-5 w-5 text-primary" />
                  {t("weekly_title")}
                </h3>
                <div className="space-y-4">
                  {[
                    { days: t("weekly_3d"), ap: "70 마일리지", width: "40%" },
                    { days: t("weekly_5d"), ap: "100 마일리지", width: "65%" },
                    { days: t("weekly_7d"), ap: "150 마일리지", width: "100%" },
                  ].map((row) => (
                    <div key={row.days}>
                      <div className="flex items-center justify-between text-sm mb-1.5">
                        <span className="font-medium text-foreground">
                          {row.days}
                        </span>
                        <span className="font-bold text-primary">{row.ap}</span>
                      </div>
                      <div className="h-2 bg-muted rounded-full overflow-hidden">
                        <div
                          className="h-full bg-gradient-to-r from-primary to-cyan rounded-full transition-all duration-1000"
                          style={{ width: row.width }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground mt-4">
                  {t("weekly_note")}
                </p>
              </div>
            </FadeIn>

            {/* 스트릭 보너스 */}
            <FadeIn delay={150}>
              <div className="rounded-2xl border border-border p-8 h-full">
                <h3 className="text-lg font-bold text-foreground mb-6 flex items-center gap-2">
                  <TrendingUp className="h-5 w-5 text-[#FFB86C]" />
                  {t("streak_bonus_title")}
                </h3>
                <div className="space-y-3">
                  {[
                    {
                      weeks: t("streak_4w"),
                      bonus: "+100 마일리지",
                      icon: "🔥",
                    },
                    {
                      weeks: t("streak_8w"),
                      bonus: "+200 마일리지",
                      icon: "🔥🔥",
                    },
                    {
                      weeks: t("streak_12w"),
                      bonus: "+500 마일리지",
                      icon: "🔥🔥🔥",
                    },
                  ].map((row) => (
                    <div
                      key={row.weeks}
                      className="flex items-center justify-between p-3 rounded-xl bg-muted/50"
                    >
                      <div className="flex items-center gap-3">
                        <span className="text-lg">{row.icon}</span>
                        <span className="text-sm font-medium text-foreground">
                          {row.weeks}
                        </span>
                      </div>
                      <span className="text-sm font-bold text-[#FFB86C]">
                        {row.bonus}
                      </span>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground mt-4">
                  {t("streak_rescue")}
                </p>
              </div>
            </FadeIn>
          </div>
        </div>
      </section>

      {/* ━━━ 티켓 응모에 투자하세요 ━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      <section className="py-14 bg-gradient-to-br from-primary via-primary/80 to-violet">
        <div className="max-w-6xl mx-auto px-6">
          <div className="text-center mb-14">
            <SectionLabel light>
              <Target className="h-3.5 w-3.5" />
              {t("invest_label")}
            </SectionLabel>
            <h2 className="text-3xl md:text-4xl font-bold text-white mb-3">
              {t("invest_title")}
            </h2>
            <div className="w-16 h-0.5 bg-gradient-to-r from-cyan to-cyan/40 mx-auto my-2" />
            <p className="text-base text-white/50 max-w-2xl mx-auto mt-4">
              {t("invest_desc")}
            </p>
          </div>

          {/* 3-step flow */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
            {[
              {
                step: "1",
                title: t("invest_step1_title"),
                desc: t("invest_step1_desc"),
              },
              {
                step: "2",
                title: t("invest_step2_title"),
                desc: t("invest_step2_desc"),
              },
              {
                step: "3",
                title: t("invest_step3_title"),
                desc: t("invest_step3_desc"),
              },
            ].map((s, i) => (
              <FadeIn key={s.step} delay={i * 150}>
                <div className="rounded-2xl bg-white/[0.04] backdrop-blur-sm border border-white/[0.06] p-8 text-center h-full">
                  <div className="w-12 h-12 rounded-full bg-gradient-to-br from-cyan to-cyan/80 text-white text-xl font-bold flex items-center justify-center mx-auto mb-5">
                    {s.step}
                  </div>
                  <h3 className="text-lg font-bold text-white mb-3">
                    {s.title}
                  </h3>
                  <p className="text-sm text-white/60 leading-relaxed">
                    {s.desc}
                  </p>
                </div>
              </FadeIn>
            ))}
          </div>

          {/* 핵심 규칙 */}
          <FadeIn>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {[
                { label: t("invest_min"), value: t("invest_min_val") },
                { label: t("invest_max"), value: t("invest_max_val") },
                { label: t("invest_refund"), value: t("invest_refund_val") },
                { label: t("invest_bonus"), value: t("invest_bonus_val") },
              ].map((rule) => (
                <div
                  key={rule.label}
                  className="rounded-xl bg-white/[0.04] border border-white/[0.06] p-4 text-center"
                >
                  <div className="text-lg font-extrabold text-cyan mb-1">
                    {rule.value}
                  </div>
                  <div className="text-xs text-white/50">{rule.label}</div>
                </div>
              ))}
            </div>
          </FadeIn>

          {/* 신규 유저 보호 */}
          <FadeIn>
            <div className="mt-8 rounded-2xl bg-violet/10 border border-violet/20 p-6 md:p-8">
              <div className="flex items-start gap-4">
                <div className="w-10 h-10 rounded-xl bg-violet/20 flex items-center justify-center shrink-0">
                  <Shield className="h-5 w-5 text-violet" />
                </div>
                <div>
                  <h4 className="text-base font-bold text-white mb-2">
                    {t("newcomer_title")}
                  </h4>
                  <p className="text-sm text-white/60 leading-relaxed">
                    {t("newcomer_desc")}
                  </p>
                </div>
              </div>
            </div>
          </FadeIn>
        </div>
      </section>

      {/* ━━━ 멤버십 등급 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      <section className="py-14">
        <div className="max-w-6xl mx-auto px-6">
          <div className="text-center mb-14">
            <SectionLabel>
              <Trophy className="h-3.5 w-3.5" />
              {t("tier_label")}
            </SectionLabel>
            <h2 className="text-3xl md:text-4xl font-bold text-foreground mb-3">
              {t("tier_title")}
            </h2>
            <Divider />
            <p className="text-base text-muted-foreground max-w-2xl mx-auto mt-4">
              {t("tier_desc")}
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
            {tiers.map((tier, i) => (
              <FadeIn key={tier.name} delay={i * 80}>
                <div className="rounded-2xl border border-border p-6 text-center hover:shadow-lg hover:-translate-y-1 transition-all duration-300 h-full">
                  <div
                    className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-4"
                    style={{ background: `${tier.color}15` }}
                  >
                    <tier.icon
                      className="h-7 w-7"
                      style={{ color: tier.color }}
                    />
                  </div>
                  <h4 className="text-base font-bold text-foreground mb-1">
                    {tier.name}
                  </h4>
                  <p className="text-xs text-muted-foreground mb-3">
                    {tier.range} 마일리지
                  </p>
                  <div
                    className="inline-block text-xs font-bold px-3 py-1 rounded-full"
                    style={{ background: `${tier.color}15`, color: tier.color }}
                  >
                    {t("tier_boost")} {tier.mult}
                  </div>
                </div>
              </FadeIn>
            ))}
          </div>
        </div>
      </section>

      {/* ━━━ 낙첨 보호 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      <section className="py-14 bg-muted/30">
        <div className="max-w-6xl mx-auto px-6">
          <div className="text-center mb-14">
            <SectionLabel>
              <Shield className="h-3.5 w-3.5" />
              {t("pity_label")}
            </SectionLabel>
            <h2 className="text-3xl md:text-4xl font-bold text-foreground mb-3">
              {t("pity_title")}
            </h2>
            <Divider />
            <p className="text-base text-muted-foreground max-w-2xl mx-auto mt-4">
              {t("pity_desc")}
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <FadeIn>
              <div className="rounded-2xl bg-card border border-border p-8 h-full">
                <h3 className="text-lg font-bold text-foreground mb-6">
                  {t("pity_refund_title")}
                </h3>
                <div className="space-y-4">
                  <div className="flex items-center gap-4 p-4 rounded-xl bg-cyan/5 border border-cyan/10">
                    <CheckCircle2 className="h-6 w-6 text-cyan shrink-0" />
                    <div>
                      <div className="text-sm font-bold text-foreground">
                        {t("pity_full_refund")}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {t("pity_full_refund_desc")}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 p-4 rounded-xl bg-[#FFB86C]/5 border border-[#FFB86C]/10">
                    <Gift className="h-6 w-6 text-[#FFB86C] shrink-0" />
                    <div>
                      <div className="text-sm font-bold text-foreground">
                        {t("pity_consolation")}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {t("pity_consolation_desc")}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </FadeIn>

            <FadeIn delay={150}>
              <div className="rounded-2xl bg-card border border-border p-8 h-full">
                <h3 className="text-lg font-bold text-foreground mb-6">
                  {t("pity_streak_title")}
                </h3>
                <div className="space-y-3">
                  {[
                    { streak: t("pity_3x"), bonus: "+10%", color: "#94A3B8" },
                    { streak: t("pity_5x"), bonus: "+30%", color: "#FFB86C" },
                    { streak: t("pity_8x"), bonus: "+60%", color: "#FF6B6B" },
                    {
                      streak: t("pity_guaranteed"),
                      bonus: t("pity_guaranteed_label"),
                      color: "#00C9A7",
                    },
                  ].map((row) => (
                    <div
                      key={row.streak}
                      className="flex items-center justify-between p-3 rounded-xl"
                      style={{ background: `${row.color}08` }}
                    >
                      <span className="text-sm font-medium text-foreground">
                        {row.streak}
                      </span>
                      <span
                        className="text-sm font-bold"
                        style={{ color: row.color }}
                      >
                        {row.bonus}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </FadeIn>
          </div>
        </div>
      </section>

      {/* ━━━ 마일리지 Shop ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      <section className="py-14">
        <div className="max-w-6xl mx-auto px-6">
          <div className="text-center mb-14">
            <SectionLabel>
              <Gift className="h-3.5 w-3.5" />
              {t("shop_label")}
            </SectionLabel>
            <h2 className="text-3xl md:text-4xl font-bold text-foreground mb-3">
              {t("shop_title")}
            </h2>
            <Divider />
            <p className="text-base text-muted-foreground max-w-2xl mx-auto mt-4">
              {t("shop_desc")}
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {[
              {
                icon: Sparkles,
                title: t("shop_digital_title"),
                desc: t("shop_digital_desc"),
                price: "200~1,000 마일리지",
                accent: "#8B5CF6",
              },
              {
                icon: Award,
                title: t("shop_badge_title"),
                desc: t("shop_badge_desc"),
                price: "500~2,000 마일리지",
                accent: "#FFB86C",
              },
              {
                icon: Star,
                title: t("shop_offline_title"),
                desc: t("shop_offline_desc"),
                price: "3,000~10,000 마일리지",
                accent: "#FF6B6B",
              },
              {
                icon: Zap,
                title: t("shop_premium_title"),
                desc: t("shop_premium_desc"),
                price: "200~1,000 마일리지",
                accent: "#00C9A7",
              },
            ].map((item, i) => (
              <FadeIn key={item.title} delay={i * 100}>
                <div className="rounded-2xl border border-border p-6 hover:shadow-lg hover:-translate-y-1 transition-all duration-300 h-full flex flex-col">
                  <div
                    className="w-10 h-10 rounded-xl flex items-center justify-center mb-4"
                    style={{ background: `${item.accent}15` }}
                  >
                    <item.icon
                      className="h-5 w-5"
                      style={{ color: item.accent }}
                    />
                  </div>
                  <h4 className="text-base font-bold text-foreground mb-2">
                    {item.title}
                  </h4>
                  <p className="text-xs text-muted-foreground leading-relaxed mb-4 flex-1">
                    {item.desc}
                  </p>
                  <span
                    className="text-xs font-bold px-3 py-1 rounded-full self-start"
                    style={{
                      background: `${item.accent}12`,
                      color: item.accent,
                    }}
                  >
                    {item.price}
                  </span>
                </div>
              </FadeIn>
            ))}
          </div>
        </div>
      </section>

      {/* ━━━ CTA ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      <section className="py-14">
        <div className="max-w-4xl mx-auto px-6">
          <FadeIn>
            <div className="rounded-2xl bg-gradient-to-br from-primary to-[#8B5CF6] p-10 md:p-14 text-center">
              <h2 className="text-2xl md:text-3xl font-bold text-white mb-4">
                {t("cta_title")}
              </h2>
              <p className="text-white/70 max-w-lg mx-auto mb-8">
                {t("cta_desc")}
              </p>
              <div className="flex flex-col sm:flex-row gap-3 justify-center">
                <Link href="/auth">
                  <Button className="bg-white text-primary hover:bg-white/90 font-bold px-8">
                    {t("cta_signup")}
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Button>
                </Link>
                <Link href="/terms">
                  <Button
                    variant="outline"
                    className="border-white/30 text-white hover:bg-white/10 font-medium px-8"
                  >
                    {t("cta_terms")}
                  </Button>
                </Link>
              </div>
            </div>
          </FadeIn>
        </div>
      </section>
    </div>
  );
}
