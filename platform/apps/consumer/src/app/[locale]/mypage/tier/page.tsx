"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { motion } from "motion/react";
import { useAuthReady } from "@/providers/AuthProvider";
import {
  ArrowLeft,
  Crown,
  Star,
  TrendingUp,
  Zap,
  ChevronRight,
  Sparkles,
  Gift,
  Shield,
  Trophy,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@pickket/ui";
import { useAuthStore } from "@pickket/store";
import { getMyTier, getUserProfile } from "@pickket/lib/api";
import { useQuery } from "@tanstack/react-query";

/* ---------- Types ---------- */

interface TierInfo {
  tier: string;
  score: number;
  multiplier: number;
}

/* ---------- Constants ---------- */

const TIERS = [
  {
    key: "rookie",
    icon: Star,
    threshold: 0,
    multiplier: 1.0,
    color: "bg-gray-400",
    textColor: "text-gray-600 dark:text-gray-400",
    gradient: "from-gray-300 to-gray-400",
    benefitKeys: ["benefit_basic_lottery", "benefit_daily_quests"],
  },
  {
    key: "fan",
    icon: Zap,
    threshold: 1000,
    multiplier: 1.05,
    color: "bg-green-500",
    textColor: "text-green-600 dark:text-green-400",
    gradient: "from-green-400 to-emerald-500",
    benefitKeys: [
      "benefit_1_05x",
      "benefit_weekly_quests",
      "benefit_fan_badge",
    ],
  },
  {
    key: "supporter",
    icon: Shield,
    threshold: 5000,
    multiplier: 1.1,
    color: "bg-blue-500",
    textColor: "text-primary/70",
    gradient: "from-blue-400 to-cyan-500",
    benefitKeys: [
      "benefit_1_10x",
      "benefit_early_bird",
      "benefit_supporter_badge",
      "benefit_limited_shop",
    ],
  },
  {
    key: "corefan",
    icon: Trophy,
    threshold: 15000,
    multiplier: 1.15,
    color: "bg-purple-500",
    textColor: "text-purple-600 dark:text-purple-400",
    gradient: "from-purple-400 to-violet-500",
    benefitKeys: [
      "benefit_1_15x",
      "benefit_priority_entry",
      "benefit_corefan_badge",
      "benefit_exclusive_events",
      "benefit_resale_discount",
    ],
  },
  {
    key: "legend",
    icon: Crown,
    threshold: 50000,
    multiplier: 1.2,
    color: "bg-amber-500",
    textColor: "text-amber-600 dark:text-amber-400",
    gradient: "from-amber-400 to-orange-500",
    benefitKeys: [
      "benefit_1_20x",
      "benefit_vip_lounge",
      "benefit_legend_badge",
      "benefit_all_priority",
      "benefit_resale_free",
      "benefit_exclusive_goods",
    ],
  },
];

const THRESHOLD_LABELS = ["0", "1K", "5K", "15K", "50K"];

/* ---------- Skeleton ---------- */

function TierSkeleton() {
  return (
    <div className="min-h-screen bg-background p-6 pt-24">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center gap-3 mb-8">
          <div className="h-10 w-10 bg-muted rounded-full animate-pulse" />
          <div className="h-6 w-32 bg-muted rounded animate-pulse" />
        </div>
        <div className="bg-card rounded-2xl shadow-lg p-6 mb-6 border border-border">
          <div className="h-20 bg-muted rounded-xl animate-pulse mb-4" />
          <div className="h-4 bg-muted rounded animate-pulse w-1/2 mb-2" />
          <div className="h-3 bg-muted rounded animate-pulse w-1/3" />
        </div>
        <div className="h-16 bg-muted rounded-2xl animate-pulse mb-6" />
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-24 bg-muted rounded-2xl animate-pulse" />
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------- Component ---------- */

export default function TierPage() {
  const router = useRouter();
  const { user } = useAuthStore();
  const authReady = useAuthReady();
  const t = useTranslations("tier");

  const { data: tierInfo, isLoading: loading } = useQuery<TierInfo | null>({
    queryKey: ["user", "tier"],
    queryFn: async () => {
      try {
        const res = await getMyTier();
        return res.data;
      } catch {
        // Fallback: use /users/me
        const userRes = await getUserProfile();
        const u = userRes.data;
        const tier = u.membership_tier ?? "rookie";
        const score = u.tier_score ?? 0;
        const match = TIERS.find((t) => t.key === tier);
        return {
          tier,
          score,
          multiplier: match?.multiplier ?? 1.0,
        };
      }
    },
    enabled: !!user,
  });

  useEffect(() => {
    if (authReady && !user) {
      router.push("/auth");
    }
  }, [authReady, user, router]);

  if (!authReady) return null;
  if (!user) return null;

  if (loading) return <TierSkeleton />;

  const currentTierKey = tierInfo?.tier ?? "rookie";
  const currentScore = tierInfo?.score ?? 0;
  const currentMultiplier = tierInfo?.multiplier ?? 1.0;
  // tierInfo is TierInfo | null | undefined from useQuery

  const currentTierIndex = TIERS.findIndex((t) => t.key === currentTierKey);
  const currentTier = TIERS[currentTierIndex] ?? TIERS[0];
  const nextTier =
    currentTierIndex < TIERS.length - 1 ? TIERS[currentTierIndex + 1] : null;

  const TierIcon = currentTier.icon;

  // Progress within current tier segment
  const currentThreshold = currentTier.threshold;
  const nextThreshold = nextTier?.threshold ?? currentTier.threshold;
  const segmentProgress =
    nextTier && nextThreshold > currentThreshold
      ? Math.min(
          100,
          ((currentScore - currentThreshold) /
            (nextThreshold - currentThreshold)) *
            100,
        )
      : 100;

  const scoreToNext = nextTier
    ? Math.max(0, nextTier.threshold - currentScore)
    : 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: "easeOut" }}
      className="min-h-screen bg-background pt-24"
    >
      <div className="max-w-7xl mx-auto px-8 pb-5">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <Link href="/mypage">
            <Button variant="ghost" size="icon" className="rounded-full">
              <ArrowLeft className="h-5 w-5" />
            </Button>
          </Link>
          <div className="flex items-center gap-2">
            <Crown className="h-5 w-5 text-primary/70" />
            <h1 className="text-xl font-bold text-foreground">{t("title")}</h1>
          </div>
        </div>

        {/* Hero Card */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className={`bg-gradient-to-br ${currentTier.gradient} rounded-2xl shadow-lg p-6 mb-6 text-white relative overflow-hidden`}
        >
          {/* Decorative circles */}
          <div className="absolute top-0 right-0 w-32 h-32 rounded-full bg-white/10 -translate-y-1/2 translate-x-1/2" />
          <div className="absolute bottom-0 left-0 w-24 h-24 rounded-full bg-white/5 translate-y-1/2 -translate-x-1/2" />

          <div className="relative z-10">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="h-14 w-14 rounded-2xl bg-white/20 backdrop-blur-sm flex items-center justify-center">
                  <TierIcon className="h-7 w-7 text-white" />
                </div>
                <div>
                  <p className="text-white/80 text-sm font-medium">
                    {t("current")}
                  </p>
                  <h2 className="text-2xl font-bold">{t(currentTier.key)}</h2>
                </div>
              </div>
              <div className="text-right">
                <p className="text-white/80 text-sm">{t("multiplier")}</p>
                <p className="text-2xl font-bold">
                  {currentMultiplier.toFixed(2)}x
                </p>
              </div>
            </div>

            <div className="flex items-center justify-between text-sm">
              <span className="text-white/80">
                {t("score")}:{" "}
                <span className="text-white font-bold">
                  {currentScore.toLocaleString()}
                </span>
              </span>
              {nextTier && (
                <span className="text-white/80">
                  {t("next_until", { points: scoreToNext.toLocaleString() })}
                </span>
              )}
            </div>

            {/* Progress to next tier */}
            {nextTier && (
              <div className="mt-3">
                <div className="h-2 bg-white/20 rounded-full overflow-hidden">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${segmentProgress}%` }}
                    transition={{ duration: 0.8, ease: "easeOut", delay: 0.3 }}
                    className="h-full bg-white rounded-full"
                  />
                </div>
              </div>
            )}
            {!nextTier && (
              <p className="text-white/80 text-sm mt-3 flex items-center gap-1">
                <Sparkles className="h-4 w-4" />
                {t("max_reached")}
              </p>
            )}
          </div>
        </motion.div>

        {/* 5-Step Progress Bar */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="bg-card rounded-2xl shadow-lg p-5 lg:p-6 mb-6 border border-border"
        >
          <h3 className="font-bold text-foreground mb-5 flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-primary/70" />
            {t("progress_title")}
          </h3>

          {/* Steps */}
          <div className="flex items-center gap-0">
            {TIERS.map((tier, i) => {
              const StepIcon = tier.icon;
              const isActive = i <= currentTierIndex;
              const isCurrent = i === currentTierIndex;

              return (
                <div
                  key={tier.key}
                  className="flex-1 flex flex-col items-center relative"
                >
                  {/* Connector line */}
                  {i > 0 && (
                    <div
                      className={`absolute top-5 right-1/2 w-full h-0.5 -z-10 ${
                        i <= currentTierIndex ? "bg-primary" : "bg-muted"
                      }`}
                    />
                  )}
                  {/* Step Circle */}
                  <div
                    className={`h-10 w-10 rounded-full flex items-center justify-center transition-all z-10 ${
                      isCurrent
                        ? "bg-primary text-white ring-4 ring-primary/20 scale-110"
                        : isActive
                          ? "bg-primary text-white"
                          : "bg-muted text-muted-foreground"
                    }`}
                  >
                    <StepIcon className="h-4 w-4" />
                  </div>
                  {/* Label */}
                  <p
                    className={`text-xs font-medium mt-2 ${
                      isCurrent
                        ? "text-primary/70 font-bold"
                        : isActive
                          ? "text-foreground"
                          : "text-muted-foreground"
                    }`}
                  >
                    {t(tier.key)}
                  </p>
                  {/* Threshold */}
                  <p className="text-2xs text-muted-foreground mt-0.5">
                    {THRESHOLD_LABELS[i]}
                  </p>
                </div>
              );
            })}
          </div>
        </motion.div>

        {/* Next Tier Info */}
        {nextTier && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.25 }}
            className="bg-card rounded-2xl shadow-lg p-5 lg:p-6 mb-6 border border-border"
          >
            <div className="flex items-center gap-3 mb-3">
              <div
                className={`h-10 w-10 rounded-full bg-gradient-to-br ${nextTier.gradient} flex items-center justify-center`}
              >
                {(() => {
                  const NextIcon = nextTier.icon;
                  return <NextIcon className="h-5 w-5 text-white" />;
                })()}
              </div>
              <div>
                <p className="text-sm text-muted-foreground">
                  {t("next_goal")}
                </p>
                <p className="font-bold text-foreground">
                  {t(nextTier.key)}{" "}
                  <span className="text-sm font-normal text-muted-foreground">
                    ({nextTier.multiplier.toFixed(2)}x)
                  </span>
                </p>
              </div>
              <div className="ml-auto text-right">
                <p className="text-xs text-muted-foreground">
                  {t("remaining_score")}
                </p>
                <p className="font-bold text-primary/70">
                  {scoreToNext.toLocaleString()}
                </p>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{t("score_hint")}</p>
          </motion.div>
        )}

        {/* Tier Benefits Section */}
        <h3 className="font-bold text-foreground mb-4 flex items-center gap-2">
          <Gift className="h-4 w-4 text-primary/70" />
          {t("benefits")}
        </h3>

        <div className="space-y-3">
          {TIERS.map((tier, index) => {
            const StepIcon = tier.icon;
            const isCurrentOrBelow = index <= currentTierIndex;

            return (
              <motion.div
                key={tier.key}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3 + index * 0.05 }}
                className={`bg-card rounded-2xl shadow-lg p-5 lg:p-6 border border-border ${
                  tier.key === currentTierKey ? "ring-2 ring-primary/30" : ""
                }`}
              >
                <div className="flex items-center gap-3 mb-3">
                  <div
                    className={`h-9 w-9 rounded-full flex items-center justify-center ${
                      isCurrentOrBelow
                        ? `bg-gradient-to-br ${tier.gradient} text-white`
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    <StepIcon className="h-4 w-4" />
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <p className="font-semibold text-foreground text-sm">
                        {t(tier.key)}
                      </p>
                      {tier.key === currentTierKey && (
                        <span className="text-2xs font-bold bg-primary/10 text-primary/70 dark:bg-primary/20 dark:text-primary/70 px-2 py-0.5 rounded-full">
                          {t("current")}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t("threshold_info", {
                        threshold: tier.threshold.toLocaleString(),
                        multiplier: tier.multiplier.toFixed(2),
                      })}
                    </p>
                  </div>
                </div>
                <ul className="space-y-1.5 ml-12">
                  {tier.benefitKeys.map((key, bi) => (
                    <li
                      key={bi}
                      className="text-xs text-muted-foreground flex items-start gap-2"
                    >
                      <ChevronRight className="h-3 w-3 mt-0.5 text-primary/70 flex-shrink-0" />
                      {t(key)}
                    </li>
                  ))}
                </ul>
              </motion.div>
            );
          })}
        </div>
      </div>
    </motion.div>
  );
}
