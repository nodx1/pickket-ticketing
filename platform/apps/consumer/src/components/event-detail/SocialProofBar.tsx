"use client";

import { Eye, Users, TrendingUp, MessageCircle } from "lucide-react";
import { motion } from "motion/react";
import { useTranslations } from "next-intl";
import { useLiveStats } from "@/hooks/useLiveStats";

interface SocialProofBarProps {
  viewCount: number;
  bidCount: number;
  totalSeats: number;
  recentCommentCount?: number;
  live?: boolean;
  eventId?: string;
}

const containerVariants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.1,
    },
  },
};

const chipVariants = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4 } },
};

export default function SocialProofBar({
  viewCount,
  bidCount,
  totalSeats,
  recentCommentCount,
  live,
  eventId,
}: SocialProofBarProps) {
  const t = useTranslations("event.socialProof");
  const fallbackStats = { viewCount: viewCount ?? 0, bidCount: bidCount ?? 0 };
  const sseLiveStats = useLiveStats(eventId ?? "", fallbackStats);
  const liveStats = live && eventId ? sseLiveStats : fallbackStats;

  const competitionRatio =
    totalSeats > 0 ? (liveStats.bidCount / totalSeats).toFixed(1) : null;

  return (
    <motion.div
      className="flex flex-wrap gap-2 pb-1"
      variants={containerVariants}
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, margin: "-40px" }}
    >
      {/* View count */}
      <motion.div
        variants={chipVariants}
        className="bg-card rounded-2xl border border-border/50 shadow-sm px-3 py-2.5 flex items-center gap-2 min-w-0"
      >
        <Eye className="h-4 w-4 text-primary/70" />
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {t("viewingNow")}
        </span>
        <span className="font-tabular font-bold text-primary/70">
          {t("countPeople", { count: liveStats.viewCount.toLocaleString() ?? "0" })}
        </span>
      </motion.div>

      {/* Bid count */}
      <motion.div
        variants={chipVariants}
        className="bg-card rounded-2xl border border-border/50 shadow-sm px-3 py-2.5 flex items-center gap-2 min-w-0"
      >
        <Users className="h-4 w-4 text-primary/70" />
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {t("bidders")}
        </span>
        <span className="font-tabular font-bold text-primary/70">
          {t("countPeople", { count: liveStats.bidCount.toLocaleString() ?? "0" })}
        </span>
      </motion.div>

      {/* Competition ratio */}
      <motion.div
        variants={chipVariants}
        className="bg-card rounded-2xl border border-border/50 shadow-sm px-3 py-2.5 flex items-center gap-2 min-w-0"
      >
        <TrendingUp className="h-4 w-4 text-primary/70" />
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {t("competitionRatio")}
        </span>
        <span className="font-tabular font-bold text-primary/70">
          {competitionRatio !== null ? `${competitionRatio}:1` : "—"}
        </span>
      </motion.div>

      {/* Community activity */}
      {recentCommentCount != null && recentCommentCount > 0 && (
        <motion.div
          variants={chipVariants}
          className="bg-card rounded-2xl border border-border/50 shadow-sm px-3 py-2.5 flex items-center gap-2 min-w-0"
        >
          <MessageCircle className="h-4 w-4 text-primary/70" />
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            {t("communityActive")}
          </span>
        </motion.div>
      )}
    </motion.div>
  );
}
