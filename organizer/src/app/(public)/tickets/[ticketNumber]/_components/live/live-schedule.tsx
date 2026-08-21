"use client";

/**
 * 이벤트 탭 — **우리 데이터**다. 주최자가 등록한 안내(타임테이블)를 보여준다.
 * KLPGA 원천과 무관하므로 `state` 가 `stale` 이어도 이 탭은 정확하다.
 *
 * ⚠️ 시각 비교는 **KST 기준**으로 한다. 로컬 시간대가 서버와 같으면 시간대 버그가
 *    눈에 안 보인다 — 그래서 `timeZone` 을 항상 명시한다.
 */
import type { EventScheduleItem } from "@/lib/v2/event-schedules";

const KST = "Asia/Seoul";

function hhmm(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: KST,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(t));
}

export type ScheduleBucket = "now" | "soon" | "later" | "done";

/**
 * 지금 기준으로 어느 칸인가.
 *
 * ⚠️ 끝 시각이 없으면 **진행 중을 판단할 수 없다** — 시작했으면 「진행 중」으로 두되
 *    다음 항목이 시작하면 자연히 밀린다. 없는 정보를 지어내지 않는다.
 */
export function bucketOf(item: EventScheduleItem, now: number): ScheduleBucket {
  const start = Date.parse(item.startsAt);
  if (Number.isNaN(start)) return "later";
  const end = item.endsAt ? Date.parse(item.endsAt) : NaN;

  if (!Number.isNaN(end) && now >= end) return "done";
  if (now >= start) return "now";
  // 90분 안에 시작하면 「곧 시작」 — 갤러리가 이동을 결정할 수 있는 창이다.
  return start - now <= 90 * 60_000 ? "soon" : "later";
}

const BUCKET_LABEL: Record<ScheduleBucket, string> = {
  now: "진행 중",
  soon: "곧 시작",
  later: "예정",
  done: "종료",
};

/**
 * ⚠️ `now` 는 **호출부가 준다**(0 = 아직 모름). 렌더 중 `Date.now()` 는 불순 호출이라
 *    React 컴파일러가 막고, 리렌더마다 결과가 흔들린다.
 */
export function LiveSchedule({ items, now }: { items: EventScheduleItem[]; now: number }) {
  const at = now;

  if (items.length === 0) {
    return (
      <p className="rounded-lg border border-border bg-card px-4 py-6 text-center text-sm text-content-muted">
        등록된 행사 안내가 없습니다.
      </p>
    );
  }

  const sorted = [...items].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));

  return (
    <ul className="space-y-2">
      {sorted.map((it) => {
        // 시각을 모르면 배지를 달지 않는다 — 0 을 1970년으로 읽으면 전부 「종료」가 된다.
        const b = at > 0 ? bucketOf(it, at) : null;
        return (
          <li
            key={it.id}
            className={`rounded-lg border p-3 ${
              b === "now" ? "border-primary/40 bg-primary/5" : "border-border bg-card"
            } ${b === "done" ? "opacity-60" : ""}`}
          >
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-bold tabular-nums text-foreground">
                {hhmm(it.startsAt)}
                {it.endsAt ? `–${hhmm(it.endsAt)}` : ""}
              </span>
              {b ? (
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                    b === "now" ? "bg-primary text-white" : "bg-muted text-content-subtle"
                  }`}
                >
                  {BUCKET_LABEL[b]}
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-sm font-semibold text-content-default">{it.title}</p>
            {it.venueName ? (
              <p className="text-xs text-content-muted">{it.venueName}</p>
            ) : null}
            {it.description ? (
              <p className="mt-1 whitespace-pre-wrap text-xs text-content-subtle">{it.description}</p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
