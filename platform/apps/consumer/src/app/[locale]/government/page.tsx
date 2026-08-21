import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Mail } from "lucide-react";
import { getTranslations } from "next-intl/server";

export const metadata: Metadata = {
  title: "공공예약 — 지자체 축제·행사 티켓 솔루션 | Pickket",
  description:
    "공정 추첨으로 민원 없는 축제 예매. 7개 언어, 감사용 리포트 자동 생성.",
  openGraph: {
    title: "공공예약 — Pickket for Public",
    description: "공정 추첨으로 축제 민원을 제로로.",
    type: "website",
  },
};

export default async function GovernmentLandingPage() {
  const t = await getTranslations("government");

  const highlights = [
    {
      title: t("highlight.fairLottery.title"),
      body: t("highlight.fairLottery.body"),
    },
    {
      title: t("highlight.auditReport.title"),
      body: t("highlight.auditReport.body"),
    },
    {
      title: t("highlight.sevenLangs.title"),
      body: t("highlight.sevenLangs.body"),
    },
  ];

  return (
    <main className="bg-white dark:bg-[#0a0a0a]">
      {/* ── Hero ───────────────────────────────────────────── */}
      <section className="px-4 pb-20 pt-28 md:pb-28 md:pt-36">
        <div className="mx-auto max-w-4xl text-center">
          <p className="text-xs font-bold uppercase tracking-[0.3em] text-muted-foreground">
            Pickket for Public
          </p>

          <h1 className="mx-auto mt-6 max-w-3xl text-5xl font-black uppercase leading-[1.05] tracking-tight text-foreground sm:text-6xl md:text-7xl">
            {t("hero.headline")}
          </h1>

          <p className="mx-auto mt-6 max-w-xl text-base leading-7 text-muted-foreground md:text-lg">
            {t("hero.subheadline")}
          </p>

          <div className="mt-10 flex flex-wrap justify-center gap-4">
            <Link
              href="/support"
              className="inline-flex items-center gap-2 rounded-full bg-foreground px-8 py-4 text-sm font-bold uppercase tracking-wider text-background transition hover:bg-foreground/90"
            >
              {t("hero.cta.inquiry")}
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
            <a
              href="mailto:support@pickket.kr?subject=%EC%A7%80%EC%9E%90%EC%B2%B4%20%EB%8F%84%EC%9E%85%20%EB%AC%B8%EC%9D%98"
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
                go.pickket.kr/festival
              </div>
            </div>

            {/* Dashboard content */}
            <div className="space-y-4 bg-white p-5 md:p-6">
              {/* Header */}
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-muted-foreground">
                    {t("mockup.dashboardLabel")}
                  </p>
                  <p className="text-sm font-black text-foreground">
                    {t("mockup.festivalName")}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="rounded-full bg-foreground px-3 py-1 text-2xs font-bold text-background">
                    LIVE
                  </span>
                  <span className="rounded-full border border-border px-3 py-1 text-2xs font-bold text-muted-foreground">
                    KO · EN · JA
                  </span>
                </div>
              </div>

              {/* Stats row */}
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                {[
                  { label: t("mockup.stat.totalApplicants"), value: "24,391" },
                  { label: t("mockup.stat.allocated"), value: "5,000" },
                  { label: t("mockup.stat.checkedIn"), value: "3,847" },
                  { label: t("mockup.stat.remainingSeats"), value: "1,153" },
                ].map((s) => (
                  <div key={s.label} className="rounded-lg bg-[#fafafa] p-3">
                    <p className="text-2xs text-muted-foreground">{s.label}</p>
                    <p className="mt-1 text-sm font-black text-foreground font-tabular">
                      {s.value}
                    </p>
                  </div>
                ))}
              </div>

              {/* Report preview */}
              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-lg border border-border p-4">
                  <p className="text-2xs font-bold uppercase tracking-wider text-muted-foreground">
                    {t("mockup.transparencyReport")}
                  </p>
                  <div className="mt-3 space-y-2">
                    {[
                      { label: t("mockup.report.allocationRate"), bar: "w-[20%]" },
                      { label: t("mockup.report.botBlockRate"), bar: "w-[95%]" },
                      { label: t("mockup.report.checkInRate"), bar: "w-[77%]" },
                    ].map((r) => (
                      <div key={r.label}>
                        <div className="flex justify-between text-2xs text-muted-foreground">
                          <span>{r.label}</span>
                        </div>
                        <div className="mt-1 h-1.5 rounded-full bg-[#f0f0f0]">
                          <div
                            className={`h-full rounded-full bg-foreground/70 ${r.bar}`}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 flex gap-2">
                    <span className="rounded border border-border px-2 py-0.5 text-2xs text-muted-foreground">
                      CSV
                    </span>
                    <span className="rounded border border-border px-2 py-0.5 text-2xs text-muted-foreground">
                      PDF
                    </span>
                  </div>
                </div>

                <div className="rounded-lg border border-border p-4">
                  <p className="text-2xs font-bold uppercase tracking-wider text-muted-foreground">
                    {t("mockup.realtimeVenue")}
                  </p>
                  <div className="mt-3 flex items-end gap-1.5 h-16">
                    {[40, 65, 80, 55, 90, 70, 85, 50, 75, 60].map((h, i) => (
                      <div
                        key={i}
                        className="flex-1 rounded-sm bg-foreground/80"
                        style={{ height: `${h}%` }}
                      />
                    ))}
                  </div>
                  <p className="mt-2 text-center text-2xs text-muted-foreground">
                    {t("mockup.entryByHour")}
                  </p>
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
              {t("highlights.fairnessLink")}
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
                title: t("features.realtimeDashboard.title"),
                desc: t("features.realtimeDashboard.desc"),
              },
              {
                title: t("features.transparencyReport.title"),
                desc: t("features.transparencyReport.desc"),
              },
              {
                title: t("features.botBlock.title"),
                desc: t("features.botBlock.desc"),
              },
              {
                title: t("features.multiLang.title"),
                desc: t("features.multiLang.desc"),
              },
              {
                title: t("features.mobileQr.title"),
                desc: t("features.mobileQr.desc"),
              },
              {
                title: t("features.waitlist.title"),
                desc: t("features.waitlist.desc"),
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

      {/* ── Key numbers ───────────────────────────────────── */}
      <section className="border-t border-border/50 px-4 py-16 md:py-20">
        <div className="mx-auto grid max-w-4xl gap-8 text-center sm:grid-cols-3">
          {[
            { value: t("numbers.eventSetupValue"), label: t("numbers.eventSetup") },
            { value: "5%", label: t("numbers.commission") },
            { value: t("numbers.initialCostValue"), label: t("numbers.initialCost") },
          ].map(({ value, label }) => (
            <div key={label}>
              <p className="text-4xl font-black text-foreground md:text-5xl">
                {value}
              </p>
              <p className="mt-2 text-sm text-muted-foreground">{label}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Bottom CTA ─────────────────────────────────────── */}
      <section className="px-4 pb-28 pt-8">
        <div className="mx-auto max-w-4xl rounded-3xl bg-foreground px-8 py-14 text-center text-background md:px-12">
          <h2 className="text-3xl font-black md:text-4xl">
            {t("cta.heading")}
          </h2>
          <p className="mx-auto mt-4 max-w-md text-sm leading-6 text-background/70">
            {t("cta.body")}
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-4">
            <Link
              href="/support"
              className="inline-flex items-center gap-2 rounded-full bg-background px-8 py-4 text-sm font-bold text-foreground transition hover:bg-background/90"
            >
              {t("cta.consult")}
            </Link>
            <a
              href="mailto:support@pickket.kr?subject=%EC%A7%80%EC%9E%90%EC%B2%B4%20%EB%8D%B0%EB%AA%A8%20%EC%8B%A0%EC%B2%AD"
              className="inline-flex items-center gap-2 rounded-full border border-background/20 px-8 py-4 text-sm font-bold text-background transition hover:bg-white/10"
            >
              <Mail className="h-4 w-4" aria-hidden="true" />
              {t("cta.emailInquiry")}
            </a>
          </div>
        </div>
      </section>
    </main>
  );
}
