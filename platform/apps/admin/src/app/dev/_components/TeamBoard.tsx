"use client";

import { formatDistanceToNow } from "date-fns";
import { ko } from "date-fns/locale";
import { GitBranch, FileCode, ExternalLink, Clock } from "lucide-react";
import { useTranslations } from "next-intl";
import type { Task } from "./use-dev-stream";

const STATUS_DOT_RING = {
  in_progress: { dot: "bg-green-500", ring: "ring-green-500/20" },
  blocked: { dot: "bg-red-500", ring: "ring-red-500/20" },
  review_needed: { dot: "bg-yellow-500", ring: "ring-yellow-500/20" },
  completed: { dot: "bg-gray-400", ring: "ring-gray-400/20" },
};

function timeAgo(iso: string): string {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true, locale: ko });
  } catch {
    return "-";
  }
}

interface Props {
  tasks: Task[];
}

export function TeamBoard({ tasks }: Props) {
  const t = useTranslations("dev.teamBoard");

  if (tasks.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-[var(--pk-border)] p-8 text-center">
        <p className="text-sm text-[var(--pk-text-secondary)]">
          {t("noActiveTasks")}
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {tasks.map((task) => {
        const sc =
          STATUS_DOT_RING[task.status as keyof typeof STATUS_DOT_RING] ??
          STATUS_DOT_RING.in_progress;
        const filesShown = task.files.slice(0, 3);
        const extraFiles = task.files.length - 3;
        return (
          <div
            key={task.id}
            className={`rounded-xl border border-[var(--pk-border)] bg-[var(--pk-surface)] p-4 ring-2 ${sc.ring} space-y-3`}
          >
            {/* 헤더 */}
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span
                  className={`h-2.5 w-2.5 rounded-full ${sc.dot} shrink-0`}
                />
                <span className="font-semibold text-[var(--pk-text)]">
                  {task.developer}
                </span>
              </div>
              <span className="text-xs text-[var(--pk-text-secondary)] bg-[var(--pk-bg)] px-2 py-0.5 rounded-full">
                {t(`status.${task.status as keyof typeof STATUS_DOT_RING}`, { defaultValue: t("status.in_progress") })}
              </span>
            </div>

            {/* 설명 */}
            <p className="text-sm text-[var(--pk-text)] line-clamp-2">
              {task.description}
            </p>

            {/* 브랜치 */}
            {task.branch && (
              <div className="flex items-center gap-1.5 text-xs text-[var(--pk-accent-light)]">
                <GitBranch className="h-3.5 w-3.5" />
                <span className="truncate">{task.branch}</span>
              </div>
            )}

            {/* 파일 */}
            {filesShown.length > 0 && (
              <div className="space-y-0.5">
                {filesShown.map((f) => (
                  <div
                    key={f}
                    className="flex items-center gap-1.5 text-xs text-[var(--pk-text-secondary)]"
                  >
                    <FileCode className="h-3 w-3 shrink-0" />
                    <span className="truncate">{f}</span>
                  </div>
                ))}
                {extraFiles > 0 && (
                  <p className="text-xs text-[var(--pk-text-secondary)] pl-4">
                    {t("extraFiles", { count: extraFiles ?? 0 })}
                  </p>
                )}
              </div>
            )}

            {/* PR 링크 */}
            {task.pr_url && (
              <a
                href={task.pr_url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-xs text-[var(--pk-accent-light)] hover:underline"
              >
                <ExternalLink className="h-3 w-3" />
                {t("viewPr")}
              </a>
            )}

            {/* 시간 */}
            <div className="flex items-center gap-1 text-xs text-[var(--pk-text-secondary)] pt-1 border-t border-[var(--pk-border)]">
              <Clock className="h-3 w-3" />
              <span>{timeAgo(task.started_at)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
