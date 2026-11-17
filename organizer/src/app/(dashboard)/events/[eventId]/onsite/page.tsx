"use client";

/**
 * 현장 입장 관리 (과업 3-2 ② "현장 단말 연동 입장 관리 소프트웨어 — 현장 입장권 검증, 중복 티켓 및
 * 매크로 계정 차단 모니터링, 실시간 좌석·입장 권한 처리를 위한 대시보드").
 *
 *  - 실시간: v2 Socket.IO `/monitor` 로 판정·부정 경보·단말 상태를 받는다(연결 상태 표시)
 *  - 집계: TimescaleDB 1분 집계(분당 입장 차트) + 게이트별 현황
 *  - 단말: 등록·키 발급·일시중지·폐기, 게이트·입장 가능 등급(입장 권한)
 *  - 차단: 티켓 차단/해제, 제재 계정 티켓 자동 포함 → 모든 단말에 즉시 동기화
 *  - 모니터링: 같은 기기 다중 계정·매크로 탐지 목록과 제재 해제
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { AlertTriangle, CheckCircle2, DoorOpen, RefreshCcw, Repeat2, ShieldAlert, Ticket, Wifi, WifiOff } from "lucide-react";

import { PageHeader, Pill, Section, StatCard, gw } from "@/components/gwasup/ui";
import { Button } from "@/components/ui/button";
import { formatDateTimeSecKst } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { OnsiteOverview, SanctionMonitor, TimeseriesView } from "@/lib/v2/gwasup-client";

import { BlockPanel, SanctionPanel } from "./_components/guard-panel";
import { TerminalPanel } from "./_components/terminal-panel";
import { type LiveDecision, useOnsiteLive } from "./_components/use-onsite-live";

const CODE_LABEL: Record<string, string> = {
  admitted: "입장",
  reentry_ok: "재입장",
  qr_replay: "캡처 재사용",
  duplicate_ticket: "중복 티켓",
  blocked_ticket: "차단 티켓",
  sanctioned_account: "제재 계정",
  gate_not_allowed: "게이트 권한",
  forged_qr: "위조 QR",
  expired_qr: "만료 QR",
  invalid_qr: "잘못된 QR",
  wrong_event: "다른 행사",
  not_found: "없는 티켓",
  cancelled: "취소 티켓",
  not_admission_day: "입장일 아님",
  manual_not_allowed: "수기 입력 불가",
};

export default function OnsitePage() {
  const { eventId } = useParams<{ eventId: string }>();
  const [overview, setOverview] = useState<OnsiteOverview | null>(null);
  const [sanctions, setSanctions] = useState<SanctionMonitor | null>(null);
  const [series, setSeries] = useState<TimeseriesView | null>(null);
  const [feed, setFeed] = useState<LiveDecision[]>([]);
  const [alerts, setAlerts] = useState<LiveDecision[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [o, s, t] = await Promise.all([
        gw<OnsiteOverview>(eventId, "onsite"),
        gw<SanctionMonitor>(eventId, "sanctions"),
        gw<TimeseriesView>(eventId, "onsite/timeseries?kind=admission&minutes=60"),
      ]);
      setOverview(o);
      setSanctions(s);
      setSeries(t);
      setFeed((prev) => (prev.length ? prev : o.recent.map((r) => ({ ...r, holder: null }))));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "불러오지 못했습니다");
    }
  }, [eventId]);

  useEffect(() => {
    // 첫 조회도 타이머로 — 이펙트 본문에서 곧바로 상태를 바꾸지 않는다(react-hooks/set-state-in-effect)
    const first = setTimeout(() => void load(), 0);
    const timer = setInterval(() => void load(), 30_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [load]);

  const live = useOnsiteLive(eventId, {
    onDecision: (d) => {
      setFeed((prev) => [d, ...prev].slice(0, 80));
      setOverview((prev) => (prev ? bump(prev, d) : prev));
    },
    onFraud: (d) => setAlerts((prev) => [d, ...prev].slice(0, 20)),
    onChange: () => void load(),
  });

  const totals = useMemo(() => overview?.totals.by_result ?? {}, [overview]);
  const rejected = useMemo(
    () => Object.entries(totals).filter(([k]) => k.startsWith("rejected:")).reduce((a, [, n]) => a + n, 0),
    [totals],
  );
  const fraud = useMemo(
    () =>
      Object.entries(totals)
        .filter(([k]) => ["rejected:qr_replay", "rejected:duplicate_ticket", "rejected:blocked_ticket", "rejected:sanctioned_account", "rejected:forged_qr"].includes(k))
        .reduce((a, [, n]) => a + n, 0),
    [totals],
  );
  const perMinute = useMemo(() => buildPerMinute(series), [series]);
  const maxMinute = Math.max(1, ...perMinute.map((m) => m.admitted + m.rejected));

  if (error && !overview) {
    return (
      <div className="rounded-lg border border-border bg-card p-10 text-center">
        <p className="font-semibold">현장 정보를 불러오지 못했습니다</p>
        <p className="mt-1 text-sm text-content-subtle">{error}</p>
        <Button variant="secondary" className="mt-4" onClick={() => void load()}>
          다시 시도
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="현장"
        title="현장 입장 관리"
        description="키오스크·POS·게이트 스캐너의 입장 판정이 실시간으로 모입니다. 캡처 화면 재사용, 같은 티켓의 다른 게이트 중복 사용, 차단·제재 티켓은 자동으로 막고 모든 단말에 알립니다."
        actions={
          <>
            <Pill tone={live === "live" ? "success" : live === "connecting" ? "default" : "danger"}>
              {live === "live" ? <Wifi className="size-3.5" /> : <WifiOff className="size-3.5" />}
              {live === "live" ? "실시간 연결" : live === "connecting" ? "연결 중" : "연결 끊김 — 30초마다 갱신"}
            </Pill>
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              <RefreshCcw className="size-4" /> 새로고침
            </Button>
          </>
        }
      />

      {alerts.length ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4" role="alert">
          <p className="flex items-center gap-2 text-sm font-bold text-destructive">
            <AlertTriangle className="size-4" /> 부정 사용 탐지 {alerts.length}건 — 모든 단말에 공유되었습니다
          </p>
          <ul className="mt-2 space-y-1 text-sm">
            {alerts.slice(0, 4).map((a, i) => (
              <li key={`${a.at}-${i}`} className="text-foreground">
                <span className="font-mono">{a.ticket_no ?? "-"}</span> · {CODE_LABEL[a.code] ?? a.code} · {a.terminal_name ?? a.gate} ·{" "}
                <span className="text-content-subtle">{formatDateTimeSecKst(a.at)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="입장한 티켓"
          value={overview ? `${overview.totals.admitted_tickets.toLocaleString("ko-KR")} / ${overview.totals.tickets.toLocaleString("ko-KR")}` : "-"}
          hint={overview && overview.totals.tickets ? `${Math.round((overview.totals.admitted_tickets / overview.totals.tickets) * 100)}% 입장` : undefined}
          icon={Ticket}
          tone="primary"
        />
        <StatCard label="입장 판정(24시간)" value={(totals.admitted ?? 0).toLocaleString("ko-KR")} icon={CheckCircle2} tone="success" />
        <StatCard label="재입장" value={(totals.reentry_ok ?? 0).toLocaleString("ko-KR")} icon={Repeat2} />
        <StatCard label="거부 / 부정 탐지" value={`${rejected} / ${fraud}`} icon={ShieldAlert} tone={fraud ? "danger" : "default"} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          <Section title="분당 입장 (최근 60분)" description={`TimescaleDB 1분 집계 · 저장 방식 ${series?.mode ?? "-"}`}>
            {perMinute.length === 0 ? (
              <p className="text-sm text-content-subtle">아직 기록이 없습니다.</p>
            ) : (
              <div className="flex h-36 items-end gap-px border-b border-border-subtle" aria-label="분당 입장 막대 차트">
                {perMinute.map((m) => (
                  <div key={m.bucket} className="flex h-full flex-1 flex-col justify-end" title={`${formatDateTimeSecKst(m.bucket)} · 입장 ${m.admitted} · 거부 ${m.rejected}`}>
                    <span className="block rounded-t-sm bg-destructive/70" style={{ height: `${(m.rejected / maxMinute) * 100}%` }} />
                    <span className="block bg-primary" style={{ height: `${(m.admitted / maxMinute) * 100}%` }} />
                  </div>
                ))}
              </div>
            )}
            <div className="mt-2 flex gap-4 text-xs text-content-subtle">
              <span className="flex items-center gap-1">
                <span className="size-2.5 rounded-sm bg-primary" /> 입장·재입장
              </span>
              <span className="flex items-center gap-1">
                <span className="size-2.5 rounded-sm bg-destructive/70" /> 거부
              </span>
            </div>
          </Section>

          <Section title="게이트별 현황" description="최근 24시간">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {Object.entries(overview?.by_gate ?? {}).map(([gate, g]) => (
                <div key={gate} className="rounded-md border border-border-subtle p-3">
                  <p className="flex items-center gap-1.5 text-sm font-bold text-foreground">
                    <DoorOpen className="size-4 text-primary" /> {gate}
                  </p>
                  <p className="mt-2 text-xs text-content-subtle">
                    입장 <b className="text-foreground">{g.admitted}</b> · 재입장 <b className="text-foreground">{g.reentry_ok}</b> · 거부{" "}
                    <b className={g.rejected ? "text-destructive" : "text-foreground"}>{g.rejected}</b>
                  </p>
                </div>
              ))}
              {Object.keys(overview?.by_gate ?? {}).length === 0 ? <p className="text-sm text-content-subtle">아직 판정이 없습니다.</p> : null}
            </div>
          </Section>

          {overview ? <TerminalPanel eventId={eventId} overview={overview} onChanged={() => void load()} /> : null}
        </div>

        <div className="space-y-6">
          <Section title="실시간 판정" description="단말에서 들어오는 판정이 바로 쌓입니다.">
            <ul className="max-h-[28rem] space-y-1.5 overflow-auto pr-1">
              {feed.map((d, i) => (
                <li
                  key={`${d.at}-${i}`}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-3 py-2 text-sm",
                    d.result === "rejected" ? (d.fraud ? "bg-destructive/10" : "bg-warning/10") : "bg-success/5",
                  )}
                >
                  <span
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      d.result === "rejected" ? (d.fraud ? "bg-destructive" : "bg-warning") : "bg-success",
                    )}
                  />
                  <span className="w-24 shrink-0 whitespace-nowrap font-semibold text-foreground">{CODE_LABEL[d.code] ?? d.code}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-content-subtle">
                    {d.ticket_no ?? "-"}
                    {d.holder ? ` · ${d.holder}` : ""}
                    {d.tier ? ` · ${d.tier}` : ""}
                  </span>
                  <span className="shrink-0 text-xs text-content-subtle">{d.gate}</span>
                </li>
              ))}
              {feed.length === 0 ? <li className="text-sm text-content-subtle">아직 판정이 없습니다.</li> : null}
            </ul>
          </Section>
          {overview ? <BlockPanel eventId={eventId} overview={overview} onChanged={() => void load()} /> : null}
          <SanctionPanel eventId={eventId} data={sanctions} onChanged={() => void load()} />
        </div>
      </div>
    </div>
  );
}

function bump(prev: OnsiteOverview, d: LiveDecision): OnsiteOverview {
  const key = d.result === "rejected" ? `rejected:${d.code}` : d.result;
  const by_result = { ...prev.totals.by_result, [key]: (prev.totals.by_result[key] ?? 0) + 1 };
  const gate = d.gate ?? "-";
  const g = prev.by_gate[gate] ?? { admitted: 0, reentry_ok: 0, rejected: 0 };
  const field = d.result as "admitted" | "reentry_ok" | "rejected";
  return {
    ...prev,
    totals: {
      ...prev.totals,
      by_result,
      admitted_tickets: prev.totals.admitted_tickets + (d.result === "admitted" ? 1 : 0),
    },
    by_gate: { ...prev.by_gate, [gate]: { ...g, [field]: (g[field] ?? 0) + 1 } },
  };
}

/** 최근 60분을 1분 칸 60개로 고정한다 — 기록이 한 칸뿐이어도 막대가 화면을 꽉 채우지 않게. */
function buildPerMinute(series: TimeseriesView | null) {
  const counts = new Map<number, { admitted: number; rejected: number }>();
  for (const b of series?.buckets ?? []) {
    const minute = Math.floor(new Date(b.bucket).getTime() / 60_000);
    const row = counts.get(minute) ?? { admitted: 0, rejected: 0 };
    if (b.result === "rejected") row.rejected += b.n;
    else row.admitted += b.n;
    counts.set(minute, row);
  }
  if (counts.size === 0) return [];
  const last = Math.floor(Date.now() / 60_000);
  return Array.from({ length: 60 }, (_, i) => {
    const minute = last - 59 + i;
    const row = counts.get(minute) ?? { admitted: 0, rejected: 0 };
    return { bucket: new Date(minute * 60_000).toISOString(), ...row };
  });
}
