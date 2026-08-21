"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { Star, Clock, TrendingUp, Users, Wallet } from "lucide-react";
import { Badge } from "@pickket/ui";
import { formatDateShort } from "@pickket/lib";
import {
  getPointBalance,
  getPointHistory,
  type PointBalance,
  type PointTransaction,
} from "@pickket/lib/api";
import { useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";

export default function PointsTab() {
  const t = useTranslations("mypage");
  const [pointType, setPointType] = useState<"fan" | "social">("fan");

  const { data: pointsData, isLoading: pointsLoading } = useQuery({
    queryKey: ["mypage", "points", pointType],
    queryFn: async () => {
      const [balanceRes, historyRes] = await Promise.allSettled([
        getPointBalance(),
        getPointHistory(pointType),
      ]);
      const pointBalances: PointBalance =
        balanceRes.status === "fulfilled"
          ? balanceRes.value.data
          : { fan: 0, social: 0 };
      let pointHistory: PointTransaction[] = [];
      if (historyRes.status === "fulfilled") {
        const data = historyRes.value.data;
        pointHistory = Array.isArray(data)
          ? data
          : Array.isArray(data.transactions)
            ? data.transactions
            : [];
      }
      return { pointBalances, pointHistory };
    },
  });

  const pointBalances = pointsData?.pointBalances ?? { fan: 0, social: 0 };
  const pointHistory = pointsData?.pointHistory ?? [];

  return (
    <div className="space-y-6">
      {/* Point Balance Cards */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05 }}
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Fan Point Card */}
          <div className="rounded-2xl shadow-sm p-5 lg:p-6 bg-background border border-border/50">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div className="h-10 w-10 rounded-full bg-gradient-to-br from-primary to-cyan flex items-center justify-center">
                  <Star className="h-5 w-5 text-white" />
                </div>
                <div>
                  <p className="text-sm font-medium text-muted-foreground">
                    Fan Point
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t("fan_point_desc")}
                  </p>
                </div>
              </div>
              <Badge className="rounded-full bg-primary/10 text-primary/70 hover:bg-primary/10">
                FP
              </Badge>
            </div>
            <p className="text-3xl font-bold font-tabular text-primary/70">
              {pointsLoading ? "..." : pointBalances.fan.toLocaleString()}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {t("held_points")}
            </p>
          </div>

          {/* Social Point Card */}
          <div className="rounded-2xl shadow-sm p-5 lg:p-6 bg-background border border-border/50">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div className="h-10 w-10 rounded-full bg-gradient-to-br from-emerald-500 to-teal-400 flex items-center justify-center">
                  <Users className="h-5 w-5 text-white" />
                </div>
                <div>
                  <p className="text-sm font-medium text-muted-foreground">
                    Social Point
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t("social_point_desc")}
                  </p>
                </div>
              </div>
              <Badge className="rounded-full bg-emerald-100 text-emerald-700 hover:bg-emerald-100">
                SP
              </Badge>
            </div>
            <p className="text-3xl font-bold font-tabular text-emerald-600 dark:text-emerald-400">
              {pointsLoading ? "..." : pointBalances.social.toLocaleString()}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {t("held_points")}
            </p>
          </div>
        </div>
      </motion.div>

      {/* Point History */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
      >
        <div className="rounded-2xl shadow-sm p-5 lg:p-6 bg-background border border-border/50">
          <div className="flex items-center justify-between mb-4">
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <Wallet className="h-5 w-5 text-primary/70" />
              {t("point_history")}
            </h2>
            <div className="flex gap-1 bg-card rounded-full p-0.5">
              <button
                type="button"
                onClick={() => setPointType("fan")}
                className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
                  pointType === "fan"
                    ? "bg-primary text-white shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Activity Point
              </button>
              <button
                type="button"
                onClick={() => setPointType("social")}
                className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
                  pointType === "social"
                    ? "bg-emerald-600 text-white shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Social Point
              </button>
            </div>
          </div>

          {pointsLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div
                  key={i}
                  className="h-16 bg-card rounded-2xl animate-pulse"
                />
              ))}
            </div>
          ) : pointHistory.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Wallet className="h-8 w-8 mx-auto mb-2 opacity-30" />
              <p>{t("no_point_history")}</p>
              <p className="text-xs mt-1">{t("point_participate_tip")}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {pointHistory.map((item, index: number) => (
                <motion.div
                  key={item.id || index}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: index * 0.03 }}
                  className="flex items-center justify-between p-4 rounded-2xl shadow-none hover:shadow-md hover:-translate-y-0.5 transition-all duration-200 bg-card"
                >
                  <div className="flex items-center gap-3">
                    <div
                      className={`h-8 w-8 rounded-full flex items-center justify-center ${
                        item.amount > 0
                          ? "bg-green-100 dark:bg-green-900/30"
                          : "bg-red-100 dark:bg-red-900/30"
                      }`}
                    >
                      {item.amount > 0 ? (
                        <TrendingUp className="h-4 w-4 text-green-600 dark:text-green-400" />
                      ) : (
                        <Clock className="h-4 w-4 text-red-600 dark:text-red-400" />
                      )}
                    </div>
                    <div>
                      <p className="text-sm font-medium">
                        {item.description || t("point_change")}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {item.created_at
                          ? formatDateShort(item.created_at)
                          : ""}
                      </p>
                    </div>
                  </div>
                  <span
                    className={`text-sm font-bold font-tabular ${
                      item.amount > 0
                        ? "text-green-600 dark:text-green-400"
                        : "text-red-600 dark:text-red-400"
                    }`}
                  >
                    {item.amount > 0 ? "+" : ""}
                    {item.amount?.toLocaleString() ?? 0}P
                  </span>
                </motion.div>
              ))}
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
}
