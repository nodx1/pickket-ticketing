"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import DnaTest from "@/components/careers/DnaTest";
import ApplicationModal from "@/components/careers/ApplicationModal";
import { Button } from "@pickket/ui";
import {
  Scale,
  Lightbulb,
  Heart,
  Flame,
  ArrowRight,
  MapPin,
  Briefcase,
  Clock,
  Sparkles,
  ChevronRight,
} from "lucide-react";

/* ─── Data ─────────────────────────────────────── */

const PHILOSOPHY_ICONS = [Scale, Lightbulb, Heart, Flame];
const PHILOSOPHY_COLORS = [
  {
    barColor: "bg-primary",
    iconColor: "text-primary",
    iconBg: "bg-primary/10",
  },
  {
    barColor: "bg-[#7C3AED]",
    iconColor: "text-[#7C3AED]",
    iconBg: "bg-violet-100",
  },
  {
    barColor: "bg-[#EC4899]",
    iconColor: "text-[#EC4899]",
    iconBg: "bg-pink-100",
  },
  {
    barColor: "bg-[#00C9A7]",
    iconColor: "text-cyan",
    iconBg: "bg-[#00C9A7]/10",
  },
];

const TEAM = [
  {
    name: "민준",
    role: "Backend Lead",
    quoteKey: "team.quote0",
    mbti: "INTJ",
    bg: "bg-primary",
  },
  {
    name: "서연",
    role: "Product Design",
    quoteKey: "team.quote1",
    mbti: "ENFP",
    bg: "bg-[#EC4899]",
  },
  {
    name: "지호",
    role: "Data / AI",
    quoteKey: "team.quote2",
    mbti: "ISTP",
    bg: "bg-[#00C9A7]",
  },
  {
    name: "하은",
    role: "Frontend",
    quoteKey: "team.quote3",
    mbti: "INFP",
    bg: "bg-[#7C3AED]",
  },
  {
    name: "도윤",
    role: "Biz / Ops",
    quoteKey: "team.quote4",
    mbti: "ENTJ",
    bg: "bg-[#F59E0B]",
  },
  {
    name: "유나",
    role: "Community",
    quoteKey: "team.quote5",
    mbti: "ESFJ",
    bg: "bg-[#FF6B6B]",
  },
];

const POSITION_BASES = [
  {
    title: "Backend Engineer",
    team: "Engineering",
    typeKey: "positions.typeFull",
    badge: "bg-primary/10 text-primary",
    descKey: "positions.desc0",
  },
  {
    title: "Frontend Engineer",
    team: "Engineering",
    typeKey: "positions.typeFull",
    badge: "bg-primary/10 text-primary",
    descKey: "positions.desc1",
  },
  {
    title: "Product Designer",
    team: "Design",
    typeKey: "positions.typeFull",
    badge: "bg-violet-100 text-violet-700",
    descKey: "positions.desc2",
  },
  {
    title: "Data Analyst",
    team: "Data / AI",
    typeKey: "positions.typeFull",
    badge: "bg-[#00C9A7]/10 text-[#00876e]",
    descKey: "positions.desc3",
  },
  {
    title: "Community Manager",
    team: "Operations",
    typeKey: "positions.typeIntern",
    badge: "bg-amber-100 text-amber-700",
    descKey: "positions.desc4",
  },
];

const BENEFIT_EMOJIS = ["🏠", "📚", "🎵", "🍽️", "💻", "🏖️"];

/* ─── Page ──────────────────────────────────────── */

export default function CareersPage() {
  const t = useTranslations("careers");
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedPosition, setSelectedPosition] = useState<
    string | undefined
  >();
  const [selectedTeam, setSelectedTeam] = useState<string | undefined>();

  const openApplication = (position?: string, team?: string) => {
    setSelectedPosition(position);
    setSelectedTeam(team);
    setModalOpen(true);
  };

  const PHILOSOPHIES = PHILOSOPHY_ICONS.map((icon, i) => ({
    icon,
    title: t(`philosophy.title${i}`),
    desc: t(`philosophy.desc${i}`),
    ...PHILOSOPHY_COLORS[i],
  }));

  const BENEFITS = BENEFIT_EMOJIS.map((emoji, i) => ({
    emoji,
    text: t(`benefits.item${i}`),
  }));

  const POSITIONS = POSITION_BASES.map((p) => ({
    ...p,
    type: t(p.typeKey),
    desc: t(p.descKey),
  }));

  return (
    <main className="min-h-screen pt-20">
      {/* ─── Hero ─── */}
      <section className="relative bg-gradient-to-b from-[#0f0f23] via-[#1a1a2e] to-[#0a0a0a] text-white overflow-hidden">
        {/* Decorative circles */}
        <div className="absolute top-16 left-8 w-40 h-40 rounded-full border border-white/[0.06] animate-float" />
        <div className="absolute bottom-8 right-12 w-56 h-56 rounded-full border border-white/[0.04] animate-pulse-soft" />
        <div className="absolute top-1/3 right-1/4 w-24 h-24 rounded-full border border-[#00C9A7]/15 animate-float" />
        <div className="absolute bottom-1/3 left-1/4 w-16 h-16 rounded-full bg-[#7C3AED]/10 animate-pulse-soft" />

        <div className="relative max-w-4xl mx-auto px-4 pt-28 pb-24 text-center">
          <span className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-semibold bg-white/10 backdrop-blur-sm text-cyan mb-8 border border-white/10">
            <Sparkles className="h-3.5 w-3.5" />
            We&apos;re Hiring
          </span>
          <h1 className="text-4xl md:text-5xl font-extrabold leading-[1.15] mb-5 tracking-tight">
            We&apos;re not just
            <br />
            building a platform.
          </h1>
          <p className="text-lg md:text-xl text-white/60 mb-3 font-light">
            {t("hero.tagline")}
          </p>
          <p className="text-sm text-white/40 mb-12">
            {t("hero.subtitle")}
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Button
              onClick={() => {
                document
                  .getElementById("dna-test")
                  ?.scrollIntoView({ behavior: "smooth" });
              }}
              className="rounded-full bg-white text-primary hover:bg-white/90 h-12 px-8 text-base font-semibold shadow-lg shadow-white/10"
            >
              <span className="flex items-center gap-2">
                {t("hero.dnaTestBtn")}
                <ArrowRight className="h-4 w-4" />
              </span>
            </Button>
            <button
              onClick={() => {
                document
                  .getElementById("positions")
                  ?.scrollIntoView({ behavior: "smooth" });
              }}
              className="rounded-full border border-white/30 text-white hover:bg-white/10 h-12 px-8 text-base font-semibold transition-colors"
            >
              {t("hero.viewPositionsBtn")}
            </button>
          </div>
        </div>

        {/* Bottom fade */}
        <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-background to-transparent" />
      </section>

      {/* ─── Philosophy ─── */}
      <section className="py-20 px-4 bg-background">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-14">
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-primary/10 text-primary mb-4">
              Our Philosophy
            </span>
            <h2 className="text-2xl md:text-3xl font-bold text-foreground mb-2">
              {t("philosophy.heading")}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t("philosophy.subheading")}
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {PHILOSOPHIES.map((p) => (
              <div
                key={p.title}
                className="rounded-2xl border border-border overflow-hidden hover:-translate-y-1 hover:shadow-lg transition-all duration-300 group"
              >
                <div
                  className={`h-1 ${p.barColor} group-hover:h-1.5 transition-all duration-300`}
                />
                <div className="p-6">
                  <div
                    className={`inline-flex h-11 w-11 rounded-xl ${p.iconBg} items-center justify-center mb-4`}
                  >
                    <p.icon className={`h-5 w-5 ${p.iconColor}`} />
                  </div>
                  <h3 className="text-lg font-bold text-foreground mb-2">
                    {p.title}
                  </h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {p.desc}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── Team ─── */}
      <section className="py-20 px-4 bg-surface-dim">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-14">
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-primary/10 text-primary mb-4">
              Our Team
            </span>
            <h2 className="text-2xl md:text-3xl font-bold text-foreground mb-2">
              {t("team.heading")}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t("team.subheading")}
            </p>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            {TEAM.map((m) => (
              <div
                key={m.name}
                className="bg-card rounded-2xl p-6 border border-border text-center hover:-translate-y-1 hover:shadow-md transition-all duration-300"
              >
                <div
                  className={`h-14 w-14 rounded-full ${m.bg} mx-auto mb-4 flex items-center justify-center shadow-lg`}
                >
                  <span className="text-white font-bold text-lg">
                    {m.name[0]}
                  </span>
                </div>
                <h4 className="font-bold text-foreground">{m.name}</h4>
                <span className="inline-block mt-1.5 px-2.5 py-0.5 rounded-full bg-muted text-2xs font-medium text-muted-foreground">
                  {m.role}
                </span>
                <p className="text-xs text-muted-foreground italic mt-4 leading-relaxed">
                  &ldquo;{t(m.quoteKey)}&rdquo;
                </p>
                <span className="inline-block mt-2 px-2 py-0.5 rounded text-2xs font-mono text-muted-foreground bg-muted">
                  {m.mbti}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── Benefits ─── */}
      <section className="py-16 px-4 bg-background">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-10">
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-primary/10 text-primary mb-4">
              Benefits
            </span>
            <h2 className="text-2xl md:text-3xl font-bold text-foreground">
              {t("benefits.heading")}
            </h2>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {BENEFITS.map((b) => (
              <div
                key={b.text}
                className="flex items-center gap-3 rounded-xl border border-border p-4 hover:bg-muted transition-colors"
              >
                <span className="text-2xl">{b.emoji}</span>
                <span className="text-sm font-medium text-foreground">
                  {b.text}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── DNA Test ─── */}
      <section id="dna-test" className="py-20 px-4 bg-surface-dim">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-12">
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-primary/10 text-primary mb-4">
              DNA Test
            </span>
            <h2 className="text-2xl md:text-3xl font-bold text-foreground mb-2">
              {t("dnaTest.heading")}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t("dnaTest.subheading")}
            </p>
          </div>
          <DnaTest />
        </div>
      </section>

      {/* ─── Open Positions ─── */}
      <section id="positions" className="py-20 px-4 bg-background">
        <div className="max-w-3xl mx-auto">
          <div className="text-center mb-12">
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-primary/10 text-primary mb-4">
              Open Positions
            </span>
            <h2 className="text-2xl md:text-3xl font-bold text-foreground mb-2">
              {t("positions.heading")}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t("positions.subheading")}
            </p>
          </div>
          <div className="space-y-3">
            {POSITIONS.map((pos) => (
              <button
                key={pos.title}
                onClick={() => openApplication(pos.title, pos.team)}
                className="w-full bg-card rounded-xl border border-border p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:-translate-y-0.5 hover:shadow-md hover:border-primary/20 transition-all duration-200 text-left group"
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <h4 className="font-semibold text-foreground group-hover:text-primary transition-colors">
                      {pos.title}
                    </h4>
                    {pos.typeKey === "positions.typeIntern" && (
                      <span className="px-1.5 py-0.5 rounded text-2xs font-bold bg-amber-100 text-amber-700">
                        INTERN
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mb-2">
                    {pos.desc}
                  </p>
                  <div className="flex items-center gap-3">
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Briefcase className="h-3 w-3" />
                      {pos.team}
                    </span>
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock className="h-3 w-3" />
                      {pos.type}
                    </span>
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <MapPin className="h-3 w-3" />
                      {t("positions.location")}
                    </span>
                  </div>
                </div>
                <ChevronRight className="h-5 w-5 text-muted-foreground group-hover:text-primary transition-colors flex-shrink-0" />
              </button>
            ))}
          </div>

          {/* Open application */}
          <div className="mt-6 text-center">
            <button
              onClick={() => openApplication()}
              className="text-sm text-primary font-medium hover:underline underline-offset-4"
            >
              {t("positions.openApply")}
            </button>
          </div>
        </div>
      </section>

      {/* ─── CTA ─── */}
      <section className="relative py-24 px-4 bg-gradient-to-br from-[#0a0a0a] to-[#0f0f23] overflow-hidden">
        <div className="absolute top-10 right-10 w-40 h-40 rounded-full border border-white/[0.06] animate-float" />
        <div className="absolute bottom-10 left-10 w-24 h-24 rounded-full border border-[#00C9A7]/10 animate-pulse-soft" />

        <div className="relative max-w-3xl mx-auto text-center">
          <h2 className="text-2xl md:text-3xl font-bold text-white mb-4 leading-snug">
            {t("cta.heading")}
          </h2>
          <p className="text-white/50 text-sm mb-10 leading-relaxed">
            {t("cta.body1")}
            <br />
            {t("cta.body2")}
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Button
              onClick={() => openApplication()}
              className="rounded-full bg-white text-primary hover:bg-white/90 h-12 px-8 text-base font-semibold shadow-lg shadow-black/20"
            >
              {t("cta.applyBtn")}
            </Button>
            <button
              onClick={() => {
                document
                  .getElementById("dna-test")
                  ?.scrollIntoView({ behavior: "smooth" });
              }}
              className="rounded-full border border-white/30 text-white hover:bg-white/10 h-12 px-8 text-base font-semibold transition-colors"
            >
              {t("cta.dnaFirstBtn")}
            </button>
          </div>
        </div>
      </section>

      {/* Application Modal */}
      <ApplicationModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        position={selectedPosition}
        team={selectedTeam}
      />
    </main>
  );
}
