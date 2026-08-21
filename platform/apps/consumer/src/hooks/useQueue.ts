"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { toast } from "sonner";
import { joinQueue, getQueueStatus, leaveQueue } from "@pickket/lib/api";

interface QueueState {
  position: number;
  totalWaiting: number;
  isActive: boolean;
  estimatedWaitSeconds: number;
  token: string | null;
  status: "idle" | "joining" | "waiting" | "active" | "error";
  error: string | null;
  purchaseDeadline: number | null; // timestamp when purchase window expires
}

const INITIAL_STATE: QueueState = {
  position: 0,
  totalWaiting: 0,
  isActive: false,
  estimatedWaitSeconds: 0,
  token: null,
  status: "idle",
  error: null,
  purchaseDeadline: null,
};

const SESSION_KEY_PREFIX = "pickket_queue_";
const PURCHASE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes to complete purchase
const MAX_RECONNECT_ATTEMPTS = 3;

export function useQueue(eventId: string) {
  const [state, setState] = useState<QueueState>(INITIAL_STATE);

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const visibilityCleanupRef = useRef<(() => void) | null>(null);
  const isActiveRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);
  const sessionKey = `${SESSION_KEY_PREFIX}${eventId}`;

  // Persist queue token to sessionStorage
  const persistToken = useCallback(
    (token: string) => {
      try {
        sessionStorage.setItem(
          sessionKey,
          JSON.stringify({
            token,
            timestamp: Date.now(),
          }),
        );
      } catch {
        // storage unavailable
      }
    },
    [sessionKey],
  );

  const clearPersistedToken = useCallback(() => {
    try {
      sessionStorage.removeItem(sessionKey);
    } catch {
      // ignore
    }
  }, [sessionKey]);

  // Stop polling and clean up visibilitychange listener
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

  // Start polling every 2 seconds with reconnect logic
  // Pauses when tab is hidden to save resources / bandwidth
  const startPolling = useCallback(() => {
    stopPolling();
    reconnectAttemptsRef.current = 0;

    const poll = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await getQueueStatus(eventId);
        const data = res.data;
        reconnectAttemptsRef.current = 0; // reset on success

        setState((prev) => ({
          ...prev,
          position: data.position,
          totalWaiting: data.total_waiting,
          isActive: data.is_active,
          estimatedWaitSeconds: data.estimated_wait_seconds,
          token: data.token,
          status: data.is_active ? "active" : "waiting",
          purchaseDeadline:
            data.is_active && !prev.purchaseDeadline
              ? Date.now() + PURCHASE_WINDOW_MS
              : prev.purchaseDeadline,
        }));

        if (data.token) persistToken(data.token);

        if (data.is_active && !isActiveRef.current) {
          isActiveRef.current = true;
          stopPolling();
          clearPersistedToken();
        }
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
        // Exponential backoff: don't poll again immediately
        // (interval still runs but errors are counted)
      }
    };

    pollingRef.current = setInterval(poll, 2000);

    // Resume immediately when tab becomes visible again
    const handleVisibility = () => {
      if (document.visibilityState === "visible") poll();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    // Store cleanup ref for visibilitychange listener
    visibilityCleanupRef.current = () =>
      document.removeEventListener("visibilitychange", handleVisibility);
  }, [eventId, stopPolling, persistToken, clearPersistedToken]);

  // Restore from sessionStorage on mount
  useEffect(() => {
    const restoreSession = async () => {
      try {
        const saved = sessionStorage.getItem(sessionKey);
        if (saved) {
          const parsed = JSON.parse(saved);
          if (parsed.token && Date.now() - parsed.timestamp < 30 * 60 * 1000) {
            // Token is less than 30 min old, try to restore
            setState((prev) => ({
              ...prev,
              token: parsed.token,
              status: "waiting",
            }));
            startPolling();
          } else {
            clearPersistedToken();
          }
        }
      } catch {
        // ignore
      }
    };
    restoreSession();
  }, [sessionKey, startPolling, clearPersistedToken]);

  // Beforeunload warning while waiting
  useEffect(() => {
    if (state.status !== "waiting" && state.status !== "active") return;

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [state.status]);

  // Join queue — "active:TOKEN" | "waiting" | "error"
  const join = useCallback(async (): Promise<
    "waiting" | "error" | `active:${string}`
  > => {
    setState((prev) => ({ ...prev, status: "joining", error: null }));
    try {
      const res = await joinQueue(eventId);
      const data = res.data;
      setState({
        position: data.position,
        totalWaiting: data.total_waiting,
        isActive: data.is_active,
        estimatedWaitSeconds: data.estimated_wait_seconds,
        token: data.token,
        status: data.is_active ? "active" : "waiting",
        error: null,
        purchaseDeadline: data.is_active
          ? Date.now() + PURCHASE_WINDOW_MS
          : null,
      });

      if (data.token) persistToken(data.token);

      if (data.is_active) {
        isActiveRef.current = true;
        clearPersistedToken();
        return `active:${data.token ?? ""}`;
      } else {
        startPolling();
        return "waiting";
      }
    } catch (err: unknown) {
      const message =
        (err as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail ||
        (err as Error)?.message ||
        "대기열 참가에 실패했습니다";
      setState((prev) => ({ ...prev, status: "error", error: message }));
      toast.error(message);
      return "error";
    }
  }, [eventId, startPolling, persistToken, clearPersistedToken]);

  // Leave queue
  const leave = useCallback(async () => {
    stopPolling();
    try {
      await leaveQueue(eventId);
    } catch {
      // Best-effort leave
    }
    isActiveRef.current = false;
    clearPersistedToken();
    setState(INITIAL_STATE);
  }, [eventId, stopPolling, clearPersistedToken]);

  // Retry after error
  const retry = useCallback(() => {
    reconnectAttemptsRef.current = 0;
    setState((prev) => ({ ...prev, status: "waiting", error: null }));
    startPolling();
  }, [startPolling]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopPolling();
    };
  }, [stopPolling]);

  return useMemo(
    () => ({ ...state, join, leave, retry }),
    [state, join, leave, retry],
  );
}
