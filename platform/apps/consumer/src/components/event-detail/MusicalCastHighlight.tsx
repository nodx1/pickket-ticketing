"use client";

import { useMemo } from "react";
import Image from "next/image";
import { useTranslations, useLocale } from "next-intl";
import { motion } from "motion/react";
import DomainSection from "./DomainSection";

// ─── Constants ──────────────────────────────────────────────────────────────

const AVATAR_GRADIENTS = [
  "from-teal-400 to-emerald-500",
  "from-violet-400 to-purple-500",
  "from-amber-400 to-orange-500",
  "from-sky-400 to-blue-500",
  "from-rose-400 to-pink-500",
  "from-lime-400 to-green-500",
] as const;

// ─── Types ──────────────────────────────────────────────────────────────────

interface MusicalCastHighlightProps {
  assignments: Array<{
    slot_name: string;
    participant_name: string;
    participant_image_url?: string | null;
    session_date: string;
  }>;
  eventDate?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function toDateOnly(dateStr: string): string {
  return dateStr.split("T")[0];
}

function formatDateBadge(dateStr: string, locale: string): string {
  const d = new Date(dateStr);
  const formatter = new Intl.DateTimeFormat(locale, {
    month: "long",
    day: "numeric",
    weekday: "short",
  });
  return formatter.format(d);
}

function getGradient(index: number): string {
  return AVATAR_GRADIENTS[index % AVATAR_GRADIENTS.length];
}

// ─── Avatar ─────────────────────────────────────────────────────────────────

function CastAvatar({
  src,
  name,
  index,
}: {
  src?: string | null;
  name: string;
  index: number;
}) {
  if (src) {
    return (
      <div className="relative w-14 h-14 rounded-full overflow-hidden ring-2 ring-white dark:ring-gray-800 shadow-md shrink-0">
        <Image
          src={src}
          alt={name}
          fill
          unoptimized
          className="object-cover"
          sizes="56px"
        />
      </div>
    );
  }

  return (
    <div
      className={`flex items-center justify-center w-14 h-14 rounded-full bg-gradient-to-br ${getGradient(index)} ring-2 ring-white dark:ring-gray-800 shadow-md shrink-0`}
    >
      <span className="text-lg font-bold text-white leading-none">
        {name.charAt(0)}
      </span>
    </div>
  );
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function MusicalCastHighlight({
  assignments,
  eventDate,
}: MusicalCastHighlightProps) {
  const t = useTranslations("domain");
  const locale = useLocale();
  // Determine which date to display
  const { targetDate, isToday, castForDate } = useMemo(() => {
    if (assignments.length === 0) {
      return { targetDate: null, isToday: false, castForDate: [] };
    }

    const now = new Date();
    const todayStr = toDateOnly(now.toISOString());

    // Group assignments by date
    const byDate = new Map<
      string,
      Array<{
        slot_name: string;
        participant_name: string;
        participant_image_url?: string | null;
        session_date: string;
      }>
    >();

    for (const a of assignments) {
      const dateKey = toDateOnly(a.session_date);
      const list = byDate.get(dateKey) || [];
      list.push(a);
      byDate.set(dateKey, list);
    }

    // 1. Check for today's assignments
    const todayAssignments = byDate.get(todayStr);
    if (todayAssignments && todayAssignments.length > 0) {
      return {
        targetDate: todayStr,
        isToday: true,
        castForDate: todayAssignments,
      };
    }

    // 2. Find the next upcoming date
    const futureDates = Array.from(byDate.keys())
      .filter((d) => d > todayStr)
      .sort();

    if (futureDates.length > 0) {
      const nextDate = futureDates[0];
      return {
        targetDate: nextDate,
        isToday: false,
        castForDate: byDate.get(nextDate) || [],
      };
    }

    // 3. Fallback: use eventDate or the most recent past date
    if (eventDate) {
      const eventDateKey = toDateOnly(eventDate);
      const eventAssignments = byDate.get(eventDateKey);
      if (eventAssignments && eventAssignments.length > 0) {
        return {
          targetDate: eventDateKey,
          isToday: false,
          castForDate: eventAssignments,
        };
      }
    }

    // Last resort: use the earliest available date
    const allDates = Array.from(byDate.keys()).sort();
    if (allDates.length > 0) {
      const firstDate = allDates[0];
      return {
        targetDate: firstDate,
        isToday: false,
        castForDate: byDate.get(firstDate) || [],
      };
    }

    return { targetDate: null, isToday: false, castForDate: [] };
  }, [assignments, eventDate]);

  // Don't render if no assignments at all
  if (assignments.length === 0 || !targetDate || castForDate.length === 0) {
    return null;
  }

  const sectionTitle = isToday ? t("musical.todayCast") : t("musical.nextCast");

  return (
    <DomainSection
      title={sectionTitle}
      iconSrc="/icons/categories/musical.svg"
      accentColor="bg-gradient-to-r from-teal-500 to-emerald-500"
    >
      {/* Date badge */}
      <div className="mb-4">
        <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-teal-50 dark:bg-teal-950/30 text-teal-700 dark:text-teal-300 text-xs font-semibold">
          <span className="w-1.5 h-1.5 rounded-full bg-teal-500 animate-pulse" />
          {formatDateBadge(targetDate, locale)}
        </span>
      </div>

      {/* Cast list — horizontal scroll */}
      <div className="-mx-5 md:-mx-6 px-5 md:px-6 overflow-x-auto scrollbar-hide">
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          variants={{ visible: { transition: { staggerChildren: 0.08 } } }}
          className="flex gap-4 pb-2"
          style={{ minWidth: "min-content" }}
          role="list"
          aria-label={t("musical.ariaCastList")}
        >
          {castForDate.map((cast, idx) => (
            <motion.div
              key={`${cast.slot_name}-${cast.participant_name}-${idx}`}
              variants={{
                hidden: { opacity: 0, y: 16 },
                visible: { opacity: 1, y: 0 },
              }}
              whileHover={{
                y: -4,
                transition: { type: "spring", stiffness: 400, damping: 25 },
              }}
              className="flex flex-col items-center gap-2 min-w-[80px] max-w-[96px] shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 rounded-xl"
              role="listitem"
              tabIndex={0}
              aria-label={t("musical.ariaCastRole", {
                role: cast.slot_name,
                name: cast.participant_name,
              })}
            >
              {/* Avatar */}
              <CastAvatar
                src={cast.participant_image_url}
                name={cast.participant_name}
                index={idx}
              />

              {/* Role name */}
              <span className="text-xs-plus text-muted-foreground leading-tight text-center line-clamp-1">
                {cast.slot_name}
              </span>

              {/* Actor name */}
              <span className="text-sm font-bold text-foreground leading-tight text-center line-clamp-2 -mt-0.5">
                {cast.participant_name}
              </span>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </DomainSection>
  );
}
