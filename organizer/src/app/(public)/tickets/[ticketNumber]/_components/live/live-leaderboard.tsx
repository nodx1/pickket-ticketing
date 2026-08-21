"use client";

/**
 * 리더보드 — 순위 · 이름 · 총타수 · 진행 홀.
 *
 * ⚠️ 실격·기권(`ranked:false`)은 **서버가 이미 걸러서 준다**(백엔드 지시서 §2).
 *    화면에서 또 거르지 않는다 — 두 곳에서 거르면 리더보드와 조편성이 갈린다.
 */
import { formatHole, formatTotal } from "@/lib/live/presentation";
import type { LiveLeader } from "@/lib/live/types";

export function LiveLeaderboard({ leaders, max }: { leaders: LiveLeader[]; max?: number }) {
  const rows = typeof max === "number" ? leaders.slice(0, max) : leaders;

  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-border bg-card px-4 py-6 text-center text-sm text-content-muted">
        아직 순위가 없습니다.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
      {rows.map((l) => (
        <li key={`${l.rank}-${l.name}`} className="flex items-center gap-3 px-3 py-2.5">
          <span className="w-10 shrink-0 text-sm font-black tabular-nums text-foreground">
            {/* 공동 순위는 T 로 묶는다 — 같은 타수인데 순위가 달라 보이면 오해가 생긴다. */}
            {l.tied ? `T${l.rank}` : l.rank}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm text-content-default">{l.name}</span>
          <span className="w-12 shrink-0 text-right text-sm font-bold tabular-nums text-foreground">
            {formatTotal(l.total)}
          </span>
          <span className="w-20 shrink-0 text-right text-xs text-content-muted">
            {formatHole(l.current_hole)}
          </span>
        </li>
      ))}
    </ul>
  );
}
