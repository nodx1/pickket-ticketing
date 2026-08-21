"use client";

/**
 * 공정 추첨 응모 현황 (주최자).
 *
 * 데이터 소스: GET /api/events/{id}/lottery-stats → v2 `/api/v1/internal/events/{id}/lottery-stats` 프록시.
 * v2 가 응모/좌석 배정/order 생성 전담이라 go 는 집계만 조회해서 표시.
 * 당첨자 개별 정보는 표시하지 않음 (프라이버시 + v2 admin 관리).
 */
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import {
  CalendarClock,
  Coins,
  Dices,
  Gavel,
  Hourglass,
  Lock,
  RefreshCcw,
  Trophy,
  Users,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { fetchWithAuth } from "@/lib/fetchWithAuth";
import { formatDateTimeSecKst } from "@/lib/format";

type Phase = "pre_apply" | "applying" | "closed" | "drawing" | "drawn";

interface LotteryStats {
  eventId: string;
  phase: Phase;
  stats: {
    totalEntries: number;
    totalApplicants: number;
    totalSeats: number;
    competitionRatio: number;
    winnersCount: number | null;
    waitlistedCount: number | null;
    losersCount: number | null;
    totalApInvested: number;
    avgApPerEntry: number;
  };
  byTier: Array<{
    tierId: string;
    tierName: string;
    seats: number;
    entries: number;
    applicants: number;
    competitionRatio: number;
    winnersCount: number | null;
    totalApInvested: number;
    saleMode?: "point_lottery" | "fixed_fcfs" | string;
    fcfsConvertedAt?: string | null;
  }>;
  drawExecutedAt: string | null;
  anyFcfsConverted?: boolean;
}

const PHASE_META: Record<Phase, { label: string; tone: string; icon: LucideIcon }> = {
  pre_apply: { label: "응모 예정", tone: "bg-muted text-content-subtle", icon: CalendarClock },
  applying: { label: "응모 접수 중", tone: "bg-warning/10 text-warning", icon: Hourglass },
  closed: { label: "응모 마감", tone: "bg-muted text-foreground", icon: Lock },
  drawing: { label: "추첨 실행 중", tone: "bg-primary/10 text-primary animate-pulse", icon: Dices },
  drawn: { label: "추첨 완료", tone: "bg-success/10 text-success", icon: Trophy },
};

export default function BidsPage() {
  const { eventId } = useParams<{ eventId: string }>();
  const [data, setData] = useState<LotteryStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchStats = useCallback(
    async (isRefresh = false) => {
      if (isRefresh) setRefreshing(true);
      try {
        const res = await fetchWithAuth<{ success: boolean; data: LotteryStats }>(
          `/api/events/${eventId}/lottery-stats`,
        );
        if (res.success) setData(res.data);
      } catch {
        // ignore
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [eventId],
  );

  useEffect(() => {
    void fetchStats();
    const timer = setInterval(() => {
      void fetchStats(true);
    }, 30_000);
    return () => clearInterval(timer);
  }, [fetchStats]);

  if (loading) {
    return (
      <div className="space-y-6">
        <SkeletonHeader />
      </div>
    );
  }

  const phase = data?.phase ?? "pre_apply";
  const phaseMeta = PHASE_META[phase];
  const PhaseIcon = phaseMeta.icon;
  const isPostDraw = phase === "drawing" || phase === "drawn";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm text-content-subtle">공정 추첨 응모 현황</p>
          <h2 className="mt-2 text-3xl font-black tracking-[-0.04em] text-foreground">
            응모 현황
          </h2>
          <div className="mt-3 flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${phaseMeta.tone}`}
            >
              <PhaseIcon className="size-3.5 shrink-0" />
              {phaseMeta.label}
            </span>
            {data?.drawExecutedAt && (
              <span className="text-xs text-content-subtle">
                추첨일: {formatDateTimeSecKst(data.drawExecutedAt)}
              </span>
            )}
          </div>
        </div>
        <Button variant="outline" onClick={() => void fetchStats(true)}>
          <RefreshCcw className={`size-4 ${refreshing ? "animate-spin" : ""}`} />
          새로고침
        </Button>
      </div>

      {data?.anyFcfsConverted && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 text-sm">
          <p className="font-semibold text-primary">⏱ 선착순 전환 알림</p>
          <p className="mt-1 text-xs text-foreground/70">
            대기자 소진 조건을 충족한 구역이 자동으로 선착순 판매로 전환됐습니다. 구역별 상세는 아래 테이블에서 확인하세요.
          </p>
        </div>
      )}

      {!data || data.stats.totalEntries === 0 ? (
        <div className="rounded-lg border border-border bg-card p-12 text-center">
          <div className="mx-auto flex size-16 items-center justify-center rounded-2xl bg-primary/10">
            <Gavel className="size-8 text-primary" />
          </div>
          <h3 className="mt-4 text-lg font-bold text-foreground">아직 응모가 없습니다</h3>
          <p className="mt-2 text-sm text-content-subtle">
            추첨 응모가 접수되면 여기에 실시간 통계가 표시됩니다.
          </p>
        </div>
      ) : (
        <>
          {/* 핵심 KPI 4개 */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <KpiCard
              icon={Users}
              label="응모자"
              value={`${data.stats.totalApplicants.toLocaleString()}명`}
              sub={`총 ${data.stats.totalEntries.toLocaleString()}건 응모`}
              tone="default"
            />
            <KpiCard
              icon={Gavel}
              label="경쟁률"
              value={`${data.stats.competitionRatio.toFixed(2)}:1`}
              sub={`좌석 ${data.stats.totalSeats.toLocaleString()}석`}
              tone="primary"
            />
            <KpiCard
              icon={Trophy}
              label="당첨자"
              value={
                isPostDraw && data.stats.winnersCount !== null
                  ? `${data.stats.winnersCount.toLocaleString()}명`
                  : "-"
              }
              sub={
                isPostDraw && data.stats.losersCount !== null
                  ? `낙첨 ${data.stats.losersCount.toLocaleString()}`
                  : "추첨 전"
              }
              tone="success"
            />
            <KpiCard
              icon={Hourglass}
              label="대기자"
              value={
                isPostDraw && data.stats.waitlistedCount !== null
                  ? `${data.stats.waitlistedCount.toLocaleString()}명`
                  : "-"
              }
              sub={isPostDraw ? "승격 대상" : "추첨 전"}
              tone="warning"
            />
          </div>

          {/* AP 투입 요약 */}
          <div className="rounded-lg border border-border bg-card p-5">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Coins className="size-4 text-primary" />
              AP 투입 현황
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Stat
                label="총 투입 AP"
                value={`${data.stats.totalApInvested.toLocaleString()} AP`}
              />
              <Stat
                label="응모당 평균"
                value={`${Math.round(data.stats.avgApPerEntry).toLocaleString()} AP`}
              />
              <Stat label="1 AP" value="₩1 상당" muted />
            </div>
          </div>

          {/* 구역별 */}
          {data.byTier.length > 0 && (
            <div className="rounded-lg border border-border bg-card">
              <div className="border-b border-border px-5 py-4">
                <h3 className="text-sm font-semibold text-foreground">구역별 응모</h3>
              </div>
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-content-muted">
                    <th className="px-5 py-3">구역</th>
                    <th className="px-5 py-3 text-right">좌석</th>
                    <th className="px-5 py-3 text-right">응모자</th>
                    <th className="px-5 py-3 text-right">응모 수</th>
                    <th className="px-5 py-3 text-right">경쟁률</th>
                    <th className="px-5 py-3 text-right">당첨</th>
                    <th className="px-5 py-3 text-right">AP 투입</th>
                    <th className="px-5 py-3 text-center">판매 모드</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byTier.map((tier) => {
                    const isFcfs = tier.saleMode === "fixed_fcfs";
                    return (
                      <tr
                        key={tier.tierId}
                        className="border-b border-border last:border-0"
                      >
                        <td className="px-5 py-3 text-sm font-semibold text-foreground">
                          {tier.tierName}
                        </td>
                        <td className="px-5 py-3 text-right text-sm">{tier.seats}</td>
                        <td className="px-5 py-3 text-right text-sm">
                          {tier.applicants.toLocaleString()}
                        </td>
                        <td className="px-5 py-3 text-right text-sm">
                          {tier.entries.toLocaleString()}
                        </td>
                        <td className="px-5 py-3 text-right text-sm font-mono">
                          {tier.competitionRatio.toFixed(2)}:1
                        </td>
                        <td className="px-5 py-3 text-right text-sm">
                          {tier.winnersCount !== null
                            ? tier.winnersCount.toLocaleString()
                            : "-"}
                        </td>
                        <td className="px-5 py-3 text-right text-sm text-content-muted">
                          {tier.totalApInvested.toLocaleString()}
                        </td>
                        <td className="px-5 py-3 text-center text-xs">
                          {isFcfs ? (
                            <div className="flex flex-col items-center gap-0.5">
                              <span className="rounded-full bg-primary/10 px-2 py-0.5 font-semibold text-primary">
                                ⏱ 선착순 전환됨
                              </span>
                              {tier.fcfsConvertedAt && (
                                <span className="text-[10px] text-content-muted">
                                  {formatDateTimeSecKst(tier.fcfsConvertedAt)}
                                </span>
                              )}
                            </div>
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-content-muted">
                              <Dices className="size-3 shrink-0" />
                              공정 추첨
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function KpiCard({
  icon: Icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: typeof Users;
  label: string;
  value: string;
  sub: string;
  tone: "default" | "primary" | "success" | "warning";
}) {
  const valueClass = {
    default: "text-foreground",
    primary: "text-primary",
    success: "text-success",
    warning: "text-warning",
  }[tone];
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-1.5 text-xs text-content-muted">
        <Icon className="size-3.5" />
        {label}
      </div>
      <p className={`mt-2 text-2xl font-black ${valueClass}`}>{value}</p>
      <p className="mt-1 text-xs text-content-subtle">{sub}</p>
    </div>
  );
}

function Stat({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div>
      <p className="text-xs text-content-muted">{label}</p>
      <p
        className={`mt-0.5 text-lg font-bold ${muted ? "text-content-subtle" : "text-foreground"}`}
      >
        {value}
      </p>
    </div>
  );
}

function SkeletonHeader() {
  return (
    <div className="animate-pulse rounded-lg border border-border bg-card p-6">
      <div className="h-5 w-48 rounded bg-bg-muted" />
      <div className="mt-3 h-8 w-32 rounded bg-bg-muted" />
    </div>
  );
}
