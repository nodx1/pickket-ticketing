"use client";

import { motion } from "motion/react";
import { Trophy, Medal, Award, MessageCircle } from "lucide-react";
import { getEventComments } from "@pickket/lib/api";
import { fmt } from "../detail-helpers";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

const MEDAL_ICONS = [Trophy, Medal, Award];
const MEDAL_COLORS = ["text-amber-400", "text-gray-300", "text-amber-600 dark:text-amber-400"];

interface LeaderEntry {
  userId: string;
  userName: string;
  userAvatar: string;
  commentCount: number;
  totalLikes: number;
}

export function CommunityLeaderboard({ eventId }: { eventId: string }) {
  const t = useTranslations("event.communityLeaderboard");
  const { data: leaders = [] } = useQuery<LeaderEntry[]>({
    queryKey: ["events", eventId, "leaderboard"],
    queryFn: async () => {
      const res = await getEventComments(eventId, {
        limit: 50,
        sort: "popular",
      });
      const userMap = new Map<string, LeaderEntry>();
      for (const c of res.data.items) {
        const existing = userMap.get(c.user_id);
        if (existing) {
          existing.commentCount++;
          existing.totalLikes += c.likes_count;
        } else {
          userMap.set(c.user_id, {
            userId: c.user_id,
            userName: c.user_name,
            userAvatar:
              c.user_avatar ??
              `https://ui-avatars.com/api/?name=${encodeURIComponent(c.user_name)}&background=6c5ce7&color=fff`,
            commentCount: 1,
            totalLikes: c.likes_count,
          });
        }
      }
      return Array.from(userMap.values())
        .sort((a, b) => b.totalLikes - a.totalLikes)
        .slice(0, 5);
    },
  });

  if (leaders.length === 0) return null;

  return (
    <div className="rounded-2xl border border-border bg-card shadow-sm p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Trophy className="h-4 w-4 text-amber-400" />
        <span className="text-sm font-bold text-foreground">{t("title")}</span>
      </div>
      <div className="space-y-2">
        {leaders.map((leader, idx) => {
          const Icon = MEDAL_ICONS[idx] ?? MessageCircle;
          const color = MEDAL_COLORS[idx] ?? "text-muted-foreground";
          return (
            <motion.div
              key={leader.userId}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: idx * 0.05 }}
              className="flex items-center gap-3"
            >
              <span className={`text-sm font-bold w-5 text-center ${color}`}>
                {idx < 3 ? <Icon className="h-4 w-4" /> : idx + 1}
              </span>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={leader.userAvatar}
                alt=""
                className="h-7 w-7 rounded-full object-cover"
              />
              <div className="flex-1 min-w-0">
                <span className="text-sm font-medium text-foreground truncate block">
                  {leader.userName}
                </span>
              </div>
              <div className="text-right text-2xs text-muted-foreground">
                <span className="font-medium text-primary/70">
                  {fmt(leader.totalLikes)}
                </span>{" "}
                {t("likes")}
              </div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
