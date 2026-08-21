"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { motion, AnimatePresence } from "motion/react";
import { Sparkles, Users, Clock, Heart } from "lucide-react";
import {
  getAnticipationSessions,
  joinAnticipationSession,
} from "@pickket/lib/api";

interface Session {
  id: string;
  event_id: string;
  title: string;
  description: string | null;
  scheduled_at: string | null;
  spotify_playlist_url: string | null;
  participant_count: number;
  created_at: string;
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

function useCountdown(
  targetDate: string | null,
  t: ReturnType<typeof useTranslations>,
) {
  const [remaining, setRemaining] = useState("");

  useEffect(() => {
    if (!targetDate) return;

    function calc() {
      const diff = new Date(targetDate!).getTime() - Date.now();
      if (diff <= 0) {
        setRemaining(t("countdown.live"));
        return;
      }
      const d = Math.floor(diff / 86_400_000);
      const h = Math.floor((diff % 86_400_000) / 3_600_000);
      const m = Math.floor((diff % 3_600_000) / 60_000);
      const s = Math.floor((diff % 60_000) / 1_000);

      if (d > 0) {
        setRemaining(t("countdown.daysHours", { d: d ?? 0, h: h ?? 0 }));
      } else if (h > 0) {
        setRemaining(t("countdown.hoursMinutes", { h: h ?? 0, m: m ?? 0 }));
      } else {
        setRemaining(t("countdown.minutesSeconds", { m: m ?? 0, s: s ?? 0 }));
      }
    }

    calc();
    const timer = setInterval(calc, 1_000);
    return () => clearInterval(timer);
  }, [targetDate, t]);

  return remaining;
}

/** Convert Spotify playlist URL to embed URL */
function toSpotifyEmbedUrl(url: string): string | null {
  // https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M → embed
  const match = url.match(
    /open\.spotify\.com\/(playlist|album|track)\/([a-zA-Z0-9]+)/,
  );
  if (!match) return null;
  return `https://open.spotify.com/embed/${match[1]}/${match[2]}?utm_source=generator&theme=0`;
}

/* ── Animated counter ────────────────────────────────────────────────────── */

function AnimatedCount({ value }: { value: number }) {
  const [display, setDisplay] = useState(value);

  useEffect(() => {
    if (display === value) return;
    const diff = value - display;
    const step = diff > 0 ? 1 : -1;
    const delay = Math.max(20, Math.min(80, 400 / Math.abs(diff)));
    const timer = setTimeout(() => setDisplay((p) => p + step), delay);
    return () => clearTimeout(timer);
  }, [value, display]);

  return (
    <motion.span
      key={display}
      initial={{ y: -6, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.15 }}
      className="tabular-nums"
    >
      {display.toLocaleString("ko-KR")}
    </motion.span>
  );
}

/* ── Session card ────────────────────────────────────────────────────────── */

function SessionCard({
  session,
  index,
  onJoin,
  t,
}: {
  session: Session;
  index: number;
  onJoin: (id: string) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const countdown = useCountdown(session.scheduled_at, t);
  const embedUrl = session.spotify_playlist_url
    ? toSpotifyEmbedUrl(session.spotify_playlist_url)
    : null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: index * 0.08 }}
      className="relative rounded-2xl overflow-hidden"
    >
      {/* Gradient border */}
      <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-purple-500/30 via-blue-500/20 to-purple-500/10 p-[1px]">
        <div className="h-full w-full rounded-2xl bg-card/95 backdrop-blur-xl" />
      </div>

      <div className="relative p-5 sm:p-6 space-y-4">
        {/* Title row */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <h4 className="text-base font-bold text-foreground truncate">
              {session.title}
            </h4>
            {session.description && (
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground line-clamp-2">
                {session.description}
              </p>
            )}
          </div>
        </div>

        {/* Stats row */}
        <div className="flex flex-wrap items-center gap-4 text-sm">
          {/* Participant count */}
          <div className="flex items-center gap-1.5 text-primary/70">
            <Users className="h-4 w-4" />
            <AnimatedCount value={session.participant_count} />
            <span className="text-muted-foreground">{t("participantSuffix")}</span>
          </div>

          {/* Countdown */}
          {session.scheduled_at && countdown && (
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <Clock className="h-4 w-4" />
              <span>{countdown}</span>
            </div>
          )}
        </div>

        {/* Spotify embed */}
        {embedUrl && (
          <div className="rounded-xl overflow-hidden">
            <iframe
              src={embedUrl}
              width="100%"
              height="152"
              allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
              loading="lazy"
              className="border-0"
              title="Spotify playlist"
            />
          </div>
        )}

        {/* Join button */}
        <button
          type="button"
          onClick={() => onJoin(session.id)}
          className="w-full flex items-center justify-center gap-2 px-5 py-2.5 rounded-full text-sm font-semibold transition-all bg-primary hover:bg-primary/80 text-white active:scale-[0.97]"
        >
          <Heart className="h-4 w-4" />
          {t("joinButton")}
        </button>
      </div>
    </motion.div>
  );
}

/* ── Main component ──────────────────────────────────────────────────────── */

export function AnticipationSession({ eventId }: { eventId: string }) {
  const t = useTranslations("event.anticipation");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getAnticipationSessions(eventId)
      .then((res) => {
        if (!cancelled) {
          setSessions(res.data.items);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  const handleJoin = useCallback((sessionId: string) => {
    // Optimistic update
    setSessions((prev) =>
      prev.map((s) =>
        s.id === sessionId
          ? { ...s, participant_count: s.participant_count + 1 }
          : s,
      ),
    );

    joinAnticipationSession(sessionId).catch(() => {
      // Revert on error
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId
            ? { ...s, participant_count: Math.max(0, s.participant_count - 1) }
            : s,
        ),
      );
    });
  }, []);

  // Don't render if no sessions or still loading
  if (!loaded || sessions.length === 0) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="space-y-4"
    >
      {/* Section header */}
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-primary/70" />
        <h3 className="text-sm font-bold tracking-wide text-foreground">
          {t("sectionTitle")}
        </h3>
        <span className="text-xs text-muted-foreground">
          {t("sessionCount", { count: sessions.length ?? 0 })}
        </span>
      </div>

      {/* Session cards */}
      <AnimatePresence>
        <div className="grid gap-4 sm:grid-cols-2">
          {sessions.map((session, i) => (
            <SessionCard
              key={session.id}
              session={session}
              index={i}
              onJoin={handleJoin}
              t={t}
            />
          ))}
        </div>
      </AnimatePresence>
    </motion.div>
  );
}
