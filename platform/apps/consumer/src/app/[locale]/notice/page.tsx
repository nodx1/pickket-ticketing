import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight,
  Bell,
  Landmark,
  Megaphone,
  Rocket,
  Ticket,
} from "lucide-react";
import { getTranslations } from "next-intl/server";

export const metadata: Metadata = {
  title: "공지사항 — Pickket",
  description: "Pickket 서비스 공지사항 및 안내",
  openGraph: {
    title: "공지사항 — Pickket",
    description: "Pickket 서비스 공지사항 및 안내",
    type: "website",
  },
};

/* ─── Data ──────────────────────────────────────────────────────────── */

const noticesMeta = [
  {
    id: 1,
    badgeColor:
      "bg-sky-500/12 text-sky-700 dark:text-sky-300 border-sky-200/60 dark:border-sky-400/20",
    icon: Rocket,
    iconBg:
      "bg-sky-500/12 text-sky-700 dark:text-sky-300 group-hover:bg-sky-500/18",
    date: "2026.03.15",
    link: null,
  },
  {
    id: 2,
    badgeColor:
      "bg-violet-500/12 text-violet-700 dark:text-violet-300 border-violet-200/60 dark:border-violet-400/20",
    icon: Ticket,
    iconBg:
      "bg-violet-500/12 text-violet-700 dark:text-violet-300 group-hover:bg-violet-500/18",
    date: "2026.03.15",
  },
  {
    id: 3,
    badgeColor:
      "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300 border-emerald-200/60 dark:border-emerald-400/20",
    icon: Landmark,
    iconBg:
      "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300 group-hover:bg-emerald-500/18",
    date: "2026.03.15",
  },
];

/* ─── Page ──────────────────────────────────────────────────────────── */

export default async function NoticePage() {
  const t = await getTranslations("notice");

  const notices = [
    {
      ...noticesMeta[0],
      badge: t("badge.launch"),
      title: t("notice1.title"),
      summary: t("notice1.summary"),
      content: [t("notice1.content1"), t("notice1.content2")],
      highlights: [
        t("notice1.highlight1"),
        t("notice1.highlight2"),
        t("notice1.highlight3"),
        t("notice1.highlight4"),
        t("notice1.highlight5"),
      ],
    },
    {
      ...noticesMeta[1],
      badge: t("badge.organizer"),
      title: t("notice2.title"),
      summary: t("notice2.summary"),
      content: [t("notice2.content1"), t("notice2.content2")],
      highlights: null,
      link: { href: "/for-organizers", label: t("notice2.linkLabel") },
    },
    {
      ...noticesMeta[2],
      badge: t("badge.public"),
      title: t("notice3.title"),
      summary: t("notice3.summary"),
      content: [t("notice3.content1"), t("notice3.content2")],
      highlights: null,
      link: { href: "/government", label: t("notice3.linkLabel") },
    },
  ];

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(59,130,246,0.08),_transparent_40%)] dark:bg-[radial-gradient(circle_at_top,_rgba(59,130,246,0.10),_transparent_36%)]">
      {/* ── Header ─────────────────────────────────────────── */}
      <section className="px-4 pb-10 pt-20 md:pt-28">
        <div className="mx-auto max-w-4xl">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Megaphone className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <h1 className="text-2xl font-black text-foreground md:text-3xl">
                {t("heading")}
              </h1>
              <p className="text-sm text-muted-foreground">
                {t("subheading")}
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Notice List ────────────────────────────────────── */}
      <section className="px-4 pb-24">
        <div className="mx-auto max-w-4xl space-y-4">
          {notices.map(
            ({
              id,
              badge,
              badgeColor,
              icon: Icon,
              iconBg,
              date,
              title,
              summary,
              content,
              highlights,
              link,
            }) => (
              <article
                key={id}
                className="group rounded-[28px] border border-border/60 bg-card/85 shadow-[0_10px_30px_rgba(15,23,42,0.06)] backdrop-blur transition hover:shadow-[0_14px_40px_rgba(15,23,42,0.10)]"
              >
                {/* Card Header */}
                <div className="flex items-start gap-4 px-6 pt-6 md:px-8 md:pt-8">
                  <div
                    className={`flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-2xl transition ${iconBg}`}
                  >
                    <Icon className="h-5 w-5" aria-hidden="true" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${badgeColor}`}
                      >
                        {badge}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {date}
                      </span>
                    </div>
                    <h2 className="mt-2 text-lg font-bold text-foreground md:text-xl">
                      {title}
                    </h2>
                  </div>
                </div>

                {/* Card Body */}
                <div className="px-6 pb-6 pt-4 md:px-8 md:pb-8 md:pl-[88px]">
                  <p className="text-sm leading-6 text-muted-foreground">
                    {summary}
                  </p>

                  {content.map((paragraph, i) => (
                    <p
                      key={i}
                      className="mt-3 text-sm leading-6 text-muted-foreground"
                    >
                      {paragraph}
                    </p>
                  ))}

                  {/* Highlights */}
                  {highlights && (
                    <div className="mt-5 rounded-2xl border border-border/40 bg-muted/20 p-4">
                      <p className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-foreground">
                        <Bell className="h-3.5 w-3.5" aria-hidden="true" />
                        {t("highlightsLabel")}
                      </p>
                      <ul className="space-y-2">
                        {highlights.map((item, i) => (
                          <li
                            key={i}
                            className="flex items-start gap-2 text-sm text-muted-foreground"
                          >
                            <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-primary/60" />
                            {item}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Link */}
                  {link && (
                    <Link
                      href={link.href}
                      className="mt-5 inline-flex items-center gap-2 rounded-full border border-border bg-card/80 px-5 py-2.5 text-sm font-semibold text-foreground transition hover:bg-card hover:shadow-sm"
                    >
                      {link.label}
                      <ArrowRight className="h-4 w-4" aria-hidden="true" />
                    </Link>
                  )}
                </div>
              </article>
            ),
          )}
        </div>
      </section>
    </main>
  );
}
