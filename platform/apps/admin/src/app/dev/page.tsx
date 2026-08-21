"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import {
  RefreshCw,
  Wifi,
  WifiOff,
  Users,
  Lock,
  ClipboardList,
  Clock,
  Settings,
  BarChart2,
  CheckSquare,
  Globe,
  Layers,
  BookOpen,
  Code2,
} from "lucide-react";
import { useDevStream } from "./_components/use-dev-stream";
import { TeamBoard } from "./_components/TeamBoard";
import { FileLockMap } from "./_components/FileLockMap";
import { HandoffFeed } from "./_components/HandoffFeed";
import { BlockerAlert } from "./_components/BlockerAlert";
import { Timeline } from "./_components/Timeline";
import { TokenSettings } from "./_components/TokenSettings";
import { ProjectOverview } from "./_components/ProjectOverview";
import { LaunchChecklist } from "./_components/LaunchChecklist";
import { ApiReference } from "./_components/ApiReference";
import { PageMap } from "./_components/PageMap";
import { DesignSystem } from "./_components/DesignSystem";
import { DocsIndex } from "./_components/DocsIndex";

type Tab =
  // 실시간 협업
  | "board"
  | "locks"
  | "handoffs"
  | "timeline"
  // 프로젝트 레퍼런스
  | "overview"
  | "checklist"
  | "api"
  | "pages"
  | "design"
  | "docs"
  // 설정
  | "settings";

type TabGroup = {
  label: string;
  tabs: { key: Tab; label: string; icon: React.ReactNode; badge?: number }[];
};

export default function DevHubPage() {
  const t = useTranslations("dev.hub");
  const { tasks, locks, blockers, handoffs, connected, refresh } =
    useDevStream();
  const [tab, setTab] = useState<Tab>("board");
  const [timelineHours, setTimelineHours] = useState(24);

  const activeBlockers = blockers.filter((b) => !b.resolved);
  const lockCount = Object.keys(locks).length;

  const tabGroups: TabGroup[] = [
    {
      label: t("groupRealtime"),
      tabs: [
        {
          key: "board",
          label: t("tabBoard"),
          icon: <Users className="h-4 w-4" />,
          badge: tasks.length,
        },
        {
          key: "locks",
          label: t("tabLocks"),
          icon: <Lock className="h-4 w-4" />,
          badge: lockCount,
        },
        {
          key: "handoffs",
          label: t("tabHandoffs"),
          icon: <ClipboardList className="h-4 w-4" />,
        },
        {
          key: "timeline",
          label: t("tabTimeline"),
          icon: <Clock className="h-4 w-4" />,
        },
      ],
    },
    {
      label: t("groupProject"),
      tabs: [
        {
          key: "overview",
          label: t("tabOverview"),
          icon: <BarChart2 className="h-4 w-4" />,
        },
        {
          key: "checklist",
          label: t("tabChecklist"),
          icon: <CheckSquare className="h-4 w-4" />,
        },
        { key: "api", label: "API", icon: <Code2 className="h-4 w-4" /> },
        {
          key: "pages",
          label: t("tabPages"),
          icon: <Globe className="h-4 w-4" />,
        },
        {
          key: "design",
          label: t("tabDesign"),
          icon: <Layers className="h-4 w-4" />,
        },
        { key: "docs", label: t("tabDocs"), icon: <BookOpen className="h-4 w-4" /> },
      ],
    },
    {
      label: t("groupSettings"),
      tabs: [
        {
          key: "settings",
          label: t("tabTokens"),
          icon: <Settings className="h-4 w-4" />,
        },
      ],
    },
  ];

  return (
    <div className="min-h-screen bg-[var(--pk-bg)] p-4 md:p-6 space-y-4">
      {/* 헤더 */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold text-[var(--pk-text)]">Dev Hub</h1>
          <div className="flex items-center gap-1.5">
            {connected ? (
              <>
                <Wifi className="h-4 w-4 text-green-500" />
                <span className="text-xs text-green-500">
                  {t("activeCount", { count: tasks.length ?? 0 })}
                </span>
              </>
            ) : (
              <>
                <WifiOff className="h-4 w-4 text-red-500" />
                <span className="text-xs text-red-500">{t("disconnected")}</span>
              </>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={refresh}
          className="flex items-center gap-1.5 rounded-lg border border-[var(--pk-border)] px-3 py-1.5 text-sm text-[var(--pk-text-secondary)] hover:bg-[var(--pk-surface)] transition-colors"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {t("reconnect")}
        </button>
      </div>

      {/* 블로커 배너 */}
      {activeBlockers.length > 0 && <BlockerAlert blockers={activeBlockers} />}

      {/* 탭 네비게이션 — 그룹 구분 */}
      <div className="flex items-center gap-1 border-b border-[var(--pk-border)] overflow-x-auto pb-px">
        {tabGroups.map((group, gi) => (
          <div key={group.label} className="flex items-center gap-0.5">
            {gi > 0 && (
              <div className="h-5 w-px bg-[var(--pk-border)] mx-1.5 shrink-0" />
            )}
            {group.tabs.map((tb) => (
              <button
                key={tb.key}
                type="button"
                onClick={() => setTab(tb.key)}
                className={`
                  flex items-center gap-1.5 whitespace-nowrap px-3 py-2 text-sm font-medium border-b-2 transition-colors
                  ${
                    tab === tb.key
                      ? "border-[var(--pk-accent)] text-[var(--pk-accent)]"
                      : "border-transparent text-[var(--pk-text-secondary)] hover:text-[var(--pk-text)]"
                  }
                `}
              >
                {tb.icon}
                {tb.label}
                {tb.badge !== undefined && tb.badge > 0 && (
                  <span className="ml-1 rounded-full bg-[var(--pk-accent)] px-1.5 py-0.5 text-xs text-white leading-none">
                    {tb.badge}
                  </span>
                )}
              </button>
            ))}
          </div>
        ))}
      </div>

      {/* 탭 콘텐츠 */}
      <div>
        {tab === "board" && (
          <div className="space-y-4">
            {tasks.length === 0 && (
              <p className="text-sm text-[var(--pk-text-secondary)]">
                {t("boardEmpty")}{" "}
                <code className="font-mono bg-[var(--pk-surface)] px-1 rounded">
                  claim_task
                </code>{" "}
                {t("boardEmptyHint")}
              </p>
            )}
            <TeamBoard tasks={tasks} />
          </div>
        )}

        {tab === "locks" && (
          <div className="space-y-4">
            <p className="text-sm text-[var(--pk-text-secondary)]">
              {t("locksDesc")}{" "}
              <code className="font-mono bg-[var(--pk-surface)] px-1 rounded">
                force_unlock
              </code>{" "}
              {t("locksDescSuffix")}
            </p>
            <FileLockMap locks={locks} />
          </div>
        )}

        {tab === "handoffs" && (
          <div className="space-y-4">
            <p className="text-sm text-[var(--pk-text-secondary)]">
              {t("handoffsDesc")}
            </p>
            <HandoffFeed handoffs={handoffs} />
          </div>
        )}

        {tab === "timeline" && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <p className="text-sm text-[var(--pk-text-secondary)]">
                {t("timelineLabel")}
              </p>
              <div className="flex gap-1">
                {[24, 48].map((h) => (
                  <button
                    key={h}
                    type="button"
                    onClick={() => setTimelineHours(h)}
                    className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                      timelineHours === h
                        ? "bg-[var(--pk-accent)] text-white"
                        : "border border-[var(--pk-border)] text-[var(--pk-text-secondary)]"
                    }`}
                  >
                    {h}h
                  </button>
                ))}
              </div>
            </div>
            <Timeline hours={timelineHours} />
          </div>
        )}

        {tab === "overview" && <ProjectOverview />}
        {tab === "checklist" && <LaunchChecklist />}
        {tab === "api" && <ApiReference />}
        {tab === "pages" && <PageMap />}
        {tab === "design" && <DesignSystem />}
        {tab === "docs" && <DocsIndex />}

        {tab === "settings" && (
          <div className="space-y-4">
            <p className="text-sm text-[var(--pk-text-secondary)]">
              {t("settingsDesc")}{" "}
              <code className="font-mono bg-[var(--pk-surface)] px-1 rounded">
                X-Admin-Key
              </code>
              {t("settingsDescSuffix")}
            </p>
            <TokenSettings />
          </div>
        )}
      </div>
    </div>
  );
}
