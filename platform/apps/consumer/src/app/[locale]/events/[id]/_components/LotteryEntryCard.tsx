"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import {
  Zap,
  Users,
  Trophy,
  Clock,
  Shield,
  XCircle,
  CheckCircle2,
} from "lucide-react";
import { Badge } from "@pickket/ui";
import {
  getLotteryStatus,
  getMyLotteryResult,
  type SeatTier,
} from "@pickket/lib/api";
import { formatKRW } from "@pickket/lib";

interface LotteryEntryCardProps {
  eventId: string;
  entryId: string;
  lotteryStatus: string | null; // "pending" | "won" | "waitlisted" | "lost"
  investedAp: number;
  groupSize: number;
  tierId: string | null;
  poolId: string | null;
  tiers: SeatTier[];
  /** waitlisted 인 경우 pool 내 FIFO 순번 (1-based) */
  waitlistPosition?: number | null;
}

interface PoolStats {
  totalSeats: number;
  totalApplicants: number;
  status: string;
}

interface WeightBreakdown {
  loyalty: number;
  history: number;
  fanclub: number;
  behavior: number;
  freshness: number;
}

const STATUS_CONFIG: Record<
  string,
  { label: string; color: string; icon: typeof Trophy }
> = {
  pending: {
    label: "추첨 대기중",
    color:
      "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
    icon: Clock,
  },
  won: {
    label: "당첨",
    color:
      "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
    icon: Trophy,
  },
  waitlisted: {
    label: "대기",
    color:
      "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
    icon: Clock,
  },
};

const WEIGHT_LABEL_KEYS: Record<string, string> = {
  loyalty: "weightLoyalty",
  history: "weightHistory",
  fanclub: "weightFanclub",
  behavior: "weightBehavior",
  freshness: "weightFreshness",
};

function WeightBar({ label, value }: { label: string; value: number }) {
  const pct = Math.min(100, Math.round(value * 100));
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-muted-foreground w-20 shrink-0">
        {label}
      </span>
      <div className="flex-1 h-1.5 rounded-full bg-border overflow-hidden">
        <div
          className="h-full rounded-full bg-primary transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs font-medium text-foreground tabular-nums w-8 text-right">
        {pct}%
      </span>
    </div>
  );
}

export default function LotteryEntryCard({
  eventId,
  entryId: _entryId,
  lotteryStatus,
  investedAp,
  groupSize,
  tierId,
  poolId,
  tiers,
  waitlistPosition,
}: LotteryEntryCardProps) {
  const t = useTranslations("event.lotteryEntryCard");
  const [pool, setPool] = useState<PoolStats | null>(null);
  const [weights, setWeights] = useState<WeightBreakdown | null>(null);

  const tier = tiers.find((t) => t.id === tierId);
  const tierPrice = tier ? (tier.face_price ?? tier.base_price) : 0;
  const status = lotteryStatus ?? "pending";
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.pending;
  const _StatusIcon = config.icon;

  // 상태별 배지: 응모중=응모 완료, 당첨=당첨, 대기=대기 N순위, 낙첨=미당첨
  const badgeConfig = (() => {
    if (status === "won")
      return {
        label: t("badgeWon"),
        icon: Trophy,
        cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
      };
    if (status === "waitlisted")
      return {
        label: waitlistPosition
          ? t("badgeWaitlistedRank", { rank: waitlistPosition ?? 0 })
          : t("badgeWaitlisted"),
        icon: Clock,
        cls: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
      };
    if (status === "lost")
      return {
        label: t("badgeLost"),
        icon: XCircle,
        cls: "bg-muted text-muted-foreground",
      };
    return {
      label: t("badgeEntered"),
      icon: CheckCircle2,
      cls: "bg-muted text-muted-foreground",
    };
  })();
  const BadgeIcon = badgeConfig.icon;

  useEffect(() => {
    if (!tierId) return;
    getLotteryStatus(eventId, tierId)
      .then((res) => {
        const d = res.data;
        setPool({
          totalSeats: d.total_seats,
          totalApplicants: d.total_applicants,
          status: d.status,
        });
      })
      .catch((err: unknown) => {
        const name = (err as { name?: string })?.name;
        if (name === "CanceledError" || name === "AbortError") return;
        console.error("[LotteryEntryCard] getLotteryStatus failed:", err);
      });
  }, [eventId, tierId]);

  useEffect(() => {
    if (!poolId || status === "pending") return;
    getMyLotteryResult(poolId)
      .then((res) => {
        const d = res.data;
        if (d.weight_breakdown) setWeights(d.weight_breakdown);
      })
      .catch((err: unknown) => {
        const name = (err as { name?: string })?.name;
        if (name === "CanceledError" || name === "AbortError") return;
        console.error("[LotteryEntryCard] getMyLotteryResult failed:", err);
      });
  }, [poolId, status]);

  const competitionRatio =
    pool && pool.totalSeats > 0
      ? (pool.totalApplicants / pool.totalSeats).toFixed(1)
      : null;

  return (
    <div className="mt-4 rounded-2xl bg-background border border-border dark:border-white/10 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-border">
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center">
            <Zap className="h-4 w-4 text-primary" />
          </div>
          <span className="text-sm font-bold text-foreground">
            {t("title")}
          </span>
        </div>
        <Badge
          className={`text-xs rounded-full px-2.5 py-0.5 ${badgeConfig.cls}`}
        >
          <BadgeIcon className="h-3 w-3 mr-1 inline" />
          {badgeConfig.label}
        </Badge>
      </div>

      <div className="px-5 py-4 space-y-4">
        {/* Info Grid */}
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-xl bg-muted/50 p-3">
            <p className="text-xs text-muted-foreground mb-0.5">{t("labelZone")}</p>
            <p className="text-sm font-bold text-foreground">
              {tier?.name ?? "—"}
            </p>
          </div>
          <div className="rounded-xl bg-muted/50 p-3">
            <p className="text-xs text-muted-foreground mb-0.5">{t("labelTickets")}</p>
            <p className="text-sm font-bold text-foreground">{t("ticketCount", { count: groupSize ?? 0 })}</p>
          </div>
          <div className="rounded-xl bg-amber-500/5 border border-amber-500/20 p-3">
            <p className="text-xs text-muted-foreground mb-0.5">{t("labelInvestedAp")}</p>
            <p className="text-sm font-bold text-primary">
              {investedAp.toLocaleString()} AP
            </p>
          </div>
          <div className="rounded-xl bg-muted/50 p-3">
            <p className="text-xs text-muted-foreground mb-0.5">{t("labelPayOnWin")}</p>
            <p className="text-sm font-bold text-emerald-600 dark:text-emerald-400">
              {formatKRW(tierPrice * groupSize)}
            </p>
          </div>
        </div>

        {/* Competition Stats */}
        {pool && (
          <div className="rounded-xl bg-muted/30 p-3 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Users className="h-3.5 w-3.5" />
                {t("competitionRatio")}
              </span>
              <span className="font-bold text-foreground">
                {competitionRatio}:1
                <span className="text-muted-foreground font-normal ml-1">
                  {t("competitionDetail", { applicants: pool.totalApplicants ?? 0, seats: pool.totalSeats ?? 0 })}
                </span>
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-border overflow-hidden">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{
                  width: `${Math.min(100, (pool.totalApplicants / Math.max(1, pool.totalSeats)) * 100)}%`,
                }}
              />
            </div>
          </div>
        )}

        {/* Weight Breakdown (after draw only) */}
        {weights && (
          <div className="space-y-2">
            <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
              <Shield className="h-3.5 w-3.5" />{t("fanWeight")}
            </p>
            <div className="space-y-2">
              {Object.entries(WEIGHT_LABEL_KEYS).map(([key, tKey]) => (
                <WeightBar
                  key={key}
                  label={t(tKey as Parameters<typeof t>[0])}
                  value={
                    (weights as unknown as Record<string, number>)[key] ?? 0
                  }
                />
              ))}
            </div>
          </div>
        )}

        {/* Footer Action */}
        {status === "won" && (
          <Link
            href="/mypage?tab=bids"
            className="block w-full py-3 rounded-xl bg-primary text-white font-bold text-sm text-center hover:brightness-110 transition-all"
          >
            {t("ctaCheckWin")}
          </Link>
        )}
        {status === "pending" && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/50 rounded-xl p-3">
            <Clock className="h-3.5 w-3.5 shrink-0" />
            <span>{t("msgPending")}</span>
          </div>
        )}
        {status === "waitlisted" && (
          <div className="flex items-center gap-2 text-xs text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-900/10 rounded-xl p-3">
            <Clock className="h-3.5 w-3.5 shrink-0" />
            <span>
              {waitlistPosition
                ? t("msgWaitlistedRank", { rank: waitlistPosition ?? 0 })
                : t("msgWaitlisted")}
            </span>
          </div>
        )}
        {status === "lost" && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/50 rounded-xl p-3">
            <XCircle className="h-3.5 w-3.5 shrink-0" />
            <span>{t("msgLost")}</span>
          </div>
        )}
      </div>
    </div>
  );
}
