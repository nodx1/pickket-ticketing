"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  joinWaitlist,
  getWaitlistStatus,
  leaveWaitlist,
} from "@pickket/lib/api";

/* ─── State ──────────────────────────────────────────────────────────────── */

interface WaitlistState {
  position: number | null;
  totalWaiting: number;
  status: "idle" | "joining" | "waiting" | "offered" | "accepted" | "error";
  entryId: string | null;
  error: string | null;
  offerDeadline: number | null; // timestamp (ms)
}

const INITIAL_STATE: WaitlistState = {
  position: null,
  totalWaiting: 0,
  status: "idle",
  entryId: null,
  error: null,
  offerDeadline: null,
};

const SESSION_KEY_PREFIX = "pickket_waitlist_";
const OFFER_WINDOW_MS = 30 * 60 * 1000; // 30 minutes to accept offer
const MAX_RECONNECT_ATTEMPTS = 3;
const POLL_INTERVAL_MS = 5_000; // 5 seconds (waitlist is less time-critical than queue)

/* ─── Hook ───────────────────────────────────────────────────────────────── */

export function useWaitlist(eventId: string, tierId: string) {
  const [state, setState] = useState<WaitlistState>(INITIAL_STATE);

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const visibilityCleanupRef = useRef<(() => void) | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const sessionKey = `${SESSION_KEY_PREFIX}${eventId}_${tierId}`;

  // ── Session persistence ────────────────────────────────────────────────

  const persistEntry = useCallback(
    (entryId: string) => {
      try {
        sessionStorage.setItem(
          sessionKey,
          JSON.stringify({ entryId, timestamp: Date.now() }),
        );
      } catch {
        /* storage unavailable */
      }
    },
    [sessionKey],
  );

  const clearPersistedEntry = useCallback(() => {
    try {
      sessionStorage.removeItem(sessionKey);
    } catch {
      /* ignore */
    }
  }, [sessionKey]);

  // ── Polling ────────────────────────────────────────────────────────────

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
    if (visibilityCleanupRef.current) {
      visibilityCleanupRef.current();
      visibilityCleanupRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    if (!eventId || !tierId) return;
    stopPolling();
    reconnectAttemptsRef.current = 0;

    const poll = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await getWaitlistStatus(eventId, tierId);
        const data = res.data;
        reconnectAttemptsRef.current = 0;

        setState((prev) => {
          const entryStatus = data.my_entry?.status;
          let newStatus = prev.status;
          let offerDeadline = prev.offerDeadline;

          if (entryStatus === "offered" && prev.status !== "offered") {
            newStatus = "offered";
            offerDeadline = Date.now() + OFFER_WINDOW_MS;
          } else if (entryStatus === "accepted") {
            newStatus = "accepted";
          } else if (entryStatus === "waiting") {
            newStatus = "waiting";
          } else if (!data.my_entry) {
            // User no longer on waitlist (expired, removed, etc.)
            newStatus = "idle";
            offerDeadline = null;
          }

          return {
            ...prev,
            position: data.my_position,
            totalWaiting: data.total_waiting,
            status: newStatus,
            entryId: data.my_entry?.id ?? prev.entryId,
            offerDeadline,
          };
        });
      } catch {
        reconnectAttemptsRef.current += 1;
        if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
          stopPolling();
          setState((prev) => ({
            ...prev,
            status: "error",
            error: "네트워크 연결이 끊어졌습니다. 다시 시도해주세요.",
          }));
        }
      }
    };

    pollingRef.current = setInterval(poll, POLL_INTERVAL_MS);

    // Resume immediately when tab becomes visible again
    const handleVisibility = () => {
      if (document.visibilityState === "visible") poll();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    visibilityCleanupRef.current = () =>
      document.removeEventListener("visibilitychange", handleVisibility);
  }, [eventId, tierId, stopPolling]);

  // ── Restore from sessionStorage on mount ──────────────────────────────

  useEffect(() => {
    if (!eventId || !tierId) return;

    const restore = async () => {
      try {
        const saved = sessionStorage.getItem(sessionKey);
        if (saved) {
          const parsed = JSON.parse(saved);
          // Session older than 2 hours → discard
          if (
            parsed.entryId &&
            Date.now() - parsed.timestamp < 2 * 60 * 60 * 1000
          ) {
            setState((prev) => ({
              ...prev,
              entryId: parsed.entryId,
              status: "waiting",
            }));
            startPolling();
          } else {
            clearPersistedEntry();
          }
        }
      } catch {
        /* ignore */
      }
    };
    restore();
  }, [sessionKey, startPolling, clearPersistedEntry, eventId, tierId]);

  // ── Cleanup on unmount ────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      stopPolling();
    };
  }, [stopPolling]);

  // ── Actions ───────────────────────────────────────────────────────────

  const join = useCallback(
    async (quantity = 1) => {
      if (!eventId || !tierId) return;
      setState((prev) => ({ ...prev, status: "joining", error: null }));
      try {
        const res = await joinWaitlist(eventId, tierId, quantity);
        const data = res.data;
        setState({
          position: data.position,
          totalWaiting: 0, // will be updated by first poll
          status: "waiting",
          entryId: data.id,
          error: null,
          offerDeadline: null,
        });
        persistEntry(data.id);
        startPolling();
      } catch (err: unknown) {
        const message =
          (err as { response?: { data?: { detail?: string } } })?.response?.data
            ?.detail ||
          (err as Error)?.message ||
          "대기열 참가에 실패했습니다";
        setState((prev) => ({ ...prev, status: "error", error: message }));
      }
    },
    [eventId, tierId, startPolling, persistEntry],
  );

  const leave = useCallback(async () => {
    if (!eventId || !tierId) return;
    stopPolling();
    try {
      await leaveWaitlist(eventId, tierId);
    } catch {
      /* best-effort */
    }
    clearPersistedEntry();
    setState(INITIAL_STATE);
  }, [eventId, tierId, stopPolling, clearPersistedEntry]);

  const retry = useCallback(() => {
    reconnectAttemptsRef.current = 0;
    setState((prev) => ({ ...prev, status: "waiting", error: null }));
    startPolling();
  }, [startPolling]);

  return useMemo(
    () => ({ ...state, join, leave, retry }),
    [state, join, leave, retry],
  );
}
