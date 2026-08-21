"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import { useQueryClient } from "@tanstack/react-query";
import PhoneVerifyModal from "./PhoneVerifyModal";
import {
  Star,
  Shield,
  Lock,
  Heart,
  Ticket,
  Users,
  BarChart3,
  Award,
  Zap,
  CheckCircle2,
  Circle,
  Crown,
  LogOut,
} from "lucide-react";
import { useAuthStore } from "@pickket/store";
import {
  Radar,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
} from "recharts";
import { Badge } from "@pickket/ui";
import { Progress } from "@pickket/ui";
import { useTranslations } from "next-intl";
import { CARD } from "@/lib/styles";

interface BidHistoryItem {
  id: string;
  event_id: string;
  event_title: string;
  max_willingness_to_pay: number;
  quantity: number;
  status: string;
  sale_mode?: string;
  effective_weight?: number | null;
  final_price: number | null;
  created_at: string;
}

interface ProfileTabProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  user: any;
  bidHistory: BidHistoryItem[];
}

export default function ProfileTab({ user, bidHistory }: ProfileTabProps) {
  const t = useTranslations("mypage");
  const router = useRouter();
  const queryClient = useQueryClient();
  const { logout } = useAuthStore();
  const [verifyOpen, setVerifyOpen] = useState(false);

  const handleLogout = () => {
    logout();
    // Clear all cached PII so a subsequent user on a shared device cannot see
    // previous user's data during the 30-min React Query gcTime window.
    queryClient.clear();
    router.push("/");
  };

  const handleVerified = () => {
    // myStatus 와 user 둘 다 다시 fetch — verification_level 즉시 반영
    queryClient.invalidateQueries({ queryKey: ["mypage", "core"] });
  };

  /* Computed dimensions */
  const dimensions = useMemo(() => {
    if (!user) return [];
    const behaviorScore = Math.max(
      0,
      1 -
        0.5 * ((user.no_show_rate as number) ?? 0) -
        0.3 * ((user.cancel_rate as number) ?? 0) -
        0.2 * ((user.dispute_rate as number) ?? 0),
    );
    return [
      {
        key: "verification",
        label: t("dimension_verification"),
        value: ((user.verification_level as number) ?? 0) * 100,
        icon: Shield,
        raw: (user.verification_level as number) ?? 0,
      },
      {
        key: "loyalty",
        label: t("dimension_loyalty"),
        value: ((user.loyalty_score as number) ?? 0) * 100,
        icon: Heart,
        raw: (user.loyalty_score as number) ?? 0,
      },
      {
        key: "history",
        label: t("dimension_history"),
        value: ((user.history_score as number) ?? 0) * 100,
        icon: Ticket,
        raw: (user.history_score as number) ?? 0,
      },
      {
        key: "fanclub",
        label: t("dimension_community"),
        value: user.is_fanclub_member ? 100 : 0,
        icon: Users,
        raw: user.is_fanclub_member ? 1 : 0,
      },
      {
        key: "behavior",
        label: t("dimension_trust"),
        value: behaviorScore * 100,
        icon: Award,
        raw: behaviorScore,
      },
    ];
  }, [t, user]);

  /* Radar chart data */
  const radarData = useMemo(
    () =>
      dimensions.map((d) => ({
        subject: d.label,
        value: d.value,
        fullMark: 100,
      })),
    [dimensions],
  );

  /* Gamification checklist - dynamic */
  const checklist = useMemo(() => {
    if (!user) return [];
    return [
      {
        label: t("checklist_signup"),
        bonus: "+0.1",
        done: true,
      },
      {
        label: t("checklist_verification"),
        bonus: "+0.3",
        done: ((user.verification_level as number) ?? 0) > 0,
      },
      {
        label: t("checklist_first_bid"),
        bonus: "+0.1",
        done: bidHistory.length > 0,
      },
      {
        label: t("checklist_community"),
        bonus: "+0.15",
        done: (user.is_fanclub_member as boolean) ?? false,
      },
    ];
  }, [bidHistory, t, user]);

  const checklistProgress = useMemo(() => {
    if (checklist.length === 0) return 0;
    return (checklist.filter((c) => c.done).length / checklist.length) * 100;
  }, [checklist]);

  return (
    <div className="space-y-6">
      {/* Fan Profile Card */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05 }}
      >
        <div className="rounded-2xl shadow-sm p-5 lg:p-6 space-y-6 bg-background border border-border/50">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <Star className="h-5 w-5 text-primary/70" />
              {t("tab_profile")}
            </h2>
            <Link
              href="/mypage/edit"
              className="text-xs text-primary hover:text-primary/80 font-medium"
            >
              프로필 수정
            </Link>
          </div>

          {/* 5 Dimension Progress Bars */}
          <div className="space-y-4">
            {dimensions.map((dim) => {
              const Icon = dim.icon;
              const showVerifyButton =
                dim.key === "verification" && (dim.raw ?? 0) < 1;
              return (
                <div key={dim.key}>
                  <div className="flex justify-between text-sm mb-1.5">
                    <span className="flex items-center gap-1.5">
                      <Icon className="h-3.5 w-3.5" /> {dim.label}
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="font-medium font-tabular">
                        {dim.value.toFixed(0)}%
                      </span>
                      {showVerifyButton && (
                        <button
                          onClick={() => setVerifyOpen(true)}
                          className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary hover:bg-primary/20 font-medium"
                        >
                          인증하기
                        </button>
                      )}
                    </span>
                  </div>
                  <Progress value={dim.value} className="h-2" />
                </div>
              );
            })}
          </div>
          <PhoneVerifyModal
            open={verifyOpen}
            onClose={() => setVerifyOpen(false)}
            onVerified={handleVerified}
          />

          {/* Tip */}
          <div className="bg-card rounded-2xl p-4 text-sm text-muted-foreground">
            <p>{t("tip_text")}</p>
            <p className="mt-1">{t("tip_verification")}</p>
          </div>
        </div>
      </motion.div>

      {/* Radar Chart - Glassmorphism */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
      >
        <div className={CARD.base}>
          <h2 className="flex items-center gap-2 text-lg font-semibold mb-4">
            <BarChart3 className="h-5 w-5 text-primary/70" />
            {t("radar_title")}
          </h2>
          <div className="w-full h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <RadarChart cx="50%" cy="50%" outerRadius="75%" data={radarData}>
                <PolarGrid
                  stroke="hsl(var(--muted-foreground))"
                  strokeOpacity={0.2}
                />
                <PolarAngleAxis
                  dataKey="subject"
                  tick={{ fill: "hsl(var(--foreground))", fontSize: 12 }}
                />
                <PolarRadiusAxis
                  angle={90}
                  domain={[0, 100]}
                  tick={{
                    fill: "hsl(var(--muted-foreground))",
                    fontSize: 10,
                  }}
                  tickCount={5}
                />
                <Radar
                  name={t("radar_name")}
                  dataKey="value"
                  stroke="hsl(var(--primary))"
                  fill="hsl(var(--primary))"
                  fillOpacity={0.2}
                  strokeWidth={2}
                />
                <RechartsTooltip
                  contentStyle={{
                    backgroundColor: "hsl(var(--card))",
                    borderRadius: "12px",
                    fontSize: "13px",
                    boxShadow: "0 2px 16px rgba(0,0,0,0.06)",
                    border: "none",
                  }}
                  formatter={(value: number | undefined) => [
                    `${(value ?? 0).toFixed(0)}${t("radar_suffix")}`,
                    "",
                  ]}
                />
              </RadarChart>
            </ResponsiveContainer>
          </div>
          <p className="text-xs text-muted-foreground text-center mt-2">
            {t("radar_footer")}
          </p>
        </div>
      </motion.div>

      {/* Gamification Checklist */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15 }}
      >
        <div className="rounded-2xl shadow-sm p-5 lg:p-6 bg-background border border-border/50">
          <h2 className="flex items-center gap-2 text-lg font-semibold mb-4">
            <Zap className="h-5 w-5 text-primary/70" />
            {t("journey_title")}
          </h2>
          <div className="flex items-center justify-between text-sm mb-2">
            <span className="text-muted-foreground">
              {t("journey_progress")}
            </span>
            <span className="font-medium font-tabular">
              {checklist.filter((c) => c.done).length}/{checklist.length}
            </span>
          </div>
          <Progress value={checklistProgress} className="h-2 mb-4" />
          <div className="space-y-3">
            {checklist.map((item) => (
              <div
                key={item.label}
                className="flex items-center justify-between"
              >
                <div className="flex items-center gap-2">
                  {item.done ? (
                    <CheckCircle2 className="h-4 w-4 text-cyan" />
                  ) : (
                    <Circle className="h-4 w-4 text-muted-foreground" />
                  )}
                  <span
                    className={
                      item.done ? "text-muted-foreground line-through" : ""
                    }
                  >
                    {item.label}
                  </span>
                </div>
                <Badge className="text-xs rounded-full bg-card text-primary/70 hover:bg-card">
                  {item.bonus}
                </Badge>
              </div>
            ))}
          </div>
        </div>
      </motion.div>

      {/* v3.0 Quest/Badge/Tier entry points */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
      >
        <div className="grid grid-cols-3 gap-3">
          <Link
            href="/mypage/quests"
            className="rounded-2xl bg-gradient-to-br from-amber-50 to-orange-50 p-4 text-center hover:shadow-md transition-shadow"
          >
            <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-amber-100">
              <Zap className="h-5 w-5 text-amber-600 dark:text-amber-400" />
            </div>
            <div className="text-sm font-semibold text-gray-800">퀘스트</div>
            <div className="text-xs text-gray-500">일일/주간 미션</div>
          </Link>
          <Link
            href="/mypage/badges"
            className="rounded-2xl bg-gradient-to-br from-purple-50 to-indigo-50 p-4 text-center hover:shadow-md transition-shadow"
          >
            <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-purple-100">
              <Award className="h-5 w-5 text-purple-600 dark:text-purple-400" />
            </div>
            <div className="text-sm font-semibold text-gray-800">뱃지</div>
            <div className="text-xs text-gray-500">나의 컬렉션</div>
          </Link>
          <Link
            href="/mypage/tier"
            className="rounded-2xl bg-gradient-to-br from-blue-50 to-cyan-50 p-4 text-center hover:shadow-md transition-shadow"
          >
            <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-blue-100">
              <Crown className="h-5 w-5 text-blue-600 dark:text-blue-400" />
            </div>
            <div className="text-sm font-semibold text-gray-800">등급</div>
            <div className="text-xs text-gray-500">멤버십 티어</div>
          </Link>
        </div>
      </motion.div>

      {/* 계정 설정 */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
      >
        <div className={`${CARD.base} p-0! overflow-hidden`}>
          <h2 className="flex items-center gap-2 text-lg font-semibold px-5 pt-5 pb-3 lg:px-6 lg:pt-6">
            <Shield className="h-5 w-5 text-primary/70" />
            계정 설정
          </h2>
          <div className="divide-y divide-border">
            <Link
              href="/mypage/edit"
              className="flex items-center justify-between px-5 py-4 hover:bg-muted/50 transition-colors"
            >
              <div className="flex items-center gap-3">
                <Users className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm">프로필 수정</span>
              </div>
              <span className="text-xs text-muted-foreground">›</span>
            </Link>
            <Link
              href="/mypage/change-password"
              className="flex items-center justify-between px-5 py-4 hover:bg-muted/50 transition-colors"
            >
              <div className="flex items-center gap-3">
                <Lock className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm">비밀번호 변경</span>
              </div>
              <span className="text-xs text-muted-foreground">›</span>
            </Link>
            <Link
              href="/mypage/privacy"
              className="flex items-center justify-between px-5 py-4 hover:bg-muted/50 transition-colors"
            >
              <div className="flex items-center gap-3">
                <Shield className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm">개인정보 설정</span>
              </div>
              <span className="text-xs text-muted-foreground">›</span>
            </Link>
            <Link
              href="/mypage/favorites"
              className="flex items-center justify-between px-5 py-4 hover:bg-muted/50 transition-colors"
            >
              <div className="flex items-center gap-3">
                <Heart className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm">즐겨찾기</span>
              </div>
              <span className="text-xs text-muted-foreground">›</span>
            </Link>
            <button
              type="button"
              onClick={handleLogout}
              className="flex w-full items-center justify-between px-5 py-4 hover:bg-muted/50 transition-colors text-left"
            >
              <div className="flex items-center gap-3">
                <LogOut className="h-4 w-4 text-red-500" />
                <span className="text-sm text-red-500 font-medium">
                  로그아웃
                </span>
              </div>
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
