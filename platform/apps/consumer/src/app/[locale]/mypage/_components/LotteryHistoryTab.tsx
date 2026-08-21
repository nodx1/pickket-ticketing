"use client";

import { useRouter } from "next/navigation";
import {
  Clock,
  Trophy,
  Hourglass,
  XCircle,
  Sparkles,
  CreditCard,
} from "lucide-react";
import { Badge } from "@pickket/ui";
import { Button } from "@pickket/ui";
import { useQuery } from "@tanstack/react-query";
import {
  getMyLotteryHistory,
  type MyLotteryHistoryEntry,
} from "@pickket/lib/api";
import { useTranslations } from "next-intl";

const STATUS_CONFIG: Record<
  string,
  { labelKey: string; color: string; icon: typeof Trophy }
> = {
  pending: {
    labelKey: "statusPending",
    color:
      "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
    icon: Hourglass,
  },
  won: {
    labelKey: "statusWon",
    color:
      "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
    icon: Trophy,
  },
  waitlisted: {
    // 동적 라벨은 EntryCard 에서 t('statusWaitlisted', { position }) 로 덮어씀
    labelKey: "statusWaitlistedBase",
    color:
      "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
    icon: Clock,
  },
  lost: {
    labelKey: "statusLost",
    color: "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400",
    icon: XCircle,
  },
};

type TranslateFn = ReturnType<typeof useTranslations<"mypage.lotteryHistory">>;

function getResultLabel(entry: MyLotteryHistoryEntry, t: TranslateFn): string {
  if (entry.result === "waitlisted" && entry.waitlist_position) {
    return t("statusWaitlisted", { position: entry.waitlist_position ?? 0 });
  }
  const key = STATUS_CONFIG[entry.result]?.labelKey ?? "statusPending";
  return t(key as Parameters<TranslateFn>[0]);
}

function EntryCard({ entry }: { entry: MyLotteryHistoryEntry }) {
  const router = useRouter();
  const t = useTranslations("mypage.lotteryHistory");
  const config = STATUS_CONFIG[entry.result] ?? STATUS_CONFIG.pending;
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

  return (
    <div className="rounded-2xl border border-border bg-background shadow-sm overflow-hidden">
      <div className="flex gap-4 p-4">
        {/* 이벤트 이미지 */}
        {entry.event_image_url && (
          // eslint-disable-next-line @next/next/no-img-element -- 외부 도메인 이미지 URL, next/image remotePatterns 없이 fill 불가
          <img
            src={entry.event_image_url}
            alt={entry.event_title}
            className="w-16 h-20 rounded-lg object-cover shrink-0"
          />
        )}

        <div className="flex-1 min-w-0">
          {/* 이벤트 제목 + 상태 */}
          <div className="flex items-start justify-between gap-2 mb-1">
            <button
              type="button"
              onClick={() => router.push(`/events/${entry.event_id}`)}
              className="text-sm font-bold text-foreground hover:text-primary transition-colors text-left truncate"
            >
              {entry.event_title}
            </button>
            <Badge
              className={`text-2xs rounded-full px-2 py-0.5 shrink-0 ${config.color}`}
            >
              <StatusIcon className="h-3 w-3 mr-0.5 inline" />
              {getResultLabel(entry, t)}
            </Badge>
          </div>

          {/* 정보 */}
          <div className="text-xs text-muted-foreground space-y-0.5">
            <div>
              {entry.tier_name} · {t("tickets", { count: entry.group_size ?? 0 })}
            </div>
            {eventDate && <div>{eventDate}</div>}
            <div>{t("appliedAt", { date: appliedDate })}</div>
            {entry.invested_ap > 0 && (
              <div className="text-primary">
                {t("apInvested", { amount: entry.invested_ap.toLocaleString() })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 당첨 → 결제 버튼 */}
      {entry.result === "won" && entry.order_id && (
        <div className="px-4 pb-4">
          <Button
            size="sm"
            onClick={() =>
              router.push(`/events/${entry.event_id}/booking?lottery_pay=1`)
            }
            className="w-full rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white"
          >
            <CreditCard className="h-3.5 w-3.5 mr-1.5" />
            {t("payNow")}
            {entry.payment_deadline && (
              <span className="ml-1 opacity-75 text-2xs">
                {t("payDeadline", {
                  date: new Date(entry.payment_deadline).toLocaleDateString("ko-KR", {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  }),
                })}
              </span>
            )}
          </Button>
        </div>
      )}
    </div>
  );
}

export default function LotteryHistoryTab() {
  const t = useTranslations("mypage.lotteryHistory");
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

  if (!data || data.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <Sparkles className="h-12 w-12 text-muted-foreground/30 mb-4" />
        <p className="text-sm text-muted-foreground">
          {t("emptyTitle")}
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          {t("emptyDescription")}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {data.map((entry) => (
        <EntryCard key={entry.entry_id} entry={entry} />
      ))}
    </div>
  );
}
