"use client";

import Link from "next/link";
import { Clock, Trophy, Hourglass, XCircle, Sparkles } from "lucide-react";
import { Badge } from "@pickket/ui";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  getMyLotteryHistory,
  type MyLotteryHistoryEntry,
} from "@pickket/lib/api";

const STATUS_CONFIG: Record<
  string,
  { color: string; icon: typeof Trophy }
> = {
  pending: {
    color:
      "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
    icon: Hourglass,
  },
  won: {
    color:
      "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
    icon: Trophy,
  },
  won_expired: {
    color: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
    icon: Clock,
  },
  waitlisted: {
    color:
      "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
    icon: Clock,
  },
  lost: {
    color: "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400",
    icon: XCircle,
  },
};

function isWonExpired(entry: MyLotteryHistoryEntry): boolean {
  // 당첨됐는데 결제 기한 만료 or 취소
  return (
    entry.result === "won" &&
    (entry.lottery_order_status === "expired" ||
      entry.lottery_order_status === "cancelled")
  );
}

function getResultLabel(
  entry: MyLotteryHistoryEntry,
  t: ReturnType<typeof useTranslations<"mypage.bidHistory">>,
): string {
  // 당첨 + 결제 만료/취소 → "결제 기한 만료" 표시
  if (isWonExpired(entry)) {
    return t("status.wonExpired");
  }
  // 매진된 tier 의 waitlisted → 사실상 낙첨. "대기 N순위" 대신 "낙첨" 표시.
  if (entry.result === "waitlisted" && entry.is_tier_sold_out) {
    return t("status.lost");
  }
  if (entry.result === "waitlisted" && entry.waitlist_position) {
    return t("status.waitlistPosition", { position: entry.waitlist_position ?? 0 });
  }
  const statusKey = entry.result as keyof typeof STATUS_CONFIG;
  if (statusKey === "pending") return t("status.pending");
  if (statusKey === "won") return t("status.won");
  if (statusKey === "lost") return t("status.lost");
  return entry.result;
}

function getEffectiveResult(entry: MyLotteryHistoryEntry): string {
  // 배지 색/아이콘 결정용
  if (isWonExpired(entry)) return "won_expired";
  if (entry.result === "waitlisted" && entry.is_tier_sold_out) return "lost";
  return entry.result;
}

function EntryCard({ entry }: { entry: MyLotteryHistoryEntry }) {
  const t = useTranslations("mypage.bidHistory");
  const effectiveResult = getEffectiveResult(entry);
  const config = STATUS_CONFIG[effectiveResult] ?? STATUS_CONFIG.pending;
  const StatusIcon = config.icon;

  const appliedDate = new Date(entry.applied_at).toLocaleDateString("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const eventDate = entry.event_date
    ? new Date(entry.event_date).toLocaleDateString("ko-KR", {
        month: "long",
        day: "numeric",
        weekday: "short",
      })
    : null;

  // 당첨 + 결제 기한 남아있는 카드만 결제 페이지로 직행 (만료된 당첨은 이벤트 상세).
  const canPay =
    entry.result === "won" &&
    entry.payment_deadline &&
    entry.lottery_order_status === "payment_required";
  const href = canPay
    ? `/events/${entry.event_id}/booking?lottery_pay=1`
    : `/events/${entry.event_id}`;

  return (
    <Link
      href={href}
      className="block rounded-2xl border border-border bg-background shadow-sm overflow-hidden cursor-pointer hover:border-primary/40 hover:bg-card/40 transition-colors"
    >
      <div className="flex gap-4 p-4">
        {entry.event_image_url && (
          // eslint-disable-next-line @next/next/no-img-element -- 외부 도메인 이미지 URL, next/image remotePatterns 없이 fill 불가
          <img
            src={entry.event_image_url}
            alt={entry.event_title}
            className="w-16 h-20 rounded-lg object-cover shrink-0"
          />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2 mb-1">
            <span className="text-sm font-bold text-foreground truncate">
              {entry.event_title}
            </span>
            <Badge
              className={`text-2xs rounded-full px-2 py-0.5 shrink-0 ${config.color}`}
            >
              <StatusIcon className="h-3 w-3 mr-0.5 inline" />
              {getResultLabel(entry, t)}
            </Badge>
          </div>
          <div className="text-xs text-muted-foreground space-y-0.5">
            <div>
              {entry.tier_name} · {t("groupSize", { count: entry.group_size ?? 0 })}
            </div>
            {eventDate && <div>{eventDate}</div>}
            <div>{t("appliedDate", { date: appliedDate })}</div>
            {entry.invested_ap > 0 && (
              <div className="text-primary">
                {t("investedAp", { amount: entry.invested_ap.toLocaleString() })}
              </div>
            )}
          </div>
        </div>
      </div>
      {canPay && (
        <div className="mx-4 mb-4 px-4 py-3 rounded-xl bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 flex items-center gap-2">
          <Trophy className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
          <div className="flex-1 text-sm text-emerald-700 dark:text-emerald-400 font-medium">
            {t("payNowPrompt")}
          </div>
          <span className="text-2xs text-emerald-600 dark:text-emerald-400/70 shrink-0">
            {t("payDeadlinePrefix")}{" "}
            {new Date(entry.payment_deadline!).toLocaleDateString("ko-KR", {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        </div>
      )}
    </Link>
  );
}

export default function BidHistoryTab() {
  const t = useTranslations("mypage.bidHistory");
  const { data, isLoading } = useQuery({
    queryKey: ["myLotteryHistory"],
    queryFn: async () => {
      const res = await getMyLotteryHistory();
      return res.data.entries;
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-24 rounded-2xl bg-muted animate-pulse" />
        ))}
      </div>
    );
  }

  const entries = data ?? [];
  const totalEntries = entries.length;
  const wonCount = entries.filter((e) => e.result === "won").length;
  const _lostCount = entries.filter((e) => e.result === "lost").length;
  // "대기중" = 추첨 전 pending + 추첨 후 waitlisted (승격 대기)
  // 둘 다 유저 관점에선 "아직 결과 확정 안 된" 상태
  const pendingCount = entries.filter(
    (e) => e.result === "pending" || e.result === "waitlisted",
  ).length;
  const _winRate =
    totalEntries > 0 ? ((wonCount / totalEntries) * 100).toFixed(1) : "0.0";

  return (
    <div className="space-y-4">
      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-2xl border border-border p-4">
          <div className="text-xs text-muted-foreground mb-1">{t("stats.totalEntries")}</div>
          <div className="text-2xl font-bold">{totalEntries}</div>
        </div>
        <div className="rounded-2xl border border-border p-4">
          <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
            <Trophy className="h-3 w-3" /> {t("stats.won")}
          </div>
          <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{wonCount}</div>
        </div>
        <div className="rounded-2xl border border-border p-4">
          <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
            <Hourglass className="h-3 w-3" /> {t("stats.pending")}
          </div>
          <div className="text-2xl font-bold text-amber-600 dark:text-amber-400">
            {pendingCount}
          </div>
        </div>
      </div>

      {/* 응모 목록 */}
      {entries.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Sparkles className="h-12 w-12 text-muted-foreground/30 mb-4" />
          <p className="text-sm text-muted-foreground">
            {t("empty.noHistory")}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            {t("empty.cta")}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {entries.map((entry) => (
            <EntryCard key={entry.entry_id} entry={entry} />
          ))}
        </div>
      )}
    </div>
  );
}
