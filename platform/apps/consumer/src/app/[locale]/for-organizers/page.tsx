import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Mail } from "lucide-react";
import { getTranslations } from "next-intl/server";

export const metadata: Metadata = {
  title: "주최자 — Pickket for Organizers",
  description:
    "공정 추첨 · 암표 차단 · 올인 가격. 팬이 신뢰하는 티켓팅으로 시작하세요.",
  openGraph: {
    title: "주최자 — Pickket for Organizers",
    description: "팬이 신뢰하는 티켓팅, 지금 시작하세요.",
    type: "website",
  },
};

export default async function ForOrganizersPage() {
  const t = await getTranslations("forOrganizers");

  const highlights = [
    {
      title: t("highlights.fairLottery.title"),
      body: t("highlights.fairLottery.body"),
    },
    {
      title: t("highlights.scalpingBlock.title"),
      body: t("highlights.scalpingBlock.body"),
    },
    {
      title: t("highlights.allinPrice.title"),
      body: t("highlights.allinPrice.body"),
    },
  ];

  return (
    <main className="bg-white dark:bg-[#0a0a0a]">
      {/* ── Hero ───────────────────────────────────────────── */}
      <section className="px-4 pb-20 pt-28 md:pb-28 md:pt-36">
        <div className="mx-auto max-w-4xl text-center">
          <p className="text-xs font-bold uppercase tracking-[0.3em] text-muted-foreground">
            Pickket for Organizers
          </p>

          <h1 className="mx-auto mt-6 max-w-3xl text-5xl font-black uppercase leading-[1.05] tracking-tight text-foreground sm:text-6xl md:text-7xl">
            {t("hero.heading1")}
            <br />
            {t("hero.heading2")}
          </h1>

          <p className="mx-auto mt-6 max-w-xl text-base leading-7 text-muted-foreground md:text-lg">
            {t("hero.subheading1")}
            <br />{t("hero.subheading2")}
          </p>

          <div className="mt-10 flex flex-wrap justify-center gap-4">
            <Link
              href="/support"
              className="inline-flex items-center gap-2 rounded-full bg-foreground px-8 py-4 text-sm font-bold uppercase tracking-wider text-background transition hover:bg-foreground/90"
            >
              {t("hero.ctaStart")}
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
            <a
              href="mailto:support@pickket.kr?subject=%EC%A3%BC%EC%B5%9C%EC%9E%90%20%EB%8F%84%EC%9E%85%20%EB%AC%B8%EC%9D%98"
              className="inline-flex items-center gap-2 rounded-full border border-border px-8 py-4 text-sm font-bold text-foreground transition hover:bg-muted"
            >
              <Mail className="h-4 w-4" aria-hidden="true" />
              support@pickket.kr
            </a>
          </div>
        </div>
      </section>

      {/* ── Dashboard Mockup ─────────────────────────────── */}
      <section className="px-4 pb-20" aria-hidden="true">
        <div className="mx-auto max-w-4xl">
          <div className="overflow-hidden rounded-2xl border border-border bg-[#fafafa]">
            {/* Browser chrome */}
            <div className="flex items-center gap-2 border-b border-border px-4 py-3">
              <div className="flex gap-1.5">
                <div className="h-2.5 w-2.5 rounded-full bg-[#e5e5e5]" />
                <div className="h-2.5 w-2.5 rounded-full bg-[#e5e5e5]" />
                <div className="h-2.5 w-2.5 rounded-full bg-[#e5e5e5]" />
              </div>
              <div className="ml-4 flex-1 rounded-md bg-white px-3 py-1 text-xs text-muted-foreground">
                go.pickket.kr
              </div>
            </div>

            {/* Dashboard content */}
            <div className="grid gap-px bg-border md:grid-cols-[200px_1fr]">
              {/* Sidebar */}
              <div className="hidden space-y-1 bg-white p-4 md:block">
                <div className="rounded-md bg-foreground px-3 py-2 text-xs font-bold text-background">
                  {t("mockup.sidebar.dashboard")}
                </div>
                <div className="rounded-md px-3 py-2 text-xs text-muted-foreground">
                  {t("mockup.sidebar.eventManagement")}
                </div>
                <div className="rounded-md px-3 py-2 text-xs text-muted-foreground">
                  {t("mockup.sidebar.settlement")}
                </div>
                <div className="rounded-md px-3 py-2 text-xs text-muted-foreground">
                  {t("mockup.sidebar.fanData")}
                </div>
                <div className="rounded-md px-3 py-2 text-xs text-muted-foreground">
                  {t("mockup.sidebar.settings")}
                </div>
              </div>

              {/* Main */}
              <div className="space-y-4 bg-white p-5 md:p-6">
                {/* Header */}
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground">
                      {t("mockup.activeEvent")}
                    </p>
                    <p className="text-sm font-black text-foreground">
                      {t("mockup.eventName")}
                    </p>
                  </div>
                  <span className="rounded-full bg-foreground px-3 py-1 text-2xs font-bold text-background">
                    LIVE
                  </span>
                </div>

                {/* Stats row */}
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {[
                    { label: t("mockup.stats.entries"), value: "12,847" },
                    { label: t("mockup.stats.winners"), value: "3,000" },
                    { label: t("mockup.stats.payments"), value: "2,841" },
                    { label: t("mockup.stats.checkins"), value: "—" },
                  ].map((s) => (
                    <div key={s.label} className="rounded-lg bg-[#fafafa] p-3">
                      <p className="text-2xs text-muted-foreground">
                        {s.label}
                      </p>
                      <p className="mt-1 text-sm font-black text-foreground font-tabular">
                        {s.value}
                      </p>
                    </div>
                  ))}
                </div>

                {/* Chart bars */}
                <div>
                  <p className="mb-2 text-2xs font-bold uppercase tracking-wider text-muted-foreground">
                    {t("mockup.seatCompetition")}
                  </p>
                  <div className="flex items-end gap-1.5 h-20">
                    {[65, 90, 45, 80, 55, 95, 70, 85, 40, 75, 60, 88].map(
                      (h, i) => (
                        <div
                          key={i}
                          className="flex-1 rounded-sm bg-foreground/80"
                          style={{ height: `${h}%` }}
                        />
                      ),
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Highlights ─────────────────────────────────────── */}
      <section className="border-t border-border/50 px-4 py-20 md:py-24">
        <div className="mx-auto max-w-4xl">
          <div className="grid gap-px overflow-hidden rounded-3xl border border-border/60 bg-border/30 sm:grid-cols-3">
            {highlights.map(({ title, body }) => (
              <article key={title} className="bg-card p-8 md:p-10">
                <h3 className="text-lg font-black text-foreground">{title}</h3>
                <p className="mt-3 whitespace-pre-line text-sm leading-6 text-muted-foreground">
                  {body}
                </p>
              </article>
            ))}
          </div>

          <p className="mt-8 text-center text-sm text-muted-foreground">
            <Link
              href="/fairness"
              className="text-foreground font-semibold hover:underline"
            >
              {t("highlights.promiseLinkText")}
            </Link>
          </p>
        </div>
      </section>

      {/* ── Features ──────────────────────────────────────── */}
      <section className="border-t border-border/50 px-4 py-20 md:py-24">
        <div className="mx-auto max-w-4xl">
          <p className="text-center text-xs font-bold uppercase tracking-[0.3em] text-muted-foreground">
            {t("features.eyebrow")}
          </p>
          <h2 className="mt-4 text-center text-2xl font-black text-foreground md:text-3xl">
            {t("features.heading")}
          </h2>

          <div className="mt-12 grid gap-x-8 gap-y-10 sm:grid-cols-2 md:grid-cols-3">
            {[
              {
                title: t("features.items.quickSetup.title"),
                desc: t("features.items.quickSetup.desc"),
              },
              {
                title: t("features.items.realtimeDashboard.title"),
                desc: t("features.items.realtimeDashboard.desc"),
              },
              {
                title: t("features.items.botBlock.title"),
                desc: t("features.items.botBlock.desc"),
              },
              {
                title: t("features.items.autoSettlement.title"),
                desc: t("features.items.autoSettlement.desc"),
              },
              {
                title: t("features.items.fanInsights.title"),
                desc: t("features.items.fanInsights.desc"),
              },
              {
                title: t("features.items.faceValueQueue.title"),
                desc: t("features.items.faceValueQueue.desc"),
              },
            ].map(({ title, desc }) => (
              <div key={title}>
                <h3 className="text-base font-bold text-foreground">{title}</h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  {desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Pricing (one line) ─────────────────────────────── */}
      <section className="border-t border-border/50 px-4 py-16 md:py-20">
        <div className="mx-auto max-w-4xl text-center">
          <h2 className="text-2xl font-black text-foreground md:text-3xl">
            {t("pricing.heading")}
          </h2>
          <p className="mt-3 text-sm text-muted-foreground">
            {t("pricing.body")}
          </p>
        </div>
      </section>

      {/* ── Bottom CTA ─────────────────────────────────────── */}
      <section className="px-4 pb-28 pt-8">
        <div className="mx-auto max-w-4xl rounded-3xl bg-foreground px-8 py-14 text-center text-background md:px-12">
          <h2 className="text-3xl font-black md:text-4xl">{t("cta.heading")}</h2>
          <p className="mx-auto mt-4 max-w-md text-sm leading-6 text-background/70">
            {t("cta.body")}
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-4">
            <Link
              href="/support"
              className="inline-flex items-center gap-2 rounded-full bg-background px-8 py-4 text-sm font-bold text-foreground transition hover:bg-background/90"
            >
              {t("cta.ctaConsult")}
            </Link>
            <a
              href="mailto:support@pickket.kr?subject=%EC%A3%BC%EC%B5%9C%EC%9E%90%20%EB%8D%B0%EB%AA%A8%20%EC%8B%A0%EC%B2%AD"
              className="inline-flex items-center gap-2 rounded-full border border-background/20 px-8 py-4 text-sm font-bold text-background transition hover:bg-white/10"
            >
              <Mail className="h-4 w-4" aria-hidden="true" />
              {t("cta.ctaMail")}
            </a>
          </div>
        </div>
      </section>
    </main>
  );
}
