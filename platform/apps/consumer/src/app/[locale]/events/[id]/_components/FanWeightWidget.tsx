"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { motion } from "motion/react";
import { Trophy, Zap, TrendingUp, CheckCircle, Gift } from "lucide-react";
import {
  getMyTier,
  getPointBalance,
  getWeeklyQuests,
  questCheckIn,
  getAttendanceStreak,
} from "@pickket/lib/api";
import { useAuthStore } from "@pickket/store";
import { fmt } from "../detail-helpers";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

// Tier mapping
const TIER_CONFIG: Record<
  string,
  { labelKey: string; color: string; icon: string; level: number }
> = {
  rookie: { labelKey: "tierRookie", color: "text-gray-400", icon: "🌱", level: 1 },
  fan: { labelKey: "tierFan", color: "text-sky-400", icon: "⭐", level: 2 },
  supporter: {
    labelKey: "tierSupporter",
    color: "text-amber-400",
    icon: "🏅",
    level: 3,
  },
  corefan: { labelKey: "tierCoreFan", color: "text-blue-400", icon: "💎", level: 4 },
  legend: { labelKey: "tierLegend", color: "text-amber-300", icon: "👑", level: 5 },
};

export function FanWeightWidget() {
  const t = useTranslations("event.fanWeight");
  const user = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();
  const [checkedIn, setCheckedIn] = useState(false);

  const { data: fanWidgetData } = useQuery({
    queryKey: ["user", "fanWeightWidget"],
    queryFn: async () => {
      const [tierRes, pointsRes, questsRes, streakRes] =
        await Promise.allSettled([
          getMyTier(),
          getPointBalance(),
          getWeeklyQuests(),
          getAttendanceStreak(),
        ]);
      return {
        tier: tierRes.status === "fulfilled" ? tierRes.value.data : null,
        points: pointsRes.status === "fulfilled" ? pointsRes.value.data : null,
        quests:
          questsRes.status === "fulfilled"
            ? (questsRes.value.data?.quests ?? questsRes.value.data ?? [])
            : [],
        streak: streakRes.status === "fulfilled" ? streakRes.value.data : null,
      };
    },
    enabled: !!user,
  });

  const tier = fanWidgetData?.tier ?? null;
  const points = fanWidgetData?.points ?? null;
  const quests = fanWidgetData?.quests ?? [];
  const streak = fanWidgetData?.streak ?? null;

  const checkInMutation = useMutation({
    mutationFn: () => questCheckIn(),
    onSuccess: () => {
      setCheckedIn(true);
      queryClient.invalidateQueries({ queryKey: ["user", "fanWeightWidget"] });
    },
    onError: (e: unknown) => {
      const status = (e as { response?: { status?: number } })?.response
        ?.status;
      if (status === 409) setCheckedIn(true);
    },
  });

  const handleCheckIn = () => {
    if (checkInMutation.isPending || checkedIn) return;
    checkInMutation.mutate();
  };
  const checkingIn = checkInMutation.isPending;

  if (!user) return null;

  const tierConfig = tier
    ? (TIER_CONFIG[tier.tier] ?? TIER_CONFIG.rookie)
    : TIER_CONFIG.rookie;
  const progress = tier?.next_threshold
    ? Math.min((tier.tier_score / tier.next_threshold) * 100, 100)
    : 100;
  const completedQuests = quests.filter(
    (q: { completed: boolean }) => q.completed,
  ).length;

  return (
    <div className="space-y-3">
      {/* Tier + Points compact card */}
      <div className="rounded-2xl border border-border bg-card shadow-sm p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-lg">{tierConfig.icon}</span>
            <div>
              <span className={`text-sm font-bold ${tierConfig.color}`}>
                {t(tierConfig.labelKey)}
              </span>
              {tier?.multiplier && (
                <span className="ml-2 text-xs text-muted-foreground">
                  {t("multiplier", { value: tier.multiplier.toFixed(2) })}
                </span>
              )}
            </div>
          </div>
          {points && (
            <div className="flex items-center gap-3 text-xs">
              <span className="flex items-center gap-1 text-primary/70">
                <Zap className="h-3 w-3" /> {fmt(points.fan)} AP
              </span>
            </div>
          )}
        </div>

        {/* Tier progress bar */}
        {tier?.next_tier && (
          <div className="space-y-1">
            <div className="flex justify-between text-2xs text-muted-foreground">
              <span>{t(tierConfig.labelKey)}</span>
              <span>
                {TIER_CONFIG[tier.next_tier]
                  ? t(TIER_CONFIG[tier.next_tier].labelKey)
                  : tier.next_tier}
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
              <motion.div
                className="h-full rounded-full bg-primary"
                initial={{ width: 0 }}
                animate={{ width: `${progress}%` }}
                transition={{ duration: 1, ease: "easeOut" }}
              />
            </div>
          </div>
        )}

        {/* "활동하면 유리해요" banner */}
        <div className="flex items-center gap-2 p-2 rounded-lg bg-primary/10 text-xs">
          <TrendingUp className="h-3.5 w-3.5 text-primary/70" />
          <span className="text-primary/70 font-medium">
            {t("activityBanner")}
          </span>
        </div>
      </div>

      {/* Check-in + Quests row */}
      <div className="flex gap-3">
        {/* Daily check-in button */}
        <button
          onClick={handleCheckIn}
          disabled={checkedIn || checkingIn}
          className={`flex-1 rounded-2xl border border-border p-3 text-center transition-all ${
            checkedIn
              ? "bg-emerald-600/10 border-emerald-600/20"
              : "bg-card hover:bg-white/5"
          }`}
        >
          <div className="flex items-center justify-center gap-2">
            {checkedIn ? (
              <CheckCircle className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <Gift className="h-4 w-4 text-primary/70" />
            )}
            <span
              className={`text-sm font-medium ${checkedIn ? "text-emerald-600 dark:text-emerald-400" : "text-foreground"}`}
            >
              {checkedIn ? t("checkInDone") : t("checkIn")}
            </span>
          </div>
          {streak && (
            <p className="text-2xs text-muted-foreground mt-1">
              {t("streakInfo", {
                weekDays: streak.current_week_days ?? 0,
                weeks: streak.consecutive_weeks ?? 0,
              })}
            </p>
          )}
        </button>

        {/* Quest progress */}
        <div className="flex-1 rounded-2xl border border-border bg-card p-3">
          <div className="flex items-center gap-2 mb-1">
            <Trophy className="h-4 w-4 text-amber-400" />
            <span className="text-sm font-medium text-foreground">{t("quests")}</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex-1 h-1.5 rounded-full bg-white/10 overflow-hidden">
              <motion.div
                className="h-full rounded-full bg-amber-400"
                initial={{ width: 0 }}
                animate={{
                  width:
                    quests.length > 0
                      ? `${(completedQuests / quests.length) * 100}%`
                      : "0%",
                }}
                transition={{ duration: 0.8 }}
              />
            </div>
            <span className="text-2xs text-muted-foreground">
              {completedQuests}/{quests.length}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
