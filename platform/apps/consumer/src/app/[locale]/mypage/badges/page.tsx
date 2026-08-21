"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuthReady } from "@/providers/AuthProvider";
import Link from "next/link";
import { motion } from "motion/react";
import {
  ArrowLeft,
  Award,
  Trophy,
  Star,
  Flame,
  Crown,
  Gem,
  Medal,
  Sparkles,
  Lock,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@pickket/ui";
import { useAuthStore } from "@pickket/store";
import { getMyBadges } from "@pickket/lib/api";
import { useQuery } from "@tanstack/react-query";

/* ---------- Types ---------- */

// Local type matches API response shape (is_earned vs shared type's "earned")
interface Badge {
  id: string;
  name: string;
  description?: string;
  category: string;
  icon?: string;
  is_earned: boolean;
  earned_at?: string;
  rarity?: string;
}

/* ---------- Constants ---------- */

const BADGE_CATEGORIES = [
  { value: "all", labelKey: "all" },
  { value: "domain", labelKey: "domain" },
  { value: "tier", labelKey: "tier_cat" },
  { value: "season", labelKey: "season" },
  { value: "milestone", labelKey: "milestone" },
] as const;

const CATEGORY_GRADIENTS: Record<string, string> = {
  domain: "from-blue-400 to-cyan-400",
  tier: "from-amber-400 to-orange-400",
  season: "from-green-400 to-emerald-400",
  milestone: "from-purple-400 to-violet-400",
};

const CATEGORY_ICONS: Record<string, typeof Award> = {
  domain: Star,
  tier: Crown,
  season: Flame,
  milestone: Trophy,
};

const RARITY_COLORS: Record<string, string> = {
  common: "text-gray-500",
  rare: "text-blue-500",
  epic: "text-purple-500",
  legendary: "text-amber-500",
};

/* ---------- Skeleton ---------- */

function BadgeSkeleton() {
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="h-14 w-14 bg-muted rounded-full animate-pulse" />
      <div className="h-3 w-12 bg-muted rounded animate-pulse" />
    </div>
  );
}

/* ---------- Component ---------- */

export default function BadgesPage() {
  const router = useRouter();
  const { user } = useAuthStore();
  const authReady = useAuthReady();
  const t = useTranslations("badges");

  const [category, setCategory] = useState("all");

  const { data: badges = [], isLoading: loading } = useQuery<Badge[]>({
    queryKey: ["user", "badges"],
    queryFn: async () => {
      const res = await getMyBadges();
      return res.data?.badges ?? res.data ?? [];
    },
    enabled: !!user,
  });

  // Auth hydrate 끝난 후에만 redirect — 첫 렌더 user=null 로 잘못 튕기는 거 방지
  useEffect(() => {
    if (authReady && !user) {
      router.push("/auth");
    }
  }, [authReady, user, router]);

  if (!authReady) return null;
  if (!user) return null;

  const filteredBadges =
    category === "all" ? badges : badges.filter((b) => b.category === category);

  const earnedCount = badges.filter((b) => b.is_earned).length;

  /* ---------- Loading ---------- */
  if (loading) {
    return (
      <div className="min-h-screen bg-background p-6 pt-24">
        <div className="max-w-7xl mx-auto">
          <div className="flex items-center gap-3 mb-8">
            <div className="h-10 w-10 bg-muted rounded-full animate-pulse" />
            <div className="h-6 w-24 bg-muted rounded animate-pulse" />
          </div>
          <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-6">
            {Array.from({ length: 12 }).map((_, i) => (
              <BadgeSkeleton key={i} />
            ))}
          </div>
        </div>
      </div>
    );
  }

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
            <Award className="h-5 w-5 text-primary/70" />
            <h1 className="text-xl font-bold text-foreground">{t("title")}</h1>
            {badges.length > 0 && (
              <span className="text-sm text-muted-foreground ml-1">
                ({earnedCount}/{badges.length})
              </span>
            )}
          </div>
        </div>

        {/* Stats Card */}
        {badges.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="bg-card rounded-2xl shadow-lg p-5 lg:p-6 mb-6 border border-border"
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">
                  {t("collection")}
                </p>
                <p className="text-2xl font-bold text-foreground mt-1">
                  {earnedCount}
                  <span className="text-base font-normal text-muted-foreground">
                    /{badges.length}
                  </span>
                </p>
              </div>
              <div className="h-14 w-14 rounded-2xl bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center">
                <Gem className="h-7 w-7 text-primary/70" />
              </div>
            </div>
            {/* Progress Bar */}
            <div className="mt-4">
              <div
                className="h-2 bg-muted rounded-full overflow-hidden"
                role="progressbar"
                aria-valuenow={earnedCount}
                aria-valuemin={0}
                aria-valuemax={badges.length}
                aria-label={t("collection")}
              >
                <motion.div
                  initial={{ width: 0 }}
                  animate={{
                    width: `${badges.length > 0 ? (earnedCount / badges.length) * 100 : 0}%`,
                  }}
                  transition={{ duration: 0.8, ease: "easeOut", delay: 0.3 }}
                  className="h-full bg-gradient-to-r from-primary to-primary/70 rounded-full"
                />
              </div>
              <p className="text-xs text-muted-foreground mt-1.5">
                {Math.round(
                  badges.length > 0 ? (earnedCount / badges.length) * 100 : 0,
                )}
                % {t("collection")}
              </p>
            </div>
          </motion.div>
        )}

        {/* Category Filter */}
        <div className="flex gap-2 overflow-x-auto pb-4 scrollbar-hide mb-2">
          {BADGE_CATEGORIES.map((cat) => (
            <button
              key={cat.value}
              onClick={() => setCategory(cat.value)}
              aria-pressed={category === cat.value}
              className={`px-3.5 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-colors ${
                category === cat.value
                  ? "bg-foreground text-background"
                  : "bg-muted text-muted-foreground hover:bg-muted"
              }`}
            >
              {t(cat.labelKey)}
            </button>
          ))}
        </div>

        {/* Badge Grid */}
        {filteredBadges.length === 0 ? (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.1 }}
            className="flex flex-col items-center justify-center py-20 text-center"
          >
            <div className="relative mb-6">
              <div className="h-20 w-20 rounded-2xl bg-gradient-to-br from-amber-100 to-orange-100 dark:from-amber-900/20 dark:to-orange-900/20 flex items-center justify-center">
                <Award className="h-10 w-10 text-amber-400 dark:text-amber-500" />
              </div>
            </div>
            <h2 className="text-lg font-semibold text-foreground mb-2">
              {t("no_badges")}
            </h2>
            <p className="text-sm text-muted-foreground mb-6 max-w-sm">
              {t("no_badges_desc")}
            </p>
            <Link href="/mypage/quests">
              <Button className="rounded-xl bg-gradient-to-r from-primary to-primary/70 text-white px-6">
                <Sparkles className="h-4 w-4 mr-2" />
                {t("go_quests")}
              </Button>
            </Link>
          </motion.div>
        ) : (
          <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-5">
            {filteredBadges.map((badge, index) => {
              const gradient =
                CATEGORY_GRADIENTS[badge.category] ??
                "from-gray-400 to-gray-500";
              const CategoryIcon = CATEGORY_ICONS[badge.category] ?? Medal;
              const rarityColor =
                RARITY_COLORS[badge.rarity ?? "common"] ?? "text-gray-500";

              return (
                <motion.div
                  key={badge.id}
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{
                    delay: index * 0.03,
                    duration: 0.3,
                    ease: "easeOut",
                  }}
                  className="flex flex-col items-center gap-2 group"
                  title={badge.description ?? badge.name}
                >
                  {/* Badge Circle */}
                  <div className="relative">
                    <div
                      className={`h-14 w-14 rounded-full flex items-center justify-center transition-transform group-hover:scale-110 ${
                        badge.is_earned
                          ? `bg-gradient-to-br ${gradient} shadow-lg`
                          : "bg-muted border-2 border-dashed border-border"
                      }`}
                    >
                      {badge.is_earned ? (
                        <CategoryIcon className="h-6 w-6 text-white" />
                      ) : (
                        <Lock className="h-5 w-5 text-muted-foreground/50" />
                      )}
                    </div>
                    {badge.rarity &&
                      badge.is_earned &&
                      badge.rarity !== "common" && (
                        <div
                          className={`absolute -top-1 -right-1 h-4 w-4 rounded-full bg-background flex items-center justify-center`}
                        >
                          <Sparkles className={`h-3 w-3 ${rarityColor}`} />
                        </div>
                      )}
                  </div>

                  {/* Badge Name */}
                  <p
                    className={`text-xs font-medium text-center leading-tight line-clamp-2 ${
                      badge.is_earned
                        ? "text-foreground"
                        : "text-muted-foreground"
                    }`}
                  >
                    {badge.name}
                  </p>

                  {/* Earned Date */}
                  {badge.is_earned && badge.earned_at && (
                    <p className="text-2xs text-muted-foreground">
                      {new Date(badge.earned_at).toLocaleDateString("ko-KR", {
                        month: "short",
                        day: "numeric",
                      })}
                    </p>
                  )}
                </motion.div>
              );
            })}
          </div>
        )}
      </div>
    </motion.div>
  );
}
