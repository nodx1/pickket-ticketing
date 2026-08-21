"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuthReady } from "@/providers/AuthProvider";
import Link from "next/link";
import { motion } from "motion/react";
import {
  ArrowLeft,
  CalendarCheck,
  Flame,
  Swords,
  CheckCircle2,
  Circle,
  Coins,
  Target,
  Clock,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@pickket/ui";
import { useAuthStore } from "@pickket/store";
import {
  getDailyQuests,
  getWeeklyQuests,
  getAttendanceStreak,
  questCheckIn,
  type Quest,
  type StreakInfo,
} from "@pickket/lib/api";
import { useTranslations } from "next-intl";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

/* Extended streak type — API may or may not include UI-specific fields
   depending on backend version. Defaults are applied in component. */
type StreakDisplay = StreakInfo & {
  checked_in_today?: boolean;
  weekly_checkins?: boolean[];
  current_streak?: number;
};

/* ---------- Skeleton ---------- */

function QuestSkeleton() {
  return (
    <div className="bg-card rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] p-5 lg:p-6 border border-border">
      <div className="flex items-center gap-4">
        <div className="h-10 w-10 bg-muted rounded-full animate-pulse" />
        <div className="flex-1 space-y-2">
          <div className="h-4 bg-muted rounded animate-pulse w-2/3" />
          <div className="h-3 bg-muted rounded animate-pulse w-1/3" />
        </div>
        <div className="h-8 w-20 bg-muted rounded-xl animate-pulse" />
      </div>
    </div>
  );
}

/* ---------- Component ---------- */

export default function QuestsPage() {
  const router = useRouter();
  const { user } = useAuthStore();
  const t = useTranslations("quests");
  const DAY_LABELS = [
    t("day_mon"),
    t("day_tue"),
    t("day_wed"),
    t("day_thu"),
    t("day_fri"),
    t("day_sat"),
    t("day_sun"),
  ];

  const queryClient = useQueryClient();

  const { data: questData, isLoading: loading } = useQuery({
    queryKey: ["user", "quests"],
    queryFn: async () => {
      const [dRes, wRes, sRes] = await Promise.allSettled([
        getDailyQuests(),
        getWeeklyQuests(),
        getAttendanceStreak(),
      ]);

      const dailyQuests: Quest[] =
        dRes.status === "fulfilled"
          ? (dRes.value.data?.quests ?? dRes.value.data ?? [])
          : [];
      const weeklyQuests: Quest[] =
        wRes.status === "fulfilled"
          ? (wRes.value.data?.quests ?? wRes.value.data ?? [])
          : [];
      const streak: StreakDisplay | null =
        sRes.status === "fulfilled" ? (sRes.value.data ?? sRes.value) : null;

      if (dRes.status === "rejected") toast.error(t("load_error"));
      if (wRes.status === "rejected") toast.error(t("load_error"));
      if (sRes.status === "rejected") toast.error(t("load_error"));

      return { dailyQuests, weeklyQuests, streak };
    },
    enabled: !!user,
  });

  const dailyQuests = questData?.dailyQuests ?? [];
  const weeklyQuests = questData?.weeklyQuests ?? [];
  const streak = questData?.streak ?? null;

  const checkInMutation = useMutation({
    mutationFn: () => questCheckIn(),
    onSuccess: () => {
      toast.success(t("checkin_success"));
      queryClient.invalidateQueries({ queryKey: ["user", "quests"] });
    },
    onError: (err: unknown) => {
      // axios 에러는 response.data.detail/message 에 backend 메시지가 들어있음
      const ax = err as {
        response?: { data?: { detail?: string; message?: string } };
        message?: string;
      };
      const msg =
        ax.response?.data?.detail ??
        ax.response?.data?.message ??
        ax.message ??
        t("checkin_error");
      toast.error(msg);
    },
  });

  const handleCheckIn = () => checkInMutation.mutate();
  const checkingIn = checkInMutation.isPending;

  // Auth hydrate 끝난 후에만 redirect — 첫 렌더 user=null 로 잘못 튕기는 거 방지
  const authReady = useAuthReady();
  useEffect(() => {
    if (authReady && !user) {
      router.push("/auth");
    }
  }, [authReady, user, router]);

  if (!authReady) return null;
  if (!user) return null;

  /* ---------- Loading ---------- */
  if (loading) {
    return (
      <div className="min-h-screen bg-background p-6 pt-24">
        <div className="max-w-7xl mx-auto">
          <div className="flex items-center gap-3 mb-8">
            <div className="h-10 w-10 bg-muted rounded-full animate-pulse" />
            <div className="h-6 w-32 bg-muted rounded animate-pulse" />
          </div>
          <div className="bg-card rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] p-5 lg:p-6 mb-6 border border-border">
            <div className="h-32 bg-muted rounded-xl animate-pulse" />
          </div>
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <QuestSkeleton key={i} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  const checkedInToday = streak?.checked_in_today ?? false;
  const weeklyCheckins = streak?.weekly_checkins ?? Array(7).fill(false);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: "easeOut" }}
      className="min-h-screen bg-background pt-24"
    >
      <div className="max-w-7xl mx-auto px-8 pb-5">
        {/* Header */}
        <div className="flex items-center gap-3 mb-8">
          <Link href="/mypage">
            <Button variant="ghost" size="icon" className="rounded-full">
              <ArrowLeft className="h-5 w-5" />
            </Button>
          </Link>
          <div className="flex items-center gap-2">
            <Swords className="h-5 w-5 text-primary" />
            <h1 className="text-xl font-bold text-foreground">{t("title")}</h1>
          </div>
        </div>

        {/* Attendance Check-in Card */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="bg-card rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] p-5 lg:p-6 mb-8 border border-border"
        >
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <CalendarCheck className="h-5 w-5 text-primary" />
              <h2 className="font-bold text-foreground">
                {t("checkin_title")}
              </h2>
            </div>
            {streak && (
              <div className="flex items-center gap-1.5 text-sm">
                <Flame className="h-4 w-4 text-orange-500" />
                <span className="font-semibold text-foreground">
                  {streak.current_streak ?? streak.consecutive_weeks ?? 0}
                  {t("streak_days", { count: streak.current_week_days ?? 0 })}
                </span>
              </div>
            )}
          </div>

          {/* Weekly Streak Display */}
          <div className="flex justify-between gap-2 mb-5">
            {DAY_LABELS.map((day, i) => {
              const checked = weeklyCheckins[i];
              return (
                <div key={day} className="flex flex-col items-center gap-1.5">
                  <div
                    role="status"
                    aria-label={`${day} ${checked ? t("completed") : ""}`}
                    className={`h-10 w-10 rounded-full flex items-center justify-center transition-colors ${
                      checked
                        ? "bg-primary text-white"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {checked ? (
                      <CheckCircle2 className="h-5 w-5" />
                    ) : (
                      <Circle className="h-5 w-5" />
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground font-medium">
                    {day}
                  </span>
                </div>
              );
            })}
          </div>

          <Button
            className="w-full rounded-xl"
            size="lg"
            disabled={checkedInToday || checkingIn}
            onClick={handleCheckIn}
          >
            {checkingIn
              ? t("checkin_loading")
              : checkedInToday
                ? t("checkin_done")
                : t("checkin_button")}
          </Button>
        </motion.div>

        {/* Daily Quests */}
        <section className="mb-8">
          <div className="flex items-center gap-2 mb-4">
            <Target className="h-5 w-5 text-amber-500" />
            <h2 className="font-bold text-foreground">{t("daily")}</h2>
            <span className="text-xs text-muted-foreground ml-auto flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {t("daily_reset")}
            </span>
          </div>

          {dailyQuests.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <div className="h-14 w-14 rounded-2xl bg-gradient-to-br from-amber-100 to-orange-100 dark:from-amber-900/20 dark:to-orange-900/20 flex items-center justify-center mb-3">
                <Target className="h-7 w-7 text-amber-400 dark:text-amber-500" />
              </div>
              <p className="text-sm text-muted-foreground">{t("no_daily")}</p>
            </div>
          ) : (
            <div className="space-y-3">
              {dailyQuests.map((quest, index) => (
                <motion.div
                  key={quest.id}
                  initial={{ opacity: 0, x: -12 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.15 + index * 0.05 }}
                  className={`bg-card rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] p-5 lg:p-6 border border-border flex items-center gap-4 ${
                    quest.completed ? "opacity-70" : ""
                  }`}
                >
                  <div
                    className={`h-10 w-10 rounded-full flex items-center justify-center flex-shrink-0 ${
                      quest.completed
                        ? "bg-green-100 dark:bg-green-900/20"
                        : "bg-amber-100 dark:bg-amber-900/20"
                    }`}
                  >
                    {quest.completed ? (
                      <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400" />
                    ) : (
                      <Target className="h-5 w-5 text-amber-600 dark:text-amber-400" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p
                      className={`font-semibold text-sm ${
                        quest.completed
                          ? "text-muted-foreground line-through"
                          : "text-foreground"
                      }`}
                    >
                      {quest.title}
                    </p>
                    {quest.description && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {quest.description}
                      </p>
                    )}
                    {quest.goal !== undefined &&
                      quest.progress !== undefined && (
                        <div className="mt-2">
                          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                            <div
                              className="h-full bg-primary rounded-full transition-all"
                              style={{
                                width: `${Math.min(
                                  100,
                                  (quest.progress / (quest.goal || 1)) * 100,
                                )}%`,
                              }}
                            />
                          </div>
                          <span className="text-xs text-muted-foreground mt-1">
                            {quest.progress}/{quest.goal}
                          </span>
                        </div>
                      )}
                  </div>
                  <div className="flex items-center gap-1 text-sm font-bold text-primary flex-shrink-0">
                    <Coins className="h-3.5 w-3.5" />+{quest.ap_reward}
                  </div>
                </motion.div>
              ))}
            </div>
          )}
        </section>

        {/* Weekly Quests */}
        <section className="mb-8">
          <div className="flex items-center gap-2 mb-4">
            <Swords className="h-5 w-5 text-violet-500" />
            <h2 className="font-bold text-foreground">{t("weekly")}</h2>
            <span className="text-xs text-muted-foreground ml-auto flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {t("weekly_reset")}
            </span>
          </div>

          {weeklyQuests.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <div className="h-14 w-14 rounded-2xl bg-gradient-to-br from-violet-100 to-purple-100 dark:from-violet-900/20 dark:to-purple-900/20 flex items-center justify-center mb-3">
                <Swords className="h-7 w-7 text-violet-400 dark:text-violet-500" />
              </div>
              <p className="text-sm text-muted-foreground">{t("no_weekly")}</p>
            </div>
          ) : (
            <div className="space-y-3">
              {weeklyQuests.map((quest, index) => (
                <motion.div
                  key={quest.id}
                  initial={{ opacity: 0, x: -12 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.2 + index * 0.05 }}
                  className={`bg-card rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] p-5 lg:p-6 border border-border flex items-center gap-4 ${
                    quest.completed ? "opacity-70" : ""
                  }`}
                >
                  <div
                    className={`h-10 w-10 rounded-full flex items-center justify-center flex-shrink-0 ${
                      quest.completed
                        ? "bg-green-100 dark:bg-green-900/20"
                        : "bg-violet-100 dark:bg-violet-900/20"
                    }`}
                  >
                    {quest.completed ? (
                      <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400" />
                    ) : (
                      <Swords className="h-5 w-5 text-violet-600 dark:text-violet-400" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p
                      className={`font-semibold text-sm ${
                        quest.completed
                          ? "text-muted-foreground line-through"
                          : "text-foreground"
                      }`}
                    >
                      {quest.title}
                    </p>
                    {quest.description && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {quest.description}
                      </p>
                    )}
                    {quest.goal !== undefined &&
                      quest.progress !== undefined && (
                        <div className="mt-2">
                          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                            <div
                              className="h-full bg-violet-500 rounded-full transition-all"
                              style={{
                                width: `${Math.min(
                                  100,
                                  (quest.progress / (quest.goal || 1)) * 100,
                                )}%`,
                              }}
                            />
                          </div>
                          <span className="text-xs text-muted-foreground mt-1">
                            {quest.progress}/{quest.goal}
                          </span>
                        </div>
                      )}
                  </div>
                  <div className="flex items-center gap-1 text-sm font-bold text-primary flex-shrink-0">
                    <Coins className="h-3.5 w-3.5" />+{quest.ap_reward}
                  </div>
                </motion.div>
              ))}
            </div>
          )}
        </section>
      </div>
    </motion.div>
  );
}
