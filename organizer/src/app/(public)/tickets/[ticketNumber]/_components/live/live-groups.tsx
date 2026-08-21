"use client";

/**
 * 🔴 조편성 — **이번 대회의 핵심 화면**.
 *
 * 갤러리가 실제로 하는 일은 「지금 누가 어디 있나」를 보고 그리로 걸어가는 것이다.
 *
 * ## 🔴 출발 홀을 반드시 함께 적는다
 * 같은 시각에 **두 조가 나간다**(1번홀·10번홀 2티 출발). 조 번호만 보고 가면
 * 반대편 코스로 간다. 「3조 · 06:50 · 10번홀 출발」이 한 덩어리여야 한다.
 *
 * ⚠️ `current_hole` 은 그 조에서 **가장 덜 친 선수**의 홀이다(스펙 §4-3).
 *    조가 흩어질 수 있으므로 「부근」으로 적는다 — 없는 정밀도를 지어내지 않는다.
 */
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  GROUP_PHASE_LABEL,
  formatHole,
  formatTotal,
  groupPhase,
  type GroupPhase,
} from "@/lib/live/presentation";
import type { LiveGroup } from "@/lib/live/types";

const FILTERS: Array<{ id: GroupPhase | "all"; label: string }> = [
  { id: "playing", label: GROUP_PHASE_LABEL.playing },
  { id: "waiting", label: GROUP_PHASE_LABEL.waiting },
  { id: "finished", label: GROUP_PHASE_LABEL.finished },
  { id: "all", label: "전체" },
];

export function LiveGroups({ groups }: { groups: LiveGroup[] }) {
  const [filter, setFilter] = useState<GroupPhase | "all">("playing");
  const shown = filter === "all" ? groups : groups.filter((g) => groupPhase(g) === filter);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2" role="group" aria-label="조 상태 필터">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
              filter === f.id
                ? "bg-primary text-white"
                : "bg-muted text-content-subtle hover:text-foreground"
            }`}
          >
            {f.label}
            <span className="ml-1 opacity-70">
              {f.id === "all" ? groups.length : groups.filter((g) => groupPhase(g) === f.id).length}
            </span>
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="rounded-lg border border-border bg-card px-4 py-6 text-center text-sm text-content-muted">
          해당하는 조가 없습니다.
        </p>
      ) : (
        <ul className="space-y-2">
          {shown.map((g) => (
            <LiveGroupCard key={`${g.group_no}-${g.tee_time}`} group={g} />
          ))}
        </ul>
      )}
    </div>
  );
}

function LiveGroupCard({ group }: { group: LiveGroup }) {
  const phase = groupPhase(group);
  return (
    <li className="rounded-lg border border-border bg-card p-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-base font-black text-foreground">{group.group_no}조</span>
        <span className="text-sm text-content-subtle">{group.tee_time}</span>
        {/* 🔴 출발 홀 — 조 번호만으로는 현장에서 못 찾는다. */}
        <span className="text-sm font-semibold text-primary">
          {formatHole(group.start_hole)} 출발
        </span>
        <Badge variant={phase === "playing" ? "default" : "secondary"} className="ml-auto">
          {GROUP_PHASE_LABEL[phase]}
        </Badge>
      </div>

      {phase === "playing" ? (
        <p className="mt-1 text-sm text-content-default">
          현재 <strong className="font-bold">{formatHole(group.current_hole, true)}</strong>
        </p>
      ) : null}

      <ul className="mt-2 space-y-1">
        {/* 🔴 이름은 null 일 수 있다 — 조는 player_codes 만 오고, 이름은 리더보드에서
            이어 붙인다(summary.ts joinGroupNames). 리더보드에 없는 코드면 이름이 없다.
            ⚠️ key 를 이름으로 잡으면 그런 선수가 둘일 때 **key 가 중복**된다. 코드로 잡는다.
            ⚠️ 빈 칸을 그리지 않는다 — 조원 수가 맞아야 갤러리가 조를 알아본다. */}
        {group.players.map((p) => (
          <li key={p.player_code} className="flex items-center justify-between text-sm">
            <span className="text-content-default">{p.name ?? "이름 미확인"}</span>
            <span className="font-semibold tabular-nums text-foreground">{formatTotal(p.total)}</span>
          </li>
        ))}
      </ul>
    </li>
  );
}
