"use client";

import React, { useEffect, useMemo } from "react";
import { Calendar, Clock, Users } from "lucide-react";
import { Badge } from "@pickket/ui";
import { type SessionData } from "@pickket/lib/api";
import { cn } from "@pickket/lib";
import { useLocale, useTranslations } from "next-intl";

interface SessionPickerProps {
  sessions: SessionData[];
  selectedEventId: string | null;
  onSelect: (eventId: string) => void;
  sessionLabel?: string;
  category?: string;
  participants?: Array<{ position: string; name: string; session_id?: string }>;
}

function formatSessionDate(dateStr: string, locale: string) {
  const d = new Date(dateStr);
  const month = d.getMonth() + 1;
  const day = d.getDate();
  // Use Intl for locale-aware short day name (e.g. "Mon", "월", "月")
  const dayOfWeek = new Intl.DateTimeFormat(locale, { weekday: "short" }).format(
    d,
  );
  return { month, day, dayOfWeek };
}

function formatSessionTime(dateStr: string, locale: string) {
  const d = new Date(dateStr);
  return d.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export default function SessionPicker({
  sessions,
  selectedEventId,
  onSelect,
  sessionLabel,
  category,
  participants,
}: SessionPickerProps) {
  const locale = useLocale();
  const t = useTranslations("booking");
  // Auto-select if single session
  useEffect(() => {
    if (sessions.length === 1 && !selectedEventId) {
      onSelect(sessions[0].event_id);
    }
  }, [sessions, selectedEventId, onSelect]);

  // Exhibition time slot grid: group sessions by date, render as time buttons
  const exhibitionGroups = useMemo(() => {
    if (category !== "exhibition" || sessions.length <= 2) return null;
    const groups = new Map<string, SessionData[]>();
    for (const s of sessions) {
      const dateKey = s.event_date.split("T")[0];
      if (!groups.has(dateKey)) groups.set(dateKey, []);
      groups.get(dateKey)!.push(s);
    }
    // Sort sessions within each group by time
    for (const [, group] of groups) {
      group.sort(
        (a, b) =>
          new Date(a.event_date).getTime() - new Date(b.event_date).getTime(),
      );
    }
    return groups.size > 1 ? groups : null;
  }, [sessions, category]);

  if (sessions.length === 0) return null;

  // Single session: compact inline display
  if (sessions.length === 1) {
    const s = sessions[0];
    const { month, day, dayOfWeek } = formatSessionDate(s.event_date, locale);
    const time = formatSessionTime(s.event_date, locale);
    return (
      <div className="bg-card border border-border rounded-2xl p-3 flex items-center gap-3">
        <Calendar className="h-4 w-4 text-primary shrink-0" />
        <span className="text-sm font-medium text-foreground">
          {month}/{day} ({dayOfWeek}) {time}
        </span>
        <span className="text-xs text-muted-foreground">
          {t("seats_left").replace("{n}", String(s.available_seats))}
        </span>
      </div>
    );
  }

  if (exhibitionGroups) {
    return (
      <section>
        <h2 className="flex items-center gap-2 text-lg font-bold text-foreground mb-4">
          <Clock className="h-5 w-5 text-primary" />
          {t("select_session")}
        </h2>
        <div className="space-y-4">
          {Array.from(exhibitionGroups.entries()).map(([dateKey, group]) => {
            const d = new Date(dateKey + "T00:00:00");
            const dayOfWeek = new Intl.DateTimeFormat(locale, {
              weekday: "short",
            }).format(d);
            return (
              <div key={dateKey}>
                <p className="text-sm font-semibold text-foreground mb-2">
                  {d.getMonth() + 1}/{d.getDate()} ({dayOfWeek})
                </p>
                <div className="flex flex-wrap gap-2">
                  {group.map((s) => {
                    const isSelected = selectedEventId === s.event_id;
                    const isSoldOut = s.available_seats === 0;
                    const time = formatSessionTime(s.event_date, locale);
                    return (
                      <button
                        key={s.event_id}
                        type="button"
                        onClick={() => !isSoldOut && onSelect(s.event_id)}
                        disabled={isSoldOut}
                        className={cn(
                          "relative px-4 py-2.5 rounded-xl text-sm font-medium transition-all",
                          isSelected &&
                            !isSoldOut &&
                            "bg-primary text-white ring-2 ring-primary/30",
                          isSoldOut &&
                            "opacity-40 cursor-not-allowed bg-muted text-muted-foreground/60 line-through",
                          !isSelected &&
                            !isSoldOut &&
                            "bg-card/90 shadow-sm hover:shadow-md border border-border hover:border-primary/50 text-foreground",
                        )}
                      >
                        {time}
                        {!isSoldOut && s.available_seats <= 10 && (
                          <span className="block text-2xs text-red-600 dark:text-red-400 mt-0.5">
                            {t("seats_left").replace(
                              "{n}",
                              String(s.available_seats),
                            )}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    );
  }

  return (
    <section>
      <h2 className="flex items-center gap-2 text-lg font-bold text-foreground mb-4">
        <Calendar className="h-5 w-5 text-primary" />
        {sessionLabel ?? t("session")} {t("select_suffix")}
      </h2>

      <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-hide -mx-1 px-1">
        {sessions.map((s, idx) => {
          const { month, day, dayOfWeek } = formatSessionDate(s.event_date, locale);
          const time = formatSessionTime(s.event_date, locale);
          const isSoldOut = s.available_seats === 0;
          const isSelected = selectedEventId === s.event_id;
          const formattedDate = `${month}/${day} (${dayOfWeek}) ${time}`;
          const sessionParticipants = (participants ?? []).filter(
            (p) => p.session_id === s.event_id,
          );

          return (
            <button
              key={s.event_id}
              type="button"
              onClick={() => !isSoldOut && onSelect(s.event_id)}
              disabled={isSoldOut}
              aria-label={`${formattedDate} ${t("session_select_aria")}${isSoldOut ? ` - ${t("sold_out")}` : ""}`}
              className={cn(
                "relative flex-shrink-0 min-w-[120px] rounded-2xl p-3 text-left transition-all duration-200",
                "bg-card/90 backdrop-blur-sm border border-border shadow-[0_4px_16px_rgba(0,0,0,0.3)]",
                isSelected && !isSoldOut && "ring-2 ring-primary bg-primary/5",
                isSoldOut && "opacity-50 cursor-not-allowed",
                !isSoldOut && !isSelected && "hover:shadow-md",
              )}
            >
              {isSoldOut && (
                <Badge className="absolute -top-2 -right-2 bg-red-600 text-white text-2xs px-1.5">
                  {t("sold_out")}
                </Badge>
              )}
              {category === "festival" && (
                <div className="text-xs font-bold text-primary mb-0.5">
                  DAY {idx + 1}
                </div>
              )}
              <div className="text-sm font-bold text-foreground">
                {month}/{day} ({dayOfWeek})
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">{time}</div>
              <div className="flex items-center gap-1 mt-2 text-xs text-muted-foreground">
                <Users className="h-3 w-3" />
                <span>
                  {t("seats_left").replace("{n}", String(s.available_seats))}
                </span>
              </div>
              {(category === "musical" || category === "classical") &&
                sessionParticipants.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {sessionParticipants.slice(0, 2).map((p) => (
                      <span
                        key={p.name}
                        className="text-2xs bg-primary/10 text-primary/70 rounded-full px-1.5 py-0.5"
                      >
                        {p.name}
                      </span>
                    ))}
                    {sessionParticipants.length > 2 && (
                      <span className="text-2xs text-muted-foreground/60">
                        +{sessionParticipants.length - 2}
                      </span>
                    )}
                  </div>
                )}
              {category === "exhibition" && (
                <Badge
                  variant="outline"
                  className="text-2xs mt-1 border-border text-muted-foreground"
                >
                  {new Date(s.event_date).toLocaleTimeString(locale, {
                    hour: "2-digit",
                    minute: "2-digit",
                    hour12: false,
                  })}
                </Badge>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}
