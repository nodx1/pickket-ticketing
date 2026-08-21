"use client";

import { CheckCircle, ArrowRight, ExternalLink, GitBranch } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { ko } from "date-fns/locale";
import { useTranslations } from "next-intl";
import type { Handoff } from "./use-dev-stream";

interface Props {
  handoffs: Handoff[];
}

export function HandoffFeed({ handoffs }: Props) {
  const t = useTranslations("dev.handoffFeed");
  if (handoffs.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-[var(--pk-border)] p-6 text-center">
        <p className="text-sm text-[var(--pk-text-secondary)]">
          {t("empty")}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {handoffs.map((h, i) => {
        let ago = "-";
        try {
          ago = formatDistanceToNow(new Date(h.timestamp), {
            addSuffix: true,
            locale: ko,
          });
        } catch {}

        return (
          <div
            key={`${h.task_id}-${i}`}
            className="rounded-xl border border-[var(--pk-border)] bg-[var(--pk-surface)] p-4 space-y-2"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2">
                <CheckCircle className="h-4 w-4 text-green-500 shrink-0" />
                <span className="font-medium text-sm text-[var(--pk-text)]">
                  {h.developer}
                </span>
                {h.branch && (
                  <span className="flex items-center gap-1 text-xs text-[var(--pk-accent-light)]">
                    <GitBranch className="h-3 w-3" />
                    {h.branch}
                  </span>
                )}
              </div>
              <span className="text-xs text-[var(--pk-text-secondary)] shrink-0">
                {ago}
              </span>
            </div>

            <p className="text-sm text-[var(--pk-text)]">{h.summary}</p>

            {h.next_steps && (
              <div className="flex items-start gap-1.5 text-xs text-[var(--pk-text-secondary)]">
                <ArrowRight className="h-3.5 w-3.5 mt-0.5 shrink-0 text-[var(--pk-accent-light)]" />
                <span>{h.next_steps}</span>
              </div>
            )}

            {h.pr_url && (
              <a
                href={h.pr_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-[var(--pk-accent-light)] hover:underline"
              >
                <ExternalLink className="h-3 w-3" />
                {t("viewPr")}
              </a>
            )}
          </div>
        );
      })}
    </div>
  );
}
