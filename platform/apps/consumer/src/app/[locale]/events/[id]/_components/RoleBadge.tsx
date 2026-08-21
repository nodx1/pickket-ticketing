"use client";

import { useTranslations } from "next-intl";
import { Sparkles, BadgeCheck, ShieldCheck, Star } from "lucide-react";
import type { FeedRole } from "../community-data";

/* ── 팬 등급 시스템 (Twitch/네이버 카페 영감) ── */
export type FanLevel = 1 | 2 | 3 | 4 | 5;

const FAN_LEVEL_CONFIG: Record<
  FanLevel,
  { labelKey: string; className: string; stars: number }
> = {
  1: {
    labelKey: "fanLevel.sprout",
    className:
      "bg-gray-100 text-gray-600 dark:bg-gray-800/40 dark:text-gray-400",
    stars: 1,
  },
  2: {
    labelKey: "fanLevel.avid",
    className: "bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400",
    stars: 2,
  },
  3: {
    labelKey: "fanLevel.gold",
    className:
      "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
    stars: 3,
  },
  4: {
    labelKey: "fanLevel.diamond",
    className:
      "bg-gradient-to-r from-cyan-100 to-blue-100 text-blue-700 dark:from-cyan-900/30 dark:to-blue-900/30 dark:text-blue-400",
    stars: 4,
  },
  5: {
    labelKey: "fanLevel.legend",
    className:
      "bg-gradient-to-r from-amber-100 via-yellow-100 to-orange-100 text-amber-800 dark:from-amber-900/30 dark:via-yellow-900/30 dark:to-orange-900/30 dark:text-amber-400",
    stars: 5,
  },
};

const TIER_TO_FAN_LEVEL: Record<string, FanLevel> = {
  rookie: 1,
  fan: 2,
  supporter: 3,
  corefan: 4,
  legend: 5,
};

const ROLE_CONFIG: Record<
  FeedRole,
  { labelKey: string; icon: typeof Sparkles | null; className: string } | null
> = {
  artist: {
    labelKey: "role.artist",
    icon: Sparkles,
    className:
      "bg-gradient-to-r from-violet-100 to-purple-100 text-violet-700 dark:from-violet-900/30 dark:to-purple-900/30 dark:text-violet-400",
  },
  organizer: {
    labelKey: "role.organizer",
    icon: BadgeCheck,
    className:
      "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  },
  verified_attendee: {
    labelKey: "role.verifiedAttendee",
    icon: ShieldCheck,
    className:
      "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  },
  fan: null,
};

export function RoleBadge({
  role,
  fanLevel,
  tierName,
}: {
  role: FeedRole;
  fanLevel?: FanLevel;
  tierName?: string;
}) {
  const t = useTranslations("event.roleBadge");
  const config = ROLE_CONFIG[role];

  // Resolve fanLevel from tierName if provided
  const resolvedFanLevel =
    fanLevel ?? (tierName ? TIER_TO_FAN_LEVEL[tierName] : undefined);

  // 팬 역할 + fanLevel이 있으면 등급 배지 표시
  if (!config && resolvedFanLevel) {
    const levelConfig = FAN_LEVEL_CONFIG[resolvedFanLevel];
    return (
      <span
        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs-plus font-medium ${levelConfig.className}`}
      >
        <Star className="h-3 w-3" />
        {t(levelConfig.labelKey)}
      </span>
    );
  }

  if (!config) return null;

  const Icon = config.icon;
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs-plus font-medium ${config.className}`}
    >
      {Icon && <Icon className="h-3 w-3" />}
      {t(config.labelKey)}
    </span>
  );
}
