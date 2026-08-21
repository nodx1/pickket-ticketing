"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import Image from "next/image";
import { useTranslations, useLocale } from "next-intl";
import { motion, AnimatePresence } from "motion/react";
import type { ParticipantSlot, ParticipantAssignment } from "@pickket/lib/api";

// ─── Constants ──────────────────────────────────────────────────────────────

/** Pixels per minute for proportional block height in timetable grid view */
const PX_PER_MINUTE = 1.6;

const STAGE_COLORS = [
  {
    bg: "bg-violet-500/15 dark:bg-violet-500/25",
    border: "border-violet-500/30",
    text: "text-violet-700 dark:text-violet-300",
    dot: "bg-violet-500",
  },
  {
    bg: "bg-sky-500/15 dark:bg-sky-500/25",
    border: "border-sky-500/30",
    text: "text-sky-700 dark:text-sky-300",
    dot: "bg-sky-500",
  },
  {
    bg: "bg-amber-500/15 dark:bg-amber-500/25",
    border: "border-amber-500/30",
    text: "text-amber-700 dark:text-amber-300",
    dot: "bg-amber-500",
  },
  {
    bg: "bg-emerald-500/15 dark:bg-emerald-500/25",
    border: "border-emerald-500/30",
    text: "text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
  {
    bg: "bg-rose-500/15 dark:bg-rose-500/25",
    border: "border-rose-500/30",
    text: "text-rose-700 dark:text-rose-300",
    dot: "bg-rose-500",
  },
  {
    bg: "bg-indigo-500/15 dark:bg-indigo-500/25",
    border: "border-indigo-500/30",
    text: "text-indigo-700 dark:text-indigo-300",
    dot: "bg-indigo-500",
  },
] as const;

// ─── Types ──────────────────────────────────────────────────────────────────

interface FestivalTimetableProps {
  slots: ParticipantSlot[];
  assignments: ParticipantAssignment[];
  eventDateStart: string;
  eventDateEnd?: string;
}

interface DayData {
  label: string;
  dateStr: string;
  dayOfWeek: string;
  month: number;
  day: number;
}

interface TimetableCell {
  assignment: ParticipantAssignment;
  slotName: string;
  stageIndex: number;
}

interface SimpleGridEntry {
  assignment: ParticipantAssignment;
  slotName: string;
  stageIndex: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseDatePart(iso: string): string {
  return iso.split("T")[0];
}

function parseHour(iso: string): number {
  const timePart = iso.split("T")[1];
  if (!timePart) return 0;
  return parseInt(timePart.split(":")[0], 10);
}

function parseMinute(iso: string): number {
  const timePart = iso.split("T")[1];
  if (!timePart) return 0;
  return parseInt(timePart.split(":")[1], 10);
}

function formatTime(hour: number): string {
  const period = hour < 12 ? "AM" : "PM";
  const display = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${display}${period}`;
}

function formatTimeMinute(hour: number, minute: number): string {
  const h = hour.toString().padStart(2, "0");
  const m = minute.toString().padStart(2, "0");
  return `${h}:${m}`;
}

function buildDays(
  startStr: string,
  endStr: string | undefined,
  locale: string,
): DayData[] {
  const start = new Date(startStr);
  const end = endStr ? new Date(endStr) : start;
  const days: DayData[] = [];
  const cursor = new Date(start);
  cursor.setHours(0, 0, 0, 0);
  const endDate = new Date(end);
  endDate.setHours(23, 59, 59, 999);
  const dayFmt = new Intl.DateTimeFormat(locale, { weekday: "short" });

  let idx = 0;
  while (cursor <= endDate && idx < 30) {
    days.push({
      label: `DAY ${idx + 1}`,
      dateStr: cursor.toISOString().split("T")[0],
      dayOfWeek: dayFmt.format(cursor),
      month: cursor.getMonth() + 1,
      day: cursor.getDate(),
    });
    cursor.setDate(cursor.getDate() + 1);
    idx++;
  }

  return days.length > 0
    ? days
    : [
        {
          label: "DAY 1",
          dateStr: parseDatePart(startStr),
          dayOfWeek: dayFmt.format(start),
          month: start.getMonth() + 1,
          day: start.getDate(),
        },
      ];
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function FestivalTimetable({
  slots,
  assignments,
  eventDateStart,
  eventDateEnd,
}: FestivalTimetableProps) {
  const t = useTranslations("domain");
  const locale = useLocale();
  const days = useMemo(
    () => buildDays(eventDateStart, eventDateEnd, locale),
    [eventDateStart, eventDateEnd, locale],
  );
  const [activeDay, setActiveDay] = useState(0);

  // Live clock: updates every minute
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  // Auto-navigate to today's day tab on mount
  useEffect(() => {
    const todayStr = new Date().toISOString().split("T")[0];
    const todayIdx = days.findIndex((d) => d.dateStr === todayStr);
    if (todayIdx >= 0) setActiveDay(todayIdx);
  }, [days]);

  // Build slot lookup
  const slotMap = useMemo(() => {
    const map = new Map<string, ParticipantSlot>();
    for (const s of slots) map.set(s.id, s);
    return map;
  }, [slots]);

  // Ordered stage names (by sort_order)
  const stageNames = useMemo(() => {
    const sorted = [...slots].sort((a, b) => a.sort_order - b.sort_order);
    return sorted.map((s) => s.slot_name);
  }, [slots]);

  // Stage filter toggles (all active by default)
  const [activeStages, setActiveStages] = useState<Set<string>>(
    () => new Set(stageNames),
  );

  // Sync activeStages when stageNames change (e.g. new data loaded)
  useEffect(() => {
    setActiveStages(new Set(stageNames));
  }, [stageNames]);

  // Is the currently selected day tab today?
  const isToday = useMemo(() => {
    const todayStr = now.toISOString().split("T")[0];
    return days[activeDay]?.dateStr === todayStr;
  }, [now, days, activeDay]);

  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();

  // Check if we have meaningful time variation (different hours across assignments)
  const hasTimeVariation = useMemo(() => {
    if (assignments.length <= 1) return false;
    const hours = new Set(assignments.map((a) => parseHour(a.session_date)));
    return hours.size > 1;
  }, [assignments]);

  // Group assignments by day date string
  const assignmentsByDay = useMemo(() => {
    const map = new Map<string, ParticipantAssignment[]>();
    for (const a of assignments) {
      const d = parseDatePart(a.session_date);
      const list = map.get(d) || [];
      list.push(a);
      map.set(d, list);
    }
    return map;
  }, [assignments]);

  // Get current day's data
  const currentDay = days[activeDay];
  const currentAssignments = useMemo(
    () => assignmentsByDay.get(currentDay?.dateStr ?? "") || [],
    [assignmentsByDay, currentDay],
  );

  // Build time grid structure for current day
  const timeGrid = useMemo(() => {
    if (!hasTimeVariation) return null;

    // Collect all hours for this day
    const hourSet = new Set<number>();
    for (const a of currentAssignments) {
      hourSet.add(parseHour(a.session_date));
    }
    const hours = Array.from(hourSet).sort((a, b) => a - b);

    // Build grid: hour -> stageIndex -> assignments
    const grid = new Map<number, Map<number, TimetableCell[]>>();
    for (const hour of hours) {
      grid.set(hour, new Map());
    }

    for (const a of currentAssignments) {
      const hour = parseHour(a.session_date);
      const slot = slotMap.get(a.slot_id);
      const stageName = slot?.slot_name ?? "STAGE";
      const stageIdx = stageNames.indexOf(stageName);
      const idx = stageIdx >= 0 ? stageIdx : 0;

      const hourMap = grid.get(hour);
      if (hourMap) {
        const cells = hourMap.get(idx) || [];
        cells.push({ assignment: a, slotName: stageName, stageIndex: idx });
        hourMap.set(idx, cells);
      }
    }

    return { hours, grid };
  }, [currentAssignments, hasTimeVariation, slotMap, stageNames]);

  // Build simple grid for fallback (no time variation)
  const simpleGrid = useMemo((): SimpleGridEntry[] | null => {
    if (hasTimeVariation) return null;

    return currentAssignments.map((a) => {
      const slot = slotMap.get(a.slot_id);
      const stageName = slot?.slot_name ?? "STAGE";
      const stageIdx = stageNames.indexOf(stageName);
      return {
        assignment: a,
        slotName: stageName,
        stageIndex: stageIdx >= 0 ? stageIdx : 0,
      };
    });
  }, [currentAssignments, hasTimeVariation, slotMap, stageNames]);

  const getStageColor = useCallback(
    (idx: number) => STAGE_COLORS[idx % STAGE_COLORS.length],
    [],
  );

  const toggleStage = useCallback((stageName: string) => {
    setActiveStages((prev) => {
      const next = new Set(prev);
      if (next.has(stageName)) {
        next.delete(stageName);
      } else {
        next.add(stageName);
      }
      return next;
    });
  }, []);

  const resetStages = useCallback(() => {
    setActiveStages(new Set(stageNames));
  }, [stageNames]);

  // Empty state
  if (assignments.length === 0) {
    return (
      <div className="rounded-2xl border border-border bg-card/80 backdrop-blur-sm p-8 text-center">
        <p className="text-sm text-muted-foreground">
          {t("festivalTimetable.noSchedule")}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-border bg-card/80 backdrop-blur-sm overflow-hidden">
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="px-5 pt-5 pb-3">
        <h3 className="text-base font-bold text-foreground tracking-tight">
          {t("festivalTimetable.title")}
        </h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          {t("festivalTimetable.stageSchedule")}
        </p>
      </div>

      {/* ── Day Tabs ───────────────────────────────────────────── */}
      {days.length > 1 && (
        <div className="px-4 pb-3">
          <div
            className="flex gap-2 overflow-x-auto scrollbar-hide pb-1"
            role="tablist"
            aria-label={t("festivalTimetable.ariaDayTabs")}
          >
            {days.map((d, idx) => {
              const isActive = idx === activeDay;
              const hasAssignments =
                (assignmentsByDay.get(d.dateStr)?.length ?? 0) > 0;
              return (
                <button
                  key={d.dateStr}
                  type="button"
                  role="tab"
                  onClick={() => setActiveDay(idx)}
                  disabled={!hasAssignments}
                  aria-selected={isActive}
                  aria-label={t("festivalTimetable.ariaDayTab", {
                    label: d.label,
                    month: d.month,
                    day: d.day,
                    dayOfWeek: d.dayOfWeek,
                  })}
                  className={[
                    "relative flex-shrink-0 rounded-xl px-4 py-2.5 text-center transition-all duration-200",
                    "min-w-[90px] min-h-[44px] border",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2",
                    isActive
                      ? "bg-foreground text-background border-foreground shadow-lg shadow-foreground/10"
                      : hasAssignments
                        ? "bg-muted/60 text-foreground border-border hover:bg-muted hover:border-border/80"
                        : "bg-muted/30 text-muted-foreground/50 border-transparent cursor-not-allowed",
                  ].join(" ")}
                >
                  <span className="block text-xs-plus font-bold tracking-wider">
                    {d.label}
                  </span>
                  <span
                    className={[
                      "block text-2xs mt-0.5",
                      isActive ? "text-background/70" : "text-muted-foreground",
                    ].join(" ")}
                  >
                    {d.month}.{d.day} ({d.dayOfWeek})
                  </span>
                  {isActive && (
                    <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full bg-primary" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Stage Legend (toggle filters) ─────────────────────── */}
      {stageNames.length > 0 && (
        <div className="px-5 pb-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={resetStages}
            aria-label={t("festivalTimetable.ariaAllStages")}
            aria-pressed={activeStages.size === stageNames.length}
            className={[
              "text-2xs font-bold px-2.5 py-1 min-h-[44px] rounded-full border transition-all duration-200",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2",
              activeStages.size === stageNames.length
                ? "bg-foreground text-background border-foreground"
                : "bg-muted/60 text-muted-foreground border-border hover:bg-muted",
            ].join(" ")}
          >
            {t("festivalTimetable.allStages")}
          </button>
          {stageNames.map((name, idx) => {
            const color = getStageColor(idx);
            const isActive = activeStages.has(name);
            return (
              <button
                key={name}
                type="button"
                onClick={() => toggleStage(name)}
                aria-pressed={isActive}
                aria-label={t("festivalTimetable.ariaStageToggle", {
                  name,
                  action: isActive
                    ? t("festivalTimetable.ariaStageHide")
                    : t("festivalTimetable.ariaStageShow"),
                })}
                className={[
                  "flex items-center gap-1.5 px-2.5 py-1 min-h-[44px] rounded-full border transition-all duration-200",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2",
                  isActive
                    ? `${color.bg} ${color.border}`
                    : "opacity-40 bg-muted/30 border-border",
                ].join(" ")}
              >
                <span className={`w-2 h-2 rounded-full ${color.dot}`} />
                <span
                  className={`text-xs-plus font-medium ${isActive ? color.text : "text-muted-foreground"}`}
                >
                  {name}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* ── Day content with cross-fade ──────────────────────── */}
      <AnimatePresence mode="wait">
        <motion.div
          key={activeDay}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.2 }}
        >
          {/* ── Timetable Grid (with time axis) ──────────────────── */}
          {hasTimeVariation &&
            timeGrid &&
            (() => {
              // Calculate red "now" line position
              const minHour = timeGrid.hours[0];
              const maxHour = timeGrid.hours[timeGrid.hours.length - 1] + 1;
              const totalHours = maxHour - minHour;
              const nowFraction = isToday
                ? (currentHour + currentMinute / 60 - minHour) / totalHours
                : -1;
              const showNowLine =
                isToday && nowFraction >= 0 && nowFraction <= 1;
              // Filter visible stage indices
              const visibleStageIndices = stageNames
                .map((name, idx) => ({ name, idx }))
                .filter((s) => activeStages.has(s.name));

              return (
                <div className="relative overflow-x-auto overflow-y-auto max-h-[520px] scrollbar-thin">
                  <table className="w-full border-collapse min-w-[320px] sm:min-w-[480px]">
                    <thead className="sticky top-0 z-10">
                      <tr className="bg-muted/90 backdrop-blur-sm">
                        <th className="text-xs-plus font-semibold text-muted-foreground uppercase tracking-wider px-4 py-3 text-left w-[72px] border-b border-border/50">
                          {t("festivalTimetable.time")}
                        </th>
                        {visibleStageIndices.map(({ name, idx }) => {
                          const color = getStageColor(idx);
                          return (
                            <th
                              key={name}
                              className="text-xs-plus font-semibold uppercase tracking-wider px-3 py-3 text-center border-b border-border/50 border-l border-l-border/30"
                            >
                              <span className={color.text}>{name}</span>
                            </th>
                          );
                        })}
                      </tr>
                    </thead>
                    <tbody className="relative">
                      {timeGrid.hours.map((hour, hIdx) => (
                        <tr
                          key={hour}
                          className={[
                            "group transition-colors",
                            hIdx % 2 === 0 ? "bg-background" : "bg-muted/20",
                          ].join(" ")}
                        >
                          {/* Time label */}
                          <td className="px-4 py-3 align-top border-b border-border/30">
                            <span className="text-xs font-bold text-foreground/80 tabular-nums">
                              {formatTime(hour)}
                            </span>
                          </td>

                          {/* Stage columns (filtered) */}
                          {visibleStageIndices.map(({ idx: sIdx }) => {
                            const cells =
                              timeGrid.grid.get(hour)?.get(sIdx) || [];
                            const color = getStageColor(sIdx);

                            return (
                              <td
                                key={sIdx}
                                className="px-2 py-2 align-top border-b border-border/30 border-l border-l-border/20"
                              >
                                <div className="flex flex-col gap-1.5">
                                  {cells.map((cell) => {
                                    const cellHour = parseHour(
                                      cell.assignment.session_date,
                                    );
                                    const cellMinute = parseMinute(
                                      cell.assignment.session_date,
                                    );
                                    const duration =
                                      cell.assignment.duration_minutes ?? 60;
                                    const cellStartMin =
                                      cellHour * 60 + cellMinute;
                                    const cellEndMin = cellStartMin + duration;
                                    const nowMin =
                                      currentHour * 60 + currentMinute;
                                    const isLive =
                                      isToday &&
                                      nowMin >= cellStartMin &&
                                      nowMin < cellEndMin;

                                    return (
                                      <ArtistBlock
                                        key={cell.assignment.id}
                                        assignment={cell.assignment}
                                        color={color}
                                        showDuration
                                        isLive={isLive}
                                        liveLabel={t("festivalTimetable.live")}
                                        performingAriaLabel={t(
                                          "festivalTimetable.ariaPerforming",
                                          {
                                            name: cell.assignment
                                              .participant_name,
                                          },
                                        )}
                                      />
                                    );
                                  })}
                                </div>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  {/* Current time red line overlay */}
                  {showNowLine && (
                    <div
                      className="absolute left-0 right-0 z-20 pointer-events-none"
                      style={{
                        top: `calc(${nowFraction * 100}% + 44px)`,
                      }}
                      role="presentation"
                      aria-label={t("festivalTimetable.ariaNowLine", {
                        time: formatTimeMinute(currentHour, currentMinute),
                      })}
                    >
                      <div className="relative flex items-center">
                        <span
                          className="absolute left-1 w-2.5 h-2.5 rounded-full bg-red-500 shadow-md shadow-red-500/30"
                          aria-hidden="true"
                        />
                        <div
                          className="w-full h-0.5 bg-red-500/70"
                          aria-hidden="true"
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}

          {/* ── Simple Grid (no time axis fallback) ──────────────── */}
          {!hasTimeVariation && simpleGrid && simpleGrid.length > 0 && (
            <div className="px-5 pb-5">
              {/* Group by stage (filtered) */}
              {stageNames
                .filter((name) => activeStages.has(name))
                .map((stageName) => {
                  const sIdx = stageNames.indexOf(stageName);
                  const entries = simpleGrid.filter(
                    (e) => e.slotName === stageName,
                  );
                  if (entries.length === 0) return null;
                  const color = getStageColor(sIdx);

                  return (
                    <div key={stageName} className="mb-4 last:mb-0">
                      <div className="flex items-center gap-2 mb-2.5">
                        <span
                          className={`w-2.5 h-2.5 rounded-full ${color.dot}`}
                        />
                        <h4
                          className={`text-xs font-bold uppercase tracking-wider ${color.text}`}
                        >
                          {stageName}
                        </h4>
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                        {entries.map((entry) => (
                          <ArtistBlock
                            key={entry.assignment.id}
                            assignment={entry.assignment}
                            color={color}
                            liveLabel={t("festivalTimetable.live")}
                            performingAriaLabel={t(
                              "festivalTimetable.ariaPerforming",
                              { name: entry.assignment.participant_name },
                            )}
                          />
                        ))}
                      </div>
                    </div>
                  );
                })}

              {/* Assignments with no matching stage */}
              {(() => {
                const orphaned = simpleGrid.filter(
                  (e) => !stageNames.includes(e.slotName),
                );
                if (orphaned.length === 0) return null;
                return (
                  <div className="mt-4">
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                      {orphaned.map((entry) => (
                        <ArtistBlock
                          key={entry.assignment.id}
                          assignment={entry.assignment}
                          color={STAGE_COLORS[0]}
                          liveLabel={t("festivalTimetable.live")}
                          performingAriaLabel={t(
                            "festivalTimetable.ariaPerforming",
                            { name: entry.assignment.participant_name },
                          )}
                        />
                      ))}
                    </div>
                  </div>
                );
              })()}
            </div>
          )}

          {/* ── Empty day ────────────────────────────────────────── */}
          {currentAssignments.length === 0 && (
            <div className="px-5 pb-8 pt-4 text-center">
              <p className="text-sm text-muted-foreground">
                {t("festivalTimetable.emptyDay")}
              </p>
            </div>
          )}
        </motion.div>
      </AnimatePresence>

      {/* ── Footer ───────────────────────────────────────────── */}
      <div className="px-5 py-3 border-t border-border/40 bg-muted/30">
        <p className="text-2xs text-muted-foreground/60 text-center">
          {t("festivalTimetable.schedule")}
        </p>
      </div>
    </div>
  );
}

// ─── Artist Block Sub-component ─────────────────────────────────────────────

interface ArtistBlockProps {
  assignment: ParticipantAssignment;
  color: (typeof STAGE_COLORS)[number];
  /** When true, render proportional height based on duration_minutes */
  showDuration?: boolean;
  /** When true, shows a LIVE badge with ping animation */
  isLive?: boolean;
  /** Translated "LIVE" label */
  liveLabel?: string;
  /** Translated aria-label for performing status */
  performingAriaLabel?: string;
}

function computeEndTime(
  hour: number,
  minute: number,
  durationMin: number,
): string {
  const totalMin = hour * 60 + minute + durationMin;
  const endH = Math.floor(totalMin / 60) % 24;
  const endM = totalMin % 60;
  return formatTimeMinute(endH, endM);
}

function ArtistBlock({
  assignment,
  color,
  showDuration,
  isLive,
  liveLabel = "LIVE",
  performingAriaLabel,
}: ArtistBlockProps) {
  const hour = parseHour(assignment.session_date);
  const minute = parseMinute(assignment.session_date);
  const hasTime = assignment.session_date.includes("T");
  const duration = assignment.duration_minutes ?? 60;

  // Proportional min-height for timetable grid view
  const blockStyle = showDuration
    ? { minHeight: `${Math.max(duration * PX_PER_MINUTE, 48)}px` }
    : undefined;

  return (
    <motion.div
      whileHover={{ y: -2, scale: 1.02 }}
      transition={{ type: "spring", stiffness: 400, damping: 25 }}
      className={[
        "group/artist relative rounded-xl border px-3 py-2.5",
        "transition-shadow duration-200",
        "hover:shadow-md",
        showDuration ? "flex flex-col justify-between" : "",
        color.bg,
        color.border,
        isLive ? "ring-2 ring-red-500/60" : "",
      ].join(" ")}
      style={blockStyle}
    >
      {/* LIVE badge */}
      {isLive && (
        <span
          className="absolute top-1 right-1 flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-red-500 text-white text-2xs font-bold z-10"
          role="status"
          aria-live="polite"
          aria-label={performingAriaLabel}
        >
          <span className="relative flex h-1.5 w-1.5" aria-hidden="true">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-75" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-white" />
          </span>
          {liveLabel}
        </span>
      )}

      <div className="flex items-center gap-2.5">
        {/* Artist image */}
        {assignment.participant_image_url && (
          <div className="relative w-9 h-9 rounded-lg overflow-hidden flex-shrink-0 ring-1 ring-white/20">
            <Image
              src={assignment.participant_image_url}
              alt={assignment.participant_name}
              fill
              className="object-cover"
              sizes="36px"
            />
          </div>
        )}

        <div className="flex-1 min-w-0">
          {/* Artist name */}
          <p
            className={[
              "text-sm font-semibold leading-tight truncate",
              color.text,
            ].join(" ")}
          >
            {assignment.participant_name}
          </p>

          {/* Time range badge (start ~ end) */}
          {hasTime && (hour !== 0 || minute !== 0) && (
            <p className="text-2xs text-muted-foreground mt-0.5 tabular-nums">
              {formatTimeMinute(hour, minute)}
              {showDuration && ` - ${computeEndTime(hour, minute, duration)}`}
            </p>
          )}
        </div>
      </div>

      {/* Duration badge (only in timetable grid) */}
      {showDuration && (
        <p className="text-2xs text-muted-foreground/70 mt-1 tabular-nums">
          {duration}min
        </p>
      )}
    </motion.div>
  );
}
