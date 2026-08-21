"use client";

import { useMemo, useState, useCallback, useRef, useEffect } from "react";
import { useTranslations, useLocale } from "next-intl";
import { motion, AnimatePresence } from "motion/react";
import Image from "next/image";
import { cn } from "@pickket/lib";
import type {
  ParticipantSlot,
  ParticipantAssignment,
  SessionData,
} from "@pickket/lib/api";

// ─── Constants ──────────────────────────────────────────────────────────────

// Day names are now provided via Intl.DateTimeFormat using the current locale

// ─── Props ──────────────────────────────────────────────────────────────────

interface CastingCalendarProps {
  slots: ParticipantSlot[];
  assignments: ParticipantAssignment[];
  sessions: SessionData[];
  onSessionSelect?: (eventId: string) => void;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatDateKey(dateStr: string): string {
  const d = new Date(dateStr);
  const month = d.getMonth() + 1;
  const day = d.getDate();
  return `${month}/${day}`;
}

function getDayOfWeek(dateStr: string, locale: string): string {
  const d = new Date(dateStr);
  return new Intl.DateTimeFormat(locale, { weekday: "short" }).format(d);
}

function isSunday(dateStr: string): boolean {
  return new Date(dateStr).getDay() === 0;
}

function isSaturday(dateStr: string): boolean {
  return new Date(dateStr).getDay() === 6;
}

// ─── Tiny Avatar ────────────────────────────────────────────────────────────

function TinyAvatar({ src, name }: { src: string; name: string }) {
  const [error, setError] = useState(false);

  if (error) {
    return (
      <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-primary/10 text-2xs font-bold text-primary shrink-0">
        {name.charAt(0)}
      </span>
    );
  }

  return (
    <Image
      src={src}
      alt={name}
      width={20}
      height={20}
      unoptimized
      onError={() => setError(true)}
      className="w-5 h-5 rounded-full object-cover ring-1 ring-border shrink-0"
    />
  );
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function CastingCalendar({
  slots,
  assignments,
  sessions,
  onSessionSelect,
}: CastingCalendarProps) {
  const t = useTranslations("domain");
  const locale = useLocale();
  const [hoveredDate, setHoveredDate] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const todayRef = useRef<HTMLTableCellElement>(null);

  // Today's date string (YYYY-MM-DD), stable across renders
  const todayStr = useMemo(() => new Date().toISOString().split("T")[0], []);

  // Build a slot ID -> slot info map
  const slotMap = useMemo(() => {
    const map = new Map<string, ParticipantSlot>();
    for (const slot of slots) {
      map.set(slot.id, slot);
    }
    return map;
  }, [slots]);

  // Build sorted unique dates from sessions
  const sortedDates = useMemo(() => {
    const dateSet = new Set<string>();
    for (const session of sessions) {
      dateSet.add(session.event_date);
    }
    return Array.from(dateSet).sort(
      (a, b) => new Date(a).getTime() - new Date(b).getTime(),
    );
  }, [sessions]);

  // Build a date -> session event_id map
  const dateToSessionId = useMemo(() => {
    const map = new Map<string, string>();
    for (const session of sessions) {
      map.set(session.event_date, session.event_id);
    }
    return map;
  }, [sessions]);

  // Sorted slots by sort_order
  const sortedSlots = useMemo(
    () => [...slots].sort((a, b) => a.sort_order - b.sort_order),
    [slots],
  );

  // Build casting matrix: Map<slotName, Map<dateKey, { name, imageUrl }>>
  const castingMatrix = useMemo(() => {
    const matrix = new Map<
      string,
      Map<string, { name: string; imageUrl?: string | null }>
    >();

    for (const slot of sortedSlots) {
      matrix.set(slot.slot_name, new Map());
    }

    for (const assignment of assignments) {
      const slot = slotMap.get(assignment.slot_id);
      if (!slot) continue;

      const row = matrix.get(slot.slot_name);
      if (!row) continue;

      row.set(assignment.session_date, {
        name: assignment.participant_name,
        imageUrl: assignment.participant_image_url,
      });
    }

    return matrix;
  }, [sortedSlots, assignments, slotMap]);

  // Auto-select today's date on mount (or closest future date)
  useEffect(() => {
    if (sortedDates.length === 0) return;
    if (sortedDates.includes(todayStr)) {
      setSelectedDate(todayStr);
    } else {
      const future = sortedDates.find((d) => d >= todayStr);
      setSelectedDate(future ?? sortedDates[sortedDates.length - 1]);
    }
  }, [sortedDates, todayStr]);

  // Scroll today's column into view when selected
  useEffect(() => {
    if (todayRef.current) {
      todayRef.current.scrollIntoView({
        behavior: "smooth",
        inline: "center",
        block: "nearest",
      });
    }
  }, [selectedDate]);

  // Keyboard navigation (ArrowLeft / ArrowRight)
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!selectedDate || sortedDates.length === 0) return;
      const idx = sortedDates.indexOf(selectedDate);
      if (e.key === "ArrowRight" && idx < sortedDates.length - 1) {
        e.preventDefault();
        setSelectedDate(sortedDates[idx + 1]);
      } else if (e.key === "ArrowLeft" && idx > 0) {
        e.preventDefault();
        setSelectedDate(sortedDates[idx - 1]);
      }
    },
    [selectedDate, sortedDates],
  );

  const handleDateClick = useCallback(
    (date: string) => {
      setSelectedDate((prev) => (prev === date ? null : date));
      const sessionId = dateToSessionId.get(date);
      if (sessionId && onSessionSelect) {
        onSessionSelect(sessionId);
      }
    },
    [dateToSessionId, onSessionSelect],
  );

  if (sortedSlots.length === 0 || sortedDates.length === 0) {
    return null;
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: "easeOut" }}
      className="bg-card/90 backdrop-blur-sm rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] dark:shadow-[0_2px_16px_rgba(0,0,0,0.2)] overflow-hidden"
    >
      {/* Header */}
      <div className="px-5 pt-5 pb-3">
        <h3 className="text-sm font-semibold text-foreground">
          {t("castingCalendar.title")}
        </h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          {t("castingCalendar.description")}
        </p>
      </div>

      {/* Scrollable matrix */}
      <div
        ref={scrollRef}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        className="overflow-x-auto scrollbar-hide snap-x snap-mandatory pb-5 px-5 outline-none focus-visible:ring-2 focus-visible:ring-primary/20 focus-visible:rounded-lg"
      >
        <table className="w-max min-w-full border-separate border-spacing-0">
          <thead>
            <tr>
              {/* Role column header */}
              <th className="sticky left-0 z-20 bg-card/95 backdrop-blur-sm text-left pr-3 pb-2">
                <span className="text-xs-plus font-medium text-muted-foreground uppercase tracking-wide">
                  {t("castingCalendar.role")}
                </span>
              </th>

              {/* Date headers */}
              {sortedDates.map((date) => {
                const dayName = getDayOfWeek(date, locale);
                const isActive = selectedDate === date || hoveredDate === date;
                const sunday = isSunday(date);
                const saturday = isSaturday(date);
                const isToday = date === todayStr;

                return (
                  <th
                    key={date}
                    ref={isToday ? todayRef : undefined}
                    className="snap-center px-1 pb-2 min-w-[64px]"
                    onMouseEnter={() => setHoveredDate(date)}
                    onMouseLeave={() => setHoveredDate(null)}
                  >
                    <motion.button
                      type="button"
                      onClick={() => handleDateClick(date)}
                      whileTap={{ scale: 0.95 }}
                      aria-pressed={selectedDate === date}
                      aria-label={t("castingCalendar.ariaCastingDate", {
                        date: formatDateKey(date),
                        day: dayName,
                      })}
                      className={cn(
                        "w-full flex flex-col items-center gap-0.5 rounded-xl px-2 py-2 min-h-[44px] transition-colors duration-200 cursor-pointer",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2",
                        isActive
                          ? "bg-primary text-primary-foreground shadow-md"
                          : "hover:bg-muted",
                        isToday && !isActive ? "ring-2 ring-primary/30" : "",
                      )}
                    >
                      <span
                        className={cn(
                          "text-sm font-semibold tabular-nums",
                          isActive
                            ? "text-primary-foreground"
                            : "text-foreground",
                        )}
                      >
                        {formatDateKey(date)}
                      </span>
                      <span
                        className={cn(
                          "text-2xs font-medium",
                          isActive
                            ? "text-primary-foreground/80"
                            : sunday
                              ? "text-red-500"
                              : saturday
                                ? "text-blue-500"
                                : "text-muted-foreground",
                        )}
                      >
                        {dayName}
                      </span>
                      {isToday && (
                        <span className="text-2xs font-bold text-primary bg-primary/10 px-1.5 py-0.5 rounded-full">
                          {t("castingCalendar.today")}
                        </span>
                      )}
                    </motion.button>
                  </th>
                );
              })}
            </tr>
          </thead>

          <tbody aria-live="polite" aria-relevant="text">
            {sortedSlots.map((slot, rowIdx) => (
              <motion.tr
                key={slot.id}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{
                  duration: 0.3,
                  delay: rowIdx * 0.04,
                  ease: "easeOut",
                }}
              >
                {/* Role name (sticky left) */}
                <td className="sticky left-0 z-10 bg-card/95 backdrop-blur-sm pr-3 py-1.5">
                  <span className="text-xs font-semibold text-foreground whitespace-nowrap">
                    {slot.slot_name}
                  </span>
                </td>

                {/* Cells */}
                {sortedDates.map((date) => {
                  const row = castingMatrix.get(slot.slot_name);
                  const cell = row?.get(date);
                  const isActive =
                    selectedDate === date || hoveredDate === date;

                  return (
                    <td
                      key={`${slot.id}-${date}`}
                      className="px-1 py-1.5 min-w-[64px]"
                      onMouseEnter={() => setHoveredDate(date)}
                      onMouseLeave={() => setHoveredDate(null)}
                      onClick={() => handleDateClick(date)}
                    >
                      <AnimatePresence mode="wait">
                        <motion.div
                          key={cell?.name ?? "empty"}
                          initial={{ opacity: 0, scale: 0.9 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.9 }}
                          transition={{ duration: 0.2 }}
                          className={cn(
                            "flex flex-col items-center justify-center gap-1 rounded-lg px-2 py-2 min-h-[44px] cursor-pointer transition-colors duration-200",
                            cell
                              ? isActive
                                ? "bg-primary/10 dark:bg-primary/20 ring-1 ring-primary/30"
                                : "bg-muted/60 hover:bg-muted"
                              : "bg-transparent",
                          )}
                        >
                          {cell ? (
                            <>
                              {cell.imageUrl && (
                                <TinyAvatar
                                  src={cell.imageUrl}
                                  name={cell.name}
                                />
                              )}
                              <span
                                className={cn(
                                  "text-xs-plus font-medium leading-tight text-center",
                                  isActive
                                    ? "text-primary"
                                    : "text-foreground/80",
                                )}
                              >
                                {cell.name}
                              </span>
                            </>
                          ) : (
                            <span className="text-2xs text-muted-foreground/40">
                              &mdash;
                            </span>
                          )}
                        </motion.div>
                      </AnimatePresence>
                    </td>
                  );
                })}
              </motion.tr>
            ))}
          </tbody>
        </table>
      </div>
    </motion.div>
  );
}
