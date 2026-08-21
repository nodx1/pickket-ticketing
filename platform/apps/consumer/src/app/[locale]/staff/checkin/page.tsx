"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { CheckCircle2, Loader2, Users } from "lucide-react";
import {
  Button,
  Input,
  Progress,
  QrScanner,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@pickket/ui";
import {
  checkIn,
  getCheckinAttendees,
  getCheckinStats,
  getMyCheckinEvents,
  type CheckinAttendee,
  type CheckinEventOption,
  type CheckinStats,
} from "@pickket/lib/api";

export default function StaffCheckinPage() {
  const t = useTranslations("staff.checkin");
  const [events, setEvents] = useState<CheckinEventOption[]>([]);
  const [selectedEventId, setSelectedEventId] = useState("");
  const [stats, setStats] = useState<CheckinStats | null>(null);
  const [attendees, setAttendees] = useState<CheckinAttendee[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<string | null>(null);

  const refreshData = useCallback(async () => {
    if (!selectedEventId) return;
    try {
      const [statsData, attendeeData] = await Promise.all([
        getCheckinStats(selectedEventId),
        getCheckinAttendees(selectedEventId, {
          q: query || undefined,
          limit: 30,
        }),
      ]);
      setStats(statsData);
      setAttendees(attendeeData.attendees);
    } catch {
      toast.error(t("errorLoadData"));
    } finally {
      setLoading(false);
    }
  }, [query, selectedEventId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const eventOptions = await getMyCheckinEvents();
        if (cancelled) return;
        setEvents(eventOptions);
        if (eventOptions.length > 0) {
          setSelectedEventId(eventOptions[0].id);
        }
      } catch {
        toast.error(t("errorLoadEvents"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void refreshData();
  }, [refreshData]);

  async function handleScan(data: string) {
    if (!selectedEventId) return;
    try {
      await checkIn(selectedEventId, { qr_data: data, method: "qr_scan" });
      setFeedback(t("qrCheckinSuccess"));
      toast.success(t("checkinSuccess"));
      await refreshData();
    } catch (error) {
      const detail = (error as { response?: { data?: { detail?: string } } })
        ?.response?.data?.detail;
      setFeedback(detail || t("checkinFail"));
      toast.error(detail || t("checkinFail"));
    }
  }

  async function handleManualCheckin(attendee: CheckinAttendee) {
    if (!selectedEventId) return;
    try {
      await checkIn(selectedEventId, {
        ticket_id: attendee.ticket_id,
        method: "manual",
      });
      toast.success(t("manualCheckinSuccess"));
      await refreshData();
    } catch {
      toast.error(t("manualCheckinFail"));
    }
  }

  const progress =
    stats && stats.total_tickets > 0
      ? (stats.checked_in / stats.total_tickets) * 100
      : 0;

  return (
    <main className="space-y-5 px-4 pt-20 pb-4 md:px-6 md:pb-6">
      <header className="rounded-3xl border border-border bg-card p-5">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          Staff Check-In
        </p>
        <h1 className="mt-2 text-2xl font-black">{t("pageTitle")}</h1>
        <div className="mt-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="w-full md:max-w-sm">
            <Select value={selectedEventId} onValueChange={setSelectedEventId}>
              <SelectTrigger className="rounded-2xl">
                <SelectValue placeholder={t("selectEvent")} />
              </SelectTrigger>
              <SelectContent>
                {events.map((event) => (
                  <SelectItem key={event.id} value={event.id}>
                    {event.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="w-full md:max-w-sm space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span>{t("admissionRate")}</span>
              <span className="font-semibold">{progress.toFixed(0)}%</span>
            </div>
            <Progress value={progress} className="h-3" />
          </div>
        </div>
      </header>

      {loading && !stats ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
          <section className="space-y-5">
            {feedback && (
              <div className="rounded-3xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
                <div className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />
                  <p>{feedback}</p>
                </div>
              </div>
            )}
            <QrScanner
              onScan={handleScan}
              onError={(error) => toast.error(error)}
            />
          </section>

          <aside className="space-y-4 rounded-3xl border border-border bg-card p-5">
            <div className="flex items-center gap-2 text-lg font-semibold">
              <Users className="h-5 w-5" />
              {t("attendeeList")}
            </div>
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("searchPlaceholder")}
              aria-label={t("searchAriaLabel")}
            />
            <div className="space-y-3">
              {attendees.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  {t("noAttendees")}
                </p>
              )}
              {attendees.map((attendee) => (
                <div
                  key={attendee.ticket_id}
                  className="rounded-2xl bg-muted/40 p-3"
                >
                  <p className="font-medium">{attendee.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {attendee.tier || t("noTier")} ·{" "}
                    {attendee.seat || t("freeSeat")}
                  </p>
                  <div className="mt-3 flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">
                      {attendee.phone || t("noPhone")}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="rounded-full"
                      disabled={attendee.status !== "active"}
                      onClick={() => void handleManualCheckin(attendee)}
                    >
                      {t("checkinButton")}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </aside>
        </div>
      )}
    </main>
  );
}
