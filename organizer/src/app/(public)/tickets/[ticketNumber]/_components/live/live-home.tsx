"use client";

/**
 * 홈 — 「지금 무슨 일이 일어나고 있나」를 한 화면에.
 *
 * ⚠️ 여기서 상태를 다시 판단하지 않는다. `state` 판정은 컨테이너(LiveView)가 하고,
 *    이 컴포넌트는 **받은 값을 그리기만** 한다. 화면마다 따로 판단하면 탭끼리 어긋난다.
 */
import { LiveLeaderboard } from "./live-leaderboard";
import { formatHole, formatTotal, groupPhase } from "@/lib/live/presentation";
import type { LiveSummary } from "@/lib/live/types";
import type { EventScheduleItem } from "@/lib/v2/event-schedules";
import { bucketOf } from "./live-schedule";

export function LiveHome({
  summary,
  schedules,
  onSeeGroups,
  onSeeSchedule,
  now,
}: {
  summary: LiveSummary;
  schedules: EventScheduleItem[];
  onSeeGroups: () => void;
  onSeeSchedule: () => void;
  /** 호출부가 주는 현재 시각(ms). 0 = 아직 모름 — 렌더 중 Date.now() 금지. */
  now: number;
}) {
  const at = now;
  const playing = summary.groups.filter((g) => groupPhase(g) === "playing");
  const waiting = summary.groups.filter((g) => groupPhase(g) === "waiting");
  const upcoming = schedules
    .filter((s) => {
      // 시각을 모르면 「곧 시작」을 단정하지 않는다.
      if (at <= 0) return false;
      const b = bucketOf(s, at);
      return b === "now" || b === "soon";
    })
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
    .slice(0, 2);

  return (
    <div className="space-y-5">
      <dl className="grid grid-cols-3 gap-2">
        <Stat label="라운드" value={(summary.tournament.round ?? 0) > 0 ? `${summary.tournament.round}R` : "-"} />
        <Stat label="코스 위" value={`${playing.length}조`} />
        <Stat label="출발 대기" value={`${waiting.length}조`} />
      </dl>

      <section>
        <h2 className="mb-2 text-sm font-bold text-foreground">선두</h2>
        <LiveLeaderboard leaders={summary.leaders} max={3} />
      </section>

      <section>
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-sm font-bold text-foreground">지금 나가 있는 조</h2>
          <button
            type="button"
            onClick={onSeeGroups}
            className="text-xs font-semibold text-primary hover:underline"
          >
            조편성에서 전부 보기
          </button>
        </div>
        {playing.length === 0 ? (
          <p className="rounded-lg border border-border bg-card px-4 py-5 text-center text-sm text-content-muted">
            코스 위에 있는 조가 없습니다.
          </p>
        ) : (
          <ul className="space-y-2">
            {playing.slice(0, 3).map((g) => (
              <li
                key={`${g.group_no}-${g.tee_time}`}
                className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm"
              >
                <span className="font-black text-foreground">{g.group_no}조</span>
                {/* 🔴 출발 홀 — 두 조가 같은 시각에 나간다. */}
                <span className="text-xs text-content-muted">{formatHole(g.start_hole)} 출발</span>
                <span className="ml-auto text-xs text-content-default">
                  {formatHole(g.current_hole, true)}
                </span>
                <span className="w-10 text-right text-xs font-semibold tabular-nums text-foreground">
                  {formatTotal(g.players[0]?.total ?? null)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-sm font-bold text-foreground">곧 시작하는 행사</h2>
          <button
            type="button"
            onClick={onSeeSchedule}
            className="text-xs font-semibold text-primary hover:underline"
          >
            전체 보기
          </button>
        </div>
        {upcoming.length === 0 ? (
          <p className="rounded-lg border border-border bg-card px-4 py-5 text-center text-sm text-content-muted">
            예정된 행사가 없습니다.
          </p>
        ) : (
          <ul className="space-y-2">
            {upcoming.map((s) => (
              <li key={s.id} className="rounded-lg border border-border bg-card px-3 py-2">
                <p className="text-sm font-semibold text-content-default">{s.title}</p>
                {s.venueName ? <p className="text-xs text-content-muted">{s.venueName}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 text-center">
      <dt className="text-[11px] text-content-muted">{label}</dt>
      <dd className="mt-0.5 text-lg font-black tabular-nums text-foreground">{value}</dd>
    </div>
  );
}
