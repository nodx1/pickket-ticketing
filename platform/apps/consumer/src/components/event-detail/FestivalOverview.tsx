"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import { useTranslations } from "next-intl";
import { Music, Users, CalendarDays } from "lucide-react";
import { motion } from "motion/react";
import DomainSection from "./DomainSection";

// ─── Types ──────────────────────────────────────────────────────────────────

interface FestivalOverviewProps {
  assignments: Array<{
    slot_name: string;
    participant_name: string;
    participant_image_url?: string | null;
    session_date: string;
    duration_minutes?: number;
  }>;
  stageInfo?: string;
  eventDate: string;
  eventDateEnd?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseDateOnly(iso: string): string {
  return iso.split("T")[0];
}

function formatDateRange(start: string, end?: string): string {
  const s = new Date(start);
  const fmt = (d: Date) =>
    `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;

  if (!end) return fmt(s);

  const e = new Date(end);
  return `${fmt(s)} ~ ${fmt(e)}`;
}

// ─── Headliner Avatar ───────────────────────────────────────────────────────

function HeadlinerAvatar({
  name,
  imageUrl,
}: {
  name: string;
  imageUrl?: string | null;
}) {
  const [imgError, setImgError] = useState(false);
  const initial = name.charAt(0).toUpperCase();

  return (
    <div className="flex flex-col items-center gap-2 min-w-[72px] max-w-[80px]">
      {imageUrl && !imgError ? (
        <div className="relative w-14 h-14 rounded-full overflow-hidden ring-2 ring-purple-500/30 ring-offset-2 ring-offset-card shadow-lg">
          <Image
            src={imageUrl}
            alt={name}
            fill
            className="object-cover"
            sizes="56px"
            unoptimized
            onError={() => setImgError(true)}
          />
        </div>
      ) : (
        <div className="w-14 h-14 rounded-full bg-gradient-to-br from-purple-500/20 to-pink-500/20 flex items-center justify-center ring-2 ring-purple-500/20 ring-offset-2 ring-offset-card">
          <span className="text-lg font-bold text-purple-600 dark:text-purple-400">
            {initial}
          </span>
        </div>
      )}
      <span className="text-xs font-medium text-foreground text-center leading-tight line-clamp-2">
        {name}
      </span>
    </div>
  );
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function FestivalOverview({
  assignments,
  stageInfo,
  eventDate,
  eventDateEnd,
}: FestivalOverviewProps) {
  const t = useTranslations("domain");
  // ── Derived stats ──────────────────────────────────────────────────────────

  const stats = useMemo(() => {
    const uniqueStages = new Set(assignments.map((a) => a.slot_name));
    const uniqueArtists = new Set(assignments.map((a) => a.participant_name));
    const uniqueDays = new Set(
      assignments.map((a) => parseDateOnly(a.session_date)),
    );

    // If we have eventDate range, compute days from that instead
    let dayCount = uniqueDays.size;
    if (eventDateEnd) {
      const start = new Date(eventDate);
      const end = new Date(eventDateEnd);
      const diff =
        Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) +
        1;
      dayCount = Math.max(diff, 1);
    }

    return {
      stageCount: uniqueStages.size,
      artistCount: uniqueArtists.size,
      dayCount,
    };
  }, [assignments, eventDate, eventDateEnd]);

  // ── Headliners (first 6 unique artists) ────────────────────────────────────

  const headliners = useMemo(() => {
    const seen = new Set<string>();
    const result: Array<{ name: string; imageUrl?: string | null }> = [];

    for (const a of assignments) {
      if (seen.has(a.participant_name)) continue;
      seen.add(a.participant_name);
      result.push({
        name: a.participant_name,
        imageUrl: a.participant_image_url,
      });
      if (result.length >= 6) break;
    }

    return result;
  }, [assignments]);

  // ── Null guard ──────────────────────────────────────────────────────────────

  if (assignments.length === 0 && !stageInfo && !eventDateEnd) {
    return null;
  }

  // ── Minimal card when no assignments ────────────────────────────────────────

  if (assignments.length === 0) {
    return (
      <DomainSection
        title={t("festival.overview")}
        iconSrc="/icons/categories/festival.svg"
        accentColor="bg-gradient-to-r from-purple-500 to-pink-500"
      >
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <CalendarDays className="h-4 w-4 shrink-0" />
            <span>{formatDateRange(eventDate, eventDateEnd)}</span>
          </div>
          {stageInfo && (
            <p className="text-sm text-muted-foreground leading-relaxed">
              {stageInfo}
            </p>
          )}
        </div>
      </DomainSection>
    );
  }

  // ── Full overview ──────────────────────────────────────────────────────────

  return (
    <DomainSection
      title={t("festival.overview")}
      iconSrc="/icons/categories/festival.svg"
      accentColor="bg-gradient-to-r from-purple-500 to-pink-500"
    >
      <div className="space-y-5">
        {/* ── Stats Row ─────────────────────────────────────── */}
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          variants={{ visible: { transition: { staggerChildren: 0.08 } } }}
          className="flex flex-wrap gap-2"
        >
          {stats.dayCount > 0 && (
            <motion.span
              variants={{
                hidden: { opacity: 0, scale: 0.85 },
                visible: { opacity: 1, scale: 1 },
              }}
              transition={{ type: "spring", stiffness: 400, damping: 25 }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-purple-500/10 dark:bg-purple-500/20 text-purple-700 dark:text-purple-300 text-xs font-semibold"
            >
              <CalendarDays className="h-3.5 w-3.5" />
              {t("festival.days", { n: stats.dayCount })}
            </motion.span>
          )}
          {stats.stageCount > 0 && (
            <motion.span
              variants={{
                hidden: { opacity: 0, scale: 0.85 },
                visible: { opacity: 1, scale: 1 },
              }}
              transition={{ type: "spring", stiffness: 400, damping: 25 }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-pink-500/10 dark:bg-pink-500/20 text-pink-700 dark:text-pink-300 text-xs font-semibold"
            >
              <Music className="h-3.5 w-3.5" />
              {t("festival.stages", { n: stats.stageCount })}
            </motion.span>
          )}
          {stats.artistCount > 0 && (
            <motion.span
              variants={{
                hidden: { opacity: 0, scale: 0.85 },
                visible: { opacity: 1, scale: 1 },
              }}
              transition={{ type: "spring", stiffness: 400, damping: 25 }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-indigo-500/10 dark:bg-indigo-500/20 text-indigo-700 dark:text-indigo-300 text-xs font-semibold"
            >
              <Users className="h-3.5 w-3.5" />
              {t("festival.artists", { n: stats.artistCount })}
            </motion.span>
          )}
        </motion.div>

        {/* ── Headliners ───────────────────────────────────── */}
        {headliners.length > 0 && (
          <div>
            <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
              {t("festival.headliners")}
            </h4>
            <div
              className="flex gap-4 overflow-x-auto scrollbar-hide pb-2 -mx-1 px-1"
              role="list"
              aria-label={t("festival.ariaHeadliners")}
            >
              {headliners.map((artist, idx) => (
                <motion.div
                  key={artist.name}
                  initial={{ opacity: 0, y: 12 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{
                    type: "spring",
                    stiffness: 300,
                    damping: 25,
                    delay: idx * 0.1,
                  }}
                  role="listitem"
                  aria-label={artist.name}
                >
                  <HeadlinerAvatar
                    name={artist.name}
                    imageUrl={artist.imageUrl}
                  />
                </motion.div>
              ))}
            </div>
          </div>
        )}

        {/* ── Date Range ───────────────────────────────────── */}
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <CalendarDays className="h-4 w-4 shrink-0" />
          <span>{formatDateRange(eventDate, eventDateEnd)}</span>
        </div>

        {/* ── Stage Info ───────────────────────────────────── */}
        {stageInfo && (
          <div
            className="rounded-xl bg-muted/50 dark:bg-muted/30 px-4 py-3"
            aria-label={`${t("festival.stageInfo")}: ${stageInfo}`}
          >
            <p className="text-sm text-muted-foreground leading-relaxed">
              {stageInfo}
            </p>
          </div>
        )}
      </div>
    </DomainSection>
  );
}
