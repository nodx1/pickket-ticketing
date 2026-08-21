"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { CalendarDays, User, Clock } from "lucide-react";
import { motion } from "motion/react";
import DomainSection from "./DomainSection";

// ─── Types ──────────────────────────────────────────────────────────────────

interface ExhibitionInfoCardProps {
  eventDate: string;
  eventDateEnd?: string;
  artistName?: string;
  durationMinutes?: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
}

function daysBetween(startIso: string, endIso: string): number {
  const start = new Date(startIso);
  const end = new Date(endIso);
  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);
  return (
    Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1
  );
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function ExhibitionInfoCard({
  eventDate,
  eventDateEnd,
  artistName,
  durationMinutes,
}: ExhibitionInfoCardProps) {
  const t = useTranslations("domain");
  // ── D-day calculation ──────────────────────────────────────────────────────

  const status = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const start = new Date(eventDate);
    start.setHours(0, 0, 0, 0);

    const end = eventDateEnd ? new Date(eventDateEnd) : start;
    end.setHours(23, 59, 59, 999);

    if (today < start) {
      const diffMs = start.getTime() - today.getTime();
      const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
      return { type: "upcoming" as const, dDay: diffDays };
    }

    if (today <= end) {
      return { type: "ongoing" as const, dDay: 0 };
    }

    return { type: "ended" as const, dDay: 0 };
  }, [eventDate, eventDateEnd]);

  // ── Total exhibition days ──────────────────────────────────────────────────

  const totalDays = useMemo(() => {
    if (!eventDateEnd) return null;
    return daysBetween(eventDate, eventDateEnd);
  }, [eventDate, eventDateEnd]);

  // ── Null guard ─────────────────────────────────────────────────────────────

  if (!eventDateEnd && !artistName) {
    return null;
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <DomainSection
      title={t("exhibition.title")}
      iconSrc="/icons/categories/exhibition.svg"
      accentColor="bg-gradient-to-r from-amber-500 to-orange-500"
    >
      <div className="space-y-4">
        {/* ── Period & Status ─────────────────────────────── */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          {/* Date range */}
          <div
            className="flex items-start gap-2.5 flex-1 min-w-0"
            aria-label={`전시 기간 ${formatDate(eventDate)}${eventDateEnd ? ` ~ ${formatDate(eventDateEnd)}` : ""}`}
          >
            <CalendarDays className="h-4.5 w-4.5 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
            <div>
              <p className="text-base font-bold text-foreground tracking-tight tabular-nums">
                {formatDate(eventDate)}
                {eventDateEnd && ` ~ ${formatDate(eventDateEnd)}`}
              </p>
              {totalDays && totalDays > 1 && (
                <span className="inline-flex items-center mt-1.5 px-2.5 py-0.5 rounded-full bg-amber-500/10 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300 text-xs-plus font-semibold">
                  {t("exhibition.totalDays", { n: totalDays })}
                </span>
              )}
            </div>
          </div>

          {/* Status badge */}
          <div className="shrink-0" role="status" aria-live="polite">
            {status.type === "upcoming" && (
              <motion.span
                initial={{ scale: 0, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{
                  type: "spring",
                  stiffness: 500,
                  damping: 25,
                  delay: 0.2,
                }}
                className="inline-flex items-center px-3 py-1.5 rounded-full bg-blue-500/10 dark:bg-blue-500/20 text-blue-700 dark:text-blue-300 text-xs font-bold tabular-nums"
                aria-label={t("exhibition.ariaOpeningDDay", { n: status.dDay })}
              >
                {t("exhibition.dDay", { n: status.dDay })}
              </motion.span>
            )}
            {status.type === "ongoing" && (
              <motion.span
                initial={{ scale: 0.8, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: "spring", stiffness: 400, damping: 20 }}
                className="relative inline-flex items-center px-3 py-1.5 rounded-full bg-emerald-500/10 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 text-xs font-bold"
                aria-label={t("exhibition.ariaOngoing")}
              >
                <motion.span
                  animate={{ scale: [1, 1.4, 1], opacity: [1, 0.5, 1] }}
                  transition={{
                    duration: 2,
                    repeat: Infinity,
                    ease: "easeInOut",
                  }}
                  className="absolute -left-0.5 top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-emerald-500"
                  aria-hidden="true"
                />
                <span className="ml-2">{t("exhibition.ongoing")}</span>
              </motion.span>
            )}
            {status.type === "ended" && (
              <span
                className="inline-flex items-center px-3 py-1.5 rounded-full bg-muted text-muted-foreground text-xs font-bold"
                aria-label={t("exhibition.ended")}
              >
                {t("exhibition.ended")}
              </span>
            )}
          </div>
        </div>

        {/* ── Divider ─────────────────────────────────────── */}
        {(artistName || durationMinutes) && (
          <div className="border-t border-border/50" />
        )}

        {/* ── Artist Info ─────────────────────────────────── */}
        {artistName && (
          <div className="flex items-center gap-2.5">
            <User className="h-4 w-4 text-muted-foreground shrink-0" />
            <p className="text-sm text-foreground">
              <span className="text-muted-foreground">
                {t("exhibition.artist")}
              </span>
              <span className="mx-1.5 text-border">|</span>
              <span className="font-medium">{artistName}</span>
            </p>
          </div>
        )}

        {/* ── Duration Info ───────────────────────────────── */}
        {durationMinutes && durationMinutes > 0 && (
          <div className="flex items-center gap-2.5">
            <Clock className="h-4 w-4 text-muted-foreground shrink-0" />
            <p className="text-sm text-muted-foreground">
              {t("exhibition.viewDuration", { min: durationMinutes })}
            </p>
          </div>
        )}
      </div>
    </DomainSection>
  );
}
