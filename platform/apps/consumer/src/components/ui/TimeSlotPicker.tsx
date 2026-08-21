"use client";

import { useEffect, useMemo, useState } from "react";
import { Clock3, Loader2, RefreshCw, Users } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { Button } from "@pickket/ui";
import { getTimeSlots, type TimeSlotAvailability } from "@pickket/lib/api";

interface TimeSlotPickerProps {
  eventId: string;
  date: string;
  durationMinutes: number;
  capacity: number;
  onSelect: (slot: { start: string; end: string }) => void;
}

function formatTimeRange(locale: string, start: string, end: string): string {
  const formatter = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${formatter.format(new Date(start))} - ${formatter.format(new Date(end))}`;
}

export default function TimeSlotPicker({
  eventId,
  date,
  durationMinutes,
  capacity,
  onSelect,
}: TimeSlotPickerProps) {
  const t = useTranslations("timeSlot");
  const locale = useLocale();
  const [slots, setSlots] = useState<TimeSlotAvailability[]>([]);
  const [selectedStart, setSelectedStart] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    void getTimeSlots(eventId, date)
      .then((result) => {
        if (!active) return;
        setSlots(result.slots);
        if (result.slots.length === 0) {
          setSelectedStart(null);
        }
      })
      .catch(() => {
        if (!active) return;
        setSlots([]);
        setError(t("error"));
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [date, eventId, t]);

  const selectedSlot = useMemo(
    () => slots.find((slot) => slot.start === selectedStart) ?? null,
    [selectedStart, slots],
  );

  return (
    <section className="rounded-3xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-lg font-semibold">
            <Clock3 className="h-5 w-5 text-primary" />
            {t("title")}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("description", { minutes: durationMinutes, capacity })}
          </p>
        </div>
        <div className="text-sm text-muted-foreground">{date}</div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : error ? (
        <div className="mt-4 rounded-2xl border border-border bg-muted/40 p-4">
          <p className="text-sm text-destructive">{error}</p>
          <Button
            type="button"
            variant="outline"
            className="mt-3 rounded-full"
            onClick={() => {
              setSelectedStart(null);
              setError(null);
              setLoading(true);
              void getTimeSlots(eventId, date)
                .then((result) => setSlots(result.slots))
                .catch(() => setError(t("error")))
                .finally(() => setLoading(false));
            }}
          >
            <RefreshCw className="h-4 w-4" />
            {t("retry")}
          </Button>
        </div>
      ) : slots.length === 0 ? (
        <div className="mt-4 rounded-2xl border border-dashed border-border bg-muted/20 p-4 text-sm text-muted-foreground">
          {t("empty")}
        </div>
      ) : (
        <div
          className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3"
          role="list"
          aria-label={t("title")}
        >
          {slots.map((slot) => {
            const isSelected = selectedStart === slot.start;
            const disabled = slot.available <= 0;
            return (
              <div key={slot.start} role="listitem">
                <button
                  type="button"
                  disabled={disabled}
                  aria-pressed={isSelected}
                  aria-label={`${formatTimeRange(locale, slot.start, slot.end)}, ${t("available", { available: slot.available, total: slot.total })}`}
                  className={`w-full rounded-2xl border px-4 py-4 text-left transition ${
                    isSelected
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background hover:border-primary/40"
                  } ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
                  onClick={() => {
                    if (disabled) return;
                    setSelectedStart(slot.start);
                    onSelect({ start: slot.start, end: slot.end });
                  }}
                >
                  <p className="text-base font-semibold">
                    {formatTimeRange(locale, slot.start, slot.end)}
                  </p>
                  <p
                    className={`mt-2 flex items-center gap-2 text-sm ${isSelected ? "text-primary-foreground/80" : "text-muted-foreground"}`}
                  >
                    <Users className="h-4 w-4" />
                    {disabled
                      ? t("soldOut")
                      : t("available", {
                          available: slot.available,
                          total: slot.total,
                        })}
                  </p>
                </button>
              </div>
            );
          })}
        </div>
      )}

      {selectedSlot && (
        <p className="mt-4 text-sm font-medium text-primary">
          {t("selected", {
            time: formatTimeRange(locale, selectedSlot.start, selectedSlot.end),
          })}
        </p>
      )}
    </section>
  );
}
