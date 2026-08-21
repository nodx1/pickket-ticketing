"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { apis } from "../_data/apis";
import { checklist } from "../_data/checklist";
import generated from "../_data/generated.json";

interface AppCard {
  name: string;
  key: string;
  port: number;
  pct: number;
  color: string;
  count: number;
  desc: string;
}

const APP_CARDS: AppCard[] = [
  {
    name: "Consumer App",
    key: "consumer",
    port: 3020,
    pct: 45,
    color: "#6c5ce7",
    count: 0,
    desc: "Next.js 16 · React 19",
  },
  {
    name: "Go (Organizer)",
    key: "go",
    port: 3021,
    pct: 30,
    color: "#00d2a0",
    count: 0,
    desc: "Next.js 16 · React 19",
  },
  {
    name: "Admin App",
    key: "admin",
    port: 3022,
    pct: 20,
    color: "#f97316",
    count: 0,
    desc: "Next.js 16 · React 19",
  },
  {
    name: "FastAPI Backend",
    key: "backend",
    port: 8021,
    pct: 70,
    color: "#22c55e",
    count: 0,
    desc: "Python 3.11 · SQLAlchemy",
  },
  {
    name: "Fair Allocation Engine",
    key: "engine",
    port: 0,
    pct: 80,
    color: "#a855f7",
    count: 0,
    desc: "Python · ortools · numpy",
  },
  {
    name: "Shared Packages",
    key: "packages",
    port: 0,
    pct: 60,
    color: "#eab308",
    count: 4,
    desc: "lib · ui · store · tailwind-config",
  },
];

const TECH_STACK = [
  {
    title: "Frontend",
    items: [
      "Next.js 16.1.6 (Turbopack)",
      "React 19.2.3",
      "Tailwind CSS 4",
      "Zustand 5 + React Query 5",
      "Motion 12",
      "Radix UI + Lucide Icons",
    ],
  },
  {
    title: "Backend",
    items: [
      "FastAPI 0.109+",
      "SQLAlchemy 2.0 (async)",
      "PostgreSQL 16",
      "Redis 7 (cache + queue)",
      "Celery 5.3 (workers)",
      "Alembic (migrations)",
    ],
  },
  {
    title: "Infra / DevOps",
    items: [
      "Docker Compose (dev/prod)",
      "GitHub Actions CI/CD",
      "AWS ECS Fargate",
      "Sentry (error tracking)",
      "OpenTelemetry (tracing)",
      "Prometheus (metrics)",
    ],
  },
  {
    title: "Payment / Auth",
    items: [
      "PortOne (PG)",
      "Stripe (fallback)",
      "JWT + OAuth2",
      "PASS 본인인증",
      "BCrypt password hashing",
    ],
  },
];

export function ProjectOverview() {
  const t = useTranslations("dev.projectOverview");
  const totalLaunchItems = useMemo(
    () => checklist.reduce((s, sec) => s + sec.items.length, 0),
    [],
  );
  const doneItems = useMemo(
    () =>
      checklist.reduce(
        (s, sec) => s + sec.items.filter((i) => i.status === "done").length,
        0,
      ),
    [],
  );
  const launchPct = Math.round((doneItems / totalLaunchItems) * 100);

  const appCards = APP_CARDS.map((c) => {
    let count = c.count;
    if (c.key === "backend") count = generated.endpointCount;
    else if (c.key === "consumer") count = generated.routeCounts.consumer;
    else if (c.key === "go")
      count = (generated.routeCounts as Record<string, number>).go || 0;
    else if (c.key === "admin") count = generated.routeCounts.admin;
    return { ...c, count };
  });

  return (
    <div className="space-y-6">
      {/* KPI Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
        {[
          {
            num: generated.routeCounts.total,
            label: "Total Routes",
            color: "#6c5ce7",
          },
          {
            num: generated.endpointCount,
            label: "API Endpoints",
            color: "#ec4899",
          },
          { num: apis.length, label: "Mapped APIs", color: "#a855f7" },
          { num: 4, label: "Packages", color: "#f97316" },
          { num: generated.docCount, label: "Docs Files", color: "#00d2a0" },
          { num: "87", label: "DB Models", color: "#22c55e" },
          { num: `${launchPct}%`, label: "Launch Ready", color: "#eab308" },
        ].map((kpi) => (
          <div
            key={kpi.label}
            className="rounded-xl border border-[var(--pk-border)] bg-[var(--pk-surface)] p-4 text-center"
          >
            <div
              className="text-2xl font-extrabold"
              style={{ color: kpi.color }}
            >
              {kpi.num}
            </div>
            <div className="text-xs text-[var(--pk-text-secondary)] mt-1">
              {kpi.label}
            </div>
          </div>
        ))}
      </div>

      {/* 전체 런치 진행률 */}
      <div className="rounded-xl border border-[var(--pk-border)] bg-[var(--pk-surface)] p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-semibold text-[var(--pk-text)]">
            {t("launchProgress")}
          </span>
          <span className="text-sm font-bold text-[var(--pk-accent)]">
            {t("launchDone", { done: doneItems ?? 0, total: totalLaunchItems ?? 0 })}
          </span>
        </div>
        <div className="h-2 bg-[var(--pk-surface-2,#1a1a24)] rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-700"
            style={{
              width: `${launchPct}%`,
              background: "linear-gradient(90deg,#6c5ce7,#00d2a0)",
            }}
          />
        </div>
        <div className="flex justify-between text-xs text-[var(--pk-text-secondary)] mt-1">
          <span>0%</span>
          <span>{launchPct}%</span>
          <span>100%</span>
        </div>
      </div>

      {/* App 카드 */}
      <div>
        <h2 className="text-base font-bold text-[var(--pk-text)] mb-3">
          {t("appsHeading")}
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {appCards.map((card) => (
            <div
              key={card.key}
              className="rounded-xl border border-[var(--pk-border)] bg-[var(--pk-surface)] p-4"
            >
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-[var(--pk-text)]">
                    {card.name}
                  </h3>
                  {card.port > 0 && (
                    <p className="text-xs text-[var(--pk-text-secondary)]">
                      Port {card.port}
                    </p>
                  )}
                </div>
                <span
                  className="text-2xl font-bold"
                  style={{ color: card.color }}
                >
                  {card.count > 0 ? card.count : "—"}
                </span>
              </div>
              <p className="text-xs text-[var(--pk-text-secondary)] mt-1">
                {card.desc}
              </p>
              <div className="h-1.5 bg-[var(--pk-surface-2,#1a1a24)] rounded-full overflow-hidden mt-3">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${card.pct}%`, backgroundColor: card.color }}
                />
              </div>
              <p className="text-xs text-[var(--pk-text-secondary)] mt-1">
                ~{card.pct}% production ready
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* 기술 스택 */}
      <div>
        <h2 className="text-base font-bold text-[var(--pk-text)] mb-3">
          Tech Stack
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {TECH_STACK.map((stack) => (
            <div
              key={stack.title}
              className="rounded-xl border border-[var(--pk-border)] bg-[var(--pk-surface)] p-4"
            >
              <h3 className="text-sm font-semibold text-[var(--pk-text)] mb-2">
                {stack.title}
              </h3>
              <ul className="space-y-1">
                {stack.items.map((item) => (
                  <li
                    key={item}
                    className="text-xs text-[var(--pk-text-secondary)]"
                  >
                    · {item}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
