"use client";

import { useTranslations } from "next-intl";
import { Tv, ParkingCircle, Radio, ExternalLink } from "lucide-react";
import { motion } from "motion/react";
import DomainSection from "./DomainSection";
import { safeExternalUrl } from "@/lib/safe-url";

interface SportsMatchSectionProps {
  homeTeam: string;
  awayTeam: string;
  matchStatus?: string;
  broadcastPlatform?: string;
  broadcastUrl?: string;
  parkingInfo?: string;
  subCategory?: string;
  venue: string;
}

function getStatusConfig(
  status: string | undefined,
  t: (key: string) => string,
) {
  switch (status?.toLowerCase()) {
    case "live":
      return {
        label: t("sports.live"),
        bg: "bg-red-500/10",
        text: "text-red-600 dark:text-red-400",
        border: "border-red-500/30",
        dot: true,
      };
    case "종료":
    case "ended":
    case "finished":
      return {
        label: t("sports.ended"),
        bg: "bg-muted",
        text: "text-muted-foreground",
        border: "border-border",
        dot: false,
      };
    case "예정":
    case "scheduled":
    default:
      return {
        label: t("sports.scheduled"),
        bg: "bg-blue-500/10",
        text: "text-blue-600 dark:text-blue-400",
        border: "border-blue-500/30",
        dot: false,
      };
  }
}

function TeamAvatar({ name, delay = 0 }: { name: string; delay?: number }) {
  const initial = name.charAt(0);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 300, damping: 25, delay }}
      className="flex flex-col items-center gap-2"
    >
      <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-surface-dim border-2 border-border flex items-center justify-center shadow-sm">
        <span className="text-2xl sm:text-3xl font-black text-foreground">
          {initial}
        </span>
      </div>
      <span className="text-sm sm:text-base font-bold text-foreground text-center leading-tight max-w-[100px]">
        {name}
      </span>
    </motion.div>
  );
}

export default function SportsMatchSection({
  homeTeam,
  awayTeam,
  matchStatus,
  broadcastPlatform,
  broadcastUrl,
  parkingInfo,
  subCategory,
  venue,
}: SportsMatchSectionProps) {
  const t = useTranslations("domain");
  const statusConfig = getStatusConfig(matchStatus, t);
  // broadcast_url 은 organizer 가 설정하는 외부 URL — http/https 만 신뢰(javascript:/data: XSS 차단)
  const safeBroadcastUrl = safeExternalUrl(broadcastUrl);
  const hasBroadcast = broadcastPlatform || safeBroadcastUrl;

  return (
    <DomainSection
      title={t("sports.title")}
      subtitle={venue}
      iconSrc="/icons/categories/sports.svg"
      accentColor="bg-gradient-to-r from-blue-500 to-sky-500"
    >
      <div className="space-y-4">
        {/* VS Card */}
        <div className="relative bg-surface-dim rounded-2xl p-6 sm:p-8">
          {/* Match Status Badge - top right */}
          <div
            className="absolute top-3 right-3"
            role="status"
            aria-live="polite"
          >
            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border ${statusConfig.bg} ${statusConfig.text} ${statusConfig.border}`}
              aria-label={statusConfig.label}
            >
              {statusConfig.dot && (
                <span className="relative flex h-2 w-2" aria-hidden="true">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
                </span>
              )}
              {statusConfig.label}
            </span>
          </div>

          {/* Sub-category badge - top left */}
          {subCategory && (
            <div className="absolute top-3 left-3">
              <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-primary/10 text-primary border border-primary/20">
                {subCategory}
              </span>
            </div>
          )}

          {/* Teams VS Layout */}
          <div className="flex items-center justify-center gap-4 sm:gap-8 pt-4">
            <TeamAvatar name={homeTeam} delay={0} />

            <div className="flex flex-col items-center">
              <motion.span
                initial={{ scale: 0.6, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{
                  type: "spring",
                  stiffness: 400,
                  damping: 20,
                  delay: 0.08,
                }}
                className="text-2xl sm:text-3xl font-black text-muted-foreground tracking-tighter"
              >
                VS
              </motion.span>
            </div>

            <TeamAvatar name={awayTeam} delay={0.15} />
          </div>
        </div>

        {/* Broadcast Card */}
        {hasBroadcast && (
          <motion.div
            whileHover={{ scale: 1.02 }}
            transition={{ type: "spring", stiffness: 400, damping: 25 }}
            className="flex items-center gap-3 bg-surface-dim rounded-xl p-4"
          >
            <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-primary/10 shrink-0">
              <Tv className="h-5 w-5 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              {broadcastPlatform && (
                <p className="text-sm font-semibold text-foreground">
                  {broadcastPlatform}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                {t("sports.broadcast")}
              </p>
            </div>
            {safeBroadcastUrl && (
              <a
                href={safeBroadcastUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold bg-primary text-white hover:bg-primary/90 transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
              >
                <Radio className="h-3.5 w-3.5" />
                {t("sports.watchLive")}
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </motion.div>
        )}

        {/* Parking Card */}
        {parkingInfo && (
          <motion.div
            whileHover={{ scale: 1.02 }}
            transition={{ type: "spring", stiffness: 400, damping: 25 }}
            className="flex items-start gap-3 bg-surface-dim rounded-xl p-4"
          >
            <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-amber-500/10 shrink-0">
              <ParkingCircle className="h-5 w-5 text-amber-600 dark:text-amber-400" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-foreground mb-1">
                {t("sports.parking")}
              </p>
              <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-line">
                {parkingInfo}
              </p>
            </div>
          </motion.div>
        )}
      </div>
    </DomainSection>
  );
}
