"use client";

import { AlertTriangle } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { ko } from "date-fns/locale";
import type { Blocker } from "./use-dev-stream";

const SEVERITY_STYLE = {
  critical: "bg-red-500/10 border-red-500/30 text-red-500",
  high: "bg-orange-500/10 border-orange-500/30 text-orange-500",
  low: "bg-yellow-500/10 border-yellow-500/30 text-yellow-600",
};

interface Props {
  blockers: Blocker[];
}

export function BlockerAlert({ blockers }: Props) {
  const active = blockers.filter((b) => !b.resolved);
  if (active.length === 0) return null;

  return (
    <div className="space-y-2">
      {active.map((b) => {
        let ago = "-";
        try {
          ago = formatDistanceToNow(new Date(b.timestamp), {
            addSuffix: true,
            locale: ko,
          });
        } catch {}
        const style = SEVERITY_STYLE[b.severity] ?? SEVERITY_STYLE.high;

        return (
          <div
            key={b.id}
            className={`flex items-start gap-3 rounded-xl border p-3 ${style}`}
          >
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-sm">{b.developer}</span>
                <span className="text-xs opacity-70 uppercase tracking-wide">
                  {b.severity}
                </span>
                <span className="text-xs opacity-60">{ago}</span>
              </div>
              <p className="text-sm mt-0.5 break-words">{b.issue}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
