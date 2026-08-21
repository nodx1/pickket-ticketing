"use client";

import { useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { ko } from "date-fns/locale";
import { Clock } from "lucide-react";
import { useTranslations } from "next-intl";

interface TimelineEvent {
  event_type: string;
  developer?: string;
  description?: string;
  summary?: string;
  issue?: string;
  file?: string;
  created_at: string;
}

const EVENT_ICON: Record<string, string> = {
  task_claimed: "🟢",
  task_updated: "🔄",
  task_completed: "✅",
  blocker_posted: "🚨",
  force_unlock: "🔓",
  pr_linked: "🔗",
};

const EVENT_LABEL_KEY: Record<string, string> = {
  task_claimed: "eventLabel.taskClaimed",
  task_updated: "eventLabel.taskUpdated",
  task_completed: "eventLabel.taskCompleted",
  blocker_posted: "eventLabel.blockerPosted",
  force_unlock: "eventLabel.forceUnlock",
  pr_linked: "eventLabel.prLinked",
};

const MCP_SERVER =
  process.env.NEXT_PUBLIC_MCP_SERVER_URL ?? "https://mcp-staging.pickket.kr";

interface Props {
  hours?: number;
}

export function Timeline({ hours = 24 }: Props) {
  const t = useTranslations("dev.timeline");
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token =
      typeof window !== "undefined"
        ? (sessionStorage.getItem("pickket_mcp_token") ?? "")
        : "";
    fetch(`${MCP_SERVER}/api/timeline?hours=${hours}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((d) => setEvents(d.events ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [hours]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-[var(--pk-text-secondary)] py-4">
        <Clock className="h-4 w-4 animate-spin" />
        {t("loading")}
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-[var(--pk-border)] p-6 text-center">
        <p className="text-sm text-[var(--pk-text-secondary)]">
          {t("empty", { hours: hours ?? 24 })}
        </p>
      </div>
    );
  }

  return (
    <div className="relative">
      <div className="absolute left-4 top-0 bottom-0 w-px bg-[var(--pk-border)]" />
      <div className="space-y-3 pl-10">
        {events.map((e, i) => {
          let ago = "-";
          try {
            ago = formatDistanceToNow(new Date(e.created_at), {
              addSuffix: true,
              locale: ko,
            });
          } catch {}
          const icon = EVENT_ICON[e.event_type] ?? "•";
          const labelKey = EVENT_LABEL_KEY[e.event_type];
          const label = labelKey ? t(labelKey) : (e.event_type ?? "");
          const detail = e.summary ?? e.issue ?? e.description ?? e.file ?? "";

          return (
            <div key={i} className="relative">
              <span className="absolute -left-6 flex h-5 w-5 items-center justify-center rounded-full bg-[var(--pk-surface)] border border-[var(--pk-border)] text-xs">
                {icon}
              </span>
              <div className="rounded-lg border border-[var(--pk-border)] bg-[var(--pk-surface)] px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium text-[var(--pk-text)]">
                      {label}
                    </span>
                    {e.developer && (
                      <span className="text-xs text-[var(--pk-accent-light)]">
                        {e.developer}
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-[var(--pk-text-secondary)] shrink-0">
                    {ago}
                  </span>
                </div>
                {detail && (
                  <p className="text-xs text-[var(--pk-text-secondary)] mt-0.5 truncate">
                    {detail}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
